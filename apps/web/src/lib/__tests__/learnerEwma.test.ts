/*
 * Tests for the learner-brain aggregation math.
 *
 * The module under test lives in services/edge-functions/_shared/ because it
 * runs in Deno, but vitest's root is apps/web, so the test lives here and
 * reaches across. That is only possible because learner-ewma.ts is
 * deliberately dependency-free — no Deno globals, no Neo4j, no Supabase.
 * Keep it that way and this file keeps running.
 *
 * What's worth pinning down is the time-weighting, because it is the part
 * that silently produces plausible-but-wrong numbers: nothing crashes when
 * decay is applied against the wrong timestamp, the profile is just subtly
 * false.
 */

import { describe, expect, it } from 'vitest'
import {
  decayFactor,
  deriveZpdEdge,
  ewmaUpdate,
  foldConceptMastery,
  decayUntouchedMastery,
  MASTERY_IDLE_HALF_LIFE_DAYS,
  STRUGGLE_IDLE_HALF_LIFE_DAYS,
  type MasteryState,
} from '../../../../../services/edge-functions/_shared/learner-ewma.ts'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 7, 1) // 2026-08-01, fixed — no wall clock in tests

describe('decayFactor', () => {
  it('halves at exactly one half-life', () => {
    expect(decayFactor(30, 30)).toBeCloseTo(0.5, 10)
    expect(decayFactor(60, 30)).toBeCloseTo(0.25, 10)
  })

  it('is a no-op for zero or negative elapsed time', () => {
    expect(decayFactor(0, 30)).toBe(1)
    expect(decayFactor(-5, 30)).toBe(1)
  })
})

describe('ewmaUpdate', () => {
  it('leaves the prior untouched when there are no signals', () => {
    const r = ewmaUpdate(0.8, T0, [], 30)
    expect(r.value).toBe(0.8)
    expect(r.at).toBe(T0)
  })

  it('moves a prior of 0 nearly all the way to a signal one half-life later', () => {
    // decay = 0.5, so value = 0.5*0 + 0.5*1 = 0.5
    const r = ewmaUpdate(0, T0, [{ at: T0 + 30 * DAY, value: 1 }], 30)
    expect(r.value).toBeCloseTo(0.5, 10)
    expect(r.at).toBe(T0 + 30 * DAY)
  })

  it('barely moves for a signal arriving immediately after the prior update', () => {
    // Near-zero elapsed time means near-zero weight on the new signal: this is
    // what stops a single burst of chat from overwriting months of history.
    const r = ewmaUpdate(0.2, T0, [{ at: T0 + 60_000, value: 1 }], 30)
    expect(r.value).toBeCloseTo(0.2, 3)
  })

  it('treats ten signals in one evening as roughly one piece of evidence', () => {
    // The regression this guards: if the update time did NOT advance per
    // signal, each of the ten would be weighted against the previous night and
    // the last would nearly overwrite the prior. Ten signals an hour apart
    // should barely move a 30-day half-life.
    const burst = Array.from({ length: 10 }, (_, i) => ({
      at: T0 + 30 * DAY + i * 3_600_000,
      value: 1,
    }))
    const clustered = ewmaUpdate(0, T0, burst, 30)
    const single = ewmaUpdate(0, T0, [{ at: T0 + 30 * DAY, value: 1 }], 30)
    expect(clustered.value - single.value).toBeLessThan(0.02)
  })

  it('sorts out-of-order signals rather than trusting the caller', () => {
    const ordered = ewmaUpdate(0, T0, [
      { at: T0 + 10 * DAY, value: 0.2 },
      { at: T0 + 40 * DAY, value: 0.9 },
    ], 30)
    const shuffled = ewmaUpdate(0, T0, [
      { at: T0 + 40 * DAY, value: 0.9 },
      { at: T0 + 10 * DAY, value: 0.2 },
    ], 30)
    expect(shuffled.value).toBeCloseTo(ordered.value, 10)
  })

  it('clamps into [0, 1]', () => {
    const r = ewmaUpdate(0.5, T0, [{ at: T0 + 90 * DAY, value: 5 }], 30)
    expect(r.value).toBeLessThanOrEqual(1)
  })
})

