// brain-decay — daily edge weight recompute + is_surfaced flip tracking.
//
// Reference: Rumbo-Design-Docs/Graph Pipeline/edge-weighting.md §5.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { computeAndPersistEdgeWeight, DEFAULT_HALF_LIFE_DAYS, SURFACING_THRESHOLD } from '../_shared/brain-weighting.ts'

const BATCH_LIMIT = 2000

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  const admin = createAdminClient()

  // Fetch edges that are either currently surfaced or above the maintenance
  // floor (0.3) — everything below that is unlikely to flip on a daily recompute.
  const { data: edges, error } = await admin
    .from('graph_edges')
    .select('id, is_surfaced, weight')
    .or(`is_surfaced.eq.true,weight.gt.0.3`)
    .limit(BATCH_LIMIT)
  if (error) return jsonResponse({ error: `load failed: ${error.message}` }, 500)

  let recomputed = 0
  let flipsToSurfaced = 0
  let flipsToUnsurfaced = 0
  let errors = 0

  for (const edge of edges ?? []) {
    const wasSurfaced = edge.is_surfaced as boolean
    try {
      const summary = await computeAndPersistEdgeWeight(admin, edge.id as string, DEFAULT_HALF_LIFE_DAYS)
      recomputed += 1
      if (!summary) continue
      if (summary.is_surfaced && !wasSurfaced) {
        flipsToSurfaced += 1
        console.info(`[brain-decay] surfaced ${edge.id} weight=${summary.weight.toFixed(3)}`)
      } else if (!summary.is_surfaced && wasSurfaced) {
        flipsToUnsurfaced += 1
        console.info(`[brain-decay] unsurfaced ${edge.id} weight=${summary.weight.toFixed(3)}`)
      }
    } catch (err) {
      errors += 1
      console.warn(`[brain-decay] edge ${edge.id} failed:`, err)
    }
  }

  return jsonResponse({
    ok: true,
    recomputed,
    flips_to_surfaced: flipsToSurfaced,
    flips_to_unsurfaced: flipsToUnsurfaced,
    surfacing_threshold: SURFACING_THRESHOLD,
    errors,
  })
})
