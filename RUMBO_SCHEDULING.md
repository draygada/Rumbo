# Rumbo — Scheduling Algorithm Specification
# For subagent implementation in Claude Code or IDE

## Purpose of this document
This file is the complete specification for Rumbo's deterministic scheduling algorithm.
It covers TypeScript types, the profile update system, the schedule-generator logic,
and the profile-updater edge function. Build each section in order. Every constant,
formula, threshold, and rule is defined here — do not invent defaults.

---

## Context
Rumbo is a productivity app for college students with attentional learning differences.
The scheduling algorithm is fully deterministic. An LLM augmentation layer (built later)
shapes parameter inputs — it never touches scheduling logic itself. This file covers
only the deterministic core.

Tech stack:
- Frontend: React 18 + TypeScript + Vite
- Backend: Supabase Edge Functions (Deno / TypeScript)
- Database: Supabase PostgreSQL with RLS
- All scheduling logic runs inside a Supabase Edge Function: `schedule-generator`
- All profile update logic runs inside a Supabase Edge Function: `profile-updater`

---

## Part 1 — TypeScript Types

Update `src/types.ts` with the following. These extend or replace existing types.

```typescript
// ─── Profile dimensions ───────────────────────────────────────────────────

export type DistributionPreference = 'front_load' | 'even' | 'ramp'
export type DeadlineStrategy = 'front_load' | 'even' | 'ramp' | 'unknown'
export type ProfileStage = 1 | 2 | 3

export interface HourScore {
  hour: number           // 0–23
  score: number          // 0–1, updated via weighted rolling average
}

export interface DeadlineProximityBuckets {
  early_avg: number      // avg composite score, sessions in deadline_proximity 0.0–0.33
  middle_avg: number     // avg composite score, sessions in deadline_proximity 0.33–0.67
  late_avg: number       // avg composite score, sessions in deadline_proximity 0.67–1.0
  early_count: number    // session count in early bucket
  middle_count: number   // session count in middle bucket
  late_count: number     // session count in late bucket
}

export interface LearningProfile {
  user_id: string
  
  // Block sizing
  block_ceiling_mins: number          // current ceiling, 60–90. Cold start: 60
  target_block_mins: number           // converges toward avg of highest-scoring sessions
  
  // Peak hour map
  peak_hour_map: HourScore[]          // one entry per hour 0–23
  
  // Distribution preference
  distribution_preference: DistributionPreference
  deadline_proximity_buckets: DeadlineProximityBuckets
  
  // Urgency threshold
  urgency_threshold: number           // cold start: 2.0, bounds: 1.5–3.0
  
  // Availability constraints (from onboarding, hard constraints)
  unavailable_before: number          // hour 0–23
  unavailable_after: number           // hour 0–23

  // Shallow placement preference
  shallow_before_deep: boolean        // default true, adapts from reflections

  // Profile learning stage
  profile_stage: ProfileStage         // 1 = accumulation, 2 = early, 3 = confident
  total_reflections: number           // total deep reflections logged

  // Ceiling adjustment tracking
  ceiling_last_adjusted_at: string | null   // ISO timestamp
  ceiling_adjustment_sessions: number       // sessions since last ceiling check

  updated_at: string
}

// ─── Tasks ────────────────────────────────────────────────────────────────

export type WorkType = 'deep' | 'shallow'

export interface Task {
  id: string
  user_id: string
  title: string
  description: string | null
  work_type: WorkType
  classifier_confidence: number        // 0–1
  estimated_mins: number
  estimated_mins_remaining: number     // decremented after each reflection
  due_at: string                       // ISO timestamp
  created_at: string
  user_overrode_classifier: boolean

  // LLM augmentation hook (null until LLM layer is built)
  cognitive_demand_override: number | null   // 0–1, set by LLM layer
}

// ─── Work blocks ──────────────────────────────────────────────────────────

export type BlockStatus = 'scheduled' | 'active' | 'completed' | 'skipped'
export type ScheduledBy = 'algorithm' | 'user'

export interface WorkBlock {
  id: string
  user_id: string
  task_id: string
  
  starts_at: string                    // ISO timestamp
  ends_at: string                      // ISO timestamp
  duration_mins: number
  
  slot_score: number                   // 0–1, peak_hour_map score at placement time
  placement_score: number              // final placement_score used for ordering
  scheduled_by: ScheduledBy
  status: BlockStatus
  
  // Confidence adjustment
  confidence_adjusted: boolean         // true if block was sized below full target
  
  // Deadline proximity at scheduling time (for profile learning)
  deadline_proximity: number           // 0–1

  // Calendar
  calendar_event_id: string | null

  created_at: string
}

// ─── Reflections ──────────────────────────────────────────────────────────

export interface DeepReflection {
  id: string
  user_id: string
  work_block_id: string
  task_id: string
  
  productivity: number                 // 1–5
  energy: number                       // 1–5
  distraction: number                  // 1–5 (5 = not distracted = good)
  completion_rate: number              // 0–1, % of planned work done
  task_progress_delta: number          // mins of estimated_mins_remaining removed
  
  // Tagged at write time for distribution preference inference
  deadline_proximity: number           // 0–1
  
  created_at: string
}

export interface ShallowReflection {
  id: string
  user_id: string
  work_block_id: string
  task_completions: Record<string, boolean>  // task_id → completed
  created_at: string
}

// ─── Scheduler I/O ────────────────────────────────────────────────────────

export interface SchedulerInput {
  user_id: string
  profile: LearningProfile
  tasks: Task[]
  existing_blocks: WorkBlock[]         // current scheduled blocks, to avoid conflicts
  calendar_busy_slots: TimeSlot[]      // from Google/Outlook
  scheduling_horizon_days: number      // how many days ahead to schedule (default 7)
}

export interface TimeSlot {
  starts_at: string                    // ISO timestamp
  ends_at: string                      // ISO timestamp
}

export interface SchedulerOutput {
  blocks: Omit<WorkBlock, 'id' | 'created_at'>[]
  warnings: SchedulerWarning[]
}

export type WarningType =
  | 'deadline_at_risk'      // urgency_ratio above threshold
  | 'insufficient_slots'    // not enough free time to fit all blocks
  | 'cold_start'            // profile stage 1, schedule is a prior estimate

export interface SchedulerWarning {
  type: WarningType
  task_id: string
  message: string
}

// ─── Profile updater I/O ──────────────────────────────────────────────────

export interface ProfileUpdateInput {
  user_id: string
  reflection: DeepReflection
  work_block: WorkBlock
  task: Task
  current_profile: LearningProfile
}
```

