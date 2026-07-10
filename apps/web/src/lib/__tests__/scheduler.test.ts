import { compositeScore } from '../../../../../supabase/functions/_shared/compositeScore'
import { urgencyRatio, isUrgencyMode, adjustedBlockMins } from '../../../../../supabase/functions/_shared/scheduler'
import { deadlineProximity, proximityBucket } from '../../../../../supabase/functions/_shared/deadlineProximity'
import { SCHEDULER } from '../../../../../supabase/functions/_shared/schedulerConstants'

// ─── compositeScore ───────────────────────────────────────────────────────

// productivity=5, energy=5, distraction=1 → (5+5+(6-1))/3 = 15/3 = 5.0
test('compositeScore: perfect session', () => {
  expect(compositeScore(5, 5, 1)).toBeCloseTo(5.0)
})

test('compositeScore: worst session', () => {
  expect(compositeScore(1, 1, 5)).toBeCloseTo(1.0)
})

test('compositeScore: average session', () => {
  expect(compositeScore(3, 3, 3)).toBeCloseTo(3.0)
})

// ─── urgencyRatio ─────────────────────────────────────────────────────────

test('urgencyRatio: 180 mins remaining, due in 7 days', () => {
  const now = new Date('2024-01-01T09:00:00Z')
  const due = new Date('2024-01-08T09:00:00Z')
  expect(urgencyRatio(180, due, now)).toBeCloseTo(1.07, 1)
})

test('urgencyRatio: 180 mins remaining, due in 2 days', () => {
  const now = new Date('2024-01-01T09:00:00Z')
  const due = new Date('2024-01-03T09:00:00Z')
  expect(urgencyRatio(180, due, now)).toBeCloseTo(3.75, 1)
})

test('isUrgencyMode: above threshold', () => {
  expect(isUrgencyMode(3.75, 2.0)).toBe(true)
})

test('isUrgencyMode: below threshold', () => {
  expect(isUrgencyMode(1.07, 2.0)).toBe(false)
})

// ─── adjustedBlockMins ────────────────────────────────────────────────────

test('adjustedBlockMins: high confidence → full block', () => {
  const result = adjustedBlockMins(60, 0.90, 60)
  expect(result.mins).toBe(60)
  expect(result.confidenceAdjusted).toBe(false)
})

test('adjustedBlockMins: mid confidence → 75% block', () => {
  const result = adjustedBlockMins(60, 0.55, 60)
  expect(result.mins).toBe(45)
  expect(result.confidenceAdjusted).toBe(true)
})

test('adjustedBlockMins: low confidence → 50% block, never below floor', () => {
  const result = adjustedBlockMins(60, 0.30, 60)
  expect(result.mins).toBe(30)
  expect(result.confidenceAdjusted).toBe(true)
})

test('adjustedBlockMins: low confidence, small target → clamped to floor', () => {
  const result = adjustedBlockMins(40, 0.30, 60)
  expect(result.mins).toBe(SCHEDULER.BLOCK_FLOOR_MINS)
})

// ─── deadlineProximity ────────────────────────────────────────────────────

test('deadlineProximity: session on day of creation → 0', () => {
  expect(deadlineProximity(new Date('2024-01-01'), new Date('2024-01-08'), new Date('2024-01-01'))).toBeCloseTo(0, 1)
})

test('deadlineProximity: session halfway through → 0.5', () => {
  expect(deadlineProximity(new Date('2024-01-01'), new Date('2024-01-09'), new Date('2024-01-05'))).toBeCloseTo(0.5, 1)
})

test('proximityBucket: 0.2 → early', () => {
  expect(proximityBucket(0.2)).toBe('early')
})

test('proximityBucket: 0.5 → middle', () => {
  expect(proximityBucket(0.5)).toBe('middle')
})

test('proximityBucket: 0.8 → late', () => {
  expect(proximityBucket(0.8)).toBe('late')
})
