// brain-pipeline-v2 — Phase 6 Fast-tier orchestrator.
//
// Reads pending academic normalized_events for one user, ensures structural
// Neo4j nodes exist, runs batched Gemini concept extraction (10 records/call),
// embeds and MERGEs concepts, and links COVERS + APPEARS_IN edges.
//
// Reference: Rumbo-Design-Docs/Graph Pipeline/tiered-pipeline.md §4,
// entity-extraction.md §4.5–§4.6, graph-schema.md §4-§5.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'
import { EMBEDDING_DIM, geminiEmbedBatch } from '../_shared/gemini.ts'
import {
  extractConceptsBatch,
  normalizeConceptName,
  SOURCE_AUTHORITY,
  type NormalizedEventLite,
} from '../_shared/brain-extraction-v2.ts'
import {
  ensureConcept,
  ensureStructuralNode,
  linkAppearsIn,
  linkCovers,
  type StructuralLabel,
} from '../_shared/neo4j-graph-writer.ts'

const PIPELINE_VERSION = 'fast-v2-2026-07-09'
const DEFAULT_LIMIT = 100
const HARD_CAP = 200

// Source-type priority: lecture > syllabus > assignment > file > course > event.
const SOURCE_TYPE_PRIORITY: Record<string, number> = {
  canvas_lecture:       10,
  canvas_syllabus:       9,
  manual_syllabus:       9,
  canvas_file_syllabus:  9,
  canvas_assignment:     8,
  manual_assignment:     8,
  canvas_file_project:   7,
  canvas_file_rubric:    7,
  canvas_file_study:     7,
  canvas_course:         6,
  manual_course:         6,
  google_calendar:       5,
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
  concepts_created: number
  concepts_merged: number
  edges_created: number
  errors: string[]
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

// ---------------------------------------------------------------------------
// Structural node mapping — per source_type, decide label + id + props
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
      return {
        label: 'Syllabus',
        id,
        courseId,
        props: {
          course_id: courseId,
          body_text: String(row.normalized_text ?? ''),
        },
      }
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
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function runForUser(userId: string, limit: number): Promise<RunResult> {
  const result: RunResult = {
    processed: 0,
    concepts_created: 0,
    concepts_merged: 0,
    edges_created: 0,
    errors: [],
  }

  const admin = createAdminClient()
  const g = neo4j()

  const effectiveLimit = Math.min(limit, HARD_CAP)
  if (limit > HARD_CAP) {
    console.warn(`[brain-pipeline-v2] WARN: requested limit ${limit} exceeds hard-cap ${HARD_CAP}; clamping.`)
  }

  const { data, error } = await admin
    .from('normalized_events')
    .select('id, user_id, source_type, course_id, normalized_text, raw_payload')
    .eq('user_id', userId)
    .eq('classification', 'academic')
    .eq('extraction_status', 'pending')
    .is('cancelled_at', null)
    .limit(effectiveLimit)
  if (error) {
    result.errors.push(`load records failed: ${error.message}`)
    return result
  }

  const rows = (data ?? []) as NormalizedEventRow[]
  rows.sort((a, b) => (SOURCE_TYPE_PRIORITY[b.source_type] ?? 0) - (SOURCE_TYPE_PRIORITY[a.source_type] ?? 0))

  // 1. Ensure structural nodes exist per record.
  const rowsForExtraction: NormalizedEventRow[] = []
  for (const row of rows) {
    try {
      const plan = planStructuralNode(row)
      if (plan) {
        await ensureStructuralNode(g, {
          userId,
          label: plan.label,
          id: plan.id,
          courseId: plan.courseId,
          props: plan.props,
        })
      }
      rowsForExtraction.push(row)
    } catch (err) {
      result.errors.push(`structural node for ${row.id}: ${errMsg(err)}`)
    }
  }

  // 2. Group by source_type so batches share a homogeneous prompt.
  const bySourceType = new Map<string, NormalizedEventRow[]>()
  for (const r of rowsForExtraction) {
    const arr = bySourceType.get(r.source_type) ?? []
    arr.push(r)
    bySourceType.set(r.source_type, arr)
  }

  for (const [sourceType, group] of bySourceType) {
    const CHUNK = 10
    for (let i = 0; i < group.length; i += CHUNK) {
      const chunk = group.slice(i, i + CHUNK)
      try {
        const lite: NormalizedEventLite[] = chunk.map(r => ({
          id: r.id,
          source_type: r.source_type,
          normalized_text: r.normalized_text,
          raw_payload: r.raw_payload,
        }))
        const extractions = await extractConceptsBatch(lite)

        // Flatten concepts for embedding.
        const flatItems: Array<{ row: NormalizedEventRow; name: string; normalized: string; is_primary: boolean }> = []
        const rowById = new Map(chunk.map(r => [r.id, r]))
        for (const ext of extractions) {
          const row = rowById.get(ext.record_id)
          if (!row) continue
          const seenNames = new Set<string>()
          for (const c of ext.concepts) {
            const normalized = normalizeConceptName(c.name)
            if (!normalized || seenNames.has(normalized)) continue
            seenNames.add(normalized)
            flatItems.push({ row, name: c.name.trim(), normalized, is_primary: Boolean(c.is_primary) })
          }
        }

        if (flatItems.length === 0) {
          await markDone(admin, chunk.map(r => r.id))
          result.processed += chunk.length
          continue
        }

        const embeds = await geminiEmbedBatch(flatItems.map(it => it.normalized))

        // Per-record error isolation: track which record ids had a failure so
        // we don't mark them done.
        const failedRowIds = new Set<string>()

        for (let j = 0; j < flatItems.length; j++) {
          const item = flatItems[j]
          const emb = embeds[j]
          if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) {
            failedRowIds.add(item.row.id)
            result.errors.push(`embedding missing for concept "${item.name}" (record ${item.row.id})`)
            continue
          }
          try {
            const authority = SOURCE_AUTHORITY[item.row.source_type] ?? 0.60
            const weight = authority * (item.is_primary ? 1.0 : 0.6)
            const cRes = await ensureConcept(g, {
              userId,
              name: item.name,
              normalizedName: item.normalized,
              embedding: emb,
              sourceAuthority: authority,
            })
            if (cRes.merged) result.concepts_merged += 1
            else result.concepts_created += 1

            const plan = planStructuralNode(item.row)
            if (plan) {
              await linkCovers(g, {
                userId,
                sourceLabel: plan.label,
                sourceId: plan.id,
                conceptId: cRes.id,
                weight,
                isPrimary: item.is_primary,
              })
              result.edges_created += 1
              const courseId = plan.label === 'Course' ? plan.id : plan.courseId
              if (courseId) {
                await linkAppearsIn(g, { userId, conceptId: cRes.id, courseId })
                result.edges_created += 1
              }
            }
          } catch (err) {
            failedRowIds.add(item.row.id)
            result.errors.push(`concept "${item.name}" (record ${item.row.id}): ${errMsg(err)}`)
          }
        }

        const doneIds = chunk.map(r => r.id).filter(id => !failedRowIds.has(id))
        await markDone(admin, doneIds)
        result.processed += doneIds.length
      } catch (err) {
        result.errors.push(`batch ${sourceType}#${i}: ${errMsg(err)}`)
      }
    }
  }

  return result
}

async function markDone(admin: ReturnType<typeof createAdminClient>, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await admin
    .from('normalized_events')
    .update({
      extraction_status: 'done',
      extracted_at: new Date().toISOString(),
      pipeline_version: PIPELINE_VERSION,
    })
    .in('id', ids)
  if (error) console.warn(`[brain-pipeline-v2] markDone failed: ${error.message}`)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
