import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/*
 * Per-course display overrides — what the student decided a course should be
 * called and coloured, as distinct from what Canvas says it is.
 *
 * Canvas ingest is read-only: normalized_events is a mirror, and editing a
 * course there would be overwritten by the next poll. So overrides live
 * alongside rather than in the source data, keyed by course_id, and are
 * applied at render time.
 *
 * Stored in localStorage rather than Postgres. That is a deliberate trade for
 * now — no migration to deploy — and the cost is real: overrides live on one
 * browser and don't follow the account. The shape below is intentionally the
 * shape of a `course_overrides` row (user_id + course_id + the same two
 * columns), so promoting it later is a data move, not a rewrite.
 */

export interface CourseOverride {
  /** Replaces the derived heading. Absent or blank means "use the derived one". */
  name?: string
  /** A token name from COURSE_COLORS. Absent means the hashed default. */
  color?: string
}

interface CourseOverridesState {
  byCourseId: Record<string, CourseOverride>
  setOverride: (courseId: string, patch: CourseOverride) => void
  clearOverride: (courseId: string) => void
}

export const useCourseOverrides = create<CourseOverridesState>()(
  persist(
    (set) => ({
      byCourseId: {},

      setOverride: (courseId, patch) =>
        set((state) => {
          const next = { ...state.byCourseId[courseId], ...patch }
          // Blank name and default colour mean "no override" — drop the entry
          // entirely rather than persisting an empty object forever.
          if (!next.name?.trim()) delete next.name
          if (!next.color) delete next.color
          const byCourseId = { ...state.byCourseId }
          if (Object.keys(next).length === 0) delete byCourseId[courseId]
          else byCourseId[courseId] = next
          return { byCourseId }
        }),

      clearOverride: (courseId) =>
        set((state) => {
          const byCourseId = { ...state.byCourseId }
          delete byCourseId[courseId]
          return { byCourseId }
        }),
    }),
    { name: 'rumbo-course-overrides' },
  ),
)

/**
 * Colours a course can be given. DESIGN.md §3 makes these semantic — they mean
 * "a class" — and deliberately excludes terra, which is the single UI accent
 * and would read as a state rather than an identity.
 */
export const COURSE_COLORS = [
  { token: '--sage', label: 'Sage' },
  { token: '--ochre', label: 'Ochre' },
  { token: '--dblue', label: 'Blue' },
  { token: '--teal', label: 'Violet' },
] as const

/** Stable default when the student hasn't chosen: hashed so a course keeps its
 *  colour as others are added and removed around it. */
export function defaultCourseColor(courseId: string): string {
  let h = 0
  for (let i = 0; i < courseId.length; i++) h = (h * 31 + courseId.charCodeAt(i)) >>> 0
  return COURSE_COLORS[h % COURSE_COLORS.length].token
}

/** The CSS colour value to paint, honouring any override. */
export function resolveCourseColor(
  courseId: string,
  override: CourseOverride | undefined,
): string {
  return `var(${override?.color ?? defaultCourseColor(courseId)})`
}

/** The heading to show, honouring any override. */
export function resolveCourseName(derived: string, override: CourseOverride | undefined): string {
  return override?.name?.trim() || derived
}
