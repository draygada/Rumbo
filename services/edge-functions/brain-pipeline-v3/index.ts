// brain-pipeline-v3 — closed-vocabulary extraction with doc/chunk embeddings.
//
// One-per-record processing (was 10-record batches in v2). Each record:
//   1. Ensure structural node exists.
//   2. Chunk body text (adaptive: none/heading-aware/fixed with overlap).
//   3. Embed body_text (or summary if > 8000 chars) + each chunk in one batch.
//   4. Upsert doc-level body_embedding.
//   5. Upsert chunks (HAS_CHUNK edges).
//   6. Fetch top-20 candidate Concepts by cosine to body_embedding.
//   7. Classify record against candidates via Gemini (matched + new_concepts).
//   8. For each matched: bumpMention + linkCovers.
//   9. For each new_concept: embed name, createConceptWithEmbedding, linkCovers.
//  10. linkAppearsIn for each concept -> Course.
//  11. Mark record extraction_status='done', pipeline_version='v3-...'.
//
// Auth: CRON_SECRET. Body: { user_id, limit? }.
// Idempotent: re-running against the same record produces the same graph state.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'
import { EMBEDDING_DIM, geminiEmbedBatch } from '../_shared/gemini.ts'
import { chunk as chunkText, type Chunk as TextChunk } from '../_shared/chunker.ts'
import {
  classifyRecord,
  type CandidateConcept,
  type ClassificationOutput,
} from '../_shared/brain-classify-v3.ts'
import {
  bumpConceptMention,
  createConceptWithEmbedding,
  ensureStructuralNode,
  getCandidateConcepts,
  linkAppearsIn,
  linkCovers,
  upsertChunk,
  upsertDocBody,
  type StructuralLabel,
} from '../_shared/neo4j-graph-writer.ts'
import { normalizeConceptName, SOURCE_AUTHORITY } from '../_shared/brain-extraction-v2.ts'

const PIPELINE_VERSION = 'v3-classify-2026-07-10'
const DEFAULT_LIMIT = 30
const HARD_CAP = 30
const CANDIDATE_TOP_K = 20
const SUMMARY_CHAR_LIMIT = 3000  // for docs > 8000 chars, body_embedding is on the summary
const DOC_TEXT_HARD_LIMIT = 12000 // input cap for classifier

const SOURCE_TYPE_PRIORITY: Record<string, number> = {
  canvas_syllabus: 10,
  manual_syllabus: 10,
  canvas_file_syllabus: 10,
  canvas_home: 10,
  canvas_lecture: 9,
  canvas_assignment: 8,
  manual_assignment: 8,
  canvas_assignment_rubric: 8,
  canvas_file_project: 7,
  canvas_file_rubric: 7,
  canvas_file_study: 7,
  canvas_page: 7,
  canvas_announcement: 6,
  canvas_course: 6,
  manual_course: 6,
  google_calendar: 5,
}

interface RunBody {
  user_id?: string
  limit?: number
}

interface NormalizedEventRow {
  id: string
  user_id: string
  source_type: string
  course_id: string | null
  normalized_text: string | null
  raw_payload: Record<string, unknown> | null
}