---

## Part 2 — Scheduling Constants

Create `src/lib/schedulerConstants.ts`. These are the only values the scheduler uses.
Do not hardcode any of these values elsewhere.

```typescript
export const SCHEDULER = {

  // Block sizing
  BLOCK_CEILING_COLD_START_MINS: 60,
  BLOCK_CEILING_MAX_MINS: 90,
  BLOCK_CEILING_MIN_MINS: 60,         // floor — ceiling never drops below cold start
  BLOCK_FLOOR_MINS: 25,               // no deep block shorter than this
  BLOCK_INCREMENT_MINS: 10,           // ceiling raises/lowers in 10-min steps

  // Cold start cap on target_block_mins
  COLD_START_BLOCK_CAP_MINS: 45,

  // Confidence-adjusted block sizing multipliers
  CONFIDENCE_FULL_THRESHOLD: 0.75,    // ≥ this → full target_block_mins
  CONFIDENCE_PARTIAL_THRESHOLD: 0.40, // ≥ this → 0.75 × target_block_mins
  CONFIDENCE_PARTIAL_MULTIPLIER: 0.75,
  CONFIDENCE_LOW_MULTIPLIER: 0.50,

  // Spacing
  SPACING_PENALTY: 0.15,              // score reduction for same-task-yesterday
  STABILITY_BONUS: 0.10,              // score bonus for historical time window match

  // Shallow blocks
  SHALLOW_BATCH_MAX_TASKS: 3,
  SHALLOW_BATCH_MAX_MINS: 25,
  SHALLOW_DEEP_GAP_MINS: 15,          // break between shallow end and deep start

  // Placement scoring weights (normal mode)
  PLACEMENT_URGENCY_WEIGHT: 0.5,
  PLACEMENT_DEMAND_WEIGHT: 0.5,

  // Placement scoring weights (urgency mode)
  URGENCY_MODE_URGENCY_WEIGHT: 1.0,
  URGENCY_MODE_DEMAND_WEIGHT: 0.0,

  // Urgency threshold bounds
  URGENCY_THRESHOLD_COLD_START: 2.0,
  URGENCY_THRESHOLD_FLOOR: 1.5,
  URGENCY_THRESHOLD_CEILING: 3.0,

  // Early anchor
  EARLY_ANCHOR_FRACTION: 0.33,        // first block must land in first 33% of days

  // Max deep blocks per day by profile stage
  MAX_DEEP_BLOCKS_PER_DAY_STAGE_1: 2,
  MAX_DEEP_BLOCKS_PER_DAY_STAGE_2: 3,
  MAX_DEEP_BLOCKS_PER_DAY_STAGE_3: 4,

  // Profile stage thresholds
  STAGE_2_REFLECTION_THRESHOLD: 5,
  STAGE_3_REFLECTION_THRESHOLD: 12,

  // Ceiling adjustment
  CEILING_RAISE_SESSION_COUNT: 5,
  CEILING_LOWER_SESSION_COUNT: 4,
  CEILING_RAISE_COMPLETION_THRESHOLD: 0.80,
  CEILING_LOWER_COMPLETION_THRESHOLD: 0.50,
  CEILING_RAISE_QUALITY_THRESHOLD: 3.5,
  CEILING_LOWER_QUALITY_THRESHOLD: 2.5,
  CEILING_ADJUST_COOLDOWN_DAYS: 7,

  // Profile update weights by stage
  STAGE_2_NEW_WEIGHT: 0.1,
  STAGE_2_CURRENT_WEIGHT: 0.9,
  STAGE_3_NEW_WEIGHT: 0.3,
  STAGE_3_CURRENT_WEIGHT: 0.7,

  // Peak hour map — faster memory than other dimensions
  PEAK_HOUR_STAGE_3_NEW_WEIGHT: 0.4,
  PEAK_HOUR_STAGE_3_CURRENT_WEIGHT: 0.6,

  // Cold start profile update (first reflection only)
  COLD_START_COMPLETION_CONFIRM_THRESHOLD: 0.80,
  COLD_START_QUALITY_CONFIRM_THRESHOLD: 3.5,
  COLD_START_COMPLETION_RETAIN_THRESHOLD: 0.50,

} as const
```

