export type UserTier = 'free' | 'premium'
export type CalendarProvider = 'google' | 'outlook' | 'none'
export type WorkType = 'deep' | 'shallow'
export type ClassifierConfidence = 'high' | 'low' | 'none'
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'overdue'

export interface User {
  id: string
  email: string
  name: string | null
  university: string | null
  tier: UserTier
  calendar_provider: CalendarProvider
  created_at: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
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

