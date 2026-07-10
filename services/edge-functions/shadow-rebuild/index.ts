// shadow-rebuild — operator-triggered per-user shadow rebuild orchestrator.
// Reference: Rumbo-Design-Docs/Graph Pipeline/pipeline-versioning.md §5, §6.
//
// Modes (POST body):
//   { user_id, target_version, mode: "diff" }   → return diff report (no commit)
//   { user_id, target_version, mode: "commit" } → atomic swap of shadow → live
//
// V0 does not include the shadow-write step itself — that's the responsibility
// of the brain-pipeline running against `*_shadow` tables when a rebuild is
// requested (a mode passed to that function). This endpoint is only the
// canary + swap surface.
//
// Auth: fail-closed x-cron-secret. Operator supplies the secret manually.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { commitShadowSwap, diffRebuild } from '../_shared/shadow-rebuild.ts'

interface Body {
  user_id?: string
  target_version?: string
  mode?: 'diff' | 'commit'
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: Body = {}
  try { body = await req.json() as Body } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const { user_id, target_version, mode } = body
  if (!user_id || !target_version || !mode) {
    return jsonResponse({ error: 'user_id, target_version, mode required' }, 400)
  }

  const admin = createAdminClient()
  try {
    if (mode === 'diff') {
      const diff = await diffRebuild(admin, user_id, target_version)
      return jsonResponse({ ok: true, diff })
    }
    await commitShadowSwap(admin, user_id, target_version)
    return jsonResponse({ ok: true, committed: true, user_id, target_version })
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Rebuild failed' }, 500)
  }
})
