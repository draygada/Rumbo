import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isCanvasCourseCurrent, courseTermEnd, isAdminShell } from '../lib/courseTerm'

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
  /**
   * Is the course still running this term? Drives the Current/Archive split on
   * the Courses page. Note this is false for EVERY course between terms, which
   * is why it isn't on its own the rule for which courses get a space — see
   * spaces/useSpaces.ts.
   */
  isCurrent: boolean
  /** When this course's term ends, for picking the most recent one. */
  termEndMs: number | null
  /** A department/tutoring shell rather than a class the student takes. */
  isShell: boolean
}

interface CourseRow {
  course_id: string | null
  source_type: string
  raw_payload: Record<string, unknown> | null
}

function shortLabel(code: string | null, name: string): string {
  if (code) {
    // Strip the term prefix FIRST. Without this the department matcher happily
    // matches the term itself when it has two letters, so every Spring course
    // came out as "SP 26" — "Sp26-CS-146J-01" matched Sp + 26. Single-letter
    // terms (W26, F25) slipped through because the matcher wants 2+ letters,
    // which is why this only showed up once Spring courses were selected.
    const withoutTerm = code.replace(/^(F|W|Sp|Su)\d{2}[-\s]*/i, '')
    // "EDUC-475-01" → "EDUC 475"; "CS-146J-01" → "CS 146J"; "PWR-2PT-01" → "PWR 2PT"
    const m = withoutTerm.match(/([A-Za-z]{2,8})[-\s]?(\d{1,4}[A-Za-z]*)/)
    if (m) return `${m[1].toUpperCase()} ${m[2].toUpperCase()}`
    return withoutTerm || code
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
        .select('course_id, source_type, raw_payload')
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
        // Manual courses have no term metadata and are only listed while
        // un-archived, so they always count as current.
        const manual = row.source_type === 'manual_course'
        byId.set(row.course_id, {
          id: row.course_id,
          code,
          name,
          label: shortLabel(code, name),
          isCurrent: manual ? true : isCanvasCourseCurrent(rp),
          termEndMs: manual ? null : courseTermEnd(rp),
          isShell: manual ? false : isAdminShell(rp),
        })
      }
      return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
    },
  })
}