describe('foldConceptMastery', () => {
  it('lands a first signal at full weight rather than decaying it against an epoch', () => {
    const at = T0 + 5 * DAY
    const state = foldConceptMastery(
      null,
      { struggle: [{ at, value: 0.9 }], understanding: [] },
      at,
    )
    expect(state.struggle_score).toBeCloseTo(0.9, 10)
    expect(state.mastery_score).toBe(0)
    expect(state.interactions_count).toBe(1)
    expect(state.first_seen_at).toBe(at)
  })

  it('ages mastery through a struggle-only turn instead of freezing it', () => {
    // A turn where the student only expressed confusion is not evidence that
    // their prior understanding survived — mastery must keep decaying.
    const prior: MasteryState = {
      struggle_score: 0.1,
      mastery_score: 0.8,
      interactions_count: 5,
      first_seen_at: T0,
      last_seen_at: T0,
      last_updated_at: T0,
      zpd_edge: 'mastered',
    }
    const now = T0 + MASTERY_IDLE_HALF_LIFE_DAYS * DAY
    const state = foldConceptMastery(
      prior,
      { struggle: [{ at: now, value: 1 }], understanding: [] },
      now,
    )
    expect(state.mastery_score).toBeCloseTo(0.4, 6)
    expect(state.struggle_score).toBeGreaterThan(prior.struggle_score)
  })

  it('counts every signal toward interactions_count', () => {
    const now = T0 + DAY
    const state = foldConceptMastery(null, {
      struggle: [{ at: T0, value: 0.5 }],
      understanding: [{ at: T0, value: 0.5 }, { at: now, value: 0.5 }],
    }, now)
    expect(state.interactions_count).toBe(3)
  })
})

describe('decayUntouchedMastery', () => {
  const prior: MasteryState = {
    struggle_score: 0.8,
    mastery_score: 0.8,
    interactions_count: 10,
    first_seen_at: T0,
    last_seen_at: T0,
    last_updated_at: T0,
    zpd_edge: 'mastered',
  }

  it('fades mastery faster than struggle — the asymmetry is the model', () => {
    const after = decayUntouchedMastery(prior, T0 + 30 * DAY)
    expect(after.mastery_score).toBeCloseTo(0.4, 6)
    // 30 days at a 90-day half-life leaves ~79%, not 50%.
    expect(after.struggle_score).toBeCloseTo(0.8 * Math.pow(0.5, 30 / STRUGGLE_IDLE_HALF_LIFE_DAYS), 6)
    expect(after.struggle_score).toBeGreaterThan(after.mastery_score)
  })

  it('does not invent interactions or move last_seen_at', () => {
    const after = decayUntouchedMastery(prior, T0 + 30 * DAY)
    expect(after.interactions_count).toBe(10)
    expect(after.last_seen_at).toBe(T0)
    expect(after.last_updated_at).toBe(T0 + 30 * DAY)
  })

  it('is stable across run granularity — one 30-day gap equals thirty nightly runs', () => {
    // Idempotence under re-running is the property the watermark design leans
    // on. If nightly decay compounded differently from a single catch-up run,
    // a missed night would permanently skew the profile.
    let nightly = prior
    for (let d = 1; d <= 30; d += 1) nightly = decayUntouchedMastery(nightly, T0 + d * DAY)
    const oneShot = decayUntouchedMastery(prior, T0 + 30 * DAY)
    expect(nightly.mastery_score).toBeCloseTo(oneShot.mastery_score, 10)
    expect(nightly.struggle_score).toBeCloseTo(oneShot.struggle_score, 10)
  })
})

describe('deriveZpdEdge', () => {
  it('stays silent below three interactions', () => {
    expect(deriveZpdEdge(0.9, 0, 1)).toBeNull()
    expect(deriveZpdEdge(0.9, 0, 2)).toBeNull()
    expect(deriveZpdEdge(0.9, 0, 3)).toBe('mastered')
  })

  it('does not call a high-struggle concept mastered just because mastery is high', () => {
    // The student who keeps coming back and keeps hitting the wall.
    expect(deriveZpdEdge(0.8, 0.8, 12)).toBe('needs_worked_example')
  })

  it('buckets across the range', () => {
    expect(deriveZpdEdge(0.9, 0.1, 10)).toBe('mastered')
    expect(deriveZpdEdge(0.5, 0.2, 10)).toBe('can_apply_with_help')
    expect(deriveZpdEdge(0.3, 0.4, 10)).toBe('needs_worked_example')
    expect(deriveZpdEdge(0.1, 0.9, 10)).toBe('pre_conceptual')
  })
})
