// -----------------------------------------------------------------------------
// useSpaceSwipe — two-finger swipe across the rail to change space.
//
// A trackpad swipe arrives as `wheel` events carrying deltaX. Three things make
// the raw event stream fiddly, and all three are handled below:
//
//  1. Axis. Vertical scrolling also fires wheel events; claiming those would
//     break scrolling anywhere the rail overlaps. We only take the gesture when
//     |deltaX| > |deltaY|.
//  2. preventDefault. Needed so the browser doesn't read the gesture as history
//     back-navigation — which requires a non-passive listener, hence the manual
//     addEventListener rather than React's onWheel.
//  3. Momentum. macOS keeps firing decaying deltaX for a few hundred ms after
//     the fingers lift. Rather than latching the whole tail out (which froze the
//     animation mid-move), the position is clamped to one space either side of
//     where the gesture started, so momentum can finish the move it began but
//     can never skip past it.
//
// MOTION MODEL. Position is a floating space index — 1.35 is 35% of the way from
// space 1 to space 2 — held in a ref and integrated by a single rAF loop that
// writes transforms straight to the DOM (see spaceMotion.ts). React state
// changes exactly once per gesture, when the committed space actually changes.
//
// The settle is a damped spring rather than a CSS transition, because a
// transition always starts from rest: it would throw away the speed your fingers
// had and restart the easing curve, which is the discontinuity that made the
// previous version feel stepped. The spring is seeded with the gesture's live
// velocity, so the hand-off is invisible. Release direction is decided by
// projecting that velocity forward, so a fast flick commits even if it was
// short — the thing that makes a gesture feel responsive rather than heavy.
// -----------------------------------------------------------------------------

import { useEffect, useRef } from 'react'
import { paintTracks } from './spaceMotion'

/** Finger travel, in px, that equals one full space. */
const SLIDE_TRAVEL_PX = 150
/** Spring: ratio ~0.9, so it arrives fast with barely any overshoot. */
const STIFFNESS = 280
const DAMPING = 30
const MASS = 1
/** Below these, the spring has arrived and the loop can stop. */
const REST_POS = 0.001
const REST_VEL = 0.02
/** Silence, in ms, that means the fingers have lifted. */
const GESTURE_END_MS = 90
/** How far ahead velocity is projected when deciding where a release lands. */
const PROJECTION_S = 0.1
/** Frame clamp, so a backgrounded tab can't integrate one enormous step. */
const MAX_DT = 1 / 30

