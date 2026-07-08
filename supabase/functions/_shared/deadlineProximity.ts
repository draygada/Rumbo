/**
 * deadline_proximity = days_elapsed_since_task_created / total_days_available
 * Range: 0.0 (session right after task creation) to 1.0 (session on due date)
 */
export function deadlineProximity(
  taskCreatedAt: Date,
  dueAt: Date,
  sessionDate: Date = new Date(),
): number {
  const totalDays = (dueAt.getTime() - taskCreatedAt.getTime()) / 86_400_000
  const elapsedDays = (sessionDate.getTime() - taskCreatedAt.getTime()) / 86_400_000
  if (totalDays <= 0) return 1
  return Math.max(0, Math.min(1, elapsedDays / totalDays))
}

export type ProximityBucket = 'early' | 'middle' | 'late'

export function proximityBucket(proximity: number): ProximityBucket {
  if (proximity <= 0.33) return 'early'
  if (proximity <= 0.67) return 'middle'
  return 'late'
}
