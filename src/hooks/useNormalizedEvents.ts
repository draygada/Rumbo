import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

// Row shape mirrors public.normalized_events (see supabase/migrations/*graph_brain_schema.sql).
export interface NormalizedEvent {
  id: string
  user_id: string
  source_type: string
  external_id: string
  timestamp: string | null
  course_id: string | null
  classification: string | null
  raw_payload: Record<string, unknown>
  normalized_text: string | null
  ingested_at: string
  cancelled_at: string | null
}

const LOOKAHEAD_DAYS = 14
const RECENTLY_ADDED_HOURS = 48

// Assignment source_types the dashboard renders. Non-assignment source_types
// (calendar events, drive files, courses/syllabi) are consumed elsewhere.
const ASSIGNMENT_SOURCE_TYPES = ['canvas_assignment', 'manual_assignment']

function isoNow(): string {
  return new Date().toISOString()
}

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

function isoHoursAgo(hours: number): string {
  const d = new Date()
  d.setHours(d.getHours() - hours)
  return d.toISOString()
}

// Upcoming: due in the next 14 days, academic-classified, not cancelled.
export function useUpcomingAssignments() {
  return useQuery({
    queryKey: ['normalized_events', 'upcoming'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('normalized_events')
        .select('*')
        .in('source_type', ASSIGNMENT_SOURCE_TYPES)
        .eq('classification', 'academic')
        .is('cancelled_at', null)
        .gte('timestamp', isoNow())
        .lte('timestamp', isoDaysFromNow(LOOKAHEAD_DAYS))
        .order('timestamp', { ascending: true })
      if (error) throw error
      return (data ?? []) as NormalizedEvent[]
    },
  })
}

// Still open: past due, not cancelled. Neutral framing per dashboard.md §6 Q2.
export function useStillOpenAssignments() {
  return useQuery({
    queryKey: ['normalized_events', 'still_open'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('normalized_events')
        .select('*')
        .in('source_type', ASSIGNMENT_SOURCE_TYPES)
        .eq('classification', 'academic')
        .is('cancelled_at', null)
        .lt('timestamp', isoNow())
        // Cap the past window so we don't render an entire semester of stale items.
        .gte('timestamp', isoDaysFromNow(-60))
        .order('timestamp', { ascending: false })
      if (error) throw error
      return (data ?? []) as NormalizedEvent[]
    },
  })
}

// Recently added: anything ingested in the last 48h.
export function useRecentlyAdded() {
  return useQuery({
    queryKey: ['normalized_events', 'recent'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('normalized_events')
        .select('*')
        .in('source_type', ASSIGNMENT_SOURCE_TYPES)
        .eq('classification', 'academic')
        .is('cancelled_at', null)
        .gte('ingested_at', isoHoursAgo(RECENTLY_ADDED_HOURS))
        .order('ingested_at', { ascending: false })
        .limit(10)
      if (error) throw error
      return (data ?? []) as NormalizedEvent[]
    },
  })
}

function localDateKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Today's academic calendar events. Empty for V0 until Calendar adapter ships.
// Query key includes today's local date so the window doesn't drift across midnight.
export function useTodaysCalendar() {
  const today = localDateKey()
  return useQuery({
    queryKey: ['normalized_events', 'today_calendar', today],
    queryFn: async () => {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date()
      end.setHours(23, 59, 59, 999)
      const { data, error } = await supabase
        .from('normalized_events')
        .select('*')
        .eq('source_type', 'google_calendar')
        .eq('classification', 'academic')
        .is('cancelled_at', null)
        .gte('timestamp', start.toISOString())
        .lte('timestamp', end.toISOString())
        .order('timestamp', { ascending: true })
      if (error) throw error
      return (data ?? []) as NormalizedEvent[]
    },
  })
}

// Whether the user has any ingestion source connected. Used to distinguish
// "not-connected-yet" from "connected-but-nothing-due" empty states.
export function useHasConnectedSources() {
  return useQuery({
    queryKey: ['connected_sources'],
    queryFn: async () => {
      const [canvas, google] = await Promise.all([
        supabase.from('canvas_credentials').select('user_id', { count: 'exact', head: true }),
        supabase.from('calendar_connections').select('id', { count: 'exact', head: true }),
      ])
      const canvasCount = canvas.count ?? 0
      const googleCount = google.count ?? 0
      return { canvas: canvasCount > 0, google: googleCount > 0, any: canvasCount + googleCount > 0 }
    },
  })
}

