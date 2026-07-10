// Google Calendar ingestion adapter — read-path sync into normalized_events.
// Reference: Rumbo-Design-Docs/External Sources/google-calendar.md
//
// Design points (google-calendar.md):
//   §3   watch channel per calendar per user (all calendars, not just primary)
//   §3.3 syncToken incremental pulls; HTTP 410 → full windowed re-sync
//   §5   per-event Haiku classification: academic | personal | pending.
//        Asymmetric suppression: any failure or low confidence → 'pending',
//        never default-academic.
//   §6   normalization: summary + description + human-readable recurrence;
//        no attendee emails in normalized_text.
//   §7   channels expire ~30d; renewed by the daily calendar-renew job.
//
// This module is composed by calendar-ingest, calendar-webhook and
// calendar-renew. It never runs on the client.

import { refreshGoogleAccessToken } from './google-calendar.ts'
import { INGESTION_PIPELINE_VERSION } from './canvas.ts'
import { geminiClassifyJson } from './gemini.ts'

// deno-lint-ignore no-explicit-any
type AdminClient = any

export const CLASSIFY_COMMIT_THRESHOLD = 0.8 // placeholder (Cat B) — google-calendar.md §5
export const LOOKBACK_DAYS = 30
export const LOOKAHEAD_MONTHS = 6
export const MAX_CLASSIFICATIONS_PER_RUN = 300
export const CHANNEL_TTL_MS = 29 * 24 * 60 * 60 * 1000 // ask 29d; Google caps ~30d

const CAL_API = 'https://www.googleapis.com/calendar/v3'

export class GoogleApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

// -----------------------------------------------------------------------------
// Token handling
// -----------------------------------------------------------------------------

export interface CalendarConnection {
  user_id: string
  access_token: string
  refresh_token: string | null
  expires_at: string | null
  scopes: string[]
}

// Returns a valid access token for the user, refreshing (and persisting) if the
// stored one expires within 60s. Throws GoogleApiError(401) when unrecoverable.
export async function getFreshAccessToken(admin: AdminClient, userId: string): Promise<string> {
  const { data, error } = await admin
    .from('calendar_connections')
    .select('user_id, access_token, refresh_token, expires_at, scopes')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()
  if (error) throw new Error(`calendar_connections read failed: ${error.message}`)
  if (!data) throw new GoogleApiError('No Google connection for user', 401)

  const conn = data as CalendarConnection
  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0
  if (expiresAt - Date.now() > 60_000) return conn.access_token

  if (!conn.refresh_token) throw new GoogleApiError('Google token expired and no refresh token', 401)
  const refreshed = await refreshGoogleAccessToken(conn.refresh_token)
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  await admin
    .from('calendar_connections')
    .update({ access_token: refreshed.access_token, expires_at: newExpiry })
    .eq('user_id', userId)
    .eq('provider', 'google')
  return refreshed.access_token
}

// -----------------------------------------------------------------------------
// Calendar list
// -----------------------------------------------------------------------------

