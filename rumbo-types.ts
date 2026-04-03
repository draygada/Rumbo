// ─────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────

export type UserTier = 'free' | 'premium'

export type WorkType = 'deep' | 'shallow'

export type ClassifierConfidence = 'high' | 'low' | 'none'

export type BlockStatus = 'scheduled' | 'active' | 'completed' | 'skipped' | 'rescheduled'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'overdue'

export type DeadlineStrategy = 'front_load' | 'even' | 'ramp' | 'unknown'

export type PeakWindow = 'early_bird' | 'morning' | 'afternoon' | 'night'

export type CalendarProvider = 'google' | 'outlook' | 'none'

export type DistributionShape = 'front_load' | 'even' | 'ramp'


// ─────────────────────────────────────────────
// USER
// ─────────────────────────────────────────────

export interface User {
  id: string                          // uuid — Supabase Auth uid
  email: string
  name: string | null
  university: string | null
  tier: UserTier
  google_calendar_connected: boolean
  outlook_connected: boolean
  google_oauth_tokens?: Record<string, unknown> | null
  outlook_oauth_tokens?: Record<string, unknown> | null
  created_at: string                  // ISO 8601
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}


// ─────────────────────────────────────────────
// ONBOARDING PREFERENCES
// Collected in step 3 — seeds the learning profile
// ─────────────────────────────────────────────

export interface OnboardingPreferences {
  user_id: string
  peak_window: PeakWindow             // Q1 — early bird / morning / afternoon / night
  unavailable_before: string          // Q2 — "HH:MM" 24h e.g. "08:00"
  unavailable_after: string           // Q2 — "HH:MM" 24h e.g. "23:00"
  preferred_block_mins: number        // Q3 — seeded 45 | 90 | 180 | 240 (hour buckets)
  completed_at: string                // ISO 8601
}


// ─────────────────────────────────────────────
// LEARNING PROFILE
// Seeded by onboarding, updated by reflections
// ─────────────────────────────────────────────

export interface HourScore {
  hour: number                        // 0–23
  score: number                       // 0–1 composite (productivity + energy - distraction)
  sample_count: number                // how many reflections contributed
}

export interface LearningProfile {
  id: string
  user_id: string

  // Seeded by onboarding Q1, refined by reflections
  peak_hour_map: HourScore[]          // 24 entries, one per hour of day

  // Seeded by onboarding Q3, refined by high-scoring session lengths
  target_block_mins: number           // scheduler's current best-guess block length

  // Hard constraint — never scheduled around, set in onboarding Q2
  unavailable_before: string          // "HH:MM"
  unavailable_after: string           // "HH:MM"

  // Inferred from completion rates at different deadline distances
  deadline_strategy: DeadlineStrategy

  // Shallow timing — 'before' until data suggests otherwise
  shallow_before_deep: boolean

  // Rolling averages across all blocks — used to track trends
  avg_productivity: number            // 1–5
  avg_energy: number                  // 1–5
  avg_distraction: number             // 1–5 (lower = better)
  avg_completion_rate: number         // 0–1

  updated_at: string
}


// ─────────────────────────────────────────────
// TASKS
// ─────────────────────────────────────────────

export interface Task {
  id: string
  user_id: string
  title: string
  description: string | null

  work_type: WorkType
  classifier_confidence: ClassifierConfidence
  user_overrode_classifier: boolean   // true if student manually changed work_type

  status: TaskStatus
  due_at: string                      // ISO 8601 — hard deadline
  estimated_mins: number              // student's input, refined by completion data
  actual_mins: number | null          // filled in as blocks complete

  // Premium only — set if PDF was uploaded and parsed
  file_url: string | null
  problems_parsed: boolean

  priority: number                    // 1 (highest) – 3 (lowest), set by student
  urgency_ratio: number               // computed: estimated_mins_remaining / (mins_until_due / 60)

  created_at: string
  updated_at: string
}


// ─────────────────────────────────────────────
// TASK PROBLEMS
// Premium only — extracted from PDF by AI (one-time, cached)
// ─────────────────────────────────────────────

export interface TaskProblem {
  id: string
  task_id: string
  user_id: string

  order_index: number                 // position in the original document
  label: string                       // e.g. "Problem 3b" or "Section 2: Methods"
  estimated_mins: number              // AI-estimated time for this problem
  is_completed: boolean
  completed_in_block_id: string | null

  created_at: string
}


// ─────────────────────────────────────────────
// WORK BLOCKS
// ─────────────────────────────────────────────

export interface WorkBlock {
  id: string
  task_id: string
  user_id: string

  work_type: WorkType
  status: BlockStatus