interface RunResult {
  processed: number
  docs_embedded: number
  chunks_created: number
  concepts_created: number
  concepts_matched: number
  edges_created: number
  errors: string[]
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Structural node planning — same shape as v2 for compatibility.
// ---------------------------------------------------------------------------

interface StructuralPlan {
  label: StructuralLabel
  id: string
  courseId: string | null
  props: Record<string, unknown>
}

function planStructuralNode(row: NormalizedEventRow): StructuralPlan | null {
  const rp = row.raw_payload ?? {}
  const courseId = row.course_id
  switch (row.source_type) {
    case 'canvas_course':
    case 'manual_course': {
      if (!courseId) return null
      return {
        label: 'Course',
        id: courseId,
        courseId: null,
        props: {
          name: String(rp.name ?? row.normalized_text ?? ''),
          code: String(rp.course_code ?? ''),
          source: row.source_type === 'canvas_course' ? 'canvas' : 'manual',
        },
      }
    }
    case 'canvas_syllabus':
    case 'manual_syllabus':
    case 'canvas_file_syllabus': {
      if (!courseId) return null
      const id = `canvas_syllabus_${courseId.replace(/^canvas_course_/, '')}`
      return { label: 'Syllabus', id, courseId, props: { course_id: courseId } }
    }
    case 'canvas_lecture': {
      if (!courseId) return null
      const itemId = rp.item_id ?? rp.content_id
      if (itemId == null) return null
      return {
        label: 'Lecture',
        id: `canvas_lecture_${itemId}`,
        courseId,
        props: {
          course_id: courseId,
          title: String(rp.item_title ?? row.normalized_text ?? ''),
          url: String(rp.html_url ?? ''),
          position: Number(rp.item_position ?? 0),
          lecture_type: String(rp.lecture_type ?? 'external'),
        },
      }
    }
    case 'canvas_assignment':
    case 'manual_assignment': {
      if (!courseId) return null
      const canonical = String(rp.rumbo_canonical_name ?? rp.name ?? row.normalized_text ?? '').trim()
      const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed'
      return {
        label: 'Assignment',
        id: `assignment_${courseId}_${slug}`,
        courseId,
        props: {
          course_id: courseId,
          name: String(rp.name ?? canonical),
          canonical_name: canonical,
          due_at: rp.due_at ?? null,
          points: rp.points_possible ?? null,
        },
      }
    }
    case 'canvas_file_project':
    case 'canvas_file_rubric':
    case 'canvas_file_study': {
      if (!courseId) return null
      const fileId = rp.id ?? rp.canvas_file_id
      if (fileId == null) return null
      const category = String(rp.file_category ?? row.source_type.replace('canvas_file_', ''))
      return {
        label: 'File',
        id: `canvas_file_${fileId}`,
        courseId,
        props: {
          course_id: courseId,
          canvas_file_id: fileId,
          category,
          display_name: String(rp.display_name ?? rp.filename ?? row.normalized_text ?? ''),
          mime_type: String(rp['content-type'] ?? rp.mime_type ?? ''),
          url: String(rp.url ?? ''),
        },
      }
    }
    case 'canvas_home': {
      if (!courseId) return null
      return {
        label: 'Course', id: courseId, courseId: null,
        props: { home_url: String(rp.html_url ?? '') },
      }
    }
    case 'canvas_announcement': {
      if (!courseId) return null
      return { label: 'Course', id: courseId, courseId: null, props: {} }
    }
    case 'canvas_page': {
      if (!courseId) return null
      const pageSlug = String(rp.page_url ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
      if (!pageSlug) return null
      return {
        label: 'File',
        id: `canvas_page_${courseId.replace(/^canvas_course_/, '')}_${pageSlug}`,
        courseId,
        props: {
          course_id: courseId,
          category: 'page',
          display_name: String(rp.title ?? row.normalized_text ?? 'Page'),
          mime_type: 'text/html',
          url: String(rp.html_url ?? ''),
        },
      }
    }
    case 'canvas_assignment_rubric': {
      if (!courseId) return null
      const canonical = String(rp.assignment_name ?? '').trim()
      const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed'
      return { label: 'Assignment', id: `assignment_${courseId}_${slug}`, courseId, props: {} }
    }
    default:
      return null
  }
}

// Which labels store body_text on the node itself.
const BODY_LABELS: readonly StructuralLabel[] = ['Lecture', 'Assignment', 'File', 'Syllabus']

// Which HTML string on raw_payload contains the source body, per source_type.
function getSourceHtml(row: NormalizedEventRow): string | null {
  const rp = row.raw_payload ?? {}
  const candidates = [
    (rp as { body_html?: unknown }).body_html,
    (rp as { message_html?: unknown }).message_html,
    (rp as { syllabus_body?: unknown }).syllabus_body,
    (rp as { description?: unknown }).description,
  ]
  for (const c of candidates) if (typeof c === 'string' && c) return c
  return null
}

// ---------------------------------------------------------------------------
// Main per-record processing
// ---------------------------------------------------------------------------

async function processOneRecord(
  admin: ReturnType<typeof createAdminClient>,
  row: NormalizedEventRow,
  result: RunResult,
): Promise<void> {
  const g = neo4j()
  const userId = row.user_id
  const plan = planStructuralNode(row)
  if (!plan) return

  // 1. Ensure the structural node exists.
  await ensureStructuralNode(g, {
    userId,
    label: plan.label,
    id: plan.id,
    courseId: plan.courseId,
    props: plan.props,
  })

  const bodyText = (row.normalized_text ?? '').trim()
  if (!bodyText) {
    await markDone(admin, [row.id])
    result.processed += 1
    return
  }

  // 2. Chunking (heading-aware or fixed-with-overlap; empty for small docs)
  const html = getSourceHtml(row)
  const chunks: TextChunk[] = chunkText({ text: bodyText, html })

  // 3. Embed body (or summary) + all chunks in one batch call.
  const bodyEmbedInput =
    bodyText.length > 8000
      ? bodyText.slice(0, SUMMARY_CHAR_LIMIT)
      : bodyText.slice(0, 8000)
  const embedInputs = [bodyEmbedInput, ...chunks.map(c => c.text_for_embed.slice(0, 8000))]
  const embeds = await geminiEmbedBatch(embedInputs)
  const bodyEmbedding = embeds[0]
  const chunkEmbeds = embeds.slice(1)

  // 4. Doc-level body_embedding upsert (only for content labels that carry a body).
  if (
    (BODY_LABELS as readonly string[]).includes(plan.label) &&
    Array.isArray(bodyEmbedding) &&
    bodyEmbedding.length === EMBEDDING_DIM
  ) {
    await upsertDocBody(g, {
      userId,
      label: plan.label as 'Lecture' | 'Assignment' | 'File' | 'Syllabus',
      id: plan.id,
      bodyText: bodyText.slice(0, DOC_TEXT_HARD_LIMIT),
      bodyEmbedding,
    })
    result.docs_embedded += 1
  }

  // 5. Chunks (skip if the label doesn't carry body).
  if ((BODY_LABELS as readonly string[]).includes(plan.label)) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const emb = chunkEmbeds[i]
      const embOk = Array.isArray(emb) && emb.length === EMBEDDING_DIM
      await upsertChunk(g, {
        userId,
        parentLabel: plan.label,
        parentId: plan.id,
        chunkIndex: c.index,
        heading: c.heading,
        text: c.text,
        embedding: embOk ? emb : null,
      })
      result.chunks_created += 1
    }
  }

