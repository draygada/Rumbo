// -----------------------------------------------------------------------------
// useSpaces — the ordered list of spaces, derived rather than authored.
//
//   [ Home ] [ …one per ACTIVE Canvas course… ] [ …spaces you created… ]
//
// Home is always index 0 and is where the app boots, so the general chat stays
// the landing screen. Only courses still running this term get an automatic
// space; finished ones stay reachable through "New space".
// -----------------------------------------------------------------------------

import { useEffect, useMemo } from 'react'
import { useCourses } from '../hooks/useCourses'
import { useSpaceStore, HOME_SPACE_ID } from './spaceStore'

export type SpaceKind = 'home' | 'course' | 'custom'

export interface Space {
  id: string
  name: string
  /** course_id the space scopes to, or null for all classes. */
  courseId: string | null
  kind: SpaceKind
  /** AA-safe hue for text/links on light surfaces. */
  ink: string
  /** Saturated hue for dots, fills and the focus ring. */
  bright: string
}

// One hue per space so the whole app recolours as you swipe. Terra is reserved
// for Home (it's the brand accent), so the rotation deliberately excludes it.
// `ink` variants are the AA-safe versions already used in index.css.
const PALETTE: Array<{ ink: string; bright: string }> = [
  { ink: '#3d7b52', bright: '#4fa06b' }, // sage
  { ink: '#2f7583', bright: '#3e9aac' }, // dblue
  { ink: '#715bae', bright: '#8a6fd4' }, // teal
  { ink: '#8a6318', bright: '#e8a23e' }, // ochre
  { ink: '#a8496b', bright: '#d4638e' }, // rose
]

const HOME_COLOR = { ink: '#b0513c', bright: '#e86a4f' } // terra

export function useSpaces(): Space[] {
  const { data: courses } = useCourses()
  const custom = useSpaceStore(s => s.custom)

  return useMemo(() => {
    const list: Space[] = [
      { id: HOME_SPACE_ID, name: 'Home', courseId: null, kind: 'home', ...HOME_COLOR },
    ]

    // Colour by position rather than by hash: a hash can hand neighbouring
    // spaces near-identical hues, and telling spaces apart at a glance is the
    // whole point of colouring them.
    let hue = 0
    const nextHue = () => PALETTE[hue++ % PALETTE.length]

    for (const course of courses ?? []) {
      if (!course.isCurrent) continue
      list.push({
        id: course.id,
        name: course.label,
        courseId: course.id,
        kind: 'course',
        ...nextHue(),
      })
    }

    for (const space of custom) {
      // Don't double up if the student made a space for a course that has since
      // become active and picked up an automatic one.
      if (space.courseId && list.some(s => s.courseId === space.courseId)) continue
      list.push({
        id: space.id,
        name: space.name || 'Untitled space',
        courseId: space.courseId,
        kind: 'custom',
        ...nextHue(),
      })
    }

    return list
  }, [courses, custom])
}

/**
 * The space currently being worked in. Falls back to Home when the persisted
 * id points at a course that has since ended (or a deleted custom space).
 */
export function useActiveSpace(): Space {
  const spaces = useSpaces()
  const activeSpaceId = useSpaceStore(s => s.activeSpaceId)
  return useMemo(
    () => spaces.find(s => s.id === activeSpaceId) ?? spaces[0],
    [spaces, activeSpaceId],
  )
}

/**
 * Repaint the app in the active space's hue.
 *
 * Writes two custom properties on <html>; index.css derives --color-accent,
 * --color-link, --color-focus and --color-bg-selected from them (picking `ink`
 * in light mode and `bright` in dark). Doing it with two variables rather than
 * per-component props means the recolour is free everywhere — including the
 * canvas in Brain, which reads the tokens off the document element.
 */
export function useApplySpaceAccent(space: Space): void {
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--space-ink', space.ink)
    root.style.setProperty('--space-bright', space.bright)
  }, [space.ink, space.bright])
}

/** Index of the active space in the ordered list — drives the swipe strip. */
export function useActiveSpaceIndex(): number {
  const spaces = useSpaces()
  const activeSpaceId = useSpaceStore(s => s.activeSpaceId)
  const i = spaces.findIndex(s => s.id === activeSpaceId)
  return i === -1 ? 0 : i
}
