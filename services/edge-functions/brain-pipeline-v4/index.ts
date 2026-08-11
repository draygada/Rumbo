// brain-pipeline-v4 — three-stage extraction with pedagogical tiering.
//
// Delta from v3:
//   1. Content-format detection (Haiku) drives chunker-v4 strategy
//   2. HTML → Markdown before chunking (preserves structural cues)
//   3. Cohere embed-v4 (search_document) replaces Gemini Embedding
//   4. Extraction is Pass 1 (Haiku per-chunk) → aggregate → Opus reasoning →
//      Pass 2 (Haiku file-level). Tier assignment + PARENT_CONCEPT edges.
//   5. COVERS carries .definition + .excerpt lifted from Pass 2
//   6. Concept tags (skill_dimensions / domain_tags / bloom_typical_level)
//      set at creation from reasoning-layer output
//   7. Hash cache: skip records whose body_hash already has a v4 extraction
//
// Deploys as a shadow function alongside v3 (existing shadow-swap infra).
// Reads pipeline_version_v4 column to identify v4-pending records.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'
import { cohereEmbedBatch, COHERE_EMBED_DIM } from '../_shared/cohere.ts'
import { detectContentFormat } from '../_shared/content-format.ts'
import { htmlToMarkdown } from '../_shared/html-to-md.ts'
import { chunkV4 } from '../_shared/chunker-v4.ts'
import {
  extractV4,
  normalizeConceptName,
  type CandidateConcept,
  type TieredConcept,
} from '../_shared/brain-extract-v4.ts'
import {
  ensureStructuralNode,
  bumpConceptMention,
  getCandidateConcepts,
  linkAppearsIn,
  upsertChunk,
  upsertDocBody,
  type StructuralLabel,
} from '../_shared/neo4j-graph-writer.ts'
import {
  createConceptWithTags,
  setConceptTags,
  linkParentConcept,
  linkCoversWithContext,
} from '../_shared/neo4j-graph-writer-v4.ts'
import { SOURCE_AUTHORITY } from '../_shared/brain-extraction-v2.ts'

const PIPELINE_VERSION = 'v4-2026-07-17'
const DEFAULT_LIMIT = 20
const HARD_CAP = 20
const CANDIDATE_TOP_K = 20
const DOC_TEXT_HARD_LIMIT = 12000

const SOURCE_TYPE_PRIORITY: Record<string, number> = {
  canvas_syllabus: 10, manual_syllabus: 10, canvas_file_syllabus: 10,
  canvas_home: 10, canvas_lecture: 9, canvas_assignment: 8,
  manual_assignment: 8, canvas_assignment_rubric: 8,
  canvas_file_project: 7, canvas_file_rubric: 7, canvas_file_study: 7,
  canvas_file_reading: 7, canvas_file_document: 6, canvas_page: 7,
  canvas_announcement: 6, canvas_course: 6, manual_course: 6,
  google_calendar: 5,
}

interface NormalizedEventRow {
  id: string
  user_id: string
  source_type: string
  course_id: string | null
  normalized_text: string | null
  raw_payload: Record<string, unknown> | null
  body_hash: string | null
}

interface RunResult {
  processed: number
  skipped_cached: number
  chunks_created: number
  concepts_created: number
  concepts_matched: number
  parent_edges: number
  covers_edges: number
  errors: string[]
}