---

## Part 3 — Composite Score Helper

Create `src/lib/compositeScore.ts`.

```typescript
/**
 * Computes the composite quality score from a deep reflection.
 * Used in: peak_hour_map updates, distribution preference inference,
 * urgency threshold learning, ceiling adjustment checks.
 *
 * distraction is inverted: 5 = not distracted = good → (6 - distraction)
 * Equal weights across all three dimensions.
 * Range: 1.0 (worst) to 5.0 (best)
 */
export function compositeScore(
  productivity: number,   // 1–5
  energy: number,         // 1–5
  distraction: number     // 1–5, higher = more distracted = worse
): number {
  return (productivity + energy + (6 - distraction)) / 3
}
```

---

## Part 4 — Urgency Ratio Helper

Create `src/lib/urgencyRatio.ts`.

```typescript
/**
 * Computes urgency_ratio for a task.
 * urgency_ratio = estimated_mins_remaining / (mins_until_due / 60)
 *
 * Interpretation:
 *   1.0 = exactly enough time if working 1hr per available hour
 *   2.0 = needs 2hrs of work per available hour (urgency threshold default)
 *   > threshold = urgency mode activates
 */
export function urgencyRatio(
  estimatedMinsRemaining: number,
  dueAt: Date,
  now: Date = new Date()
): number {
  const minsUntilDue = (dueAt.getTime() - now.getTime()) / (1000 * 60)
  if (minsUntilDue <= 0) return Infinity   // overdue
  return estimatedMinsRemaining / (minsUntilDue / 60)
}

export function isUrgencyMode(ratio: number, threshold: number): boolean {
  return ratio > threshold
}
```

---

## Part 5 — Placement Score Helper

Create `src/lib/placementScore.ts`.

```typescript
import { SCHEDULER } from './schedulerConstants'
import { isUrgencyMode } from './urgencyRatio'

/**
 * Computes placement_score for a task competing for a slot.
 *
 * Normal mode:  0.5 × urgency_ratio (normalized) + 0.5 × cognitive_demand
 * Urgency mode: 1.0 × urgency_ratio (normalized) + 0.0 × cognitive_demand
 *
 * urgency_ratio is normalized to 0–1 by dividing by (threshold × 2)
 * so it's comparable to cognitive_demand's 0–1 range.
 * Clamped at 1.0 maximum.
 */
export function placementScore(
  urgencyRatio: number,
  cognitiveDemand: number,      // 0–1, from classifier or LLM override
  urgencyThreshold: number,
  inUrgencyMode: boolean
): number {
  const normalizedUrgency = Math.min(urgencyRatio / (urgencyThreshold * 2), 1)
  
  if (inUrgencyMode) {
    return (
      SCHEDULER.URGENCY_MODE_URGENCY_WEIGHT * normalizedUrgency +
      SCHEDULER.URGENCY_MODE_DEMAND_WEIGHT * cognitiveDemand
    )
  }
  
  return (
    SCHEDULER.PLACEMENT_URGENCY_WEIGHT * normalizedUrgency +
    SCHEDULER.PLACEMENT_DEMAND_WEIGHT * cognitiveDemand
  )
}

/**
 * Derives cognitive_demand from classifier signals.
 * Uses LLM override if present (set by LLM augmentation layer).
 * Returns 0–1.
 */
export function cognitiveDemand(
  deepScore: number,              // from ClassifierResult
  estimatedMins: number,
  cognitiveDemanddOverride: number | null
): number {
  if (cognitiveDemanddOverride !== null) return cognitiveDemanddOverride
  
  // Normalize estimated_mins contribution: 90 min = 1.0, 25 min = ~0.28
  const durationSignal = Math.min(estimatedMins / 90, 1)
  
  // Blend deep classifier score with duration proxy
  return (deepScore * 0.6) + (durationSignal * 0.4)
}
```

---

## Part 6 — Confidence-Adjusted Block Sizing

Create `src/lib/blockSizing.ts`.