  // 6. Candidate concepts by cosine to body embedding.
  const candidates: CandidateConcept[] =
    Array.isArray(bodyEmbedding) && bodyEmbedding.length === EMBEDDING_DIM
      ? (await getCandidateConcepts(g, { userId, embedding: bodyEmbedding, topK: CANDIDATE_TOP_K }))
          .map(c => ({ id: c.id, name: c.name }))
      : []

  // 7. Closed-vocab classification.
  const classification: ClassificationOutput | null = await classifyRecord({
    record_text: bodyText,
    source_type: row.source_type,
    candidates,
  })
  if (!classification) {
    // Classifier failed — leave record pending for retry.
    return
  }

  // 8/9. Wire matched + new_concepts to the source node.
  const authority = SOURCE_AUTHORITY[row.source_type] ?? 0.6
  const sourceLabel = plan.label
  const sourceId = plan.id
  const courseId = plan.label === 'Course' ? plan.id : plan.courseId

  for (const m of classification.matched) {
    if (m.confidence < 0.6) continue
    try {
      await bumpConceptMention(g, { userId, conceptId: m.concept_id })
      const weight = authority * (m.is_primary ? 1.0 : 0.6)
      await linkCovers(g, {
        userId,
        sourceLabel,
        sourceId,
        conceptId: m.concept_id,
        weight,
        isPrimary: m.is_primary,
      })
      if (courseId) {
        await linkAppearsIn(g, { userId, conceptId: m.concept_id, courseId })
        result.edges_created += 2
      } else {
        result.edges_created += 1
      }
      result.concepts_matched += 1
    } catch (err) {
      result.errors.push(`matched concept ${m.concept_id}: ${errMsg(err)}`)
    }
  }

