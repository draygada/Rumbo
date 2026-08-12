// -----------------------------------------------------------------------------
// spaceMotion — the elements the swipe animates, and how they're painted.
//
// The gesture writes transforms STRAIGHT TO THE DOM, once per animation frame,
// rather than going through React state. Wheel events arrive at 60-120Hz on a
// trackpad; routing each one through setState re-rendered the whole rail per
// event, which is what made the old swipe feel stepped.
//
// Elements register here instead of being prop-drilled, because the two things
// that move — the rail's name strip and the page content — live in different
// components (SpaceSwitcher and DashboardLayout) with the gesture owner
// (Sidebar) in neither's path.
// -----------------------------------------------------------------------------

import { useCallback } from 'react'

export type MotionTrack = 'strip' | 'content'

const elements: Record<MotionTrack, HTMLElement | null> = {
  strip: null,
  content: null,
}

/** Callback ref that registers an element as an animation track. */
export function useMotionTrack(kind: MotionTrack) {
  return useCallback(
    (el: HTMLElement | null) => {
      elements[kind] = el
    },
    [kind],
  )
}

/** How far the content slides, in px, for a full one-space move. */
const CONTENT_PARALLAX_PX = 34
/** How much the content dims at the midpoint of a move. */
const CONTENT_FADE = 0.4

/**
 * Paint one frame.
 *
 * @param pos    floating space index — 1.35 means 35% of the way from space 1 to 2
 * @param index  the committed space index, which the content is anchored to
 */
export function paintTracks(pos: number, index: number): void {
  const strip = elements.strip
  if (strip) {
    // The strip is exactly one viewport wide (its slides overflow it), so 100%
    // is precisely one slide — independent of the rail's collapsed/hover width.
    strip.style.transform = `translateX(${(-pos * 100).toFixed(3)}%)`
  }

  const content = elements.content
  if (content) {
    // Content trails the rail at a fraction of the distance and dims through
    // the crossing, so the whole app reads as moving rather than the label
    // alone. Clamped so a rubber-band at either end can't fade it out.
    const delta = Math.max(-1, Math.min(1, pos - index))
    content.style.transform = `translateX(${(-delta * CONTENT_PARALLAX_PX).toFixed(2)}px)`
    content.style.opacity = (1 - Math.abs(delta) * CONTENT_FADE).toFixed(3)
  }
}
