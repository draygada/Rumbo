import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { LearningProfile, DeepReflection } from '../../../src/types/index.ts'
import { SCHEDULER } from '../_shared/schedulerConstants.ts'
import { compositeScore } from '../_shared/compositeScore.ts'
import { proximityBucket } from '../_shared/deadlineProximity.ts'

interface ProfileUpdateInput {
  user_id: string
  reflection: DeepReflection
  work_block: { starts_at: string; duration_mins: number }
  task: { estimated_mins: number }
  current_profile: LearningProfile
}

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const input: ProfileUpdateInput = await req.json()
  const { reflection, work_block, task, current_profile } = input

  const updated = updateProfile(current_profile, reflection, work_block, task)

  const { error } = await supabase
    .from('learning_profile')
    .update(updated)
    .eq('user_id', input.user_id)

  if (error) return new Response(JSON.stringify({ error }), { status: 500 })
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})

// ─── Core update logic ────────────────────────────────────────────────────

function updateProfile(
  profile: LearningProfile,
  reflection: DeepReflection,
  work_block: { starts_at: string; duration_mins: number },
  _task: { estimated_mins: number },
): Partial<LearningProfile> {
  const totalReflections = profile.total_reflections + 1
  const stage = deriveStage(totalReflections)
  const composite = compositeScore(reflection.productivity, reflection.energy, reflection.distraction)

  return {
    total_reflections: totalReflections,
    profile_stage: stage,
    peak_hour_map: updatePeakHourMap(profile, work_block, composite, stage),
    distribution_preference: updateDistributionPreference(profile, reflection, composite, stage),
    target_block_mins: updateTargetBlockMins(profile, work_block, composite, stage),
    urgency_threshold: updateUrgencyThreshold(profile, reflection, composite, stage),
    block_ceiling_mins: updateBlockCeiling(profile, reflection, composite),
    updated_at: new Date().toISOString(),
  }
}

// ─── Stage ────────────────────────────────────────────────────────────────

function deriveStage(total: number): 1 | 2 | 3 {
  if (total >= SCHEDULER.STAGE_3_REFLECTION_THRESHOLD) return 3
  if (total >= SCHEDULER.STAGE_2_REFLECTION_THRESHOLD) return 2
  return 1
}

function stageWeights(stage: 1 | 2 | 3, isPeakHour = false) {
  if (stage === 1) return { newWeight: 0, currentWeight: 1 }
  if (stage === 2) return { newWeight: SCHEDULER.STAGE_2_NEW_WEIGHT, currentWeight: SCHEDULER.STAGE_2_CURRENT_WEIGHT }
  if (isPeakHour) return { newWeight: SCHEDULER.PEAK_HOUR_STAGE_3_NEW_WEIGHT, currentWeight: SCHEDULER.PEAK_HOUR_STAGE_3_CURRENT_WEIGHT }
  return { newWeight: SCHEDULER.STAGE_3_NEW_WEIGHT, currentWeight: SCHEDULER.STAGE_3_CURRENT_WEIGHT }
}

// ─── Peak hour map ────────────────────────────────────────────────────────

function updatePeakHourMap(
  profile: LearningProfile,
  work_block: { starts_at: string },
  composite: number,
  stage: 1 | 2 | 3,
): typeof profile.peak_hour_map {
  if (stage === 1) return profile.peak_hour_map

  const sessionHour = new Date(work_block.starts_at).getHours()
  const { newWeight, currentWeight } = stageWeights(stage, true)
  const normalized = (composite - 1) / 4  // 1–5 → 0–1

  return profile.peak_hour_map.map(entry =>
    entry.hour !== sessionHour
      ? entry
      : { hour: entry.hour, score: newWeight * normalized + currentWeight * entry.score }
  )
}

// ─── Distribution preference ──────────────────────────────────────────────

