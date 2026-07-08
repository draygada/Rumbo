// ─── Existing app types ───────────────────────────────────────────────────

export type WorkerType = 'early_bird' | 'morning' | 'afternoon' | 'night_owl'
export type TaskType = 'deep' | 'shallow'
export type UserTier = 'free' | 'premium'

export interface User {
  id: string
  email: string
  name: string | null
  tier: UserTier
  onboarding_step: string
  onboarding_completed: boolean
  onboarding_q1: WorkerType | null
  onboarding_q2_before: string | null
  onboarding_q2_after: string | null
  field_of_study: string | null
  created_at: string
}

export interface CalendarConnection {
  id: string
  user_id: string
  provider: 'google' | 'microsoft'
  access_token: string
  refresh_token: string
  expires_at: string
  created_at: string
}

// ─── Profile ──────────────────────────────────────────────────────────────

export type DistributionPreference = 'front_load' | 'even' | 'ramp'
export type ProfileStage = 1 | 2 | 3

export interface HourScore {
  hour: number   // 0–23
  score: number  // 0–1
}

export interface DeadlineProximityBuckets {
  early_avg: number
  middle_avg: number
  late_avg: number
  early_count: number
  middle_count: number
  late_count: number
}

export interface LearningProfile {
  user_id: string
  block_ceiling_mins: number
  target_block_mins: number
  peak_hour_map: HourScore[]
  distribution_preference: DistributionPreference
  deadline_proximity_buckets: DeadlineProximityBuckets
  urgency_threshold: number
  unavailable_before: number
  unavailable_after: number
  shallow_before_deep: boolean
  profile_stage: ProfileStage
  total_reflections: number
  ceiling_last_adjusted_at: string | null
  ceiling_adjustment_sessions: number
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
  classifier_confidence: number
  estimated_mins: number
  estimated_mins_remaining: number
  due_at: string                      // ISO timestamp
  created_at: string
  user_overrode_classifier: boolean
  cognitive_demand_override: number | null
}

// ─── Work blocks ──────────────────────────────────────────────────────────

export type BlockStatus = 'scheduled' | 'active' | 'completed' | 'skipped'
export type ScheduledBy = 'algorithm' | 'user'

export interface WorkBlock {
  id: string
  user_id: string
  task_id: string
  starts_at: string
  ends_at: string
  duration_mins: number
  slot_score: number
  placement_score: number
  scheduled_by: ScheduledBy
  status: BlockStatus
  confidence_adjusted: boolean
  deadline_proximity: number
  calendar_event_id: string | null
  created_at: string
}

// ─── Reflections ──────────────────────────────────────────────────────────

export interface DeepReflection {
  id: string
  user_id: string
  work_block_id: string
  task_id: string
  productivity: number       // 1–5
  energy: number             // 1–5
  distraction: number        // 1–5 (5 = not distracted)
  completion_rate: number    // 0–1
  task_progress_delta: number
  deadline_proximity: number // 0–1
  created_at: string
}

export interface ShallowReflection {
  id: string
  user_id: string
  work_block_id: string
  task_completions: Record<string, boolean>
  created_at: string
}
