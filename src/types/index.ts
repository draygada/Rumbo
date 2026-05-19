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

export interface LearningProfile {
  id: string
  user_id: string
  worker_type: WorkerType
  unavailable_before: string  // "HH:MM"
  unavailable_after: string   // "HH:MM"
  peak_hour_map: Record<string, number>
  updated_at: string
}

export interface Task {
  id: string
  user_id: string
  title: string
  description: string | null
  due_date: string            // ISO timestamp
  estimated_mins: number
  work_type: TaskType | null
  classifier_confidence: number | null
  shallow_score: number | null
  deep_score: number | null
  user_overrode_classifier: boolean
  pdf_url: string | null
  status: string
  created_at: string
}

export interface WorkBlock {
  id: string
  task_id: string
  user_id: string
  start_time: string          // ISO datetime
  end_time: string            // ISO datetime
  calendar_event_id: string | null
  completed: boolean
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
