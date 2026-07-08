import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  runScheduler,
  parseHour,
  parsePeakHourMap,
  type SchedulerProfile,
  type SchedulerTask,
  type BusyInterval,
} from '../_shared/scheduler.ts'
import {
  fetchGoogleBusyIntervals,
  refreshGoogleAccessToken,
  deleteGoogleCalendarEvent,
  listRumboCalendarEventIds,
} from '../_shared/google-calendar.ts'
import { invokeCalendarSync } from '../_shared/calendar-sync-client.ts'

const TAG = '[schedule-generator]'

// ─── Auth helpers ─────────────────────────────────────────────────────────

function isServiceCall(req: Request): boolean {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  return !!serviceKey && req.headers.get('Authorization') === `Bearer ${serviceKey}`
}

function isCronSecret(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET')
  return !!secret && req.headers.get('x-cron-secret') === secret
}

// ─── Google Calendar busy loader ──────────────────────────────────────────

async function loadCalendarBusy(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  const { data: conn, error: connError } = await admin
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()

  if (connError) {
    console.error(TAG, 'calendar_connections query failed', { userId, error: connError.message })
    return []
  }

  if (!conn) {
    console.log(TAG, 'no Google Calendar connected for user', { userId })
    return []
  }

  let token = conn.access_token
  if (new Date(conn.expires_at).getTime() <= Date.now() + 60_000) {
    console.log(TAG, 'token expired, refreshing', { userId, expires_at: conn.expires_at })
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
      console.log(TAG, 'token refreshed successfully', { userId })
    } catch (e) {
      console.error(TAG, 'token refresh failed', { userId, error: e instanceof Error ? e.message : String(e) })
      return []
    }
  }

  try {
    const intervals = await fetchGoogleBusyIntervals(token, timeMin, timeMax)
    console.log(TAG, 'calendar busy intervals loaded', { userId, count: intervals.length })
    return intervals.map(i => ({ start: i.start, end: i.end }))
  } catch (e) {
    console.error(TAG, 'fetchGoogleBusyIntervals failed', { userId, error: e instanceof Error ? e.message : String(e) })
    return []
  }
}

// Returns the user's valid Google access token, refreshing if needed.
async function getValidGoogleTokenForUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<{ token: string | null }> {
  const { data: conn, error } = await admin
    .from('calendar_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()

  if (error || !conn) return { token: null }

  if (new Date(conn.expires_at).getTime() > Date.now() + 60_000) {
    return { token: conn.access_token }
  }

  if (!conn.refresh_token) return { token: null }

  try {
    const refreshed = await refreshGoogleAccessToken(conn.refresh_token)
    await admin
      .from('calendar_connections')
      .update({
        access_token: refreshed.access_token,
        expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      })
      .eq('id', conn.id)
    return { token: refreshed.access_token }
  } catch {
    return { token: null }
  }
}

// ─── DB adapters ──────────────────────────────────────────────────────────

function toSchedulerProfile(p: Record<string, unknown>): SchedulerProfile {
  const rawMap = (p.peak_hour_map ?? {}) as Record<string, number>

  const parseBoundary = (v: unknown): number => {
    if (typeof v === 'number') return v
    if (typeof v === 'string') return parseHour(v)
    return -1  // sentinel: means value was missing/null
  }

  let before = parseBoundary(p.unavailable_before)
  let after  = parseBoundary(p.unavailable_after)

  // Fall back to sane defaults if values are missing, zero, or inverted
  if (before < 0 || before === 0 && after === 0) before = 8
  if (after  < 0 || after <= before)             after  = 22

  // Build a flat [0..1] map when peak_hour_map is empty or all zeros
  let peakMap: Array<{ hour: number; score: number }> = Array.isArray(rawMap)
    ? (rawMap as Array<{ hour: number; score: number }>)
    : parsePeakHourMap(rawMap)

  const allZero = peakMap.every(h => h.score === 0)
  if (!peakMap.length || allZero) {
    peakMap = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      score: h >= before && h < after ? 0.5 : 0,
    }))
  }

  const blockCeiling = (p.block_ceiling_mins as number) || 60
  const targetBlock  = (p.target_block_mins  as number) || 45

  return {
    unavailable_before:    before,
    unavailable_after:     after,
    peak_hour_map:         peakMap,
    block_ceiling_mins:    blockCeiling,
    target_block_mins:     Math.min(targetBlock, blockCeiling),
    urgency_threshold:     (p.urgency_threshold as number)     || 2.0,
    distribution_preference: (p.distribution_preference as SchedulerProfile['distribution_preference']) ?? 'even',
    profile_stage:         (p.profile_stage as 1 | 2 | 3)     ?? 1,
    shallow_before_deep:   (p.shallow_before_deep as boolean)  ?? true,
  }
}