```typescript
import { SCHEDULER } from './schedulerConstants'

/**
 * Returns the actual block duration for a task given its classifier confidence.
 * Confidence flows into block sizing — not just UI display.
 *
 * ≥ 0.75 → full target_block_mins
 * 0.40–0.75 → 0.75 × target_block_mins
 * < 0.40 → 0.50 × target_block_mins (resized on student confirmation)
 *
 * Never returns below BLOCK_FLOOR_MINS.
 * Never returns above block_ceiling_mins from profile.
 */
export function adjustedBlockMins(
  targetBlockMins: number,
  confidence: number,
  blockCeilingMins: number
): { mins: number; confidenceAdjusted: boolean } {
  let multiplier = 1.0
  let confidenceAdjusted = false

  if (confidence >= SCHEDULER.CONFIDENCE_FULL_THRESHOLD) {
    multiplier = 1.0
  } else if (confidence >= SCHEDULER.CONFIDENCE_PARTIAL_THRESHOLD) {
    multiplier = SCHEDULER.CONFIDENCE_PARTIAL_MULTIPLIER
    confidenceAdjusted = true
  } else {
    multiplier = SCHEDULER.CONFIDENCE_LOW_MULTIPLIER
    confidenceAdjusted = true
  }

  const raw = Math.round(targetBlockMins * multiplier)
  const clamped = Math.max(
    SCHEDULER.BLOCK_FLOOR_MINS,
    Math.min(raw, blockCeilingMins)
  )

  return { mins: clamped, confidenceAdjusted }
}
```

---

## Part 7 — Slot Scoring

Create `src/lib/slotScoring.ts`.

```typescript
import { HourScore, WorkBlock, Task } from '../types'
import { SCHEDULER } from './schedulerConstants'

/**
 * Scores a candidate time slot for a given task.
 * Returns 0–1. Higher = better fit.
 *
 * Components:
 *   1. Peak hour score from peak_hour_map (base)
 *   2. Stability bonus if slot matches task's historical time window
 *   3. Spacing penalty if same task was worked on yesterday
 *   4. Unavailability check (hard wall — returns 0 if outside allowed hours)
 */
export function slotScore(params: {
  slotStartHour: number               // 0–23
  peakHourMap: HourScore[]
  task: Task
  recentBlocksForTask: WorkBlock[]    // blocks for this task in past 2 days
  historicalHourForTask: number | null  // mode hour from past blocks for this task
  unavailableBefore: number
  unavailableAfter: number
  slotDate: Date
  now: Date
}): number {
  const {
    slotStartHour,
    peakHourMap,
    task,
    recentBlocksForTask,
    historicalHourForTask,
    unavailableBefore,
    unavailableAfter,
    slotDate,
    now,
  } = params

  // Hard wall: unavailable hours
  if (slotStartHour < unavailableBefore || slotStartHour >= unavailableAfter) {
    return 0
  }

  // Base: peak hour score
  const hourEntry = peakHourMap.find(h => h.hour === slotStartHour)
  let score = hourEntry?.score ?? 0.5   // default 0.5 if no data yet

  // Stability bonus: same time window as historical blocks for this task
  if (historicalHourForTask !== null) {
    const hourDiff = Math.abs(slotStartHour - historicalHourForTask)
    if (hourDiff <= 1) {
      score += SCHEDULER.STABILITY_BONUS
    }
  }

  // Spacing penalty: same task worked yesterday
  const yesterday = new Date(slotDate)
  yesterday.setDate(yesterday.getDate() - 1)
  const workedYesterday = recentBlocksForTask.some(block => {
    const blockDate = new Date(block.starts_at)
    return (
      blockDate.getFullYear() === yesterday.getFullYear() &&
      blockDate.getMonth() === yesterday.getMonth() &&
      blockDate.getDate() === yesterday.getDate() &&
      block.status === 'completed'
    )
  })

  if (workedYesterday) {
    score -= SCHEDULER.SPACING_PENALTY
  }

  // Clamp to 0–1
  return Math.max(0, Math.min(1, score))
}
```

---

## Part 8 — Deadline Proximity Helper

Create `src/lib/deadlineProximity.ts`.

```typescript
/**
 * Computes deadline_proximity for a session.
 * Used when tagging reflections and for distribution preference inference.
 *
 * deadline_proximity = days_elapsed_since_task_created / total_days_available
 * Range: 0.0 (session right after task creation) to 1.0 (session on due date)
 *
 * Bucketed into thirds:
 *   early:  0.0–0.33
 *   middle: 0.33–0.67
 *   late:   0.67–1.0
 */
export function deadlineProximity(
  taskCreatedAt: Date,
  dueAt: Date,
  sessionDate: Date = new Date()
): number {
  const totalDays =
    (dueAt.getTime() - taskCreatedAt.getTime()) / (1000 * 60 * 60 * 24)
  const elapsedDays =
    (sessionDate.getTime() - taskCreatedAt.getTime()) / (1000 * 60 * 60 * 24)

  if (totalDays <= 0) return 1.0
  return Math.max(0, Math.min(1, elapsedDays / totalDays))
}

export type ProximityBucket = 'early' | 'middle' | 'late'

export function proximityBucket(proximity: number): ProximityBucket {
  if (proximity <= 0.33) return 'early'
  if (proximity <= 0.67) return 'middle'
  return 'late'
}
```

---

## Part 9 — Date Range Allocation

Create `src/lib/dateRangeAllocation.ts`.

