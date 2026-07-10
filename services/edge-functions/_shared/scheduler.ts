/**
 * Deterministic scheduling — spec implementation.
 * Shared by schedule-generator edge function.
 */

import { SCHEDULER } from './schedulerConstants.ts'
import { deadlineProximity } from './deadlineProximity.ts'

const SLOT_STEP_MINS = 15

// ─── Types ────────────────────────────────────────────────────────────────

export interface SchedulerProfile {
  unavailable_before: number                               // hour 0–23
  unavailable_after: number                                // hour 0–23
  peak_hour_map: Array<{ hour: number; score: number }>
  block_ceiling_mins: number
  target_block_mins: number
  urgency_threshold: number
  distribution_preference: 'front_load' | 'even' | 'ramp'
  profile_stage: 1 | 2 | 3
  shallow_before_deep: boolean
}

export interface SchedulerTask {
  id: string
  work_type: 'deep' | 'shallow'
  estimated_mins: number
  estimated_mins_remaining: number
  due_at: Date
  created_at: Date
  classifier_confidence: number
  cognitive_demand_override: number | null
}

export interface SchedulerBlock {
  task_id: string
  user_id: string
  starts_at: string
  ends_at: string
  duration_mins: number
  slot_score: number
  placement_score: number
  scheduled_by: 'algorithm'
  status: 'scheduled'
  confidence_adjusted: boolean
  deadline_proximity: number
}

export interface BusyInterval {
  start: Date
  end: Date
}

export interface SchedulerInput {
  user_id: string
  profile: SchedulerProfile
  tasks: SchedulerTask[]
  existing_busy: BusyInterval[]
  horizon_days: number
  now?: Date
}

export interface SchedulerWarning {
  type: 'deadline_at_risk' | 'insufficient_slots' | 'cold_start'
  task_id: string
  message: string
}

export interface SchedulerOutput {
  blocks: SchedulerBlock[]
  warnings: SchedulerWarning[]
}

// ─── Exported helpers (also tested directly) ─────────────────────────────

/**
 * urgency_ratio = estimated_mins_remaining / (mins_until_due / 60)
 * > 1.0 means more work than hours available at a 1:1 pace.
 */
export function urgencyRatio(remaining: number, dueAt: Date, now: Date = new Date()): number {
  const mins = (dueAt.getTime() - now.getTime()) / 60_000
  if (mins <= 0) return Infinity
  return remaining / (mins / 60)
}

export function isUrgencyMode(ratio: number, threshold: number): boolean {
  return ratio > threshold
}

/**
 * Returns actual block duration after applying classifier confidence.
 * ≥ 0.75 → full target  |  0.40–0.75 → 0.75×  |  < 0.40 → 0.50×
 * Clamped to [BLOCK_FLOOR_MINS, block_ceiling_mins].
 */
export function adjustedBlockMins(
  target: number,
  confidence: number,
  ceiling: number,
): { mins: number; confidenceAdjusted: boolean } {
  let multiplier = 1.0
  let confidenceAdjusted = false
  if (confidence < SCHEDULER.CONFIDENCE_PARTIAL_THRESHOLD) {
    multiplier = SCHEDULER.CONFIDENCE_LOW_MULTIPLIER
    confidenceAdjusted = true
  } else if (confidence < SCHEDULER.CONFIDENCE_FULL_THRESHOLD) {
    multiplier = SCHEDULER.CONFIDENCE_PARTIAL_MULTIPLIER
    confidenceAdjusted = true
  }
  const raw = Math.round(target * multiplier)
  const clamped = Math.max(SCHEDULER.BLOCK_FLOOR_MINS, Math.min(raw, ceiling))
  return { mins: clamped, confidenceAdjusted }
}

// ─── Private helpers ──────────────────────────────────────────────────────

function cognitiveDemand(
  workType: 'deep' | 'shallow',
  estimatedMins: number,
  override: number | null,
  confidence: number,
): number {
  if (override !== null) return override
  const deepScore = workType === 'deep' ? confidence : 1 - confidence
  const durationSignal = Math.min(estimatedMins / 90, 1)
  return deepScore * 0.6 + durationSignal * 0.4
}

function computePlacementScore(
  ratio: number,
  demand: number,
  threshold: number,
  urgency: boolean,
): number {
  const normalized = Math.min(ratio / (threshold * 2), 1)
  if (urgency) return normalized
  return SCHEDULER.PLACEMENT_URGENCY_WEIGHT * normalized + SCHEDULER.PLACEMENT_DEMAND_WEIGHT * demand
}