// ---------------------------------------------------------------------------
// Auth + helpers
// ---------------------------------------------------------------------------

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Structural node planning — copied from v3 (unchanged behavior).
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
      const termObj = (rp.term ?? {}) as Record<string, unknown>
      const termName = typeof termObj.name === 'string' ? termObj.name : null
      const termEnd = typeof termObj.end_at === 'string' ? termObj.end_at
        : (typeof rp.end_at === 'string' ? rp.end_at : null)
      const termStart = typeof termObj.start_at === 'string' ? termObj.start_at
        : (typeof rp.start_at === 'string' ? rp.start_at : null)
      return {
        label: 'Course', id: courseId, courseId: null,
        props: {
          name: String(rp.name ?? row.normalized_text ?? ''),
          code: String(rp.course_code ?? ''),
          source: row.source_type === 'canvas_course' ? 'canvas' : 'manual',
          term: termName, term_end: termEnd, term_start: termStart,
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
        label: 'Lecture', id: `canvas_lecture_${itemId}`, courseId,
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
        label: 'Assignment', id: `assignment_${courseId}_${slug}`, courseId,
        props: {
          course_id: courseId, name: String(rp.name ?? canonical),
          canonical_name: canonical, due_at: rp.due_at ?? null,
          points: rp.points_possible ?? null,
        },
      }
    }
    case 'canvas_file_project':
    case 'canvas_file_rubric':
    case 'canvas_file_study':
    case 'canvas_file_reading':
    case 'canvas_file_document': {
      if (!courseId) return null
      const fileId = rp.id ?? rp.canvas_file_id
      if (fileId == null) return null
      const category = String(rp.file_category ?? row.source_type.replace('canvas_file_', ''))
      return {
        label: 'File', id: `canvas_file_${fileId}`, courseId,
        props: {
          course_id: courseId, canvas_file_id: fileId, category,
          display_name: String(rp.display_name ?? rp.filename ?? row.normalized_text ?? ''),
          mime_type: String(rp['content-type'] ?? rp.mime_type ?? ''),
          url: String(rp.url ?? ''),
        },
      }
    }
    case 'canvas_home': {
      if (!courseId) return null
      const pageTitle = typeof rp.title === 'string' ? rp.title.trim() : ''
      return {
        label: 'File', id: `canvas_home_${courseId.replace(/^canvas_course_/, '')}`, courseId,
        props: {
          course_id: courseId, category: 'home',
          display_name: pageTitle ? `Course Home Page — ${pageTitle}` : 'Course Home Page',
          mime_type: 'text/html', url: String(rp.html_url ?? ''),
        },
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
        label: 'File', id: `canvas_page_${courseId.replace(/^canvas_course_/, '')}_${pageSlug}`, courseId,
        props: {
          course_id: courseId, category: 'page',
          display_name: String(rp.title ?? row.normalized_text ?? 'Page'),
          mime_type: 'text/html', url: String(rp.html_url ?? ''),
        },
      }
    }
    case 'canvas_assignment_rubric': {
      if (!courseId) return null
      const canonical = String(rp.assignment_name ?? '').trim()
      const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed'
      return { label: 'Assignment', id: `assignment_${courseId}_${slug}`, courseId, props: {} }
    }
    default: return null
  }
}