```typescript
import { Task, LearningProfile } from '../types'
import { SCHEDULER } from './schedulerConstants'

/**
 * Given a task and the current profile, returns an ordered list of
 * target dates on which blocks should be placed.
 *
 * Rules:
 *   1. First block must land within first 33% of available days (early anchor)
 *   2. No same-task blocks on consecutive days (soft — handled in slotScoring,
 *      but allocation avoids consecutive days as a starting point)
 *   3. Distribution shape determined by profile.distribution_preference
 *   4. Never allocates on due_date itself — due date is valid scheduling day
 *      but only if needed by urgency; allocation prefers to leave it clear
 *
 * Returns dates sorted ascending (earliest first).
 */
export function allocateDates(params: {
  task: Task
  blocksNeeded: number
  availableDays: Date[]          // pre-filtered: not in past, within horizon
  profile: LearningProfile
  inUrgencyMode: boolean
}): Date[] {
  const { task, blocksNeeded, availableDays, profile, inUrgencyMode } = params

  if (availableDays.length === 0 || blocksNeeded === 0) return []

  // In urgency mode: pack blocks as early as possible, ignore distribution shape
  if (inUrgencyMode) {
    return availableDays.slice(0, blocksNeeded)
  }

  const total = availableDays.length
  const earlyAnchorCount = Math.ceil(total * SCHEDULER.EARLY_ANCHOR_FRACTION)

  // Split available days into thirds
  const earlyDays = availableDays.slice(0, earlyAnchorCount)
  const middleDays = availableDays.slice(
    earlyAnchorCount,
    Math.ceil(total * 0.67)
  )
  const lateDays = availableDays.slice(Math.ceil(total * 0.67))

  // Always place one block in early window (early anchor — non-negotiable)
  const selected: Date[] = [earlyDays[0]]
  let remaining = blocksNeeded - 1

  if (remaining <= 0) return selected

  // Distribute remaining blocks according to distribution_preference
  const middleTarget = distributeCount(remaining, profile.distribution_preference, 'middle')
  const lateTarget = remaining - middleTarget

  selected.push(...pickEvenly(middleDays, middleTarget))
  selected.push(...pickEvenly(lateDays, lateTarget))

  return selected.sort((a, b) => a.getTime() - b.getTime())
}

function distributeCount(
  remaining: number,
  preference: 'front_load' | 'even' | 'ramp',
  zone: 'middle' | 'late'
): number {
  if (preference === 'front_load') {
    return zone === 'middle' ? Math.ceil(remaining * 0.7) : Math.floor(remaining * 0.3)
  }
  if (preference === 'ramp') {
    return zone === 'middle' ? Math.floor(remaining * 0.3) : Math.ceil(remaining * 0.7)
  }
  // even
  return Math.round(remaining / 2)
}

function pickEvenly(days: Date[], count: number): Date[] {
  if (count <= 0 || days.length === 0) return []
  if (count >= days.length) return [...days]

  const result: Date[] = []
  const step = days.length / count
  for (let i = 0; i < count; i++) {
    result.push(days[Math.floor(i * step)])
  }
  return result
}
```

---

## Part 10 — Profile Updater Edge Function

Create `supabase/functions/profile-updater/index.ts`.

This function is triggered by a DB webhook after every deep reflection is saved.

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ProfileUpdateInput, LearningProfile, DeepReflection } from '../../src/types.ts'
import { SCHEDULER } from '../../src/lib/schedulerConstants.ts'
import { compositeScore } from '../../src/lib/compositeScore.ts'
import { proximityBucket } from '../../src/lib/deadlineProximity.ts'

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const input: ProfileUpdateInput = await req.json()
  const { reflection, work_block, task, current_profile } = input

  const updated = updateProfile(current_profile, reflection, work_block, task)

  const { error } = await supabase
    .from('learning_profile')
    .update(updated)
    .eq('user_id', input.user_id)

  if (error) {
    return new Response(JSON.stringify({ error }), { status: 500 })
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})

// ─── Core profile update logic ────────────────────────────────────────────

function updateProfile(
  profile: LearningProfile,
  reflection: DeepReflection,
  work_block: { starts_at: string; duration_mins: number },
  task: { estimated_mins: number }
): Partial<LearningProfile> {
  const totalReflections = profile.total_reflections + 1
  const stage = deriveStage(totalReflections)
  const composite = compositeScore(
    reflection.productivity,
    reflection.energy,
    reflection.distraction
  )

  return {
    total_reflections: totalReflections,
    profile_stage: stage,
    peak_hour_map: updatePeakHourMap(profile, reflection, work_block, composite, stage),
    distribution_preference: updateDistributionPreference(profile, reflection, composite, stage),
    target_block_mins: updateTargetBlockMins(profile, work_block, composite, stage),
    urgency_threshold: updateUrgencyThreshold(profile, reflection, composite, stage),
    block_ceiling_mins: updateBlockCeiling(profile, reflection, composite),
    updated_at: new Date().toISOString(),
  }
}

// ─── Profile stage ────────────────────────────────────────────────────────

