import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { isCanvasCourseCurrent, courseTermEnd, isAdminShell, courseShortLabel } from '../lib/courseTerm'

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
   * the Courses page. Note this is false for EVERY course between terms.
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

export function useCourses() {
  return useQuery({
    // NOT plain ['courses'] — useNormalizedEvents exports a different hook of
    // the same name that caches a Map<id, CourseInfo> for card labels. Sharing
    // one key made the two overwrite each other in the query cache, and
    // whichever resolved last crashed the other consumer (selectSpaceCourses
    // calling .filter on a Map took down /tasks and the sidebar).
    queryKey: ['courses', 'list'],
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
          // 28 chars: this label renders into chips and menu rows.
          label: courseShortLabel(code, name, 28),
          isCurrent: manual ? true : isCanvasCourseCurrent(rp),
          termEndMs: manual ? null : courseTermEnd(rp),
          isShell: manual ? false : isAdminShell(rp),
        })
      }
      return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
    },
  })
}