export interface GoogleCalendarListEntry {
  id: string
  summary?: string
  primary?: boolean
  accessRole?: string
  deleted?: boolean
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const items: GoogleCalendarListEntry[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ maxResults: '250', showDeleted: 'false' })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(`${CAL_API}/users/me/calendarList?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new GoogleApiError(`calendarList failed: ${await res.text()}`, res.status)
    const data = await res.json()
    for (const item of (data.items ?? []) as GoogleCalendarListEntry[]) {
      if (!item.deleted && item.id) items.push(item)
    }
    pageToken = data.nextPageToken
  } while (pageToken)
  return items
}

// -----------------------------------------------------------------------------
// Watch channels — stateless webhook auth via HMAC token
// -----------------------------------------------------------------------------

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Channel token proves a webhook notification is ours: HMAC(user:calendar, CRON_SECRET).
export async function channelToken(userId: string, calendarId: string): Promise<string> {
  const secret = Deno.env.get('CRON_SECRET') ?? ''
  return await hmacHex(secret, `${userId}:${calendarId}`)
}

// Channel id must be ≤64 chars of [A-Za-z0-9-_]; calendar ids are emails/URLs,
// so hash them into the id rather than embedding.
export async function channelIdFor(userId: string, calendarId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(calendarId))
  const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `rumbo-${userId}-${hex.slice(0, 16)}`
}

export interface WatchResult {
  channelId: string
  resourceId: string
  expiration: string // ISO
}

// Registers a push channel for one calendar. Returns null on failure — callers
// fall back to cron-driven polling, so a watch failure is degraded, not fatal.
export async function registerWatch(
  userId: string,
  calendarId: string,
  accessToken: string,
): Promise<WatchResult | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) return null
  try {
    const id = await channelIdFor(userId, calendarId)
    const token = await channelToken(userId, calendarId)
    const res = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id,
        type: 'web_hook',
        address: `${supabaseUrl}/functions/v1/calendar-webhook`,
        token,
        expiration: String(Date.now() + CHANNEL_TTL_MS),
      }),
    })
    if (!res.ok) {
      console.warn(`[gcal] watch register failed (${res.status}) for ${calendarId}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const data = await res.json()
    return {
      channelId: data.id as string,
      resourceId: data.resourceId as string,
      expiration: new Date(Number(data.expiration)).toISOString(),
    }
  } catch (err) {
    console.warn(`[gcal] watch register error for ${calendarId}:`, err)
    return null
  }
}

// Stops a channel. 404 = already gone, treated as success.
export async function stopChannel(channelId: string, resourceId: string, accessToken: string): Promise<void> {
  const res = await fetch(`${CAL_API}/channels/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id: channelId, resourceId }),
  })
  if (!res.ok && res.status !== 404) {
    console.warn(`[gcal] channel stop failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  }
}

// -----------------------------------------------------------------------------
// Classification — Haiku, asymmetric suppression (google-calendar.md §5)
// -----------------------------------------------------------------------------

export interface ClassificationResult {
  classification: 'academic' | 'personal'
  confidence: number
}

const CLASSIFIER_SYSTEM_PROMPT =
  'You classify a student\'s calendar events as academic or personal. ' +
  'Academic: classes, lectures, sections, labs, office hours, exams, review sessions, ' +
  'study groups, academic advising, coursework deadlines. ' +
  'Personal: social events, medical appointments, jobs unrelated to coursework, errands, travel, clubs unless clearly course-related. ' +
  'Confidence reflects how certain you are. If information is too thin to tell, use low confidence.'

