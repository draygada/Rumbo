// router-v4 — Haiku classifier that picks learning_mode + template for a
// standalone query.
//
// learning_mode drives model dispatch at Stage 8 (answer generation):
//   - tutoring         → Sonnet 4.6 (pedagogical, canvas-grounded)
//   - exploration      → Sonnet 4.6 (broader, connection-forward)
//   - lookup           → Haiku 4.5 (terse, deterministic)
//   - cross_course     → Sonnet 4.6 with per-course-grouped prompt
//   - small_talk       → Haiku 4.5, no retrieval
//
// template names route into metadata-shortcut Cypher (see metadata-shortcut.ts)
// when the query is a pure lookup — bypasses Stages 3-7 for ~1.2s TTFT.

import { anthropicToolJson, HAIKU_MODEL } from './anthropic.ts'

export type LearningMode =
  | 'tutoring'
  | 'exploration'
  | 'lookup'
  | 'cross_course'
  | 'small_talk'

export type ShortcutTemplate =
  | 'next_due'
  | 'due_range'
  | 'list_assignments'
  | 'list_lectures'
  | 'list_courses'
  | 'course_status'
  | 'find_source'
  | 'concept_home'
  | 'grading_policy'
  | 'week_summary'
  | null

export interface RouterOutput {
  learning_mode: LearningMode
  template: ShortcutTemplate
  course_hint: string | null    // course code the query implies, if detectable
  concept_hint: string | null   // concept the query implies, if detectable
  reasoning: string             // short — helps eval debugging
}

const SYSTEM = `You classify a student's standalone query for a tutor.

Pick learning_mode:
- "tutoring"     — student is learning, wants an explanation, or asks WHAT CONTENT is in a lecture/reading/assignment. Examples: "what did lecture 1 cover", "explain regularization", "walk me through the case study", "summarize week 3", "what's the argument in the Geekie reading".
- "exploration" — student wants to explore connections across their materials, "what else relates to X", broader thinking
- "lookup"       — PURE METADATA question with no content substance needed. Examples: "when is X due", "list my assignments", "which class am I taking", "how many lectures in ECON 105". If the answer requires reading document CONTENT, this is NOT lookup — pick tutoring instead.
- "cross_course" — question spans multiple courses ("how does X in class A relate to Y in class B")
- "small_talk"   — greeting, thanks, off-topic — no retrieval needed

Key discriminator for lookup vs tutoring: does answering require just database lookup (dates, names, counts) OR reading document text? If it requires reading text, use tutoring.

For lookup, ALSO pick a template (bypasses full retrieval):
- "next_due"          — "when is my next assignment due"
- "due_range"          — "what's due next week", "upcoming this month"
- "list_assignments"  — "show me all assignments for X"
- "list_lectures"     — "list the lectures for X"
- "list_courses"      — "what classes am I taking"
- "course_status"     — "how am I doing in X"
- "find_source"       — "where's the reading on Y", "which lecture was Y in"
- "concept_home"      — "which class teaches X"
- "grading_policy"    — "what's the grading for X"
- "week_summary"       — "what's happening this week"

If mode is not "lookup", set template to null.

course_hint: any explicit course code or unambiguous name mentioned (e.g. "ECON 105", "the ML class"). null if none.
concept_hint: a specific concept the query is about (e.g. "linear regression", "market segmentation"). null if none.

reasoning: 1 sentence explaining your call. Useful for eval.`

const SCHEMA = {
  type: 'object' as const,
  properties: {
    learning_mode: {
      type: 'string' as const,
      enum: ['tutoring', 'exploration', 'lookup', 'cross_course', 'small_talk'],
    },
    template: {
      type: 'string' as const,
      enum: [
        'next_due', 'due_range', 'list_assignments', 'list_lectures',
        'list_courses', 'course_status', 'find_source', 'concept_home',
        'grading_policy', 'week_summary',
      ],
    },
    course_hint: { type: 'string' as const },
    concept_hint: { type: 'string' as const },
    reasoning: { type: 'string' as const },
  },
  required: ['learning_mode', 'reasoning'],
}

export async function routeQuery(query: string): Promise<RouterOutput> {
  const out = await anthropicToolJson<RouterOutput>({
    system: SYSTEM,
    userText: `QUERY: ${query}`,
    toolName: 'emit_router_decision',
    toolDescription: 'Emit the routing decision for this query.',
    schema: SCHEMA,
    model: HAIKU_MODEL,
    maxTokens: 400,
  })
  if (!out) {
    return {
      learning_mode: 'tutoring', template: null,
      course_hint: null, concept_hint: null,
      reasoning: 'router failed; default tutoring',
    }
  }
  return {
    learning_mode: out.learning_mode,
    template: (out.template ?? null) as ShortcutTemplate,
    course_hint: out.course_hint ?? null,
    concept_hint: out.concept_hint ?? null,
    reasoning: out.reasoning ?? '',
  }
}
