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

/** Classifies work type from the task title only (keyword matching). */
export function classify(title: string): ClassifierResult {
  const shallowScore = countMatches(title, SHALLOW_KEYWORDS)
  const deepScore = countMatches(title, DEEP_KEYWORDS)

  const confidence = Math.max(shallowScore, deepScore) / (shallowScore + deepScore + 1)
  const type: TaskType = deepScore >= shallowScore ? 'deep' : 'shallow'

  return { type, confidence, shallowScore, deepScore }
}