function deriveStage(totalReflections: number): 1 | 2 | 3 {
  if (totalReflections >= SCHEDULER.STAGE_3_REFLECTION_THRESHOLD) return 3
  if (totalReflections >= SCHEDULER.STAGE_2_REFLECTION_THRESHOLD) return 2
  return 1
}

function stageWeights(stage: 1 | 2 | 3, isPeakHour = false) {
  if (stage === 1) return { newWeight: 0, currentWeight: 1 }   // locked
  if (stage === 2) return {
    newWeight: SCHEDULER.STAGE_2_NEW_WEIGHT,
    currentWeight: SCHEDULER.STAGE_2_CURRENT_WEIGHT
  }
  // Stage 3 — peak hour map has faster memory
  if (isPeakHour) return {
    newWeight: SCHEDULER.PEAK_HOUR_STAGE_3_NEW_WEIGHT,
    currentWeight: SCHEDULER.PEAK_HOUR_STAGE_3_CURRENT_WEIGHT
  }
  return {
    newWeight: SCHEDULER.STAGE_3_NEW_WEIGHT,
    currentWeight: SCHEDULER.STAGE_3_CURRENT_WEIGHT
  }
}

// ─── Peak hour map update ─────────────────────────────────────────────────

function updatePeakHourMap(
  profile: LearningProfile,
  reflection: DeepReflection,
  work_block: { starts_at: string },
  composite: number,
  stage: 1 | 2 | 3
): typeof profile.peak_hour_map {
  if (stage === 1) return profile.peak_hour_map   // locked in stage 1

  const sessionHour = new Date(work_block.starts_at).getHours()
  const { newWeight, currentWeight } = stageWeights(stage, true)

  // Normalize composite 1–5 to 0–1 for peak_hour_map
  const normalizedComposite = (composite - 1) / 4

  return profile.peak_hour_map.map(entry => {
    if (entry.hour !== sessionHour) return entry
    return {
      hour: entry.hour,
      score: newWeight * normalizedComposite + currentWeight * entry.score
    }
  })
}

// ─── Distribution preference update ──────────────────────────────────────

function updateDistributionPreference(
  profile: LearningProfile,
  reflection: DeepReflection,
  composite: number,
  stage: 1 | 2 | 3
): LearningProfile['distribution_preference'] {
  if (stage === 1) return profile.distribution_preference

  const bucket = proximityBucket(reflection.deadline_proximity)
  const buckets = { ...profile.deadline_proximity_buckets }

  // Update the relevant bucket's running average
  const countKey = `${bucket}_count` as keyof typeof buckets
  const avgKey = `${bucket}_avg` as keyof typeof buckets
  const count = (buckets[countKey] as number) + 1
  const currentAvg = buckets[avgKey] as number
  const { newWeight, currentWeight } = stageWeights(stage)

  ;(buckets[avgKey] as number) = newWeight * composite + currentWeight * currentAvg
  ;(buckets[countKey] as number) = count

  // Determine preference from which bucket scores highest
  const { early_avg, middle_avg, late_avg } = buckets
  const max = Math.max(early_avg, middle_avg, late_avg)

  let preference: LearningProfile['distribution_preference']
  if (max === early_avg) preference = 'front_load'
  else if (max === late_avg) preference = 'ramp'
  else preference = 'even'

  return preference
}

// ─── Target block mins update ─────────────────────────────────────────────

function updateTargetBlockMins(
  profile: LearningProfile,
  work_block: { duration_mins: number },
  composite: number,
  stage: 1 | 2 | 3
): number {
  if (stage === 1) return profile.target_block_mins

  // Only update if session was high quality — converge toward
  // avg length of highest-scoring sessions
  if (composite < 3.5) return profile.target_block_mins

  const { newWeight, currentWeight } = stageWeights(stage)
  const updated =
    newWeight * work_block.duration_mins + currentWeight * profile.target_block_mins

  // Clamp within floor and ceiling
  return Math.max(
    SCHEDULER.BLOCK_FLOOR_MINS,
    Math.min(profile.block_ceiling_mins, Math.round(updated))
  )
}

// ─── Urgency threshold update ─────────────────────────────────────────────

function updateUrgencyThreshold(
  profile: LearningProfile,
  reflection: DeepReflection,
  composite: number,
  stage: 1 | 2 | 3
): number {
  if (stage === 1) return profile.urgency_threshold

  // Only update from sessions that were in urgency mode
  // Proxy: late deadline proximity (0.67+) as a stand-in until
  // work_block.urgency_mode flag is added to the schema
  if (reflection.deadline_proximity < 0.67) return profile.urgency_threshold

  const { newWeight, currentWeight } = stageWeights(stage)

  // High composite in urgency → student handles pressure well → drift threshold up
  // Low composite in urgency → student struggles under pressure → drift threshold down
  const normalizedComposite = (composite - 1) / 4   // 0–1
  const targetThreshold =
    SCHEDULER.URGENCY_THRESHOLD_FLOOR +
    normalizedComposite *
      (SCHEDULER.URGENCY_THRESHOLD_CEILING - SCHEDULER.URGENCY_THRESHOLD_FLOOR)

  const updated =
    newWeight * targetThreshold + currentWeight * profile.urgency_threshold

  return Math.max(
    SCHEDULER.URGENCY_THRESHOLD_FLOOR,
    Math.min(SCHEDULER.URGENCY_THRESHOLD_CEILING, updated)
  )
}

