import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { deleteGoogleCalendarEvent, refreshGoogleAccessToken } from '../_shared/google-calendar.ts'

const TAG = '[delete-task]'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      console.error(TAG, 'auth failed', { error: authError?.message })
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const taskId = body.task_id as string | undefined
    if (!taskId) {
      return jsonResponse({ error: 'task_id required' }, 400)
    }

    console.log(TAG, 'delete request', { userId: user.id, taskId })

    const admin = createAdminClient()

    // ── Verify task belongs to this user ──────────────────────────────────
    const { data: task, error: taskError } = await admin
      .from('tasks')
      .select('id')
      .eq('id', taskId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (taskError) {
      console.error(TAG, 'task lookup failed', { taskId, error: taskError.message })
      throw taskError
    }
    if (!task) {
      return jsonResponse({ error: 'Task not found' }, 404)
    }

    // ── Collect calendar event IDs before cascade deletes them ────────────
    const { data: blocks, error: blocksError } = await admin
      .from('work_blocks')
      .select('id, calendar_event_id')
      .eq('task_id', taskId)
      .eq('user_id', user.id)
      .not('calendar_event_id', 'is', null)

    if (blocksError) {
      console.error(TAG, 'work_blocks query failed', { taskId, error: blocksError.message })
      throw blocksError
    }

    const eventIds = (blocks ?? [])
      .map(b => b.calendar_event_id as string)
      .filter(Boolean)

    console.log(TAG, 'calendar events to delete', { taskId, count: eventIds.length })

    // ── Delete Google Calendar events if any ──────────────────────────────
    if (eventIds.length > 0) {
      const { data: conn, error: connError } = await admin
        .from('calendar_connections')
        .select('*')
        .eq('user_id', user.id)
        .eq('provider', 'google')
        .maybeSingle()

      if (connError) {
        console.error(TAG, 'calendar_connections query failed', { error: connError.message })
      }

      if (conn) {
        let token = conn.access_token

        if (new Date(conn.expires_at).getTime() <= Date.now() + 60_000) {
          try {
            const refreshed = await refreshGoogleAccessToken(conn.refresh_token)
            token = refreshed.access_token
            await admin
              .from('calendar_connections')
              .update({
                access_token: token,
                expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
              })
              .eq('id', conn.id)
            console.log(TAG, 'token refreshed', { userId: user.id })
          } catch (e) {
            console.error(TAG, 'token refresh failed — calendar events will not be deleted', {
              error: e instanceof Error ? e.message : String(e),
            })
            token = ''
          }
        }

        if (token) {
          let deleted = 0
          const calendarErrors: string[] = []
          for (const eventId of eventIds) {
            try {
              await deleteGoogleCalendarEvent(token, eventId)
              deleted++
              console.log(TAG, 'calendar event deleted', { eventId })
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              console.error(TAG, 'calendar event delete failed', { eventId, error: msg })
              calendarErrors.push(`${eventId}: ${msg}`)
            }
          }
          console.log(TAG, 'calendar cleanup done', { deleted, failed: calendarErrors.length })
        }
      } else {
        console.log(TAG, 'no calendar connection found — skipping calendar cleanup', { userId: user.id })
      }
    }

    // ── Delete the task (cascade removes work_blocks) ─────────────────────
    const { error: deleteError } = await admin
      .from('tasks')
      .delete()
      .eq('id', taskId)
      .eq('user_id', user.id)

    if (deleteError) {
      console.error(TAG, 'task delete failed', { taskId, error: deleteError.message })
      throw deleteError
    }

    console.log(TAG, 'task deleted successfully', { taskId, calendarEventsRemoved: eventIds.length })
    return jsonResponse({ ok: true, task_id: taskId, calendar_events_removed: eventIds.length })

  } catch (e) {
    console.error(TAG, 'unhandled error', {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    return jsonResponse({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