const BODY_LABELS: readonly StructuralLabel[] = ['Lecture', 'Assignment', 'File', 'Syllabus']

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
// Per-record processing
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

  await ensureStructuralNode(g, {
    userId, label: plan.label, id: plan.id,
    courseId: plan.courseId, props: plan.props,
  })

  const bodyText = (row.normalized_text ?? '').trim()
  if (!bodyText) {
    await markDone(admin, row.id, null)
    result.processed += 1
    return
  }

  // Hash cache: same body_hash already has a v4 extraction? Mark done + skip.
  const bodyHash = await sha256Hex(bodyText)
  if (row.body_hash === bodyHash) {
    const { data } = await admin
      .from('normalized_events')
      .select('pipeline_version_v4')
      .eq('id', row.id).single()
    if (data?.pipeline_version_v4) {
      result.skipped_cached += 1
      return
    }
  }

  // 1. HTML → Markdown (if source HTML available; else use normalized_text as-is)
  const html = getSourceHtml(row)
  const markdown = html ? htmlToMarkdown(html).markdown : bodyText

  // 2. Content-format detection
  const format = await detectContentFormat({
    text: markdown, html, sourceType: row.source_type,
  })

  // 3. Chunker-v4 dispatch
  const chunks = chunkV4({ markdown, format })

  // 4. Cohere embed-v4 (search_document): body + all chunks in one batch
  const bodyEmbedInput = markdown.length > 8000 ? markdown.slice(0, 3000) : markdown
  const embedInputs = [bodyEmbedInput, ...chunks.map(c => c.text_for_embed.slice(0, 8000))]
  const embeds = await cohereEmbedBatch(embedInputs, 'search_document')
  const bodyEmbedding = embeds[0]
  const chunkEmbeds = embeds.slice(1)

  // 5. Upsert doc-body
  if (
    (BODY_LABELS as readonly string[]).includes(plan.label) &&
    Array.isArray(bodyEmbedding) && bodyEmbedding.length === COHERE_EMBED_DIM
  ) {
    await upsertDocBody(g, {
      userId,
      label: plan.label as 'Lecture' | 'Assignment' | 'File' | 'Syllabus',
      id: plan.id,
      bodyText: bodyText.slice(0, DOC_TEXT_HARD_LIMIT),
      bodyEmbedding,
    })
  }

  // 6. Upsert chunks
  if ((BODY_LABELS as readonly string[]).includes(plan.label)) {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const emb = chunkEmbeds[i]
      const embOk = Array.isArray(emb) && emb.length === COHERE_EMBED_DIM
      await upsertChunk(g, {
        userId, parentLabel: plan.label, parentId: plan.id,
        chunkIndex: c.index, heading: c.heading, text: c.text,
        embedding: embOk ? emb : null,
      })
      result.chunks_created += 1
    }
  }

  // 7. Candidate concepts (vector similarity to body embedding)
  const candidates: CandidateConcept[] =
    Array.isArray(bodyEmbedding) && bodyEmbedding.length === COHERE_EMBED_DIM
      ? (await getCandidateConcepts(g, { userId, embedding: bodyEmbedding, topK: CANDIDATE_TOP_K }))
          .map(c => ({ id: c.id, name: c.name }))
      : []

  // 8. Three-stage extraction
  const chunksForPass1 = chunks.length > 0
    ? chunks.map(c => ({ chunk_index: c.index, heading: c.heading, text: c.text }))
    : [{ chunk_index: 0, heading: null, text: bodyText.slice(0, 6000) }]

  const extraction = await extractV4({
    sourceType: row.source_type,
    courseName: plan.label === 'Course' ? (plan.props.name as string) : null,
    recordText: bodyText,
    chunks: chunksForPass1,
    candidates,
  })

  // 9. Resolve tiered concepts → concept IDs. Build a name→id map so
  // parent_name references can be wired into PARENT_CONCEPT edges.
  const resolved = await resolveTieredConcepts(g, {
    userId, tiered: extraction.tiered, candidates,
  })
  result.concepts_created += resolved.newConceptIds.length

  // 10. PARENT_CONCEPT edges (tier-2 → tier-1)
  for (const tier2 of extraction.tiered) {
    if (tier2.tier !== 2 || !tier2.parent_name) continue
    const childId = resolved.identityToId(tier2)
    const parentId = resolved.parentNameToId.get(normalizeConceptName(tier2.parent_name))
    if (!childId || !parentId) continue
    try {
      await linkParentConcept(g, {
        userId, childConceptId: childId, parentConceptId: parentId,
        confidence: tier2.confidence,
      })
      result.parent_edges += 1
    } catch (err) {
      result.errors.push(`parent edge: ${errMsg(err)}`)
    }
  }

  // 11. Pass 2 matches → COVERS edges (with definition + excerpt)
  const authority = SOURCE_AUTHORITY[row.source_type] ?? 0.6
  const sourceLabel = plan.label
  const sourceId = plan.id
  const courseIdForAppears = plan.label === 'Course' ? plan.id : plan.courseId

  for (const match of extraction.matches) {
    const conceptId = resolved.matchToId(match.identity)
    if (!conceptId) continue
    try {
      await bumpConceptMention(g, { userId, conceptId })
      const tier1Boost = resolved.tierOf(conceptId) === 1 ? 1.0 : 0.75
      const weight = authority * (match.is_primary ? 1.0 : 0.6) * tier1Boost
      await linkCoversWithContext(g, {
        userId, sourceLabel, sourceId, conceptId,
        weight, isPrimary: match.is_primary,
        definition: match.definition, excerpt: match.excerpt,
      })
      if (sourceLabel !== 'Course' && courseIdForAppears) {
        await linkAppearsIn(g, { userId, conceptId, courseId: courseIdForAppears })
      }
      result.covers_edges += 1
      result.concepts_matched += 1
    } catch (err) {
      result.errors.push(`covers edge: ${errMsg(err)}`)
    }
  }

  await markDone(admin, row.id, bodyHash)
  result.processed += 1
}

// ---------------------------------------------------------------------------
// Tiered-concept resolution: match candidates by id, create new concepts with
// tags for proposals. Returns lookup helpers used by the orchestrator.
// ---------------------------------------------------------------------------