// Canvas sync state — powers the "we're pulling in your courses" and
// "your Canvas token needs refresh" empty-state variants (dashboard.md §4).
export interface CanvasSyncState {
  user_id: string
  canvas_domain: string
  last_polled_at: string | null
  token_status: 'valid' | 'expired' | string
  updated_at: string
}

export function useCanvasSyncState() {
  return useQuery({
    queryKey: ['canvas_sync_state'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('canvas_sync_state')
        .select('user_id, canvas_domain, last_polled_at, token_status, updated_at')
        .maybeSingle()
      if (error) throw error
      return (data ?? null) as CanvasSyncState | null
    },
  })
}

// Group assignments by course_id, preserving intra-group due-date ordering.
export function groupByCourse(events: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const grouped = new Map<string, NormalizedEvent[]>()
  for (const event of events) {
    const key = event.course_id ?? 'uncategorized'
    const bucket = grouped.get(key) ?? []
    bucket.push(event)
    grouped.set(key, bucket)
  }
  return grouped
}

// Course info keyed by course_id (e.g. 'canvas_course_12345'). Populated by
// useCourseNames() from canvas_course + manual_courses. Display code prefers
// the short course_code (CS 106A) over the full name.
export interface CourseInfo {
  course_code: string | null
  name: string
  source: 'canvas' | 'manual'
}

// Derive a display name for an event. Prefers the courses-lookup map when
// available; falls back to anything the payload carries; finally the raw id.
export function courseNameFromEvent(
  event: NormalizedEvent,
  courses?: Map<string, CourseInfo>,
): string {
  if (courses && event.course_id) {
    const info = courses.get(event.course_id)
    if (info) return info.course_code || info.name
  }
  const payload = event.raw_payload
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    if (typeof p.course_code === 'string' && p.course_code) return p.course_code
    if (typeof p.course_name === 'string' && p.course_name) return p.course_name
  }
  return event.course_id ?? 'Uncategorized'
}

// Fetch every course the user has (Canvas-ingested + manually added).
// Returns a Map keyed by the course_id used on assignments.
export function useCourses() {
  return useQuery({
    queryKey: ['courses'],
    queryFn: async () => {
      const [{ data: canvasRows }, { data: manualRows }] = await Promise.all([
        supabase
          .from('normalized_events')
          .select('external_id, raw_payload')
          .eq('source_type', 'canvas_course')
          .is('cancelled_at', null),
        supabase
          .from('manual_courses')
          .select('id, name, course_code')
          .is('archived_at', null),
      ])
      const map = new Map<string, CourseInfo>()
      for (const row of canvasRows ?? []) {
        const payload = (row.raw_payload ?? {}) as Record<string, unknown>
        const state = typeof payload.workflow_state === 'string' ? payload.workflow_state : ''
        // Skip courses Canvas has abandoned. `deleted` / `unpublished` shells
        // return with no metadata and would show as "Untitled course" clutter.
        if (state === 'deleted' || state === 'unpublished') continue
        const rawName = typeof payload.name === 'string' ? payload.name.trim() : ''
        const rawCode = typeof payload.course_code === 'string' ? payload.course_code.trim() : ''
        const term = (payload.term as { name?: string } | undefined)?.name?.trim() ?? ''
        // Unlabeled ghost row — skip.
        if (!rawName && !rawCode && !term) continue
        const name = rawName || rawCode || term || 'Untitled course'
        const courseCode = rawCode || null
        map.set(row.external_id as string, { name, course_code: courseCode, source: 'canvas' })
      }
      for (const row of manualRows ?? []) {
        const key = `manual_course_${row.id}`
        map.set(key, {
          name: (row.name as string) ?? 'Manual course',
          course_code: (row.course_code as string | null) ?? null,
          source: 'manual',
        })
      }
      return map
    },
  })
}

export function assignmentNameFromEvent(event: NormalizedEvent): string {
  const payload = event.raw_payload
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    if (typeof p.name === 'string' && p.name) return p.name
    if (typeof p.title === 'string' && p.title) return p.title
  }
  const text = event.normalized_text ?? ''
  if (!text) return 'Untitled'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

export function pointsFromEvent(event: NormalizedEvent): number | null {
  const payload = event.raw_payload
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>
    const raw = p.points_possible
    if (typeof raw === 'number' && !Number.isNaN(raw)) return raw
    if (typeof raw === 'string') {
      const parsed = parseFloat(raw)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return null
}

export function sourceBadge(sourceType: string): string {
  if (sourceType.startsWith('canvas')) return 'Canvas'
  if (sourceType.startsWith('manual')) return 'Manual'
  return sourceType
}
