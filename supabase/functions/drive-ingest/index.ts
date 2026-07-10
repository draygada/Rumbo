// drive-ingest — every 6h metadata sync for connected Google Drives.
// Auth: fail-closed x-cron-secret (same pattern as canvas-ingest / calendar-ingest).
// Reference: External Sources/google-drive.md §3.1, CLAUDE.md §5 Phase 5.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { GoogleApiError, syncUserDrive } from '../_shared/drive-ingest.ts'
import { kickBrainPipeline } from '../_shared/brain-kick.ts'

interface IngestBody {
  user_id?: string
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

  const results: Array<Record<string, unknown>> = []
  for (const row of rows ?? []) {
    try {
      const stats = await syncUserDrive(admin, row.user_id)
      results.push({ user_id: row.user_id, ...stats })
      kickBrainPipeline(row.user_id).catch(err => console.warn('[drive-ingest] brain kick failed:', err))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = err instanceof GoogleApiError && err.status === 401 ? 'google_auth_failed' : message
      results.push({ user_id: row.user_id, error: code })
      console.warn(`[drive-ingest] user ${row.user_id} failed:`, message)
    }
  }

  return jsonResponse({ ok: true, processed: results.length, results })
})
