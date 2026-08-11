// tutor-v4-stream — streaming variant of tutor-v4.
//
// Mirrors tutor-v4/index.ts stages 1-7 EXACTLY (rewriteQuery → routeQuery →
// metadata-shortcut with the empty→retrieval fallback → retrieveV4, keeping the
// DEMO_COURSE_ID scoping intact via retrieveV4), then STREAMS stage 8 (answer
// generation) to the browser token-by-token over Server-Sent Events.
//
// SSE event contract (each frame: `event: <name>\ndata: <json>\n\n`):
//   meta   { learning_mode, template, session_id, sources }
//   token  { delta }                       — one per streamed chunk (or 1 total
//                                             for non-streamed modes)
//   done   { answer, model_used }
//   error  { error }
//
// New endpoint URL: /functions/v1/tutor-v4-stream. No JWT (same as tutor-v4).

import { corsHeaders } from '../_shared/cors.ts'
import { neo4j } from '../_shared/neo4j.ts'
import { rewriteQuery, type PriorTurn } from '../_shared/query-rewriter.ts'
import { routeQuery } from '../_shared/router-v4.ts'
import { runShortcut } from '../_shared/metadata-shortcut.ts'
import { retrieveV4, type RetrievedSource } from '../_shared/retrieval-v4.ts'
import { generateAnswer } from '../_shared/answer-v4.ts'
import { anthropicTextStream, SONNET_MODEL } from '../_shared/anthropic-stream.ts'

interface TutorRequest {
  user_id: string
  session_id?: string | null
  message: string
  prior_turns?: PriorTurn[]
}