  if (classification.new_concepts.length > 0) {
    const namesNormalized = classification.new_concepts.map(c => normalizeConceptName(c.name))
    const newEmbeds = await geminiEmbedBatch(namesNormalized)
    for (let i = 0; i < classification.new_concepts.length; i++) {
      const proposal = classification.new_concepts[i]
      const normalized = namesNormalized[i]
      const emb = newEmbeds[i]
      if (!normalized) continue
      if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
        result.errors.push(`no embedding for proposed concept "${proposal.name}"`)
        continue
      }
      try {
        const conceptId = await createConceptWithEmbedding(g, {
          userId,
          name: proposal.name.trim(),
          normalizedName: normalized,
          embedding: emb,
        })
        const weight = authority * (proposal.is_primary ? 1.0 : 0.6)
        await linkCovers(g, {
          userId,
          sourceLabel,
          sourceId,
          conceptId,
          weight,
          isPrimary: proposal.is_primary,
        })
        if (courseId) {
          await linkAppearsIn(g, { userId, conceptId, courseId })
          result.edges_created += 2
        } else {
          result.edges_created += 1
        }
        result.concepts_created += 1
      } catch (err) {
        result.errors.push(`new concept "${proposal.name}": ${errMsg(err)}`)
      }
    }
  }

  await markDone(admin, [row.id])
  result.processed += 1
}

async function markDone(admin: ReturnType<typeof createAdminClient>, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await admin
    .from('normalized_events')
    .update({
      extraction_status: 'done',
      extracted_at: new Date().toISOString(),
      pipeline_version: PIPELINE_VERSION,
    })
    .in('id', ids)
}

async function runForUser(userId: string, limit: number): Promise<RunResult> {
  const result: RunResult = {
    processed: 0,
    docs_embedded: 0,
    chunks_created: 0,
    concepts_created: 0,
    concepts_matched: 0,
    edges_created: 0,
    errors: [],
  }
  const admin = createAdminClient()
  const effective = Math.min(limit, HARD_CAP)

  const { data, error } = await admin
    .from('normalized_events')
    .select('id, user_id, source_type, course_id, normalized_text, raw_payload')
    .eq('user_id', userId)
    .eq('classification', 'academic')
    .eq('extraction_status', 'pending')
    .is('cancelled_at', null)
    .limit(effective)
  if (error) {
    result.errors.push(`load records failed: ${error.message}`)
    return result
  }
  const rows = ((data ?? []) as NormalizedEventRow[]).sort(
    (a, b) => (SOURCE_TYPE_PRIORITY[b.source_type] ?? 0) - (SOURCE_TYPE_PRIORITY[a.source_type] ?? 0),
  )

  for (const row of rows) {
    try {
      await processOneRecord(admin, row, result)
    } catch (err) {
      result.errors.push(`record ${row.id}: ${errMsg(err)}`)
    }
  }
  return result
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: RunBody = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text) as RunBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  if (!body.user_id) return jsonResponse({ error: 'user_id required' }, 400)

  try {
    const result = await runForUser(body.user_id, body.limit ?? DEFAULT_LIMIT)
    return jsonResponse({ ok: true, ...result })
  } catch (err) {
    return jsonResponse({ ok: false, error: errMsg(err) }, 500)
  }
})
