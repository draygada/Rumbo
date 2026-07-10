// drive-content-extract — dequeues drive_content_queue and writes a
// `drive_content` normalized record per successfully extracted file.
// Called on cron (short cadence) and by the graph pipeline when it enqueues a file.
// Reference: External Sources/google-drive.md §3.2.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { drainContentQueue } from '../_shared/drive-ingest.ts'

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
  const summary = await drainContentQueue(admin, 20)
  return jsonResponse({ ok: true, ...summary })
})
