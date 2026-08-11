// answer-v4 — Stage 8: dispatch by learning_mode → prompt + model.
//
// Modes:
//   tutoring     — Sonnet 4.6, tutor-persona system prompt, Canvas-grounded,
//                  COVERS.definition surfaced, sequence-safe
//   exploration  — Sonnet 4.6, exploratory framing (connect-forward)
//   lookup       — Haiku 4.5, terse format directly from MetadataResult
//   cross_course — Sonnet 4.6, per-course-grouped prompt (--- course headers)
//   small_talk   — Haiku 4.5, no retrieval used
//
// Load-bearing invariants (from tutor-persona.md + LLD §12):
//   - Never claim knowledge NOT sourced from the retrieved context.
//     If context is insufficient, say so honestly and ask for direction.
//   - Never produce submittable work on the student's behalf.
//   - Sequence-safe: don't reference material past the student's current
//     position (surface via context injection when learner-brain lands V0.1;
//     for now: just don't confabulate week numbers).
//   - Warm graduate-student voice; no relentless Socratic questioning.
//   - Empty compliments banned ("Great question!"). Empty hedging banned.

import { anthropicText, HAIKU_MODEL, SONNET_MODEL } from './anthropic.ts'
import type { RetrievedSource } from './retrieval-v4.ts'
import type { MetadataResult } from './metadata-shortcut.ts'
import type { LearningMode } from './router-v4.ts'

export interface AnswerInput {
  query: string
  learningMode: LearningMode
  sources: RetrievedSource[]
  metadata: MetadataResult | null
  clarifyingQuestion: string | null   // if set, we short-circuit and just ask
  learnerContext?: string | null      // V0.1 will populate; empty for V0
}

export interface AnswerOutput {
  text: string
  model_used: string
  mode: LearningMode
  sources_cited: number
  is_clarifying: boolean
}

// ---------------------------------------------------------------------------
// Tutor persona — condensed from Features/tutor-persona.md.
// ---------------------------------------------------------------------------

const TUTOR_PERSONA = `You are Rumbo, a personal tutor for a specific college student.

You have ACCESS to the student's own coursework (Canvas assignments, lectures, syllabi, files) via the RETRIEVED CONTEXT below. Everything you claim about the student's classes MUST be grounded in that context — never invent professor names, week numbers, assignment titles, or concept definitions that aren't there.

Voice:
- Warm graduate student at a good school. Confident but not showy. Considered, not stiff.
- Speak directly. Second person, contractions, sentence fragments where they land.
- Never open with empty affirmations ("Great question!", "That's a really interesting thought!").
- Never end with unearned encouragement ("You've got this!").
- When you don't know, say so — plainly. "I don't see this in your Week 6 material — do you want me to look at Week 7?" Do NOT invent to fill space.

Pedagogy:
- Match the student's framing to their professor's framing when the retrieved context reveals it (COVERS.definition, COVERS.excerpt).
- Mixed-modal: sometimes explain directly, sometimes ask one guiding question, sometimes give an example. Not relentlessly Socratic — that grates.
- Sequence-safe: if the student is in Week 6, don't reference Week 10 material as if they've seen it.
- Never produce submittable work: essays, code, filled-in problem sets, discussion posts. If asked, decline and offer to help them think through it instead.

Cite sources by their titles inline where useful. Don't fabricate citations.`

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

export async function generateAnswer(input: AnswerInput): Promise<AnswerOutput> {
  // Short-circuit — clarifying question from empty-retrieval fallback.
  if (input.clarifyingQuestion) {
    return {
      text: input.clarifyingQuestion,
      model_used: 'none',
      mode: input.learningMode,
      sources_cited: 0,
      is_clarifying: true,
    }
  }

  switch (input.learningMode) {
    case 'small_talk':
      return await answerSmallTalk(input)
    case 'lookup':
      return await answerLookup(input)
    case 'cross_course':
      return await answerCrossCourse(input)
    case 'exploration':
      return await answerExploration(input)
    case 'tutoring':
    default:
      return await answerTutoring(input)
  }
}

// ---------------------------------------------------------------------------
// small_talk — Haiku, no retrieval used
// ---------------------------------------------------------------------------

async function answerSmallTalk(input: AnswerInput): Promise<AnswerOutput> {
  const system = `You are Rumbo, a warm but understated tutor. Reply briefly (one or two sentences) to this greeting / small-talk message, then invite the student to share what they're working on. Do NOT open with empty compliments ("Great question!"), do NOT use exclamation-heavy hype, and do NOT use emoji. Warm, not giddy.`
  const text = await anthropicText({
    system, userText: input.query, model: HAIKU_MODEL, maxTokens: 200,
  })
  return {
    text: text ?? 'Hey — what are you working on?',
    model_used: HAIKU_MODEL,
    mode: 'small_talk',
    sources_cited: 0,
    is_clarifying: false,
  }
}

// ---------------------------------------------------------------------------
// lookup — Haiku, format MetadataResult tersely
// ---------------------------------------------------------------------------