function scoreSlot(
  hour: number,
  profile: SchedulerProfile,
  priorBlocks: Array<{ starts_at: string }>,
  historicalHour: number | null,
  slotDate: Date,
): number {
  if (hour < profile.unavailable_before || hour >= profile.unavailable_after) return 0

  const entry = profile.peak_hour_map.find(h => h.hour === hour)
  let score = entry?.score ?? 0.5

  if (historicalHour !== null && Math.abs(hour - historicalHour) <= 1) {
    score += SCHEDULER.STABILITY_BONUS
  }

  const yesterday = new Date(slotDate)
  yesterday.setDate(yesterday.getDate() - 1)
  const workedYesterday = priorBlocks.some(b => {
    const d = new Date(b.starts_at)
    return (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    )
  })
  if (workedYesterday) score -= SCHEDULER.SPACING_PENALTY

  return Math.max(0, Math.min(1, score))
}

function mergeBusy(intervals: BusyInterval[]): BusyInterval[] {
  if (!intervals.length) return []
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime())
  const merged = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    const cur = sorted[i]
    if (cur.start <= last.end) {
      last.end = new Date(Math.max(last.end.getTime(), cur.end.getTime()))
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

function isFree(start: Date, end: Date, busy: BusyInterval[]): boolean {
  return !busy.some(b => start < b.end && b.start < end)
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function startOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  return r
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function allocateDates(
  available: Date[],
  needed: number,
  preference: 'front_load' | 'even' | 'ramp',
  urgency: boolean,
): Date[] {
  if (!available.length || needed === 0) return []
  const n = Math.min(needed, available.length)
  if (urgency || n >= available.length) return available.slice(0, n)

  const total = available.length
  const earlyEnd = Math.ceil(total * SCHEDULER.EARLY_ANCHOR_FRACTION)
  const midEnd = Math.ceil(total * 0.67)
  const early = available.slice(0, earlyEnd)
  const mid = available.slice(earlyEnd, midEnd)
  const late = available.slice(midEnd)

  const selected = [early[0]]
  const rem = n - 1
  if (rem <= 0) return selected

  let midCount: number
  if (preference === 'front_load') midCount = Math.ceil(rem * 0.7)
  else if (preference === 'ramp') midCount = Math.floor(rem * 0.3)
  else midCount = Math.round(rem / 2)

  selected.push(...pickEvenly(mid, midCount), ...pickEvenly(late, rem - midCount))

  // Distribution can fall short when buckets are smaller than the requested count.
  // Backfill from the full available pool so we always return exactly n dates.
  if (selected.length < n) {
    const seen = new Set(selected.map(d => d.getTime()))
    for (const d of available) {
      if (selected.length >= n) break
      if (!seen.has(d.getTime())) { selected.push(d); seen.add(d.getTime()) }
    }
  }

  return selected.sort((a, b) => a.getTime() - b.getTime())
}

function pickEvenly(days: Date[], count: number): Date[] {
  if (count <= 0 || !days.length) return []
  if (count >= days.length) return [...days]
  const step = days.length / count
  return Array.from({ length: count }, (_, i) => days[Math.floor(i * step)])
}

function findBestSlot(
  date: Date,
  durationMins: number,
  profile: SchedulerProfile,
  busy: BusyInterval[],
  workType: 'deep' | 'shallow',
  priorBlocks: Array<{ starts_at: string }>,
  historicalHour: number | null,
  now: Date,
): { start: Date; end: Date; score: number } | null {
  const durationMs = durationMins * 60_000

  const dayStart = new Date(date)
  dayStart.setHours(profile.unavailable_before, 0, 0, 0)
  const dayEnd = new Date(date)
  dayEnd.setHours(profile.unavailable_after, 0, 0, 0)

  const windowStart = new Date(Math.max(dayStart.getTime(), now.getTime()))
  if (windowStart.getTime() + durationMs > dayEnd.getTime()) return null

  let best: { start: Date; end: Date; score: number } | null = null

  for (
    let t = windowStart.getTime();
    t + durationMs <= dayEnd.getTime();
    t += SLOT_STEP_MINS * 60_000
  ) {
    const slotStart = new Date(t)
    const slotEnd = new Date(t + durationMs)
    if (!isFree(slotStart, slotEnd, busy)) continue

    const score = scoreSlot(slotStart.getHours(), profile, priorBlocks, historicalHour, date)

    // Shallow: first-fit, no need to scan the full day
    if (workType === 'shallow') return { start: slotStart, end: slotEnd, score }

    if (!best || score > best.score || (score === best.score && slotStart < best.start)) {
      best = { start: slotStart, end: slotEnd, score }
    }
  }

  return best
}

function modeHour(blocks: Array<{ starts_at: string }>): number | null {
  if (!blocks.length) return null
  const counts = new Map<number, number>()
  for (const b of blocks) {
    const h = new Date(b.starts_at).getHours()
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  let best = -1, bestCount = 0
  for (const [h, c] of counts) {
    if (c > bestCount) { bestCount = c; best = h }
  }
  return best === -1 ? null : best
}

// ─── Main entry point ─────────────────────────────────────────────────────

export function runScheduler(input: SchedulerInput): SchedulerOutput {
  const { user_id, profile, tasks, existing_busy, horizon_days } = input
  const now = input.now ?? new Date()
  const busy = mergeBusy(existing_busy)
  const blocks: SchedulerBlock[] = []
  const warnings: SchedulerWarning[] = []

  if (profile.profile_stage === 1) {
    warnings.push({ type: 'cold_start', task_id: '', message: 'Profile in accumulation stage — schedule is a prior estimate' })
  }

  const scored = tasks.map(task => {
    const ratio = urgencyRatio(task.estimated_mins_remaining, task.due_at, now)
    const urgency = isUrgencyMode(ratio, profile.urgency_threshold)
    const demand = cognitiveDemand(task.work_type, task.estimated_mins, task.cognitive_demand_override, task.classifier_confidence)
    const score = computePlacementScore(ratio, demand, profile.urgency_threshold, urgency)
    return { task, ratio, urgency, score }
  })

  const deepSorted = scored.filter(t => t.task.work_type === 'deep').sort((a, b) => b.score - a.score)
  const shallowSorted = scored.filter(t => t.task.work_type === 'shallow').sort((a, b) => b.score - a.score)
  const ordered = profile.shallow_before_deep
    ? [...shallowSorted, ...deepSorted]
    : [...deepSorted, ...shallowSorted]

  const deepPerDay = new Map<string, number>()
  const maxDeepPerDay = SCHEDULER.MAX_DEEP_BLOCKS_PER_DAY[profile.profile_stage]

  for (const { task, ratio, urgency, score: pScore } of ordered) {
    if (ratio === Infinity) {
      warnings.push({ type: 'deadline_at_risk', task_id: task.id, message: 'Task is overdue' })
      continue
    }
    if (urgency) {
      warnings.push({ type: 'deadline_at_risk', task_id: task.id, message: `Urgency ratio ${ratio.toFixed(2)} exceeds threshold ${profile.urgency_threshold}` })
    }

    const { mins: blockMins, confidenceAdjusted } = adjustedBlockMins(
      profile.target_block_mins,
      task.classifier_confidence,
      profile.block_ceiling_mins,
    )
    const blocksNeeded = Math.ceil(task.estimated_mins_remaining / blockMins)

    const horizonEnd = addDays(now, horizon_days)
    const cap = task.due_at < horizonEnd ? task.due_at : horizonEnd
    const availableDays: Date[] = []
    let cur = startOfDay(addDays(now, 1))
    const capDay = startOfDay(cap)
    while (cur <= capDay) { availableDays.push(new Date(cur)); cur = addDays(cur, 1) }

    const targetDates = allocateDates(availableDays, blocksNeeded, profile.distribution_preference, urgency)

    const taskBlocks = blocks.filter(b => b.task_id === task.id).map(b => ({ starts_at: b.starts_at }))
    const historicalHour = modeHour(taskBlocks)

    let placed = 0
    let minsRemaining = task.estimated_mins_remaining
    for (const date of targetDates) {
      if (placed >= blocksNeeded || minsRemaining <= 0) break
      if (task.work_type === 'deep') {
        const key = dateKey(date)
        if ((deepPerDay.get(key) ?? 0) >= maxDeepPerDay) continue
      }

      // Use remaining minutes but never go below the floor or above the target.
      // This ensures total always meets or overshoots estimated_mins_remaining
      // by the smallest amount possible, and deep blocks are never < 25 min.
      const thisMins = Math.min(blockMins, Math.max(SCHEDULER.BLOCK_FLOOR_MINS, minsRemaining))

      const slot = findBestSlot(date, thisMins, profile, busy, task.work_type, taskBlocks, historicalHour, now)
      if (!slot) continue

      const proximity = deadlineProximity(task.created_at, task.due_at, slot.start)
      blocks.push({
        task_id: task.id, user_id,
        starts_at: slot.start.toISOString(), ends_at: slot.end.toISOString(),
        duration_mins: thisMins, slot_score: slot.score, placement_score: pScore,
        scheduled_by: 'algorithm', status: 'scheduled',
        confidence_adjusted: confidenceAdjusted, deadline_proximity: proximity,
      })
      busy.push({ start: slot.start, end: slot.end })
      if (task.work_type === 'deep') {
        const key = dateKey(date)
        deepPerDay.set(key, (deepPerDay.get(key) ?? 0) + 1)
      }
      minsRemaining -= thisMins
      placed++
    }

    if (placed < blocksNeeded) {
      warnings.push({ type: 'insufficient_slots', task_id: task.id, message: `Placed ${placed}/${blocksNeeded} blocks — not enough free time before deadline` })
    }
  }

  return { blocks, warnings }
}

// ─── DB adapter helpers ───────────────────────────────────────────────────

/** Parse "HH:MM" string → hour integer (0–23). */
export function parseHour(hhmm: string): number {
  return parseInt(hhmm.split(':')[0], 10)
}

/** Convert DB peak_hour_map (Record<string, number>) → HourScore[]. */
export function parsePeakHourMap(raw: Record<string, number>): Array<{ hour: number; score: number }> {
  return Array.from({ length: 24 }, (_, h) => ({ hour: h, score: raw[String(h)] ?? 0.5 }))
}