interface SourceOut {
  source_type: string
  title: string
  course_code: string | null
  slide_or_section: string | null
  rerank_score: number | null
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Tutor persona + formatters — replicated faithfully from answer-v4.ts, which
// does NOT export TUTOR_PERSONA / formatFlatSources / formatGroupedByCourse.
// Keep in sync with _shared/answer-v4.ts.
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

const EXPLORATION_SUFFIX = `

For this exploration turn: prioritize CONNECTIONS the student may not have noticed — how this concept links to material in other retrieved sources, what it enables, what it depends on. Still stay grounded in the retrieved context.`

const CROSS_COURSE_SUFFIX = `

For this cross-course turn: the RETRIEVED CONTEXT is grouped by course with --- headers. Draw explicit comparisons across courses when the material supports it. If the connection is a stretch, say so honestly rather than force a parallel.`

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

function toSourceOut(s: RetrievedSource): SourceOut {
  return {
    source_type: s.source_type,
    title: s.title,
    course_code: s.course_code,
    slide_or_section: s.slide_or_section,
    rerank_score: s.rerank_score,
  }
}

// ---------------------------------------------------------------------------
// Stage 8 (streamed) — build the exact answer-v4 system + userText per mode and
// stream token deltas. Returns the full answer + model id for the done event.
// ---------------------------------------------------------------------------

async function streamRetrievalAnswer(
  mode: 'tutoring' | 'exploration' | 'cross_course',
  query: string,
  sources: RetrievedSource[],
  send: (event: string, data: unknown) => void,
): Promise<{ answer: string; model_used: string }> {
  let system = TUTOR_PERSONA
  let userText: string
  let temperature = 0.4
  let maxTokens = 1400

  if (mode === 'exploration') {
    system = TUTOR_PERSONA + EXPLORATION_SUFFIX
    temperature = 0.5
    userText = `QUERY (exploration): ${query}\n\nRETRIEVED CONTEXT:\n${formatFlatSources(sources)}`
  } else if (mode === 'cross_course') {
    system = TUTOR_PERSONA + CROSS_COURSE_SUFFIX
    temperature = 0.4
    maxTokens = 1600
    userText = `QUERY (cross-course): ${query}\n\nRETRIEVED CONTEXT (grouped by course):\n${formatGroupedByCourse(sources)}`
  } else {
    // tutoring — learnerContext is null for V0, so the learner block is empty.
    userText = `QUERY: ${query}\n\nRETRIEVED CONTEXT:\n${formatFlatSources(sources)}`
  }

  const streamed = await anthropicTextStream({
    system,
    userText,
    model: SONNET_MODEL,
    maxTokens,
    temperature,
    onDelta: (delta) => send('token', { delta }),
  })

  if (streamed) return { answer: streamed, model_used: SONNET_MODEL }

  // Fail-soft: streaming returned nothing (API error). Emit the same fallback
  // answer-v4 would return so the client shows something.
  const fallback = 'I ran into a problem generating an answer. Try rephrasing?'
  send('token', { delta: fallback })
  return { answer: fallback, model_used: SONNET_MODEL }
}

// ---------------------------------------------------------------------------
// Pipeline — stages 1-7 identical to tutor-v4, dispatching to a streamed or
// single-shot stage 8. Emits meta first, then tokens, and returns the final
// answer + model for the caller to send in `done`.
// ---------------------------------------------------------------------------

async function runPipeline(
  body: TutorRequest,
  send: (event: string, data: unknown) => void,
): Promise<{ answer: string; model_used: string }> {
  const sessionId = body.session_id ?? null

  // Stage 1: query rewriter
  const rewritten = await rewriteQuery({
    currentMessage: body.message,
    priorTurns: body.prior_turns ?? [],
  })

  // Stage 2: router
  const route = await routeQuery(rewritten.query)

  // Stage 2b: metadata shortcut path
  if (route.learning_mode === 'lookup' && route.template) {
    const g = neo4j()
    const metaResult = await runShortcut(g, {
      userId: body.user_id,
      template: route.template,
      courseHint: route.course_hint,
      conceptHint: route.concept_hint,
    })

    if (metaResult.empty) {
      // Empty→retrieval fallback (identical to tutor-v4): run full tutoring
      // retrieval rather than answering "couldn't find anything".
      const retrieval = await retrieveV4(g, {
        userId: body.user_id,
        query: rewritten.query,
        learningMode: 'tutoring',
        courseHint: route.course_hint,
        conceptHint: route.concept_hint,
      })
      send('meta', {
        learning_mode: 'tutoring',
        template: `lookup_fallback:${route.template}`,
        session_id: sessionId,
        sources: retrieval.sources.map(toSourceOut),
      })
      if (retrieval.clarifyingQuestion) {
        send('token', { delta: retrieval.clarifyingQuestion })
        return { answer: retrieval.clarifyingQuestion, model_used: 'none' }
      }
      return await streamRetrievalAnswer('tutoring', rewritten.query, retrieval.sources, send)
    }

    // Non-empty shortcut → lookup answer (single-shot, non-streamed).
    send('meta', {
      learning_mode: 'lookup',
      template: route.template,
      session_id: sessionId,
      sources: metaResult.rows.map((r) => ({
        source_type: r.kind,
        title: r.title,
        course_code: r.course_code ?? null,
        slide_or_section: null,
        rerank_score: null,
      })),
    })
    const answer = await generateAnswer({
      query: rewritten.query,
      learningMode: 'lookup',
      sources: [],
      metadata: metaResult,
      clarifyingQuestion: null,
    })
    send('token', { delta: answer.text })
    return { answer: answer.text, model_used: answer.model_used }
  }

  if (route.learning_mode === 'small_talk') {
    send('meta', {
      learning_mode: 'small_talk',
      template: null,
      session_id: sessionId,
      sources: [],
    })
    const answer = await generateAnswer({
      query: rewritten.query,
      learningMode: 'small_talk',
      sources: [],
      metadata: null,
      clarifyingQuestion: null,
    })
    send('token', { delta: answer.text })
    return { answer: answer.text, model_used: answer.model_used }
  }

  // Full retrieval path (Stages 3-7 + streamed 8).
  const g = neo4j()
  const learningMode = route.learning_mode as 'tutoring' | 'exploration' | 'cross_course'
  const retrieval = await retrieveV4(g, {
    userId: body.user_id,
    query: rewritten.query,
    learningMode,
    courseHint: route.course_hint,
    conceptHint: route.concept_hint,
  })

  send('meta', {
    learning_mode: route.learning_mode,
    template: null,
    session_id: sessionId,
    sources: retrieval.sources.map(toSourceOut),
  })

  if (retrieval.clarifyingQuestion) {
    send('token', { delta: retrieval.clarifyingQuestion })
    return { answer: retrieval.clarifyingQuestion, model_used: 'none' }
  }

  return await streamRetrievalAnswer(learningMode, rewritten.query, retrieval.sources, send)
}

// ---------------------------------------------------------------------------
// HTTP handler — SSE response backed by a ReadableStream.
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let body: TutorRequest
  try {
    body = (await req.json()) as TutorRequest
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!body.user_id || !body.message) {
    return new Response(JSON.stringify({ ok: false, error: 'user_id and message required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        const { answer, model_used } = await runPipeline(body, send)
        send('done', { answer, model_used })
      } catch (err) {
        console.error('[tutor-v4-stream] fatal:', err)
        send('error', { error: errMsg(err) })
      } finally {
        closed = true
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})
