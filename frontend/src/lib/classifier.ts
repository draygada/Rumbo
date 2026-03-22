import type { ClassifierResult, WorkType } from '@/types'

const SHALLOW_KEYWORDS = [
  'email',
  'reply',
  'respond',
  'submit',
  'upload',
  'schedule',
  'read',
  'review',
  'canvas',
  'lms',
  'form',
  'admin',
  'message',
  'notes',
  'slides',
  'plan',
  'print',
  'confirm',
  'check',
  'watch',
] as const

const DEEP_KEYWORDS = [
  'problem set',
  'pset',
  'essay',
  'write',
  'code',
  'build',
  'design',
  'analyze',
  'study',
  'exam',
  'lab',
  'report',
  'project',
  'research',
  'derive',
  'prove',
  'implement',
  'debug',
  'calculate',
  'draft',
] as const

function countMatches(haystack: string, needle: string): number {
  // simple substring count; good enough for v1 keyword classifier
  if (!needle) return 0
  let count = 0
  let idx = 0
  while (true) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) break
    count += 1
    idx = found + needle.length
  }
  return count
}

export function classifyTaskTitle(title: string, estimatedMins?: number): ClassifierResult {
  const text = title.toLowerCase().trim()

  let shallowScore = 0
  let deepScore = 0
  const matched: string[] = []

  for (const kw of SHALLOW_KEYWORDS) {
    const hits = countMatches(text, kw)
    if (hits > 0) {
      shallowScore += 1.0 * hits
      matched.push(kw)
    }
  }

  for (const kw of DEEP_KEYWORDS) {
    const hits = countMatches(text, kw)
    if (hits > 0) {
      deepScore += 1.0 * hits
      matched.push(kw)
    }
  }

  const confidenceValue = Math.max(shallowScore, deepScore) / (shallowScore + deepScore + 1)

  let confidence: ClassifierResult['confidence']
  if (confidenceValue >= 0.75) confidence = 'high'
  else if (confidenceValue >= 0.4) confidence = 'low'
  else confidence = 'none'

  let workType: WorkType
  if (confidence === 'none') {
    workType = 'deep'
  } else {
    workType = deepScore >= shallowScore ? 'deep' : 'shallow'
  }

  // Spec edge case: readings classified shallow BUT if estimated_mins > 45 → promote to deep
  if (
    workType === 'shallow' &&
    typeof estimatedMins === 'number' &&
    estimatedMins > 45 &&
    (text.includes('read') || text.includes('reading'))
  ) {
    workType = 'deep'
  }

  return {
    work_type: workType,
    confidence,
    shallow_score: shallowScore,
    deep_score: deepScore,
    matched_keywords: matched,
  }
}