// Returns null on ANY failure — caller stores 'pending', never defaults to academic.
export async function classifyEvent(
  summary: string,
  description: string,
): Promise<ClassificationResult | null> {
  const parsed = await geminiClassifyJson<{ classification: string; confidence: number }>({
    system: CLASSIFIER_SYSTEM_PROMPT,
    userText: `Event title: ${summary.slice(0, 300)}\nDescription: ${(description ?? '').slice(0, 500)}`,
    schema: {
      type: 'object',
      properties: {
        classification: { type: 'string', enum: ['academic', 'personal'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['classification', 'confidence'],
    },
    maxTokens: 100,
  })
  if (!parsed) return null
  if (parsed.classification !== 'academic' && parsed.classification !== 'personal') return null
  const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0
  return { classification: parsed.classification, confidence }
}

// -----------------------------------------------------------------------------
// Normalization (google-calendar.md §6)
// -----------------------------------------------------------------------------

export interface GoogleCalendarEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  recurrence?: string[]
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  updated?: string
  organizer?: { email?: string; self?: boolean }
}

const DAY_NAMES: Record<string, string> = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday',
  FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
}
const FREQ_NAMES: Record<string, string> = {
  DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly',
}

// "RRULE:FREQ=WEEKLY;BYDAY=TU,TH" → "Recurring: weekly on Tuesday and Thursday."
export function humanRecurrence(rules: string[] | undefined): string {
  if (!rules || rules.length === 0) return ''
  const rrule = rules.find(r => r.startsWith('RRULE:'))
  if (!rrule) return ''
  const parts = new Map<string, string>()
  for (const kv of rrule.slice('RRULE:'.length).split(';')) {
    const [k, v] = kv.split('=')
    if (k && v) parts.set(k, v)
  }
  const freq = FREQ_NAMES[parts.get('FREQ') ?? ''] ?? ''
  if (!freq) return ''
  const days = (parts.get('BYDAY') ?? '')
    .split(',')
    .map(d => DAY_NAMES[d.replace(/^[-+]?\d+/, '')])
    .filter(Boolean)
  let text = `Recurring: ${freq}`
  if (days.length === 1) text += ` on ${days[0]}`
  else if (days.length > 1) text += ` on ${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`
  return `${text}.`
}

// normalized_text: summary + description + recurrence. Attendee emails are
// deliberately excluded (google-calendar.md §6 — PII kept to raw_payload only).
export function normalizedTextForEvent(event: GoogleCalendarEvent): string {
  const parts = [event.summary?.trim() ?? '', event.description?.trim() ?? '', humanRecurrence(event.recurrence)]
  return parts.filter(Boolean).join('\n').trim()
}

// dateTime events → ISO; all-day date events → midnight UTC of that date.
export function timestampForEvent(event: GoogleCalendarEvent): string | null {
  if (event.start?.dateTime) {
    const d = new Date(event.start.dateTime)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (event.start?.date) return `${event.start.date}T00:00:00Z`
  return null
}

// -----------------------------------------------------------------------------
// Sync — syncToken incremental with 410 → windowed full re-sync
// -----------------------------------------------------------------------------

interface EventsPage {
  items: GoogleCalendarEvent[]
  nextPageToken?: string
  nextSyncToken?: string
}

async function fetchEventsPage(
  calendarId: string,
  accessToken: string,
  params: URLSearchParams,
): Promise<EventsPage> {
  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) throw new GoogleApiError(`events list failed: ${(await res.text()).slice(0, 300)}`, res.status)
  return await res.json()
}

export interface SyncOutcome {
  events: GoogleCalendarEvent[]
  nextSyncToken: string | null
  fullSync: boolean
}

// Pulls changed events for one calendar. Uses the stored syncToken when present;
// on 410 (expired token) falls back to a full windowed sync. Window:
// now − LOOKBACK_DAYS to now + LOOKAHEAD_MONTHS, singleEvents=true so
// recurrences arrive pre-expanded (google-calendar.md §3.3, §6).
export async function pullCalendarEvents(
  calendarId: string,
  accessToken: string,
  storedSyncToken: string | null,
  forceWindow = false,
): Promise<SyncOutcome> {
  const events: GoogleCalendarEvent[] = []
  let syncToken = forceWindow ? null : storedSyncToken
  let fullSync = !syncToken

  const windowParams = () => {
    const timeMin = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    const timeMax = new Date()
    timeMax.setMonth(timeMax.getMonth() + LOOKAHEAD_MONTHS)
    return new URLSearchParams({
      singleEvents: 'true',
      maxResults: '250',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
    })
  }

  let params: URLSearchParams
  if (syncToken) {
    params = new URLSearchParams({ syncToken, maxResults: '250' })
  } else {
    params = windowParams()
  }

  let nextSyncToken: string | null = null
  let pageToken: string | undefined
  let pages = 0
  while (pages < 40) {
    if (pageToken) params.set('pageToken', pageToken)
    let page: EventsPage
    try {
      page = await fetchEventsPage(calendarId, accessToken, params)
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 410 && syncToken) {
        // Expired sync token — restart with a full windowed sync.
        syncToken = null
        fullSync = true
        events.length = 0
        params = windowParams()
        pageToken = undefined
        pages = 0
        continue
      }
      throw err
    }
    events.push(...(page.items ?? []))
    if (page.nextSyncToken) nextSyncToken = page.nextSyncToken
    pageToken = page.nextPageToken
    pages += 1
    if (!pageToken) break
  }
  return { events, nextSyncToken, fullSync }
}

// -----------------------------------------------------------------------------
// Upsert into normalized_events
// -----------------------------------------------------------------------------

const CHUNK = 200

function externalIdFor(event: GoogleCalendarEvent): string {
  return `gcal_${event.id}`
}

export interface UpsertStats {
  upserted: number
  cancelled: number
  classified: number
  pending: number
}

