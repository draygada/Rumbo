import { TaskType } from '../types'

const SHALLOW_KEYWORDS = [
  'email', 'reply', 'respond', 'submit', 'upload', 'schedule', 'read', 'review',
  'canvas', 'lms', 'form', 'admin', 'message', 'notes', 'slides', 'plan', 'print',
  'confirm', 'check', 'watch',
]

const DEEP_KEYWORDS = [
  'problem set', 'pset', 'essay', 'write', 'code', 'build', 'design', 'analyze',
  'study', 'exam', 'lab', 'report', 'project', 'research', 'derive', 'prove',
  'implement', 'debug', 'calculate', 'draft',
]

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase()
  return keywords.filter(kw => lower.includes(kw)).length
}

export interface ClassifierResult {
  type: TaskType
  confidence: number
  shallowScore: number
  deepScore: number
}

export function classify(title: string, estimatedMins?: number): ClassifierResult {
  const shallowScore = countMatches(title, SHALLOW_KEYWORDS)
  const deepScore = countMatches(title, DEEP_KEYWORDS)

  const confidence = Math.max(shallowScore, deepScore) / (shallowScore + deepScore + 1)

  let type: TaskType = deepScore >= shallowScore ? 'deep' : 'shallow'

  // Edge case: reading classified shallow but long task → promote to deep
  if (type === 'shallow' && estimatedMins !== undefined && estimatedMins > 45) {
    type = 'deep'
  }

  return { type, confidence, shallowScore, deepScore }
}
