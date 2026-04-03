export type UserTier = 'free' | 'premium'
export type WorkType = 'deep' | 'shallow'
export type ClassifierConfidence = 'high' | 'low' | 'none'
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'overdue'

export interface User {
  id: string
  email: string
  name: string | null
  university: string | null
  tier: UserTier
  google_calendar_connected: boolean
  outlook_connected: boolean
  google_oauth_tokens?: Record<string, unknown> | null
  outlook_oauth_tokens?: Record<string, unknown> | null
  onboarding_complete: boolean
  created_at: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}

export type PeakWindow = 'early_bird' | 'morning' | 'afternoon' | 'night'

export interface HourScore {
  hour: number
  score: number
}

export interface RecurringBlock {
  days: string[]
  start_time: string
  end_time: string
  label: string
}

export interface LearningProfile {
  user_id: string
  peak_hour_map: HourScore[]
  target_block_mins: number
  unavailable_before: string
  unavailable_after: string
  recurring_blocks: RecurringBlock[]
}

export interface Task {
  id: string
  user_id: string
  title: string
  description: string | null

  work_type: WorkType
  classifier_confidence: ClassifierConfidence
  user_overrode_classifier: boolean

  status: TaskStatus
  due_at: string
  estimated_mins: number
  actual_mins: number | null

  file_url: string | null
  problems_parsed: boolean

  priority: number
  urgency_ratio: number

  created_at: string
  updated_at: string
}

export interface ClassifierResult {
  work_type: WorkType
  confidence: ClassifierConfidence
  shallow_score: number
  deep_score: number
  matched_keywords: string[]
}