// Writes events into normalized_events. Committed classifications are sticky —
// a re-synced event keeps its stored academic/personal label and is not
// re-classified (google-calendar.md §5). Cancelled events soft-delete via
// cancelled_at only. classifierBudget caps LLM calls per run.
export async function upsertEvents(
  admin: AdminClient,
  userId: string,
  calendarId: string,
  events: GoogleCalendarEvent[],
  classifierBudget: { remaining: number },
): Promise<UpsertStats> {
  const stats: UpsertStats = { upserted: 0, cancelled: 0, classified: 0, pending: 0 }
  if (events.length === 0) return stats

  // Sticky classification: pre-fetch what we already know for these ids.
  const existing = new Map<string, { classification: string | null; confidence: number | null }>()
  const ids = events.map(externalIdFor)
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await admin
      .from('normalized_events')
      .select('external_id, classification, classification_confidence')
      .eq('user_id', userId)
      .eq('source_type', 'google_calendar')
      .in('external_id', chunk)
    if (error) throw new Error(`existing classification read failed: ${error.message}`)
    for (const row of data ?? []) {
      existing.set(row.external_id, {
        classification: row.classification,
        confidence: row.classification_confidence,
      })
    }
  }

  const nowIso = new Date().toISOString()
  const rows: Record<string, unknown>[] = []

  for (const event of events) {
    if (!event.id) continue
    const externalId = externalIdFor(event)
    const cancelled = event.status === 'cancelled'
    const prior = existing.get(externalId)
    const priorCommitted = prior?.classification === 'academic' || prior?.classification === 'personal'

    let classification: string = prior?.classification ?? 'pending'
    let confidence: number | null = prior?.confidence ?? null
    let classificationSource: string | null = priorCommitted ? 'llm' : null

    if (!cancelled && !priorCommitted) {
      const summary = event.summary ?? ''
      if (classifierBudget.remaining > 0 && (summary || event.description)) {
        classifierBudget.remaining -= 1
        const result = await classifyEvent(summary, event.description ?? '')
        if (result && result.confidence >= CLASSIFY_COMMIT_THRESHOLD) {
          classification = result.classification
          confidence = result.confidence
          classificationSource = 'llm'
          stats.classified += 1
        } else {
          classification = 'pending'
          confidence = result?.confidence ?? null
          classificationSource = result ? 'llm' : null
          stats.pending += 1
        }
      } else {
        classification = 'pending'
        stats.pending += 1
      }
    }

    rows.push({
      user_id: userId,
      source_type: 'google_calendar',
      external_id: externalId,
      timestamp: timestampForEvent(event),
      course_id: null,
      classification,
      classification_source: classificationSource,
      classification_confidence: confidence,
      raw_payload: { ...event, rumbo_calendar_id: calendarId },
      normalized_text: normalizedTextForEvent(event),
      cancelled_at: cancelled ? nowIso : null,
      pipeline_version: INGESTION_PIPELINE_VERSION,
    })
    if (cancelled) stats.cancelled += 1
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await admin
      .from('normalized_events')
      .upsert(chunk, { onConflict: 'user_id,source_type,external_id' })
    if (error) throw new Error(`normalized_events upsert failed: ${error.message}`)
    stats.upserted += chunk.length
  }
  return stats
}

// -----------------------------------------------------------------------------
// Per-calendar + per-user orchestration
// -----------------------------------------------------------------------------

