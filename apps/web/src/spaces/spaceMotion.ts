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

/**
 * How far the content slides for a full one-space move, as a share of the
 * viewport width. A fixed ~34px read as a twitch on a wide window — the move
 * has to be proportional to the screen to look like the page is travelling
 * rather than nudging.
 */
const CONTENT_PARALLAX_RATIO = 0.16
const CONTENT_PARALLAX_MAX_PX = 220
/** How much the content dims and shrinks at the midpoint of a move. */
const CONTENT_FADE = 0.55
const CONTENT_SCALE = 0.04

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
    // Content travels with the gesture, dimming and easing back slightly as it
    // goes, so the whole app reads as moving between spaces rather than a label
    // sliding in the sidebar. Clamped so a rubber-band at either end can't fade
    // the page out.
    const delta = Math.max(-1, Math.min(1, pos - index))
    const magnitude = Math.abs(delta)
    const travel = Math.min(CONTENT_PARALLAX_MAX_PX, window.innerWidth * CONTENT_PARALLAX_RATIO)
    const scale = 1 - magnitude * CONTENT_SCALE
    content.style.transform =
      `translateX(${(-delta * travel).toFixed(2)}px) scale(${scale.toFixed(4)})`
    content.style.opacity = (1 - magnitude * CONTENT_FADE).toFixed(3)
  }
}
