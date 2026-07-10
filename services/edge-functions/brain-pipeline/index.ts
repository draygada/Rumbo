// brain-pipeline — end-to-end graph brain job.
//
// Invocation modes:
//   - Cron / batch: POST with no body → iterate every user with any pending
//     academic normalized_events row.
//   - Single-user: POST { user_id: "..." } → run the pipeline for that user only
//     (used by kickBrainPipeline after ingests).
//
// Auth: fail-closed x-cron-secret (same pattern as canvas-ingest / drive-ingest).
//
// Reference: entity-extraction.md, entity-resolution.md, edge-inference.md,
// edge-weighting.md; CLAUDE.md §5 Phases 7–10.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { extractEntities, type NormalizedEventRow } from '../_shared/brain-extraction.ts'
import { resolveCandidate, type CandidateRow } from '../_shared/brain-resolution.ts'
import { inferEdgesForNode, type NodeSummary } from '../_shared/brain-inference.ts'

const BATCH_SIZE = 100

interface RunBody {
  user_id?: string
}

interface UserResult {
  user_id: string
  records_processed: number
  entities: number
  edges: number
  surfaced_edges: number
  errors: number
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

async function pendingUserIds(admin: ReturnType<typeof createAdminClient>): Promise<string[]> {
  const { data, error } = await admin
    .from('normalized_events')
    .select('user_id')
    .eq('extraction_status', 'pending')
    .eq('classification', 'academic')
    .limit(5000)
  if (error) throw new Error(`user enumeration failed: ${error.message}`)
  return Array.from(new Set((data ?? []).map(r => r.user_id as string)))
}

async function runForUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<UserResult> {
  const result: UserResult = {
    user_id: userId,
    records_processed: 0,
    entities: 0,
    edges: 0,
    surfaced_edges: 0,
    errors: 0,
  }

  const { data: records, error } = await admin
    .from('normalized_events')
    .select('id, user_id, source_type, classification, raw_payload, normalized_text')
    .eq('user_id', userId)
    .eq('extraction_status', 'pending')
    .eq('classification', 'academic')
    .order('ingested_at', { ascending: true })
    .limit(BATCH_SIZE)
  if (error) {
    result.errors += 1
    console.warn(`[brain-pipeline] load records failed for ${userId}:`, error.message)
    return result
  }

  for (const record of (records ?? []) as NormalizedEventRow[]) {
    result.records_processed += 1

    // Stage 1: extraction.
    const extraction = await extractEntities(admin, record)
    if (extraction.status === 'failed') {
      result.errors += 1
      continue
    }
    if (extraction.status === 'skipped' || extraction.candidates.length === 0) continue

    // Stage 2: resolve each candidate. Load full candidate rows first.
    const { data: candidateRows, error: candErr } = await admin
      .from('entity_candidates')
      .select('id, user_id, source_record_id, name, entity_type, context_snippet, extraction_confidence, source_authority, embedding')
      .in('id', extraction.candidates)
    if (candErr || !candidateRows) {
      result.errors += 1
      continue
    }
    result.entities += candidateRows.length

    const touchedNodeIds = new Set<string>()
    for (const cand of candidateRows as CandidateRow[]) {
      try {
        const outcome = await resolveCandidate(admin, cand)
        touchedNodeIds.add(outcome.node_id)
      } catch (err) {
        result.errors += 1
        console.warn('[brain-pipeline] resolve failed:', err)
      }
    }

    // Stage 3 + 4: inference + weighting for each touched node.
    if (touchedNodeIds.size > 0) {
      const { data: nodes } = await admin
        .from('graph_nodes')
        .select('id, user_id, name, entity_type, is_provisional, embedding')
        .in('id', Array.from(touchedNodeIds))
      for (const node of (nodes ?? []) as NodeSummary[]) {
        try {
          const stats = await inferEdgesForNode(admin, node)
          result.edges += stats.edges_written
          result.surfaced_edges += stats.surfaced
        } catch (err) {
          result.errors += 1
          console.warn('[brain-pipeline] inference failed:', err)
        }
      }
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

  const admin = createAdminClient()

  let userIds: string[]
  try {
    userIds = body.user_id ? [body.user_id] : await pendingUserIds(admin)
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500)
  }

  const results: UserResult[] = []
  let totalRecords = 0
  let totalEntities = 0
  let totalEdges = 0
  let totalSurfaced = 0
  let totalErrors = 0

  for (const uid of userIds) {
    try {
      const r = await runForUser(admin, uid)
      results.push(r)
      totalRecords += r.records_processed
      totalEntities += r.entities
      totalEdges += r.edges
      totalSurfaced += r.surfaced_edges
      totalErrors += r.errors
    } catch (err) {
      totalErrors += 1
      console.warn(`[brain-pipeline] user ${uid} failed:`, err)
      results.push({
        user_id: uid,
        records_processed: 0,
        entities: 0,
        edges: 0,
        surfaced_edges: 0,
        errors: 1,
      })
    }
  }

  return jsonResponse({
    ok: true,
    users_processed: userIds.length,
    records_processed: totalRecords,
    entities: totalEntities,
    edges: totalEdges,
    surfaced_edges: totalSurfaced,
    errors: totalErrors,
    results,
  })
})
