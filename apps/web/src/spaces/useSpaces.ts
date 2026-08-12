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
import { useCourses, type Course } from '../hooks/useCourses'
import { useSpaceStore, HOME_SPACE_ID } from './spaceStore'

/** Courses whose terms end within this of each other count as the same term. */
const SAME_TERM_MS = 21 * 24 * 60 * 60 * 1000

/**
 * Which courses get an automatic space.
 *
 * "Currently active in Canvas" is the intent, but taken literally it breaks for
 * a chunk of the year: between terms NOTHING is in session, so the rule would
 * hide every real class. In the current data — mid-August — Winter 26 ended in
 * March and Spring 26 in June, so a literal reading produced zero real spaces
 * and surfaced only two administrative shells with placeholder 2099 end dates.
 *
 * So: courses in session if any are, otherwise the most recent term that
 * actually ran. Anything older stays one click away under "New space".
 */
export function selectSpaceCourses(courses: Course[]): Course[] {
  const real = courses.filter(c => !c.isShell)

  const inSession = real.filter(c => c.isCurrent)
  if (inSession.length > 0) return inSession

  const dated = real.filter(c => c.termEndMs !== null)
  if (dated.length === 0) return []

  // Between terms — fall back to the newest term we have on record, taking
  // every course that shares it rather than just the single latest course.
  const latest = Math.max(...dated.map(c => c.termEndMs as number))
  return dated.filter(c => latest - (c.termEndMs as number) < SAME_TERM_MS)
}

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
  /** Hue washed into the page/rail/card surfaces, or 'transparent' for paper. */
  tint: string
  /** Which SPACE_BACKGROUNDS entry is in effect. */
  backgroundId: string
}

/**
 * Background washes. The tint is mixed into the existing warm-paper (or warm-
 * dark) surfaces at a low percentage rather than replacing them, so text
 * contrast and the whole token set survive untouched — see index.css.
 */
export interface SpaceBackground {
  id: string
  label: string
  tint: string
}

export const SPACE_BACKGROUNDS: SpaceBackground[] = [
  { id: 'paper', label: 'Paper', tint: 'transparent' },
  { id: 'sage', label: 'Sage', tint: '#4fa06b' },
  { id: 'ocean', label: 'Ocean', tint: '#3e9aac' },
  { id: 'lilac', label: 'Lilac', tint: '#8a6fd4' },
  { id: 'ochre', label: 'Ochre', tint: '#e8a23e' },
  { id: 'rose', label: 'Rose', tint: '#d4638e' },
  { id: 'terra', label: 'Terra', tint: '#e86a4f' },
]

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
  const backgroundBySpace = useSpaceStore(s => s.backgroundBySpace)

  return useMemo(() => {
    // A space's background defaults to a wash of its own hue, so spaces look
    // distinct out of the box; Home stays warm paper. Either can be overridden
    // from the space menu.
    const resolveBackground = (id: string, kind: SpaceKind, bright: string) => {
      const chosen = backgroundBySpace[id]
      if (chosen) {
        const bg = SPACE_BACKGROUNDS.find(b => b.id === chosen)
        if (bg) return { tint: bg.tint, backgroundId: bg.id }
      }
      return kind === 'home'
        ? { tint: 'transparent', backgroundId: 'paper' }
        : { tint: bright, backgroundId: 'auto' }
    }

    const list: Space[] = [
      {
        id: HOME_SPACE_ID, name: 'Home', courseId: null, kind: 'home', ...HOME_COLOR,
        ...resolveBackground(HOME_SPACE_ID, 'home', HOME_COLOR.bright),
      },
    ]

    // Colour by position rather than by hash: a hash can hand neighbouring
    // spaces near-identical hues, and telling spaces apart at a glance is the
    // whole point of colouring them.
    let hue = 0
    const nextHue = () => PALETTE[hue++ % PALETTE.length]

    for (const course of selectSpaceCourses(courses ?? [])) {
      const color = nextHue()
      list.push({
        id: course.id,
        name: course.label,
        courseId: course.id,
        kind: 'course',
        ...color,
        ...resolveBackground(course.id, 'course', color.bright),
      })
    }

    for (const space of custom) {
      // Don't double up if the student made a space for a course that has since
      // become active and picked up an automatic one.
      if (space.courseId && list.some(s => s.courseId === space.courseId)) continue
      const color = nextHue()
      list.push({
        id: space.id,
        name: space.name || 'Untitled space',
        courseId: space.courseId,
        kind: 'custom',
        ...color,
        ...resolveBackground(space.id, 'custom', color.bright),
      })
    }

    return list
  }, [courses, custom, backgroundBySpace])
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
 * Writes three custom properties on <html>; index.css derives the accent tokens
 * from --space-ink/--space-bright (picking `ink` in light mode and `bright` in
 * dark) and washes --space-tint into the page, rail and card surfaces. Doing it
 * with variables rather than per-component props means the recolour is free
 * everywhere — including the canvas in Brain, which reads tokens straight off
 * the document element.
 */
export function useApplySpaceTheme(space: Space): void {
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--space-ink', space.ink)
    root.style.setProperty('--space-bright', space.bright)
    root.style.setProperty('--space-tint', space.tint)
  }, [space.ink, space.bright, space.tint])
}

/** Index of the active space in the ordered list — drives the swipe strip. */
export function useActiveSpaceIndex(): number {
  const spaces = useSpaces()
  const activeSpaceId = useSpaceStore(s => s.activeSpaceId)
  const i = spaces.findIndex(s => s.id === activeSpaceId)
  return i === -1 ? 0 : i
}
