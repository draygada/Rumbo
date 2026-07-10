// calendar-renew — daily maintenance job for Google Calendar sync.
//
// Duties (in order):
//   1. Renew watch channels expiring within 7 days (google-calendar.md §7).
//      Stop the old channel (best-effort) then register a fresh one.
//   2. On Sundays UTC, run a forced-window sync so the rolling event window
//      (now − LOOKBACK_DAYS to now + LOOKAHEAD_MONTHS) advances even when
//      no push notifications fire.
//   3. Drain up to 200 pending classifications.
//
// Auth: fail-closed x-cron-secret, same shape as canvas-ingest.
//
// Reference: External Sources/google-calendar.md §7, CLAUDE.md §5 Phase 4.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  getFreshAccessToken,
  reclassifyPending,
  registerWatch,
  stopChannel,
  syncUserCalendars,
} from '../_shared/google-calendar-ingest.ts'

const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

interface RenewalResult {
  user_id: string
  renewed: number
  forced_sync?: { calendars: number; upserted: number; classified: number; pending: number }
  error?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  const admin = createAdminClient()
  const cutoff = new Date(Date.now() + RENEWAL_WINDOW_MS).toISOString()

  // Users who have at least one channel expiring soon, or a row with no channel yet.
  const { data: expiring, error } = await admin
    .from('calendar_sync_state')
    .select('user_id, calendar_id, channel_id, channel_resource_id, channel_expiry')
    .or(`channel_expiry.lt.${cutoff},channel_id.is.null`)
  if (error) return jsonResponse({ error: `expiring read failed: ${error.message}` }, 500)

  // Group by user so each getFreshAccessToken runs once per user.
  const byUser = new Map<string, typeof expiring>()
  for (const row of expiring ?? []) {
    const bucket = byUser.get(row.user_id) ?? []
    bucket.push(row)
    byUser.set(row.user_id, bucket)
  }

  const isSundayUTC = new Date().getUTCDay() === 0
  const results: RenewalResult[] = []

  for (const [userId, rows] of byUser) {
    const result: RenewalResult = { user_id: userId, renewed: 0 }
    try {
      const accessToken = await getFreshAccessToken(admin, userId)
      for (const row of rows) {
        if (row.channel_id && row.channel_resource_id) {
          await stopChannel(row.channel_id, row.channel_resource_id, accessToken)
        }
        const watch = await registerWatch(userId, row.calendar_id, accessToken)
        if (watch) {
          await admin
            .from('calendar_sync_state')
            .update({
              channel_id: watch.channelId,
              channel_resource_id: watch.resourceId,
              channel_expiry: watch.expiration,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
            .eq('calendar_id', row.calendar_id)
          result.renewed += 1
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      console.warn(`[calendar-renew] user ${userId} renewal failed:`, result.error)
    }
    results.push(result)
  }

  // Weekly forced-window sync for every connected Google user.
  if (isSundayUTC) {
    const { data: users } = await admin
      .from('calendar_connections')
      .select('user_id')
      .eq('provider', 'google')
    for (const row of users ?? []) {
      try {
        const summary = await syncUserCalendars(admin, row.user_id, { registerWatches: false, forceWindow: true })
        const existing = results.find(r => r.user_id === row.user_id)
        const fs = { calendars: summary.calendars, upserted: summary.upserted, classified: summary.classified, pending: summary.pending }
        if (existing) existing.forced_sync = fs
        else results.push({ user_id: row.user_id, renewed: 0, forced_sync: fs })
      } catch (err) {
        console.warn(`[calendar-renew] forced sync failed for ${row.user_id}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  let reclassified = 0
  try {
    reclassified = await reclassifyPending(admin, 200)
  } catch (err) {
    console.warn('[calendar-renew] reclassifyPending failed:', err)
  }

  return jsonResponse({ ok: true, sunday: isSundayUTC, reclassified, results })
})
