import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  createGoogleCalendarEvent,
  refreshGoogleAccessToken,
} from '../_shared/google-calendar.ts'

const TAG = '[calendar-sync]'

interface RequestBody {
  user_id: string
  timezone?: string
}

async function getValidGoogleToken(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<string | null> {
  const { data: conn, error: connError } = await admin
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()

  if (connError) {
    console.error(TAG, 'calendar_connections query failed', { userId, error: connError.message })
    return null
  }

  if (!conn) {
    console.log(TAG, 'no Google Calendar connection found', { userId })
    return null
  }

  console.log(TAG, 'connection found', { userId, expires_at: conn.expires_at })

  const expiresAt = new Date(conn.expires_at)
  if (expiresAt.getTime() > Date.now() + 60_000) {
    console.log(TAG, 'token valid, no refresh needed', { userId })
    return conn.access_token
  }

  if (!conn.refresh_token) {
    console.error(TAG, 'token expired and no refresh_token present', { userId })
    return null
  }

  console.log(TAG, 'token expired, refreshing', { userId })
  try {
    const refreshed = await refreshGoogleAccessToken(conn.refresh_token)
    const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()

    const { error: updateError } = await admin
      .from('calendar_connections')
      .update({ access_token: refreshed.access_token, expires_at: newExpiry })
      .eq('id', conn.id)

    if (updateError) {
      console.error(TAG, 'failed to save refreshed token', { userId, error: updateError.message })
    } else {
      console.log(TAG, 'token refreshed and saved', { userId, new_expiry: newExpiry })
    }

    return refreshed.access_token
  } catch (e) {
    console.error(TAG, 'token refresh threw', { userId, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const isService = authHeader === `Bearer ${serviceKey}`

    console.log(TAG, 'request received', { method: req.method, isService })

    if (!isService) {
      console.error(TAG, 'rejected: not a service call')
      return jsonResponse({ error: 'Forbidden' }, 403)
    }

    const body = (await req.json()) as RequestBody
    console.log(TAG, 'body parsed', { user_id: body.user_id, timezone: body.timezone })

    if (!body.user_id) {
      console.error(TAG, 'missing user_id in body')
      return jsonResponse({ error: 'user_id required' }, 400)
    }

    const admin = createAdminClient()
    const token = await getValidGoogleToken(admin, body.user_id)

    if (!token) {
      console.log(TAG, 'no valid token — skipping calendar sync', { userId: body.user_id })
      return jsonResponse({
        ok: true,
        synced: 0,
        message: 'No calendar connected or token refresh failed. Reconnect Google Calendar in Settings.',
      })
    }

    // ── Fetch unsynced blocks ────────────────────────────────────────────
    const { data: blocks, error: blocksError } = await admin
      .from('work_blocks')
      .select('id, task_id, starts_at, ends_at, calendar_event_id')
      .eq('user_id', body.user_id)
      .is('calendar_event_id', null)
      .neq('status', 'completed')
      .gte('starts_at', new Date().toISOString())

    if (blocksError) {
      console.error(TAG, 'work_blocks query failed', {
        userId: body.user_id,
        code: blocksError.code,
        message: blocksError.message,
      })
      throw blocksError
    }

    console.log(TAG, 'unsynced blocks found', { userId: body.user_id, count: blocks?.length ?? 0 })

    if (!blocks?.length) {
      return jsonResponse({ ok: true, synced: 0, pending: 0 })
    }

    // ── Fetch task titles ────────────────────────────────────────────────
    const taskIds = [...new Set(blocks.map(b => b.task_id))]
    const titleByTaskId = new Map<string, string>()

    const { data: tasks, error: tasksError } = await admin
      .from('tasks')
      .select('id, title')
      .in('id', taskIds)

    if (tasksError) {
      console.error(TAG, 'tasks title query failed', { error: tasksError.message })
      throw tasksError
    }
    for (const task of tasks ?? []) {
      titleByTaskId.set(task.id, task.title)
    }

    // ── Create calendar events ────────────────────────────────────────────
    const timeZone = body.timezone ?? 'UTC'
    let synced = 0
    const errors: string[] = []

    for (const block of blocks) {
      const taskTitle = titleByTaskId.get(block.task_id) ?? 'Study block'
      console.log(TAG, 'creating calendar event', {
        userId: body.user_id,
        blockId: block.id,
        taskTitle,
        starts_at: block.starts_at,
        ends_at: block.ends_at,
        timeZone,
      })

      try {
        const eventId = await createGoogleCalendarEvent(
          token,
          taskTitle,
          new Date(block.starts_at),
          new Date(block.ends_at),
          undefined,
          timeZone,
        )
        console.log(TAG, 'event created', { userId: body.user_id, blockId: block.id, eventId })

        const { error: updateError } = await admin
          .from('work_blocks')
          .update({ calendar_event_id: eventId })
          .eq('id', block.id)

        if (updateError) {
          console.error(TAG, 'failed to save calendar_event_id', { blockId: block.id, error: updateError.message })
          throw updateError
        }
        synced++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(TAG, 'block sync failed', { blockId: block.id, error: msg })
        errors.push(`block ${block.id}: ${msg}`)
      }
    }

    console.log(TAG, 'sync complete', { userId: body.user_id, synced, failed: errors.length })
    return jsonResponse({
      ok: true,
      synced,
      pending: blocks.length - synced,
      errors: errors.length ? errors : undefined,
    })

  } catch (e) {
    console.error(TAG, 'unhandled error', {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    return jsonResponse({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