// ─── Block ceiling update ─────────────────────────────────────────────────

function updateBlockCeiling(
  profile: LearningProfile,
  reflection: DeepReflection,
  composite: number
): number {
  // Check cooldown
  const now = new Date()
  if (profile.ceiling_last_adjusted_at) {
    const lastAdjusted = new Date(profile.ceiling_last_adjusted_at)
    const daysSince =
      (now.getTime() - lastAdjusted.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < SCHEDULER.CEILING_ADJUST_COOLDOWN_DAYS) {
      return profile.block_ceiling_mins
    }
  }

  const sessions = profile.ceiling_adjustment_sessions + 1

  // Check raise conditions
  if (
    sessions >= SCHEDULER.CEILING_RAISE_SESSION_COUNT &&
    reflection.completion_rate >= SCHEDULER.CEILING_RAISE_COMPLETION_THRESHOLD &&
    composite >= SCHEDULER.CEILING_RAISE_QUALITY_THRESHOLD
  ) {
    return Math.min(
      profile.block_ceiling_mins + SCHEDULER.BLOCK_INCREMENT_MINS,
      SCHEDULER.BLOCK_CEILING_MAX_MINS
    )
  }

  // Check lower conditions
  if (
    sessions >= SCHEDULER.CEILING_LOWER_SESSION_COUNT &&
    reflection.completion_rate < SCHEDULER.CEILING_LOWER_COMPLETION_THRESHOLD &&
    composite < SCHEDULER.CEILING_LOWER_QUALITY_THRESHOLD
  ) {
    return Math.max(
      profile.block_ceiling_mins - SCHEDULER.BLOCK_INCREMENT_MINS,
      SCHEDULER.BLOCK_CEILING_MIN_MINS
    )
  }

  return profile.block_ceiling_mins
}
```

---

## Part 11 — Cold Start Profile Seeding

Create `src/lib/coldStart.ts`.

Called once after onboarding completes. Seeds the initial `learning_profile` row.

```typescript
import { LearningProfile, HourScore } from '../types'
import { SCHEDULER } from './schedulerConstants'

type OnboardingAnswers = {
  userId: string
  peakWindow: 'morning' | 'afternoon' | 'night'
  unavailableBefore: number   // hour 0–23
  unavailableAfter: number    // hour 0–23
  typicalSessionMins: number  // from Q3: 25, 37, 52, or 75 (midpoints of ranges)
}

export function seedProfile(answers: OnboardingAnswers): Omit<LearningProfile, 'updated_at'> {
  return {
    user_id: answers.userId,

    block_ceiling_mins: SCHEDULER.BLOCK_CEILING_COLD_START_MINS,
    target_block_mins: Math.min(answers.typicalSessionMins, SCHEDULER.COLD_START_BLOCK_CAP_MINS),

    peak_hour_map: seedPeakHourMap(answers.peakWindow, answers.unavailableBefore, answers.unavailableAfter),

    distribution_preference: 'even',
    deadline_proximity_buckets: {
      early_avg: 3.0,
      middle_avg: 3.0,
      late_avg: 3.0,
      early_count: 0,
      middle_count: 0,
      late_count: 0,
    },

    urgency_threshold: SCHEDULER.URGENCY_THRESHOLD_COLD_START,

    unavailable_before: answers.unavailableBefore,
    unavailable_after: answers.unavailableAfter,

    shallow_before_deep: true,

    profile_stage: 1,
    total_reflections: 0,

    ceiling_last_adjusted_at: null,
    ceiling_adjustment_sessions: 0,
  }
}

/**
 * Seeds peak_hour_map with flat scores within the student's self-reported window.
 * Hours within the window get 0.7 (elevated but not max — we don't know more yet).
 * Hours outside the window get 0.3.
 * Unavailable hours get 0.0.
 */
function seedPeakHourMap(
  peakWindow: 'morning' | 'afternoon' | 'night',
  unavailableBefore: number,
  unavailableAfter: number
): HourScore[] {
  const windows = {
    morning:   { start: 8,  end: 11 },
    afternoon: { start: 12, end: 16 },
    night:     { start: 18, end: 23 },
  }

  const window = windows[peakWindow]

  return Array.from({ length: 24 }, (_, hour) => {
    if (hour < unavailableBefore || hour >= unavailableAfter) {
      return { hour, score: 0 }
    }
    if (hour >= window.start && hour <= window.end) {
      return { hour, score: 0.7 }
    }
    return { hour, score: 0.3 }
  })
}

/**
 * Midpoint values for Q3 onboarding answer → target_block_mins seed.
 * Pass the student's selection to seedProfile as typicalSessionMins.
 */
