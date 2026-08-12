// -----------------------------------------------------------------------------
// spaceMotion — the elements the swipe animates, and how they're painted.
//
// The gesture writes transforms STRAIGHT TO THE DOM, once per animation frame,
// rather than going through React state. Wheel events arrive at 60-120Hz on a
// trackpad; routing each one through setState re-rendered the whole rail per
// event, which is what made the old swipe feel stepped.
//
// Elements register here instead of being prop-drilled, because the things that
// move — the rail's name strip, the position dots, the page content — live in
// different components (SpaceSwitcher, DashboardLayout) with the gesture owner
// (Sidebar) in neither's path.
//
// READS BEFORE WRITES. Everything below measures first and mutates second. The
// dot positions have to come from the DOM (the rail changes width on hover, so
// they can't be cached), and interleaving a read after a style write would force
// a synchronous layout on every frame of the gesture.
// -----------------------------------------------------------------------------

import { useCallback } from 'react'

export type MotionTrack = 'strip' | 'content' | 'pips' | 'blob'

const elements: Record<MotionTrack, HTMLElement | null> = {
  strip: null,
  content: null,
  pips: null,
  blob: null,
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

/** Per-space accent hues, so the travelling drop can take on its destination's colour. */
let spaceColors: string[] = []
export function setSpaceColors(colors: string[]): void {
  spaceColors = colors
}

/** How far the content slides for a one-space move, as a share of viewport width. */
const CONTENT_PARALLAX_RATIO = 0.16
const CONTENT_PARALLAX_MAX_PX = 220
/** How much the content dims and shrinks at the midpoint of a move. */
const CONTENT_FADE = 0.55
const CONTENT_SCALE = 0.04
/** Resting size of the drop that marks the active space. */
const BLOB_WIDTH_PX = 15
/** How much of the gap the drop stretches across at the midpoint of a move. */
const BLOB_STRETCH = 0.62

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

function parseHex(hex: string): [number, number, number] {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? v.split('').map(c => c + c).join('') : v
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

/** Blend two accent hues, so the drop changes colour as it crosses. */
function mixHex(a: string, b: string, t: number): string {
  try {
    const [r1, g1, b1] = parseHex(a)
    const [r2, g2, b2] = parseHex(b)
    const r = Math.round(lerp(r1, r2, t))
    const g = Math.round(lerp(g1, g2, t))
    const bl = Math.round(lerp(b1, b2, t))
    return `rgb(${r}, ${g}, ${bl})`
  } catch {
    return a
  }
}

/**
 * Paint one frame.
 *
 * @param pos    floating space index — 1.35 means 35% of the way from space 1 to 2
 * @param index  the committed space index, which the content is anchored to
 */
export function paintTracks(pos: number, index: number): void {
  const { strip, content, pips, blob } = elements

  // ---- reads ----------------------------------------------------------------
  let blobGeometry: { x: number; width: number; color: string } | null = null
  if (pips && blob) {
    const dots = Array.from(pips.querySelectorAll<HTMLElement>('[data-pip]'))
    if (dots.length > 0) {
      const clamped = Math.max(0, Math.min(dots.length - 1, pos))
      const lo = Math.floor(clamped)
      const hi = Math.min(dots.length - 1, lo + 1)
      const frac = clamped - lo

      const centerOf = (d: HTMLElement) => d.offsetLeft + d.offsetWidth / 2
      const from = centerOf(dots[lo])
      const to = centerOf(dots[hi])

      // Stretch at the midpoint and relax at either end. With the gooey filter
      // on the container this reads as a drop pulling away from one dot and
      // merging into the next rather than a marker teleporting between them.
      const stretch = Math.sin(Math.PI * frac)
      const width = BLOB_WIDTH_PX + stretch * Math.abs(to - from) * BLOB_STRETCH

      blobGeometry = {
        x: lerp(from, to, frac),
        width,
        color: mixHex(spaceColors[lo] ?? '#888888', spaceColors[hi] ?? '#888888', frac),
      }
    }
  }

  const parallax = content
    ? Math.min(CONTENT_PARALLAX_MAX_PX, window.innerWidth * CONTENT_PARALLAX_RATIO)
    : 0

  // ---- writes ---------------------------------------------------------------
  if (strip) {
    // The strip is exactly one viewport wide (its slides overflow it), so 100%
    // is precisely one slide — independent of the rail's collapsed/hover width.
    strip.style.transform = `translateX(${(-pos * 100).toFixed(3)}%)`
  }

  if (blob && blobGeometry) {
    blob.style.width = `${blobGeometry.width.toFixed(2)}px`
    blob.style.transform = `translate(${(blobGeometry.x - blobGeometry.width / 2).toFixed(2)}px, -50%)`
    blob.style.background = blobGeometry.color
  }

  if (content) {
    // Content travels with the gesture, dimming and easing back as it goes, so
    // the whole app reads as moving between spaces rather than a label sliding
    // in the sidebar. Clamped so a rubber-band at either end can't fade the
    // page out entirely.
    const delta = Math.max(-1, Math.min(1, pos - index))
    const magnitude = Math.abs(delta)
    const scale = 1 - magnitude * CONTENT_SCALE
    content.style.transform =
      `translateX(${(-delta * parallax).toFixed(2)}px) scale(${scale.toFixed(4)})`
    content.style.opacity = (1 - magnitude * CONTENT_FADE).toFixed(3)
  }
}