interface Options {
  count: number
  index: number
  onChange: (nextIndex: number) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function useSpaceSwipe<T extends HTMLElement>({ count, index, onChange }: Options) {
  const ref = useRef<T | null>(null)

  // Live props for the listener and the loop, which are bound once.
  const live = useRef({ count, index, onChange })
  live.current = { count, index, onChange }

  const sim = useRef({
    pos: index,          // rendered floating index
    vel: 0,              // spaces per second
    target: index,       // spring rest position
    gesturing: false,
    gestureStart: index, // clamp anchor: one space either side of here
    running: false,
    raf: 0,
    lastFrame: 0,
    lastEventTs: 0,
    endTimer: null as ReturnType<typeof setTimeout> | null,
  })

  // Set by the effect below; lets any other trigger (pip, keyboard) restart the
  // one shared integrator rather than running a second copy of it.
  const ensureLoopRef = useRef<() => void>(() => {})

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const s = sim.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function frame(now: number) {
      const st = sim.current
      const dt = Math.min(MAX_DT, (now - st.lastFrame) / 1000) || 1 / 60
      st.lastFrame = now

      if (!st.gesturing) {
        // Damped spring toward the committed space. Seeded with whatever
        // velocity the fingers left behind, so release is continuous.
        const displacement = st.pos - st.target
        const accel = (-STIFFNESS * displacement - DAMPING * st.vel) / MASS
        st.vel += accel * dt
        st.pos += st.vel * dt

        if (Math.abs(st.pos - st.target) < REST_POS && Math.abs(st.vel) < REST_VEL) {
          st.pos = st.target
          st.vel = 0
          paintTracks(st.pos, live.current.index)
          st.running = false
          return
        }
      }

      paintTracks(st.pos, live.current.index)
      st.raf = requestAnimationFrame(frame)
    }

    function ensureLoop() {
      const st = sim.current
      if (st.running) return
      st.running = true
      st.lastFrame = performance.now()
      st.raf = requestAnimationFrame(frame)
    }
    ensureLoopRef.current = ensureLoop

    function endGesture() {
      const st = sim.current
      const { count: n, onChange: change } = live.current
      st.gesturing = false

      // Where the current speed would carry us — a short fast flick lands the
      // same as a long slow drag, which is what makes it feel responsive.
      const projected = st.pos + st.vel * PROJECTION_S
      const landing = clamp(
        Math.round(projected),
        Math.max(0, st.gestureStart - 1),
        Math.min(n - 1, st.gestureStart + 1),
      )

      st.target = landing
      if (landing !== live.current.index) change(landing)
      ensureLoop()
    }

    function onWheel(e: WheelEvent) {
      // Vertical intent — leave it to the page.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()

      const st = sim.current
      const { count: n, onChange: change } = live.current
      if (n <= 1) return

      if (!st.gesturing) {
        st.gesturing = true
        // Anchor to the nearest whole space so a gesture started mid-settle
        // still moves exactly one space.
        st.gestureStart = clamp(Math.round(st.pos), 0, n - 1)
        st.lastEventTs = e.timeStamp - 8
      }

      if (st.endTimer) clearTimeout(st.endTimer)
      st.endTimer = setTimeout(endGesture, GESTURE_END_MS)

      const before = st.pos
      const delta = e.deltaX / SLIDE_TRAVEL_PX
      st.pos = clamp(
        st.pos + delta,
        Math.max(0, st.gestureStart - 1),
        Math.min(n - 1, st.gestureStart + 1),
      )

      // Velocity from the movement actually applied over the REAL interval
      // between events — a fixed divisor would read a fast flick and a slow
      // drag as the same speed, which is exactly what release projection needs
      // to tell apart. Clamped because the first event of a gesture and any
      // scheduling hiccup produce meaningless intervals.
      const dt = clamp((e.timeStamp - st.lastEventTs) / 1000, 1 / 240, MAX_DT)
      st.lastEventTs = e.timeStamp
      const instant = (st.pos - before) / dt
      // Smoothed, so one jittery event can't throw the release decision. The
      // clamp above also means travel lost at the ends bleeds speed off rather
      // than banking it for the release.
      st.vel = st.vel * 0.7 + instant * 0.3

      // Recolour the app the moment the halfway line is crossed, rather than
      // waiting for the fingers to lift — the content and the gesture stay in
      // step. The clamp above caps this at one crossing per gesture.
      const crossed = clamp(Math.round(st.pos), 0, n - 1)
      if (crossed !== live.current.index) change(crossed)

      if (reduced) {
        st.pos = crossed
        st.vel = 0
      }
      ensureLoop()
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    paintTracks(s.pos, live.current.index)

    return () => {
      el.removeEventListener('wheel', onWheel)
      const st = sim.current
      if (st.endTimer) clearTimeout(st.endTimer)
      if (st.raf) cancelAnimationFrame(st.raf)
      st.running = false
    }
  }, [])

  // Any other route to a new space — a pip click, the keyboard, deleting the
  // space you were in — springs there through the same loop.
  useEffect(() => {
    const st = sim.current
    if (st.gesturing || st.target === index) return
    st.target = index
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      st.pos = index
      st.vel = 0
      paintTracks(st.pos, index)
      return
    }
    ensureLoopRef.current()
  }, [index])

  // Keyboard equivalent. A mouse can't produce deltaX at all, so this isn't a
  // nicety — without it the feature is unreachable on a non-trackpad machine.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || !(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const { count: n, index: i, onChange: change } = live.current
      if (n <= 1) return
      e.preventDefault()
      const next = clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, n - 1)
      if (next !== i) change(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return { ref }
}