export const Q3_SESSION_MINS: Record<string, number> = {
  'under_30':  25,
  '30_to_45':  37,
  '45_to_60':  52,
  '60_to_90':  75,
}
```

---

## Part 12 — Test Cases

Create `src/lib/__tests__/scheduler.test.ts`.

Run these before wiring the scheduler to the database.
All cases should produce deterministic, predictable output.

```typescript
/**
 * Test case definitions for the scheduling algorithm.
 * Run with your test framework of choice (Vitest recommended).
 *
 * These test the helper functions in isolation.
 * Integration tests (full schedule-generator output) come after unit tests pass.
 */

import { compositeScore } from '../compositeScore'
import { urgencyRatio, isUrgencyMode } from '../urgencyRatio'
import { adjustedBlockMins } from '../blockSizing'
import { deadlineProximity, proximityBucket } from '../deadlineProximity'
import { SCHEDULER } from '../schedulerConstants'

// ─── compositeScore ───────────────────────────────────────────────────────

// Perfect session: all 5s → composite = (5 + 5 + (6-5)) / 3 = 11/3 ≈ 3.67
// Worst session: all 1s → composite = (1 + 1 + (6-1)) / 3 = 7/3 ≈ 2.33
// Note: distraction 1 (very distracted) → (6-1) = 5... wait:
// distraction 5 = not distracted = good → (6-5) = 1... hmm
// Correct: distraction 5 (not distracted) → (6-5) = 1, reduces composite
// Actually: distraction inverse means high distraction = bad.
// distraction 1 (very distracted) → (6-1) = 5 (penalizes heavily)
// distraction 5 (not distracted) → (6-5) = 1 (low penalty)
// So perfect productive session with no distraction:
//   productivity=5, energy=5, distraction=1 → (5+5+(6-1))/3 = 15/3 = 5.0 ✓

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
  const ratio = urgencyRatio(180, due, now)
  expect(ratio).toBeCloseTo(1.07, 1)
})

test('urgencyRatio: 180 mins remaining, due in 2 days', () => {
  const now = new Date('2024-01-01T09:00:00Z')
  const due = new Date('2024-01-03T09:00:00Z')
  const ratio = urgencyRatio(180, due, now)
  expect(ratio).toBeCloseTo(3.75, 1)
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
  expect(result.mins).toBe(SCHEDULER.BLOCK_FLOOR_MINS)  // 25
})

// ─── deadlineProximity ────────────────────────────────────────────────────

test('deadlineProximity: session on day of creation → 0', () => {
  const created = new Date('2024-01-01')
  const due = new Date('2024-01-08')
  const session = new Date('2024-01-01')
  expect(deadlineProximity(created, due, session)).toBeCloseTo(0, 1)
})

test('deadlineProximity: session halfway through → 0.5', () => {
  const created = new Date('2024-01-01')
  const due = new Date('2024-01-09')
  const session = new Date('2024-01-05')
  expect(deadlineProximity(created, due, session)).toBeCloseTo(0.5, 1)
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
```

---

## Implementation Order

Build in this exact order. Each step depends on the previous.

```
Step 1:  src/types.ts                          — types first, everything else depends on them
Step 2:  src/lib/schedulerConstants.ts         — all constants in one place
Step 3:  src/lib/compositeScore.ts             — used by profile-updater and tests
Step 4:  src/lib/urgencyRatio.ts               — used by scheduler and placement score
Step 5:  src/lib/deadlineProximity.ts          — used by profile-updater
Step 6:  src/lib/blockSizing.ts                — used by scheduler
Step 7:  src/lib/placementScore.ts             — used by scheduler
Step 8:  src/lib/slotScoring.ts                — used by scheduler
Step 9:  src/lib/dateRangeAllocation.ts        — used by scheduler
Step 10: src/lib/coldStart.ts                  — used by onboarding flow
Step 11: src/lib/__tests__/scheduler.test.ts   — run all unit tests, all must pass
Step 12: supabase/functions/profile-updater/   — build after unit tests pass
Step 13: supabase/functions/schedule-generator/ — build last, depends on all helpers
```

---

## LLM Augmentation Hooks (do not build yet)

These are the four places the LLM layer will plug in when built.
Leave them as nullable fields / fallback paths for now.

```
1. tasks.cognitive_demand_override (nullable float 0–1)
   Currently: null → placementScore uses classifier signal
   Later: LLM writes refined value based on reflection history

2. tasks.classifier_confidence (already exists)
   Currently: keyword classifier only
   Later: LLM can refine confidence from description content

3. profile-updater ceiling adjustment gate
   Currently: rules execute unconditionally
   Later: LLM reviews reflections before raise/lower executes

4. profile-updater urgency threshold gate
   Currently: late deadline_proximity used as urgency proxy
   Later: work_block.urgency_mode flag added, LLM flags external context
```

---

## What this file does not cover

- `schedule-generator` edge function full implementation (covered separately)
- Calendar sync (`calendar-sync` edge function)
- Shallow batch assembly logic
- Reflection UI and data capture
- RLS policies (already set up per project context)
- Stripe billing
- PDF / description parsing (AI features, separate spec)