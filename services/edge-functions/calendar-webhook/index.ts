// calendar-webhook — receives Google Calendar push notifications.
//
// Google delivers headers X-Goog-Channel-ID, X-Goog-Channel-Token,
// X-Goog-Resource-ID, X-Goog-Resource-State. Auth is STATELESS: the token
// registered at watch time is HMAC-SHA256(`${user_id}:${calendar_id}`, CRON_SECRET).
// We reconstruct it after looking up which (user, calendar) the channel maps to
// and reject on mismatch.
//
// Always return 200 on internal errors after logging — Google backs off channels
// that error persistently, so ephemeral sync failures should not tear down our
// push subscription.
//
// Reference: External Sources/google-calendar.md §3.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  channelToken,
  getFreshAccessToken,
  GoogleApiError,
  syncCalendar,
} from '../_shared/google-calendar-ingest.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const channelId = req.headers.get('X-Goog-Channel-ID') ?? req.headers.get('x-goog-channel-id')
  const suppliedToken = req.headers.get('X-Goog-Channel-Token') ?? req.headers.get('x-goog-channel-token')
  const resourceState = req.headers.get('X-Goog-Resource-State') ?? req.headers.get('x-goog-resource-state')

  // Initial "sync" ping fires immediately after channel creation with no payload.
  if (resourceState === 'sync') return new Response('ok', { status: 200 })

  if (!channelId) return new Response('ok', { status: 200 })

  const admin = createAdminClient()
  const { data: state, error } = await admin
    .from('calendar_sync_state')
    .select('user_id, calendar_id')
    .eq('channel_id', channelId)
    .maybeSingle()
  if (error) {
    console.warn('[calendar-webhook] state lookup failed:', error.message)
    return new Response('ok', { status: 200 })
  }
  if (!state) {
    // Stale channel — Google is delivering to a channel we no longer track.
    // Returning 200 lets Google keep pushing until channel expiry; we could
    // proactively stopChannel, but we don't have an access token here to do so.
    return new Response('ok', { status: 200 })
  }

  const expectedToken = await channelToken(state.user_id, state.calendar_id)
  if (!suppliedToken || suppliedToken !== expectedToken) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  try {
    const accessToken = await getFreshAccessToken(admin, state.user_id)
    await syncCalendar(admin, state.user_id, state.calendar_id, accessToken)
  } catch (err) {
    const status = err instanceof GoogleApiError ? err.status : 0
    console.warn(`[calendar-webhook] sync failed (${status}) for ${state.user_id}/${state.calendar_id}:`, err instanceof Error ? err.message : err)
  }
  return new Response('ok', { status: 200 })
})
