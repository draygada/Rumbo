import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { courseShortLabel } from './courseTerm'

/*
 * Demo mode — pins a fixed set of courses to "Current".
 *
 * Normally a course's Current/Archive state is derived entirely from real
 * data: the term prefix in its code, Canvas's term.end_at, an academic-year
 * range, then workflow_state / enrollment state / start_at / end_at. See
 * isCanvasCourseCurrent. That stays the rule — this only ever ADDS courses to
 * Current, and never archives one the dates say is running.
 *
 * It exists because the demo happens between terms. Every real class the
 * student has taken ended months ago, so an honest reading of the dates leaves
 * Current holding nothing but two administrative shells, which makes the whole
 * product look empty through no fault of the logic.
 *
 * Matched on the NORMALIZED label rather than course_id or raw code, so a
 * pinned course survives re-ingest, a new term prefix, or a section change —
 * "W26-EDUC-475-01" and "Sp26-EDUC-475-02" both resolve to "EDUC 475".
 */

/** Courses pinned to Current while demo mode is on, by normalized label. */
export const DEMO_PINNED_LABELS = ['EDUC 475', 'COLLEGE 101'] as const

interface DemoModeState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

export const useDemoMode = create<DemoModeState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    { name: 'rumbo-demo-mode' },
  ),
)

/** Is this course one of the pinned ones? Does NOT consult the toggle. */
export function isDemoPinnedCourse(code: string | null, name: string): boolean {
  const label = courseShortLabel(code, name)
  return DEMO_PINNED_LABELS.some(pinned => pinned.toLowerCase() === label.toLowerCase())
}

/**
 * Effective Current state: the real answer, plus the pins when demo mode is on.
 * Deliberately OR, never override — demo mode can't archive a live course.
 */
export function resolveIsCurrent(
  isCurrentByDates: boolean,
  demoEnabled: boolean,
  code: string | null,
  name: string,
): boolean {
  if (isCurrentByDates) return true
  return demoEnabled && isDemoPinnedCourse(code, name)
}
