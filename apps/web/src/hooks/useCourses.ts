import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

/*
 * The student's courses, derived from ingested course records.
 *
 * Canvas and manual courses both land in normalized_events as
 * canvas_course / manual_course rows, so this is the one list that reflects
 * everything the brain actually knows about — which is what a chat scope
 * should be chosen from.
 */

export interface Course {
  /** Graph/course id, e.g. "canvas_course_221697" — what the tutor scopes on. */
  id: string
  /** "W26-EDUC-475-01" when Canvas gives us one. */
  code: string | null
  name: string
  /** Short label for chips/menus: the code if present, else a trimmed name. */
  label: string
}

interface CourseRow {
  course_id: string | null
  raw_payload: Record<string, unknown> | null
}

function shortLabel(code: string | null, name: string): string {
  if (code) {
    // "W26-EDUC-475-01" → "EDUC 475"
    const m = code.match(/([A-Za-z]{2,8})-?(\d{1,4}[A-Za-z]?)/)
    if (m) return `${m[1].toUpperCase()} ${m[2]}`
    return code
  }
  return name.length > 28 ? `${name.slice(0, 28).trimEnd()}…` : name
}

export function useCourses() {
  return useQuery({
    queryKey: ['courses'],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Course[]> => {
      const { data, error } = await supabase
        .from('normalized_events')
        .select('course_id, raw_payload')
        .in('source_type', ['canvas_course', 'manual_course'])
        .is('cancelled_at', null)
      if (error) throw error

      const byId = new Map<string, Course>()
      for (const row of (data ?? []) as CourseRow[]) {
        if (!row.course_id || byId.has(row.course_id)) continue
        const rp = row.raw_payload ?? {}
        const name = String(rp.name ?? '').trim() || row.course_id
        const code = typeof rp.course_code === 'string' && rp.course_code.trim()
          ? rp.course_code.trim()
          : null
        byId.set(row.course_id, { id: row.course_id, code, name, label: shortLabel(code, name) })
      }
      return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
    },
  })
}
