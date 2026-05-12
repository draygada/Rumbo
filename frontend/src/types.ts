export type UserTier = 'free' | 'premium'
export type WorkType = 'deep' | 'shallow'
export type ClassifierConfidence = 'high' | 'low' | 'none'
export type TaskStatus = 'pending' | 'in_progress' | 'complete'
export type DayFragmentation = 'low' | 'medium' | 'high' | 'very_high'
export type DeadlineStrategy = 'front_load' | 'even' | 'ramp' | 'unknown'

export interface User {
  id: string
  email: string
  name: string | null
  tier: UserTier
  stripe_customer_id: string | null
  stripe_sub_id: string | null
  onboarding_step: '1' | '2' | '3' | '4' | 'complete'
  onboarding_q1: string | null
  onboarding_q2_before: string | null
  onboarding_q2_after: string | null
  onboarding_q3: number | null
  onboarding_q4: string | null
  created_at: string
}

export type PeakWindow = 'early_bird' | 'morning' | 'afternoon' | 'night_owl'

export interface HourScore {
  hour: number
  score: number
}

export interface LearningProfile {
  user_id: string
  peak_hour_map: HourScore[]
  target_block_mins: number
  deadline_strategy: DeadlineStrategy
  shallow_before_deep: boolean
  unavailable_before: string
  unavailable_after: string
  day_fragmentation: DayFragmentation
  peak_hour_confidence: number
  reflection_count: number
}

export interface Task {
  id: string
  user_id: string
  title: string
  due_date: string
  estimated_mins: number
  work_type: WorkType | null
  classifier_confidence: number | null
  shallow_score: number | null
  deep_score: number | null
  user_overrode_classifier: boolean
  urgency_ratio: number | null
  description: string | null
  description_hash: string | null
  pdf_url: string | null
  pdf_hash: string | null
  calendar_color: string | null
  status: TaskStatus
  deleted_at: string | null
  created_at: string
}

export interface ClassifierResult {
  work_type: WorkType
  /** Raw confidence float 0–1. Thresholds: ≥ 0.75 high, ≥ 0.4 low, < 0.4 none. */
  confidence: number
  shallow_score: number
  deep_score: number
  matched_keywords: string[]
}
