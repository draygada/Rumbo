// ─────────────────────────────────────────────
// AI PARSE TYPES — add to types.ts
// ─────────────────────────────────────────────

// Returned by parse-description edge function
export interface DescriptionParseResult {
  task_id: string

  // Refined estimate — overwrites student input if diff > 20%
  refined_estimated_mins: number | null

  // AI's work type read — combined with keyword classifier
  ai_work_type: WorkType
  ai_work_type_confidence: number       // 0–1

  // Whether AI overrode the keyword classifier's work_type
  overrode_classifier: boolean

  parsed_at: string
}

// Subtasks extracted from description (premium only)
export interface TaskSubtask {
  id: string
  task_id: string
  user_id: string

  order_index: number                   // position in description
  label: string                         // e.g. "Write introduction" or "Part 2: Analysis"
  estimated_mins: number                // AI-estimated time for this subtask
  is_completed: boolean
  completed_in_block_id: string | null

  created_at: string
}

// ─────────────────────────────────────────────
// UPDATED TASK — add these fields to Task interface
// ─────────────────────────────────────────────

// Add to existing Task interface:
// 
//   description: string | null           // raw pasted text — stored even for free tier
//   description_parsed: boolean          // true once parse-description has run (premium)
//   subtasks_extracted: boolean          // true if TaskSubtask rows exist for this task
//
//   // AI override tracking
//   ai_refined_estimate: boolean         // true if AI changed estimated_mins
//   ai_overrode_classifier: boolean      // true if AI changed work_type

// ─────────────────────────────────────────────
// UPDATED EDGE FUNCTION INPUT TYPES
// ─────────────────────────────────────────────

export interface ParseDescriptionInput {
  task_id: string
  user_id: string
  title: string
  description: string
  current_work_type: WorkType
  current_estimated_mins: number
  classifier_result: ClassifierResult   // keyword classifier output — AI uses as prior
}

export interface ParseDescriptionOutput {
  description_parse: DescriptionParseResult
  subtasks: Omit<TaskSubtask, 'id' | 'created_at'>[]
}

// ─────────────────────────────────────────────
// UPDATED SCHEDULER
// ─────────────────────────────────────────────

// SchedulerInput already handles this correctly —
// it reads from tasks table which will have AI-refined
// estimated_mins and work_type by the time nightly refresh runs.
//
// For immediate scheduling on task creation:
// schedule-generator runs with whatever data exists at save time.
// If AI parse later changes estimated_mins or work_type materially,
// a re-schedule is triggered automatically via DB webhook.

export interface RescheduleReason {
  type: 'ai_estimate_change' | 'ai_type_change' | 'reflection' | 'manual' | 'nightly_refresh'
  task_id: string
  triggered_at: string
}

