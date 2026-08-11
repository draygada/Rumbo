import { useEffect, useRef, useState } from 'react'

/*
 * Smooths bursty stream output into a steady reveal.
 *
 * The SSE deltas from tutor-v4-stream do not arrive evenly — Anthropic emits
 * a few characters at a time early on and then whole sentences at once, so
 * rendering each delta immediately looks like text lurching in blocks. This
 * hook holds the authoritative text and releases it at a roughly constant
 * rate on animation frames, which reads as typing rather than stuttering.
 *
 * Behaviour:
 *   - Catches up faster the further behind it falls, so a long burst never
 *     leaves the UI trailing the model by seconds (bounded by MAX_CHARS_FRAME).
 *   - When `done` flips true, the remaining buffer is flushed on the next
 *     frame — the final answer is never left partially revealed.
 *   - Resets cleanly when the source text shrinks (new turn / new chat).
 */

// Baseline reveal speed. ~1.6 chars per 16ms frame ≈ 100 chars/sec, close to
// fast human reading and comfortably slower than the model generates.
const BASE_CHARS_PER_FRAME = 1.6
// Fraction of the outstanding backlog to burn down each frame, so we converge
// instead of accumulating lag on long answers.
const CATCHUP_RATIO = 0.08
// Hard ceiling so a huge burst still animates rather than snapping in.
const MAX_CHARS_FRAME = 24

export function useSmoothStream(fullText: string | null, done = false): string {
  const [shown, setShown] = useState('')
  const shownLenRef = useRef(0)
  const fullRef = useRef('')
  const doneRef = useRef(false)
  const rafRef = useRef<number | null>(null)

  fullRef.current = fullText ?? ''
  doneRef.current = done

  // Reset when the stream is cleared or replaced by a shorter string.
  useEffect(() => {
    const full = fullText ?? ''
    if (full.length < shownLenRef.current) {
      shownLenRef.current = full.length
      setShown(full)
    }
    if (fullText === null) {
      shownLenRef.current = 0
      setShown('')
    }
  }, [fullText])

  useEffect(() => {
    function tick() {
      const full = fullRef.current
      const behind = full.length - shownLenRef.current

      if (behind > 0) {
        // Flush immediately once the server says the answer is complete —
        // waiting to "type out" a finished answer just adds dead time.
        const step = doneRef.current
          ? behind
          : Math.min(MAX_CHARS_FRAME, Math.max(1, Math.ceil(BASE_CHARS_PER_FRAME + behind * CATCHUP_RATIO)))
        shownLenRef.current = Math.min(full.length, shownLenRef.current + step)
        setShown(full.slice(0, shownLenRef.current))
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return shown
}
