// calendar-ingest — Google Calendar sync entrypoint.
//
// Invocation modes (same shape as canvas-ingest):
//   - Cron / batch: POST with no body → iterate every user with a Google
//     calendar_connections row.
//   - Single-user: POST { user_id: "..." } → sync just that user (used at
//     onboarding for first-ingest and by calendar-oauth after connect).
//
// Auth: verify_jwt = false. Requires header `x-cron-secret` matching
// CRON_SECRET env var. Fail-closed unless SUPABASE_ENV=dev.
//
// Reference: External Sources/google-calendar.md, CLAUDE.md §5 Phase 4.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  GoogleApiError,
  reclassifyPending,
  syncUserCalendars,
  type UserSyncSummary,
} from '../_shared/google-calendar-ingest.ts'
import { kickBrainPipeline } from '../_shared/brain-kick.ts'

interface IngestBody {
  user_id?: string
}

interface UserResult extends Partial<UserSyncSummary> {
  user_id: string
  error?: string
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

  let body: IngestBody = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text) as IngestBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const admin = createAdminClient()

  const query = admin.from('calendar_connections').select('user_id').eq('provider', 'google')
  const { data: rows, error } = body.user_id ? await query.eq('user_id', body.user_id) : await query
  if (error) return jsonResponse({ error: `Failed to load connections: ${error.message}` }, 500)

  const results: UserResult[] = []
  for (const row of rows ?? []) {
    try {
      const summary = await syncUserCalendars(admin, row.user_id, {})
      results.push({ user_id: row.user_id, ...summary })
      kickBrainPipeline(row.user_id).catch(err => console.warn('[calendar-ingest] brain kick failed:', err))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof GoogleApiError && err.status === 401) {
        // Google token unrecoverable — user must reconnect. The scopes column
        // stays as-is; the connection is retained so the user can see they
        // need to reconnect in the Settings UI.
        results.push({ user_id: row.user_id, error: 'google_auth_failed' })
      } else {
        results.push({ user_id: row.user_id, error: message })
      }
      console.warn(`[calendar-ingest] user ${row.user_id} failed:`, message)
    }
  }

  // Weekly drain of any pending classifications (idempotent — reclassifies
  // event by event, capped by limit).
  let reclassified = 0
  try {
    reclassified = await reclassifyPending(admin, 100)
  } catch (err) {
    console.warn('[calendar-ingest] reclassifyPending failed:', err)
  }

  return jsonResponse({ ok: true, processed: results.length, reclassified, results })
})