export async function syncCalendar(
  admin: AdminClient,
  userId: string,
  calendarId: string,
  accessToken: string,
  opts: { forceWindow?: boolean } = {},
): Promise<UpsertStats> {
  const { data: stateRow } = await admin
    .from('calendar_sync_state')
    .select('sync_token')
    .eq('user_id', userId)
    .eq('calendar_id', calendarId)
    .maybeSingle()

  const outcome = await pullCalendarEvents(
    calendarId,
    accessToken,
    stateRow?.sync_token ?? null,
    opts.forceWindow ?? false,
  )

  const budget = { remaining: MAX_CLASSIFICATIONS_PER_RUN }
  const stats = await upsertEvents(admin, userId, calendarId, outcome.events, budget)

  if (outcome.nextSyncToken) {
    await admin
      .from('calendar_sync_state')
      .update({ sync_token: outcome.nextSyncToken, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('calendar_id', calendarId)
  }
  return stats
}

export interface UserSyncSummary {
  calendars: number
  upserted: number
  cancelled: number
  classified: number
  pending: number
  watchesRegistered: number
}

// Full pass for one user: discover calendars, seed sync-state rows (insert-only,
// never clobbering existing sync_token/channel columns), register watch
// channels where missing/expired, then sync each calendar.
export async function syncUserCalendars(
  admin: AdminClient,
  userId: string,
  opts: { registerWatches?: boolean; forceWindow?: boolean } = {},
): Promise<UserSyncSummary> {
  const summary: UserSyncSummary = {
    calendars: 0, upserted: 0, cancelled: 0, classified: 0, pending: 0, watchesRegistered: 0,
  }
  const accessToken = await getFreshAccessToken(admin, userId)
  const calendars = await listCalendars(accessToken)
  summary.calendars = calendars.length

  const { data: stateRows, error: stateError } = await admin
    .from('calendar_sync_state')
    .select('calendar_id, channel_id, channel_expiry')
    .eq('user_id', userId)
  if (stateError) throw new Error(`calendar_sync_state read failed: ${stateError.message}`)
  const stateByCal = new Map<string, { channel_id: string | null; channel_expiry: string | null }>(
    (stateRows ?? []).map((r: { calendar_id: string; channel_id: string | null; channel_expiry: string | null }) =>
      [r.calendar_id, { channel_id: r.channel_id, channel_expiry: r.channel_expiry }]),
  )

  for (const cal of calendars) {
    // Seed state row only if missing — an upsert would clobber sync_token/channel.
    if (!stateByCal.has(cal.id)) {
      const { error } = await admin.from('calendar_sync_state').insert({
        user_id: userId,
        calendar_id: cal.id,
        is_primary: Boolean(cal.primary),
      })
      // Unique-violation race with a concurrent run is fine; anything else isn't.
      if (error && !`${error.code}`.startsWith('23')) {
        throw new Error(`calendar_sync_state seed failed: ${error.message}`)
      }
      stateByCal.set(cal.id, { channel_id: null, channel_expiry: null })
    }

    if (opts.registerWatches !== false) {
      const state = stateByCal.get(cal.id)
      const expiry = state?.channel_expiry ? new Date(state.channel_expiry).getTime() : 0
      const needsWatch = !state?.channel_id || expiry <= Date.now()
      if (needsWatch) {
        const watch = await registerWatch(userId, cal.id, accessToken)
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
            .eq('calendar_id', cal.id)
          summary.watchesRegistered += 1
        }
      }
    }

    const stats = await syncCalendar(admin, userId, cal.id, accessToken, { forceWindow: opts.forceWindow })
    summary.upserted += stats.upserted
    summary.cancelled += stats.cancelled
    summary.classified += stats.classified
    summary.pending += stats.pending
  }
  return summary
}

// -----------------------------------------------------------------------------
// Pending-classification drain (weekly job / renew tick)
// -----------------------------------------------------------------------------

export async function reclassifyPending(admin: AdminClient, limit = 100): Promise<number> {
  const { data, error } = await admin
    .from('normalized_events')
    .select('id, raw_payload')
    .eq('source_type', 'google_calendar')
    .eq('classification', 'pending')
    .is('cancelled_at', null)
    .order('ingested_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`pending read failed: ${error.message}`)

  let committed = 0
  for (const row of data ?? []) {
    const payload = row.raw_payload as { summary?: string; description?: string }
    const result = await classifyEvent(payload.summary ?? '', payload.description ?? '')
    if (result && result.confidence >= CLASSIFY_COMMIT_THRESHOLD) {
      const { error: updateError } = await admin
        .from('normalized_events')
        .update({
          classification: result.classification,
          classification_source: 'llm',
          classification_confidence: result.confidence,
        })
        .eq('id', row.id)
      if (!updateError) committed += 1
    }
  }
  return committed
}