function updateDistributionPreference(
  profile: LearningProfile,
  reflection: DeepReflection,
  composite: number,
  stage: 1 | 2 | 3,
): LearningProfile['distribution_preference'] {
  if (stage === 1) return profile.distribution_preference

  const bucket = proximityBucket(reflection.deadline_proximity)
  const buckets = { ...profile.deadline_proximity_buckets }
  const countKey = `${bucket}_count` as keyof typeof buckets
  const avgKey = `${bucket}_avg` as keyof typeof buckets
  const { newWeight, currentWeight } = stageWeights(stage)

  ;(buckets[avgKey] as number) = newWeight * composite + currentWeight * (buckets[avgKey] as number)
  ;(buckets[countKey] as number) = (buckets[countKey] as number) + 1

  const { early_avg, middle_avg, late_avg } = buckets
  const max = Math.max(early_avg, middle_avg, late_avg)
  if (max === early_avg) return 'front_load'
  if (max === late_avg) return 'ramp'
  return 'even'
}

// ─── Target block mins ────────────────────────────────────────────────────

function updateTargetBlockMins(
  profile: LearningProfile,
  work_block: { duration_mins: number },
  composite: number,
  stage: 1 | 2 | 3,
): number {
  if (stage === 1 || composite < 3.5) return profile.target_block_mins
  const { newWeight, currentWeight } = stageWeights(stage)
  const updated = newWeight * work_block.duration_mins + currentWeight * profile.target_block_mins
  return Math.max(SCHEDULER.BLOCK_FLOOR_MINS, Math.min(profile.block_ceiling_mins, Math.round(updated)))
}

// ─── Urgency threshold ────────────────────────────────────────────────────

function updateUrgencyThreshold(
  profile: LearningProfile,
  reflection: DeepReflection,
  composite: number,
  stage: 1 | 2 | 3,
): number {
  if (stage === 1 || reflection.deadline_proximity < 0.67) return profile.urgency_threshold
  const { newWeight, currentWeight } = stageWeights(stage)
  const normalized = (composite - 1) / 4
  const target = SCHEDULER.URGENCY_THRESHOLD_FLOOR + normalized * (SCHEDULER.URGENCY_THRESHOLD_CEILING - SCHEDULER.URGENCY_THRESHOLD_FLOOR)
  const updated = newWeight * target + currentWeight * profile.urgency_threshold
  return Math.max(SCHEDULER.URGENCY_THRESHOLD_FLOOR, Math.min(SCHEDULER.URGENCY_THRESHOLD_CEILING, updated))
}

// ─── Block ceiling ────────────────────────────────────────────────────────

function updateBlockCeiling(
  profile: LearningProfile,
  reflection: DeepReflection,
  composite: number,
): number {
  if (profile.ceiling_last_adjusted_at) {
    const daysSince = (Date.now() - new Date(profile.ceiling_last_adjusted_at).getTime()) / 86_400_000
    if (daysSince < SCHEDULER.CEILING_ADJUST_COOLDOWN_DAYS) return profile.block_ceiling_mins
  }

  const sessions = profile.ceiling_adjustment_sessions + 1

  if (
    sessions >= SCHEDULER.CEILING_RAISE_SESSION_COUNT &&
    reflection.completion_rate >= SCHEDULER.CEILING_RAISE_COMPLETION_THRESHOLD &&
    composite >= SCHEDULER.CEILING_RAISE_QUALITY_THRESHOLD
  ) {
    return Math.min(profile.block_ceiling_mins + SCHEDULER.BLOCK_INCREMENT_MINS, SCHEDULER.BLOCK_CEILING_MAX_MINS)
  }

  if (
    sessions >= SCHEDULER.CEILING_LOWER_SESSION_COUNT &&
    reflection.completion_rate < SCHEDULER.CEILING_LOWER_COMPLETION_THRESHOLD &&
    composite < SCHEDULER.CEILING_LOWER_QUALITY_THRESHOLD
  ) {
    return Math.max(profile.block_ceiling_mins - SCHEDULER.BLOCK_INCREMENT_MINS, SCHEDULER.BLOCK_CEILING_MIN_MINS)
  }

  return profile.block_ceiling_mins
}