function toSchedulerTask(t: Record<string, unknown>): SchedulerTask {
  const estimatedMins = (t.estimated_mins as number) ?? 60
  const storedConfidence = (t.classifier_confidence as number | null) ?? null
  const userOverrode = (t.user_overrode_classifier as boolean) ?? false

  // User explicitly chose the work type → no classification uncertainty → full confidence.
  // Stored confidence of 0 means no keyword signal, not a bad classification → floor at 0.5.
  let confidence: number
  if (userOverrode) {
    confidence = 1.0
  } else if (storedConfidence === null || storedConfidence === 0) {
    confidence = 0.5
  } else {
    confidence = storedConfidence
  }

  return {
    id: t.id as string,
    work_type: ((t.work_type as string) ?? 'deep') as 'deep' | 'shallow',
    estimated_mins: estimatedMins,
    estimated_mins_remaining: (t.estimated_mins_remaining as number) ?? estimatedMins,
    due_at: new Date((t.due_at ?? t.due_date) as string),
    created_at: new Date(t.created_at as string),
    classifier_confidence: confidence,
    cognitive_demand_override: (t.cognitive_demand_override as number | null) ?? null,
  }
}

// ─── Core scheduling logic ────────────────────────────────────────────────

async function scheduleForUser(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  taskId: string | undefined,
  timezone: string,
): Promise<{ blocks_created: number; warnings: string[] }> {
  console.log(TAG, 'scheduleForUser start', { userId, taskId, timezone })

  const now = new Date()
  const horizon = new Date(now)
  horizon.setDate(horizon.getDate() + 7)

  // ── 1. Load learning profile ────────────────────────────────────────────
  const { data: profileRow, error: profileError } = await admin
    .from('learning_profile')
    .select('*')
    .eq('user_id', userId)
    .single()

  if (profileError) {
    console.error(TAG, 'learning_profile query failed', { userId, code: profileError.code, message: profileError.message })
    throw new Error(`Learning profile query failed: ${profileError.message}`)
  }
  if (!profileRow) {
    console.error(TAG, 'learning_profile not found — user must complete onboarding', { userId })
    throw new Error('Learning profile not found')
  }

  // Log raw DB values before any conversion so we can catch bad stored data
  const raw = profileRow as Record<string, unknown>
  console.log(TAG, 'profile raw DB values', {
    userId,
    unavailable_before: raw.unavailable_before,
    unavailable_after: raw.unavailable_after,
    unavailable_before_type: typeof raw.unavailable_before,
    unavailable_after_type: typeof raw.unavailable_after,
    peak_hour_map_type: Array.isArray(raw.peak_hour_map) ? 'array' : typeof raw.peak_hour_map,
    peak_hour_map_length: Array.isArray(raw.peak_hour_map) ? (raw.peak_hour_map as unknown[]).length : 'n/a',
    block_ceiling_mins: raw.block_ceiling_mins,
    target_block_mins: raw.target_block_mins,
    profile_stage: raw.profile_stage,
  })

  const profile = toSchedulerProfile(raw)
  console.log(TAG, 'profile parsed', {
    userId,
    unavailable_before: profile.unavailable_before,
    unavailable_after: profile.unavailable_after,
    window_valid: profile.unavailable_before < profile.unavailable_after,
    window_hours: profile.unavailable_after - profile.unavailable_before,
    target_block_mins: profile.target_block_mins,
    block_ceiling_mins: profile.block_ceiling_mins,
    profile_stage: profile.profile_stage,
  })

  // ── 2. Load tasks ────────────────────────────────────────────────────────
  let taskQuery = admin
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .gt('due_date', now.toISOString())
    .neq('status', 'completed')

  if (taskId) taskQuery = taskQuery.eq('id', taskId)

  const { data: taskRows, error: tasksError } = await taskQuery
  if (tasksError) {
    console.error(TAG, 'tasks query failed', { userId, taskId, code: tasksError.code, message: tasksError.message })
    throw tasksError
  }

  console.log(TAG, 'tasks loaded', { userId, taskId, count: taskRows?.length ?? 0 })

  if (!taskRows?.length) {
    console.warn(TAG, 'no eligible tasks found — check due_date is in the future and status != completed', { userId, taskId, now: now.toISOString() })
    return { blocks_created: 0, warnings: [] }
  }

  // Log raw task values before conversion
  for (const t of taskRows) {
    const raw = t as Record<string, unknown>
    console.log(TAG, 'task raw DB values', {
      id: raw.id,
      due_date: raw.due_date,
      due_at: raw.due_at,
      estimated_mins: raw.estimated_mins,
      estimated_mins_remaining: raw.estimated_mins_remaining,
      work_type: raw.work_type,
      status: raw.status,
      classifier_confidence: raw.classifier_confidence,
    })
  }

  const tasks = taskRows.map(t => toSchedulerTask(t as Record<string, unknown>))

  // Log parsed task values
  for (const t of tasks) {
    console.log(TAG, 'task parsed', {
      id: t.id,
      due_at: t.due_at.toISOString(),
      due_at_is_past: t.due_at.getTime() < now.getTime(),
      days_until_due: ((t.due_at.getTime() - now.getTime()) / 86_400_000).toFixed(2),
      estimated_mins_remaining: t.estimated_mins_remaining,
      work_type: t.work_type,
    })
  }
  const taskIds = tasks.map(t => t.id)

  // ── 3. Delete stale unfinished blocks (and their calendar events) ──────────
  // Fetch first so we can clean up Google Calendar before the DB rows are gone.
  let staleQuery = admin
    .from('work_blocks')
    .select('id, calendar_event_id')
    .eq('user_id', userId)
    .neq('status', 'completed')
    .not('calendar_event_id', 'is', null)

  const { data: staleBlocks } = await (taskId
    ? staleQuery.eq('task_id', taskId)
    : staleQuery.in('task_id', taskIds))

  const staleEventIds = (staleBlocks ?? [])
    .map((b: { id: string; calendar_event_id: string | null }) => b.calendar_event_id as string)
    .filter(Boolean)

  if (staleEventIds.length > 0) {
    const { token: calToken } = await getValidGoogleTokenForUser(admin, userId)
    if (calToken) {
      let calDeleted = 0
      for (const eventId of staleEventIds) {
        try {
          await deleteGoogleCalendarEvent(calToken, eventId)
          calDeleted++
        } catch (e) {
          console.warn(TAG, 'stale calendar event delete failed (ignored)', {
            userId, eventId, error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      console.log(TAG, 'stale calendar events removed', { userId, calDeleted, total: staleEventIds.length })
    } else {
      console.log(TAG, 'no valid token — stale calendar events left on calendar', { userId, count: staleEventIds.length })
    }
  }

  const deleteQuery = admin
    .from('work_blocks')
    .delete()
    .eq('user_id', userId)
    .neq('status', 'completed')

  const { error: deleteError } = await (taskId
    ? deleteQuery.eq('task_id', taskId)
    : deleteQuery.in('task_id', taskIds))

  if (deleteError) {
    console.error(TAG, 'delete stale blocks failed', { userId, taskId, code: deleteError.code, message: deleteError.message })
    throw deleteError
  }
  console.log(TAG, 'stale blocks deleted', { userId, taskId })

  // ── 4. Load completed blocks as busy intervals ───────────────────────────
  const { data: completedRows, error: completedError } = await admin
    .from('work_blocks')
    .select('starts_at, ends_at')
    .eq('user_id', userId)
    .eq('status', 'completed')

  if (completedError) {
    console.error(TAG, 'completed blocks query failed', { userId, message: completedError.message })
  }

  const completedBusy: BusyInterval[] = (completedRows ?? []).map(b => ({
    start: new Date(b.starts_at),
    end: new Date(b.ends_at),
  }))
  console.log(TAG, 'completed busy intervals', { userId, count: completedBusy.length })

  // ── 5. Load calendar busy intervals ─────────────────────────────────────
  const calendarBusy = await loadCalendarBusy(admin, userId, now, horizon)

  // ── 6. Run scheduler ─────────────────────────────────────────────────────
  console.log(TAG, 'scheduler input', {
    userId,
    now: now.toISOString(),
    horizon: horizon.toISOString(),
    profile: {
      unavailable_before: profile.unavailable_before,
      unavailable_after: profile.unavailable_after,
      target_block_mins: profile.target_block_mins,
      block_ceiling_mins: profile.block_ceiling_mins,
      profile_stage: profile.profile_stage,
      distribution_preference: profile.distribution_preference,
      shallow_before_deep: profile.shallow_before_deep,
      urgency_threshold: profile.urgency_threshold,
    },
    tasks: tasks.map(t => ({
      id: t.id,
      work_type: t.work_type,
      due_at: t.due_at.toISOString(),
      due_at_is_past: t.due_at.getTime() < now.getTime(),
      estimated_mins_remaining: t.estimated_mins_remaining,
      days_until_due: ((t.due_at.getTime() - now.getTime()) / 86_400_000).toFixed(2),
    })),
    existing_busy_count: completedBusy.length + calendarBusy.length,
  })

  const { blocks, warnings } = runScheduler({
    user_id: userId,
    profile,
    tasks,
    existing_busy: [...completedBusy, ...calendarBusy],
    horizon_days: 7,
    now,
  })

  console.log(TAG, 'scheduler output', {
    userId,
    blocks_produced: blocks.length,
    warnings: warnings.map(w => `${w.type}:${w.task_id} — ${w.message}`),
  })

  if (!blocks.length) {
    console.warn(TAG, 'scheduler produced 0 blocks', { userId, warnings })
    return { blocks_created: 0, warnings: warnings.map(w => w.message) }
  }

  // ── 7. Insert work blocks ────────────────────────────────────────────────
  const rows = blocks.map(b => ({
    task_id: b.task_id,
    user_id: b.user_id,
    starts_at: b.starts_at,
    ends_at: b.ends_at,
    duration_mins: b.duration_mins,
    slot_score: b.slot_score,
    placement_score: b.placement_score,
    scheduled_by: b.scheduled_by,
    status: b.status,
    confidence_adjusted: b.confidence_adjusted,
    deadline_proximity: b.deadline_proximity,
  }))

  console.log(TAG, 'inserting work blocks', { userId, count: rows.length, first_block: rows[0] })

  const { error: insertError } = await admin.from('work_blocks').insert(rows)
  if (insertError) {
    console.error(TAG, 'work_blocks insert failed', {
      userId,
      code: insertError.code,
      message: insertError.message,
      details: insertError.details,
      hint: insertError.hint,
      sample_row: rows[0],
    })
    throw insertError
  }

  console.log(TAG, 'work blocks inserted successfully', { userId, count: rows.length })

  // ── 8. Purge orphaned Rumbo calendar events ──────────────────────────────
  // List every [Rumbo] event from now forward, compare against current work_blocks,
  // and delete any event that no longer has a matching DB row.
  await purgeOrphanedCalendarEvents(admin, userId, now)

  return { blocks_created: rows.length, warnings: warnings.map(w => w.message) }
}

async function purgeOrphanedCalendarEvents(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  now: Date,
): Promise<void> {
  const { token } = await getValidGoogleTokenForUser(admin, userId)
  if (!token) {
    console.log(TAG, 'purgeOrphans: no valid token, skipping', { userId })
    return
  }

  // Fetch all [Rumbo] event IDs from the calendar
  let calEventIds: string[]
  try {
    calEventIds = await listRumboCalendarEventIds(token, now)
    console.log(TAG, 'purgeOrphans: calendar events found', { userId, count: calEventIds.length })
  } catch (e) {
    console.warn(TAG, 'purgeOrphans: listRumboCalendarEventIds failed', {
      userId, error: e instanceof Error ? e.message : String(e),
    })
    return
  }

  if (!calEventIds.length) return

  // Fetch all calendar_event_ids currently stored in work_blocks for this user
  const { data: liveBlocks } = await admin
    .from('work_blocks')
    .select('calendar_event_id')
    .eq('user_id', userId)
    .not('calendar_event_id', 'is', null)

  const liveIds = new Set((liveBlocks ?? []).map((b: { calendar_event_id: string | null }) => b.calendar_event_id))

  // Delete any calendar event not backed by a current work block
  const orphans = calEventIds.filter(id => !liveIds.has(id))
  console.log(TAG, 'purgeOrphans: orphaned events to delete', { userId, count: orphans.length })

  let purged = 0
  for (const eventId of orphans) {
    try {
      await deleteGoogleCalendarEvent(token, eventId)
      purged++
    } catch (e) {
      console.warn(TAG, 'purgeOrphans: delete failed (ignored)', {
        userId, eventId, error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  console.log(TAG, 'purgeOrphans: done', { userId, purged, total: orphans.length })
}

// ─── Request handler ──────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const timezone = (body.timezone as string | undefined) ?? 'UTC'
    const admin = createAdminClient()

    const authHeader = req.headers.get('Authorization') ?? ''
    const isService = isServiceCall(req)
    const isCron = isCronSecret(req)

    console.log(TAG, 'request received', {
      method: req.method,
      isService,
      isCron,
      hasAuth: !!authHeader,
      body_keys: Object.keys(body),
      timezone,
    })

    // ── Path 1: DB trigger or internal service call ────────────────────────
    if (isService && body.user_id) {
      const userId = body.user_id as string
      const taskId = body.task_id as string | undefined
      console.log(TAG, 'path: service call', { userId, taskId, mode: body.mode })

      if (body.mode === 'nightly') {
        const { data: users } = await admin.from('users').select('id').eq('onboarding_completed', true)
        console.log(TAG, 'nightly: users to schedule', { count: users?.length ?? 0 })

        let total = 0
        for (const user of users ?? []) {
          try {
            const result = await scheduleForUser(admin, user.id, undefined, timezone)
            total += result.blocks_created
            await invokeCalendarSync(user.id, timezone)
          } catch (e) {
            console.error(TAG, 'nightly: user failed', { userId: user.id, error: e instanceof Error ? e.message : String(e) })
          }
        }
        return jsonResponse({ ok: true, users: users?.length ?? 0, blocks_created: total })
      }

      const result = await scheduleForUser(admin, userId, taskId, timezone)
      const calendarSync = await invokeCalendarSync(userId, timezone)
      console.log(TAG, 'service call complete', { userId, ...result, calendar_sync: calendarSync })
      return jsonResponse({ ok: true, ...result, calendar_sync: calendarSync })
    }

    // ── Path 2: Nightly cron ──────────────────────────────────────────────
    if (isCron || body.mode === 'nightly') {
      console.log(TAG, 'path: cron/nightly')
      const { data: users } = await admin.from('users').select('id').eq('onboarding_completed', true)
      console.log(TAG, 'nightly: users to schedule', { count: users?.length ?? 0 })

      let total = 0
      for (const user of users ?? []) {
        try {
          const result = await scheduleForUser(admin, user.id, undefined, timezone)
          total += result.blocks_created
          await invokeCalendarSync(user.id, timezone)
        } catch (e) {
          console.error(TAG, 'nightly: user failed', { userId: user.id, error: e instanceof Error ? e.message : String(e) })
        }
      }
      return jsonResponse({ ok: true, users: users?.length ?? 0, blocks_created: total })
    }

    // ── Path 3: User-initiated (JWT auth) ─────────────────────────────────
    console.log(TAG, 'path: JWT auth')
    if (!authHeader) {
      console.error(TAG, 'missing Authorization header')
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      console.error(TAG, 'JWT auth failed', { error: authError?.message })
      return jsonResponse({ error: 'Unauthorized' }, 401)
    }
    console.log(TAG, 'JWT auth OK', { userId: user.id })

    if (body.sync_only) {
      console.log(TAG, 'sync_only mode', { userId: user.id })
      const calendarSync = await invokeCalendarSync(user.id, timezone)
      return jsonResponse({ ok: true, sync_only: true, calendar_sync: calendarSync })
    }

    const result = await scheduleForUser(
      admin,
      (body.user_id as string | undefined) ?? user.id,
      body.task_id as string | undefined,
      timezone,
    )
    const calendarSync = await invokeCalendarSync(user.id, timezone)
    console.log(TAG, 'JWT call complete', { userId: user.id, ...result, calendar_sync: calendarSync })
    return jsonResponse({ ok: true, ...result, calendar_sync: calendarSync })

  } catch (e) {
    console.error(TAG, 'unhandled error', {
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    })
    return jsonResponse({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
