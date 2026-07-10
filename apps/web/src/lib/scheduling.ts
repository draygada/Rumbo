import { supabase } from './supabase'

export function getUserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

export async function runScheduleGenerator(taskId?: string): Promise<void> {
  const timezone = getUserTimezone()
  const body = { task_id: taskId, timezone }

  console.log('[scheduling.runScheduleGenerator] Invoking schedule-generator', body)

  const { data, error } = await supabase.functions.invoke('schedule-generator', { body })

  if (error) {
    console.error('[scheduling.runScheduleGenerator] Edge function failed', {
      taskId,
      timezone,
      message: error.message,
      name: error.name,
      context: (error as { context?: unknown }).context,
      fullError: error,
    })
    throw error
  }

  console.log('[scheduling.runScheduleGenerator] Success', { taskId, data })

  const sync = (data as { calendar_sync?: { synced?: number; message?: string; errors?: string[] } })
    ?.calendar_sync
  if (sync?.errors?.length) {
    console.warn('[scheduling.runScheduleGenerator] Calendar sync had errors', sync.errors)
  }
  if (sync?.synced === 0 && sync?.message) {
    console.warn('[scheduling.runScheduleGenerator] Calendar sync:', sync.message)
  }
}

export async function runCalendarSync(): Promise<{ synced?: number; message?: string; errors?: string[] }> {
  const timezone = getUserTimezone()
  console.log('[scheduling.runCalendarSync] Invoking sync_only')

  const { data, error } = await supabase.functions.invoke('schedule-generator', {
    body: { sync_only: true, timezone },
  })

  if (error) {
    console.error('[scheduling.runCalendarSync] Failed', error)
    throw error
  }

  const raw = (data as { calendar_sync?: Record<string, unknown> })?.calendar_sync ?? {}
  console.log('[scheduling.runCalendarSync] Result', raw)

  // Surface singular `error` field as `errors` array so callers handle it uniformly
  if (raw.error && !raw.errors) {
    raw.errors = [raw.error as string]
  }
  if (raw.ok === false && !raw.errors) {
    raw.errors = ['Calendar sync failed — check edge function logs']
  }

  return raw as { synced?: number; message?: string; errors?: string[] }
}
