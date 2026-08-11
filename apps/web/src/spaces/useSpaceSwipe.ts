// -----------------------------------------------------------------------------
// useSpaceSwipe — two-finger horizontal swipe over the rail to change space.
//
// A trackpad swipe arrives as `wheel` events carrying deltaX. Three things make
// this fiddly, and all three are handled below:
//
//  1. Axis. Vertical scrolling also fires wheel events; claiming those would
//     break scrolling anywhere the rail overlaps. We only take the gesture when
//     |deltaX| > |deltaY|.
//  2. Momentum. macOS keeps firing decaying deltaX for a few hundred ms after
//     the fingers lift. Without a latch a single flick skips three spaces, so
//     after a commit we ignore everything until the stream goes quiet.
//  3. preventDefault. Needed so the browser doesn't read the gesture as history
//     back-navigation — which requires a non-passive listener, hence the manual
//     addEventListener rather than React's onWheel.
//
// The accumulator is exposed as `dragX` so the strip can track the fingers and
// then snap, instead of jumping at a threshold (which reads as a bug).
// -----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'

/** Horizontal travel, in px, that commits a switch. */
const THRESHOLD = 56
/** Silence that ends a gesture, in ms — long enough to outlast momentum. */
const QUIET_MS = 140
/** Resistance applied when swiping past the first/last space. */
const RUBBER_BAND = 0.28

interface Options {
  count: number
  index: number
  onChange: (nextIndex: number) => void
}

export function useSpaceSwipe<T extends HTMLElement>({ count, index, onChange }: Options) {
  const ref = useRef<T | null>(null)
  const [dragX, setDragX] = useState(0)

  // Live values for the listener, which is bound once and must not close over
  // stale props.
  const state = useRef({ count, index, onChange })
  state.current = { count, index, onChange }

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let acc = 0
    let latched = false
    let quiet: ReturnType<typeof setTimeout> | null = null

    function reset() {
      acc = 0
      latched = false
      setDragX(0)
    }

    function onWheel(e: WheelEvent) {
      // Vertical intent — leave it to the page.
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()

      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(reset, QUIET_MS)

      // Still inside the momentum tail of a committed swipe.
      if (latched) return

      const { count: n, index: i, onChange: change } = state.current
      if (n <= 1) return

      acc += e.deltaX
      const atStart = i === 0 && acc < 0
      const atEnd = i === n - 1 && acc > 0
      setDragX(-(atStart || atEnd ? acc * RUBBER_BAND : acc))

      if (!atStart && !atEnd && Math.abs(acc) >= THRESHOLD) {
        const next = Math.min(n - 1, Math.max(0, i + (acc > 0 ? 1 : -1)))
        if (next !== i) change(next)
        latched = true
        acc = 0
        setDragX(0)
      }
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (quiet) clearTimeout(quiet)
    }
  }, [])

  // Keyboard equivalent. A mouse can't produce deltaX at all, so this isn't a
  // nicety — without it the feature is unreachable on a non-trackpad machine.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || !(e.metaKey || e.ctrlKey)) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const { count: n, index: i, onChange: change } = state.current
      if (n <= 1) return
      e.preventDefault()
      const next = Math.min(n - 1, Math.max(0, i + (e.key === 'ArrowRight' ? 1 : -1)))
      if (next !== i) change(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return { ref, dragX }
}