  start_at: string                    // ISO 8601
  end_at: string                      // ISO 8601
  duration_mins: number               // end_at - start_at in minutes

  // Calendar integration
  calendar_event_id: string | null    // Google / Outlook event id
  calendar_provider: CalendarProvider

  // Premium: which problems were assigned to this block
  assigned_problem_ids: string[]

  // Populated after completion
  actual_start_at: string | null
  actual_end_at: string | null
  actual_duration_mins: number | null

  // Scheduling metadata — explains why this slot was chosen
  slot_score: number                  // 0–1 fit score at time of scheduling
  scheduled_by: 'immediate' | 'nightly_refresh' | 'reschedule'

  created_at: string
}


// ─────────────────────────────────────────────
// SHALLOW BATCH
// Groups shallow tasks into a single block
// ─────────────────────────────────────────────

export interface ShallowBatch {
  id: string
  user_id: string
  block_id: string                    // the WorkBlock this batch is assigned to
  task_ids: string[]                  // ordered by estimated_mins ASC (quick wins first)
  overflow_to_batch_id: string | null // if tasks spilled into next day's batch
  created_at: string
}


// ─────────────────────────────────────────────
// REFLECTIONS
// ─────────────────────────────────────────────

export interface DeepReflection {
  id: string
  block_id: string
  task_id: string
  user_id: string

  productivity: 1 | 2 | 3 | 4 | 5
  energy: 1 | 2 | 3 | 4 | 5
  distraction: 1 | 2 | 3 | 4 | 5    // 1 = very distracted, 5 = fully focused

  // Premium: % of assigned problems completed
  completion_rate: number             // 0–1
  problems_completed_ids: string[]

  // Free tier: estimated % of overall task done this session
  task_progress_delta: number         // 0–1 e.g. 0.25 = did 25% of the task

  notes: string | null                // optional free text
  submitted_at: string
}

export interface ShallowReflection {
  id: string
  block_id: string
  user_id: string

  // Per task in the batch — true = done, false = needs rescheduling
  task_completions: Record<string, boolean>   // { [task_id]: boolean }

  submitted_at: string
}


// ─────────────────────────────────────────────
// SCHEDULER TYPES
// Internal types used by the scheduling algorithm
// ─────────────────────────────────────────────

export interface TimeSlot {
  start_at: string                    // ISO 8601
  end_at: string                      // ISO 8601
  duration_mins: number
  score: number                       // 0–1 profile fit score
  is_available: boolean
}

export interface SchedulerInput {
  user: User
  profile: LearningProfile
  tasks: Task[]
  existing_blocks: WorkBlock[]        // already scheduled Rumbo blocks
  busy_slots: TimeSlot[]              // from calendar events
  horizon_days: number                // how many days ahead to schedule (default: 7)
}

export interface SchedulerOutput {
  blocks_to_create: Omit<WorkBlock, 'id' | 'created_at'>[]
  blocks_to_delete: string[]          // block ids to remove (nightly refresh only)
  warnings: SchedulerWarning[]
}

export interface SchedulerWarning {
  type: 'insufficient_time' | 'deadline_at_risk' | 'no_available_slots' | 'max_daily_load_reached'
  task_id: string
  message: string
}


// ─────────────────────────────────────────────
// CLASSIFIER TYPES
// ─────────────────────────────────────────────

export interface ClassifierResult {
  work_type: WorkType
  confidence: ClassifierConfidence
  shallow_score: number
  deep_score: number
  matched_keywords: string[]
}


// ─────────────────────────────────────────────
// PROFILE UPDATER INPUT
// Passed to profile-updater edge function after each reflection
// ─────────────────────────────────────────────

export interface ProfileUpdateInput {
  user_id: string
  reflection: DeepReflection
  block: WorkBlock                    // the block that was just reflected on
  current_profile: LearningProfile
}


// ─────────────────────────────────────────────
// CALENDAR SYNC
// ─────────────────────────────────────────────

export interface CalendarEvent {
  external_id: string                 // Google / Outlook event id
  title: string
  start_at: string
  end_at: string
  is_rumbo_block: boolean             // true if Rumbo created it
  provider: CalendarProvider
}

export interface CalendarSyncResult {
  created: string[]                   // block ids successfully pushed
  updated: string[]
  failed: string[]
  provider_errors: Record<string, string>
}


// ─────────────────────────────────────────────
// STRIPE / BILLING
// ─────────────────────────────────────────────

export interface StripeWebhookPayload {
  event_type: 'checkout.session.completed' | 'customer.subscription.deleted' | 'invoice.payment_failed'
  user_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  new_tier: UserTier
}