async function resolveTieredConcepts(
  g: ReturnType<typeof neo4j>,
  args: {
    userId: string
    tiered: TieredConcept[]
    candidates: CandidateConcept[]
  },
): Promise<{
  identityToId: (t: TieredConcept) => string | null
  matchToId: (identity: { candidate_id?: string; proposal_name?: string }) => string | null
  parentNameToId: Map<string, string>
  tierOf: (conceptId: string) => 1 | 2 | null
  newConceptIds: string[]
}> {
  const candidateById = new Map(args.candidates.map(c => [c.id, c]))
  const identityIdMap = new Map<string, string>() // tempKey → conceptId
  const parentNameToId = new Map<string, string>()
  const tierMap = new Map<string, 1 | 2>()
  const newConceptIds: string[] = []

  const nameToProposalEmbedding = new Map<string, number[]>()
  const proposalsNeedingEmbedding: Array<{ tempKey: string; name: string; tier: TieredConcept }> = []

  for (const t of args.tiered) {
    if (t.candidate_id) {
      const cand = candidateById.get(t.candidate_id)
      if (!cand) continue
      identityIdMap.set(keyOf(t), cand.id)
      tierMap.set(cand.id, t.tier)
      parentNameToId.set(normalizeConceptName(cand.name), cand.id)
      // Patch tags on existing candidate (idempotent)
      try {
        await setConceptTags(g, {
          userId: args.userId, conceptId: cand.id,
          tags: {
            skill_dimensions: t.skill_dimensions,
            domain_tags: t.domain_tags,
            bloom_typical_level: t.bloom_typical_level,
          },
        })
      } catch { /* fail-soft */ }
    } else if (t.proposal_name) {
      proposalsNeedingEmbedding.push({
        tempKey: keyOf(t),
        name: t.proposal_name.trim(),
        tier: t,
      })
    }
  }

  if (proposalsNeedingEmbedding.length > 0) {
    const names = proposalsNeedingEmbedding.map(p => normalizeConceptName(p.name))
    const embs = await cohereEmbedBatch(names, 'clustering')
    for (let i = 0; i < proposalsNeedingEmbedding.length; i++) {
      const p = proposalsNeedingEmbedding[i]
      const emb = embs[i]
      if (!Array.isArray(emb) || emb.length !== COHERE_EMBED_DIM) continue
      nameToProposalEmbedding.set(names[i], emb)
      try {
        const conceptId = await createConceptWithTags(g, {
          userId: args.userId,
          name: p.name,
          normalizedName: names[i],
          embedding: emb,
          tags: {
            skill_dimensions: p.tier.skill_dimensions,
            domain_tags: p.tier.domain_tags,
            bloom_typical_level: p.tier.bloom_typical_level,
          },
        })
        identityIdMap.set(p.tempKey, conceptId)
        tierMap.set(conceptId, p.tier.tier)
        parentNameToId.set(names[i], conceptId)
        newConceptIds.push(conceptId)
      } catch (err) {
        console.warn('[brain-pipeline-v4] create concept failed:', err)
      }
    }
  }

  return {
    identityToId: (t: TieredConcept) => identityIdMap.get(keyOf(t)) ?? null,
    matchToId: (identity) => {
      if (identity.candidate_id) return candidateById.get(identity.candidate_id)?.id ?? null
      if (identity.proposal_name) {
        const norm = normalizeConceptName(identity.proposal_name)
        return parentNameToId.get(norm) ?? null
      }
      return null
    },
    parentNameToId,
    tierOf: (conceptId) => tierMap.get(conceptId) ?? null,
    newConceptIds,
  }
}

function keyOf(t: TieredConcept): string {
  return t.candidate_id ? `cid:${t.candidate_id}` : `pn:${normalizeConceptName(t.proposal_name ?? '')}`
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function markDone(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
  bodyHash: string | null,
): Promise<void> {
  const update: Record<string, unknown> = {
    pipeline_version_v4: PIPELINE_VERSION,
    extracted_at_v4: new Date().toISOString(),
  }
  if (bodyHash) update.body_hash = bodyHash
  await admin.from('normalized_events').update(update).eq('id', id)
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runForUser(userId: string, limit: number): Promise<RunResult> {
  const result: RunResult = {
    processed: 0, skipped_cached: 0, chunks_created: 0,
    concepts_created: 0, concepts_matched: 0,
    parent_edges: 0, covers_edges: 0, errors: [],
  }
  const admin = createAdminClient()
  const effective = Math.min(limit, HARD_CAP)

  // Fetch a larger pool than `effective` and sort by SOURCE_TYPE_PRIORITY in
  // memory — Postgres doesn't know our priority map, so we can't ORDER BY on
  // the DB side without a case statement. Overfetch by ~5x, then slice.
  const overfetch = Math.max(effective * 5, 40)
  const { data, error } = await admin
    .from('normalized_events')
    .select('id, user_id, source_type, course_id, normalized_text, raw_payload, body_hash')
    .eq('user_id', userId)
    .eq('classification', 'academic')
    .is('pipeline_version_v4', null)
    .is('cancelled_at', null)
    .limit(overfetch)
  if (error) {
    result.errors.push(`load records failed: ${error.message}`)
    return result
  }

  const rows = ((data ?? []) as NormalizedEventRow[])
    .sort((a, b) => (SOURCE_TYPE_PRIORITY[b.source_type] ?? 0) - (SOURCE_TYPE_PRIORITY[a.source_type] ?? 0))
    .slice(0, effective)
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

  let body: { user_id?: string; limit?: number } = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text)
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  if (!body.user_id) return jsonResponse({ error: 'user_id required' }, 400)

  try {
    const result = await runForUser(body.user_id, body.limit ?? DEFAULT_LIMIT)
    return jsonResponse({ ok: true, pipeline_version: PIPELINE_VERSION, ...result })
  } catch (err) {
    return jsonResponse({ ok: false, error: errMsg(err) }, 500)
  }
})