async function answerLookup(input: AnswerInput): Promise<AnswerOutput> {
  if (!input.metadata || input.metadata.empty) {
    return {
      text: `I couldn't find anything matching that. Want to tell me more — a specific class or timeframe?`,
      model_used: 'none',
      mode: 'lookup',
      sources_cited: 0,
      is_clarifying: false,
    }
  }
  const rowsBlock = input.metadata.rows.map((r, i) => {
    const parts = [`${i + 1}. ${r.title}`]
    if (r.course_code) parts.push(`(${r.course_code})`)
    if (r.due_at) parts.push(`— due ${r.due_at}`)
    if (r.detail) parts.push(`— ${r.detail}`)
    return parts.join(' ')
  }).join('\n')

  const system = `You are Rumbo. Given the LOOKUP RESULT rows below, answer the student's QUERY in a terse, direct format. Reformat the rows for the student's specific question (bullet list, sentence, or short paragraph — pick what fits). Don't add commentary the rows don't support. If the answer is a single fact, state it in one sentence.`
  const userText = `QUERY: ${input.query}

LOOKUP RESULT (template=${input.metadata.template}):
${rowsBlock}`
  const text = await anthropicText({
    system, userText, model: HAIKU_MODEL, maxTokens: 400,
  })
  return {
    text: text ?? rowsBlock,
    model_used: HAIKU_MODEL,
    mode: 'lookup',
    sources_cited: input.metadata.rows.length,
    is_clarifying: false,
  }
}

// ---------------------------------------------------------------------------
// tutoring — Sonnet, tutor persona, flat retrieved-source list
// ---------------------------------------------------------------------------

async function answerTutoring(input: AnswerInput): Promise<AnswerOutput> {
  const contextBlock = formatFlatSources(input.sources)
  const learnerBlock = input.learnerContext ? `\nLEARNER CONTEXT:\n${input.learnerContext}\n` : ''
  const userText = `QUERY: ${input.query}
${learnerBlock}
RETRIEVED CONTEXT:
${contextBlock}`

  const text = await anthropicText({
    system: TUTOR_PERSONA, userText,
    model: SONNET_MODEL, maxTokens: 1400, temperature: 0.4,
  })
  return {
    text: text ?? 'I ran into a problem generating an answer. Try rephrasing?',
    model_used: SONNET_MODEL,
    mode: 'tutoring',
    sources_cited: input.sources.length,
    is_clarifying: false,
  }
}

// ---------------------------------------------------------------------------
// exploration — Sonnet, connection-forward framing
// ---------------------------------------------------------------------------

async function answerExploration(input: AnswerInput): Promise<AnswerOutput> {
  const contextBlock = formatFlatSources(input.sources)
  const explorationSystem = TUTOR_PERSONA + `

For this exploration turn: prioritize CONNECTIONS the student may not have noticed — how this concept links to material in other retrieved sources, what it enables, what it depends on. Still stay grounded in the retrieved context.`
  const userText = `QUERY (exploration): ${input.query}

RETRIEVED CONTEXT:
${contextBlock}`

  const text = await anthropicText({
    system: explorationSystem, userText,
    model: SONNET_MODEL, maxTokens: 1400, temperature: 0.5,
  })
  return {
    text: text ?? 'I ran into a problem generating an answer. Try rephrasing?',
    model_used: SONNET_MODEL,
    mode: 'exploration',
    sources_cited: input.sources.length,
    is_clarifying: false,
  }
}

// ---------------------------------------------------------------------------
// cross_course — Sonnet, per-course-grouped prompt (§6.8 spec)
// ---------------------------------------------------------------------------

async function answerCrossCourse(input: AnswerInput): Promise<AnswerOutput> {
  const contextBlock = formatGroupedByCourse(input.sources)
  const crossSystem = TUTOR_PERSONA + `

For this cross-course turn: the RETRIEVED CONTEXT is grouped by course with --- headers. Draw explicit comparisons across courses when the material supports it. If the connection is a stretch, say so honestly rather than force a parallel.`
  const userText = `QUERY (cross-course): ${input.query}

RETRIEVED CONTEXT (grouped by course):
${contextBlock}`

  const text = await anthropicText({
    system: crossSystem, userText,
    model: SONNET_MODEL, maxTokens: 1600, temperature: 0.4,
  })
  return {
    text: text ?? 'I ran into a problem generating an answer. Try rephrasing?',
    model_used: SONNET_MODEL,
    mode: 'cross_course',
    sources_cited: input.sources.length,
    is_clarifying: false,
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatFlatSources(sources: RetrievedSource[]): string {
  if (sources.length === 0) return '(no retrieved context)'
  return sources.map((s, i) => {
    const parts: string[] = []
    parts.push(`--- Source ${i + 1}: ${s.title} (${s.source_type}${s.course_code ? ` · ${s.course_code}` : ''})`)
    if (s.slide_or_section) parts.push(`Section: ${s.slide_or_section}`)
    if (s.covers_definition) parts.push(`Definition from source: ${s.covers_definition}`)
    parts.push(s.body_text.slice(0, 4000))
    return parts.join('\n')
  }).join('\n\n')
}

function formatGroupedByCourse(sources: RetrievedSource[]): string {
  const byCourse = new Map<string, RetrievedSource[]>()
  for (const s of sources) {
    const key = s.course_code
      ? `${s.course_code}${s.course_name ? ` (${s.course_name})` : ''}`
      : '(unassigned course)'
    if (!byCourse.has(key)) byCourse.set(key, [])
    byCourse.get(key)!.push(s)
  }
  const blocks: string[] = []
  for (const [course, list] of byCourse) {
    const lines: string[] = [`--- ${course} ---`]
    for (const s of list) {
      lines.push(`Source: ${s.title} (${s.source_type})${s.slide_or_section ? ` · ${s.slide_or_section}` : ''}`)
      if (s.covers_definition) lines.push(`Definition from source: ${s.covers_definition}`)
      lines.push(s.body_text.slice(0, 3000))
      lines.push('')
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n')
}
