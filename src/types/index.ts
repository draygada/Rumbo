export type WorkerType = 'early_bird' | 'morning' | 'afternoon' | 'night_owl'
export type TaskType = 'deep' | 'shallow'
export type UserTier = 'free' | 'premium'

export interface User {
  id: string
  email: string
  username: string
  field_of_study: string | null
  tier: UserTier
  onboarding_completed: boolean
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
  due_date: string            // ISO date
  estimated_mins: number
  task_type: TaskType
  user_overrode_classifier: boolean
  pdf_url: string | null
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
