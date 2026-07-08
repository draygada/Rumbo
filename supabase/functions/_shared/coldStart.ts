import { LearningProfile, HourScore } from '../../../src/types/index.ts'
import { SCHEDULER } from './schedulerConstants.ts'

type OnboardingAnswers = {
  userId: string
  peakWindow: 'morning' | 'afternoon' | 'night'
  unavailableBefore: number  // hour 0–23
  unavailableAfter: number   // hour 0–23
  typicalSessionMins: number // midpoint from Q3 options
}

/** Seeds the initial learning_profile row after onboarding completes. */
export function seedProfile(answers: OnboardingAnswers): Omit<LearningProfile, 'updated_at'> {
  return {
    user_id: answers.userId,

    block_ceiling_mins: SCHEDULER.BLOCK_CEILING_COLD_START_MINS,
    target_block_mins: Math.min(answers.typicalSessionMins, SCHEDULER.COLD_START_BLOCK_CAP_MINS),

    peak_hour_map: buildPeakHourMap(answers.peakWindow, answers.unavailableBefore, answers.unavailableAfter),

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
 * Hours within the peak window get 0.7 (elevated prior, not max).
 * Hours outside the window get 0.3.
 * Unavailable hours get 0.0.
 */
function buildPeakHourMap(
  peakWindow: 'morning' | 'afternoon' | 'night',
  unavailableBefore: number,
  unavailableAfter: number,
): HourScore[] {
  const windows = {
    morning:   { start: 8,  end: 11 },
    afternoon: { start: 12, end: 16 },
    night:     { start: 18, end: 23 },
  }
  const w = windows[peakWindow]
  return Array.from({ length: 24 }, (_, hour) => {
    if (hour < unavailableBefore || hour >= unavailableAfter) return { hour, score: 0 }
    if (hour >= w.start && hour <= w.end) return { hour, score: 0.7 }
    return { hour, score: 0.3 }
  })
}

/** Midpoint values for Q3 onboarding answer → typicalSessionMins. */
export const Q3_SESSION_MINS: Record<string, number> = {
  under_30: 25,
  '30_to_45': 37,
  '45_to_60': 52,
  '60_to_90': 75,
}
