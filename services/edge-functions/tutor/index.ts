// tutor — the Rumbo tutor Edge Function (Phase 8).
//
// Pattern per Features/ai-tutor.md §2:
//   1. Fetch or create session; load recent turns
//   2. Classify the question (within_course vs cross_course) + extract entities
//   3. Retrieve from Neo4j
//   4. Compose LLM prompt with retrieved context + history
//   5. Generate response (Gemini Flash, non-streaming in V0)
//   6. Persist user + assistant turns
//   7. Fire-and-forget: post-turn learner signal capture
//
// V0 explicitly non-streaming — SSE is V0.1. Keeps the response contract
// simple and lets the web UI show a spinner + final answer.
//
// Auth: user JWT (verify_jwt = true).
// Body: { question, conversation_id? }.
// Response: { conversation_id, answer, mode, confidence, sources, turn_id }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'
import {
  geminiClassifyJson,
  geminiEmbedBatch,
  type GeminiJsonSchema,
} from '../_shared/gemini.ts'
import {
  chunkFanOutSearch,
  computeConfidence,
  fanOutDocSearch,
  listCourses,
  resolveConcept,
  resolveCourseByCode,
  resolveCourseByEmbedding,
  retrieveAcrossCourses,
  retrieveCourseOverview,
  retrieveWithinCourse,
  type ChunkHit,
  type DocHit,
  type RetrievalHit,
} from '../_shared/tutor-retrieval.ts'

const TUTOR_SYSTEM_PROMPT = `You are Rumbo, a personal academic tutor. The student's own coursework is retrieved for you as a RETRIEVED CONTEXT block. That block is the source of truth about what THIS student is doing.

Rules:
- **Ground every claim about the student in the RETRIEVED CONTEXT.** If the context lists specific lectures, files, assignments, or courses, you MUST reference them by their exact title. Do not paraphrase them into generic categories.
- **Do not answer from general knowledge alone when the student asks about their own coursework.** If the retrieval doesn't have what they asked for, say so — do NOT fill the gap with a Wikipedia-style intro. Example: if asked "what did my education class cover?" and no education-course sources were retrieved, say "I don't see materials from an education course in your Rumbo yet — can you tell me the course code or upload the syllabus?" — do NOT lecture about what education classes typically cover.
- **When the student references a course you can't find, but the RETRIEVED CONTEXT includes a COURSES list**, that means the course they asked about doesn't exist in their Rumbo but similar courses might. Suggest the closest match by name — use only the course code and name that literally appears in the COURSES list. Do NOT invent a course name.
- **When defining a concept**, the definition itself can come from general knowledge — but tie it back to where the student has seen the concept in their own coursework (from the retrieval).
- **For "where have I seen this before"** questions, cite sources in chronological order (earliest first).
- **For "what am I taking?" or "list my courses"**, list them by name and term from the retrieval. Do not add courses that aren't retrieved.
- **Check the term against today's date.** If a course's term looks like it's in the past (e.g. today is 2026-07 but the course is "Winter 2025 (W25)"), you MUST call that out — say "I only have data for past terms right now; you don't appear to be enrolled in any current course." Do NOT label a past term as "current."
- **Never write essay drafts, problem set solutions, or code that solves an assignment.** If asked, offer to explain the concept instead.
- Keep responses under 250 words unless the question needs more.

Format:
- Two or three sentences of explanation. If sources apply, refer to them by exact title in the body of the response ("your CS 106A syllabus covers…"). Do not paste a bulleted source list at the end — the UI renders sources separately.`

const MODE_CLASSIFIER_SCHEMA: GeminiJsonSchema = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: ['within_course', 'cross_course', 'list_courses', 'small_talk'],
    },
    course_reference: { type: 'string' },      // course code / descriptor as spoken
    concept_query: { type: 'string' },         // the concept if any
    list_scope: { type: 'string', enum: ['all', 'current'] },
    reasoning: { type: 'string' },
  },
  required: ['mode'],
}

interface ModeClassification {
  mode: 'within_course' | 'cross_course' | 'list_courses' | 'small_talk'
  course_reference?: string
  concept_query?: string
  list_scope?: 'all' | 'current'
  reasoning?: string
}

interface TutorRequestBody {
  question?: string
  conversation_id?: string
}

interface TurnRow {
  role: 'user' | 'assistant'
  content: string
}

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const jwt = authHeader.slice('Bearer '.length)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return null
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

async function loadRecentTurns(
  admin: ReturnType<typeof createAdminClient>,
  sessionId: string,
  limit = 12,
): Promise<TurnRow[]> {
  const { data, error } = await admin
    .from('tutor_turns')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return ((data ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>).reverse()
}

async function classifyMode(question: string, history: TurnRow[]): Promise<ModeClassification> {
  const historyText = history
    .slice(-4)
    .map(t => `${t.role}: ${t.content}`)
    .join('\n')
  const parsed = await geminiClassifyJson<ModeClassification>({
    system: `Classify the student's question into ONE retrieval mode.

MODES:
- "within_course": student asked about a specific course. Any of:
  - Explicit code: "in CS 146J", "EDUC 475", "COLLEGE 101"
  - Subject + "class"/"course": "my education class", "the ML course", "my stats course"
  - Descriptor: "the fullstack class", "the class I'm taking on rest APIs"
  DEFAULT to within_course when the student's question is anchored on a specific class, even if they didn't cite a code.
- "cross_course": student asks WHERE across their coursework a concept has appeared. E.g. "where have I seen jacobians before?", "remind me what a gradient is and where I've encountered it"
- "list_courses": student wants a listing of their classes. E.g. "what am I taking?", "list my current classes", "show me all my past courses". Set list_scope='current' for current-term questions, 'all' for lifetime.
- "small_talk": greeting, meta, or non-academic

FIELDS:
- course_reference: the course code, subject, or descriptor uttered — as literally as possible. Include "education", "college", "CS", etc.
- concept_query: the specific topic (only for within_course + cross_course).
- list_scope: only when mode=list_courses.
`,
    userText: `Recent conversation:
${historyText}

Current question: ${question}`,
    schema: MODE_CLASSIFIER_SCHEMA,
    maxTokens: 300,
  })
  return parsed ?? { mode: 'cross_course', concept_query: question }
}

function formatRetrievalForPrompt(
  hits: RetrievalHit[],
  courses: Array<{ code: string | null; name: string | null; term: string | null }>,
  docHits: DocHit[] = [],
  chunkHits: ChunkHit[] = [],
): string {
  const sections: string[] = []
  if (courses.length > 0) {
    const lines = courses.map((c, i) => {
      const label = c.code || c.name || 'Untitled course'
      return `${i + 1}. ${label}${c.name && c.code ? ` — ${c.name}` : ''}${c.term ? ` (${c.term})` : ''}`
    })
    sections.push(`COURSES:\n${lines.join('\n')}`)
  }
  // De-dup source hits: prefer semantic doc-match info over concept-match info.
  const docSection = docHits.slice(0, 8).map((d, i) => {
    const courseTag = d.course_code || d.course_name
    const tag = courseTag ? `[${courseTag}${d.course_term ? ` · ${d.course_term}` : ''}]` : ''
    const url = d.source_url ? ` <${d.source_url}>` : ''
    return `${i + 1}. ${tag} ${d.source_label}: ${d.source_title}${url}  (semantic score ${d.score.toFixed(2)})`
  })
  if (docSection.length > 0) {
    sections.push(`SEMANTIC DOC MATCHES (from question embedding):\n${docSection.join('\n')}`)
  }
  const chunkSection = chunkHits.slice(0, 5).map((c, i) => {
    const heading = c.heading ? `[${c.heading}] ` : ''
    const excerpt = (c.text || '').replace(/\s+/g, ' ').slice(0, 400)
    return `${i + 1}. ${heading}${excerpt}${c.text.length > 400 ? '...' : ''}`
  })
  if (chunkSection.length > 0) {
    sections.push(`VERBATIM EXCERPTS (from chunk embeddings):\n${chunkSection.join('\n')}`)
  }
  if (hits.length > 0) {
    const bullets = hits.slice(0, 8).map((h, i) => {
      const parts: string[] = []
      const courseTag = h.course_code || h.course_name
      if (courseTag) parts.push(`[${courseTag}${h.course_term ? ` · ${h.course_term}` : ''}]`)
      parts.push(`${h.source_label}: ${h.source_title}`)
      if (h.slide_number != null) parts.push(`(slide ${h.slide_number})`)
      if (h.source_url) parts.push(`<${h.source_url}>`)
      if (h.concept_name) parts.push(`— concept: ${h.concept_name}`)
      return `${i + 1}. ${parts.join(' ')}`
    })
    sections.push(`CONCEPT-BASED SOURCES:\n${bullets.join('\n')}`)
  }
  if (sections.length === 0) return '(no relevant sources in your Rumbo brain)'
  return sections.join('\n\n')
}

async function generateAnswer(args: {
  question: string
  history: TurnRow[]
  retrievalText: string
  mode: ModeClassification['mode']
}): Promise<string> {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) return "I can't reach the LLM right now — the tutor is down."

  const conversationText = args.history
    .slice(-6)
    .map(t => `${t.role.toUpperCase()}: ${t.content}`)
    .join('\n')

  const today = new Date().toISOString().slice(0, 10)
  const userText = `Today is ${today}.

RETRIEVED CONTEXT FROM YOUR RUMBO BRAIN:
${args.retrievalText}

MODE: ${args.mode}

RECENT CONVERSATION:
${conversationText || '(new conversation)'}

STUDENT QUESTION:
${args.question}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TUTOR_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
          maxOutputTokens: 1400,
          temperature: 0.4,
          // Disable thinking so the token budget goes to visible answer.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  )
  if (!res.ok) {
    console.warn(`[tutor] gemini ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return "I couldn't reach the tutor model just now. Try again in a moment."
  }
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  return text || "I'm not sure how to answer that yet."
}

// Fire-and-forget learner signal capture — see Features/learner-model.md.
async function captureSignals(args: {
  admin: ReturnType<typeof createAdminClient>
  userId: string
  sessionId: string
  turnId: string
  userQuestion: string
  assistantAnswer: string
  retrievalHits: RetrievalHit[]
}) {
  try {
    const schema: GeminiJsonSchema = {
      type: 'object',
      properties: {
        signals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              signal_type: { type: 'string', enum: ['struggle', 'understanding', 'preference'] },
              target_type: { type: 'string', enum: ['Concept', 'Assignment', 'Course'] },
              target_id: { type: 'string' },
              intensity: { type: 'number', minimum: 0, maximum: 1 },
              note: { type: 'string' },
              source: { type: 'string', enum: ['explicit', 'inferred'] },
            },
            required: ['signal_type', 'target_type', 'target_id', 'intensity', 'source'],
          },
        },
      },
      required: ['signals'],
    }
    const hitsSummary = args.retrievalHits.slice(0, 6).map(h => `${h.concept_id}: ${h.concept_name}`).join('\n')
    const parsed = await geminiClassifyJson<{ signals: Array<{
      signal_type: 'struggle' | 'understanding' | 'preference'
      target_type: 'Concept' | 'Assignment' | 'Course'
      target_id: string
      intensity: number
      note?: string
      source: 'explicit' | 'inferred'
    }> }>({
      system: `Review a tutor exchange and emit zero or more learner signals.
- struggle: student said "I don't get it", "confused", asked the same thing twice, or their phrasing implies confusion
- understanding: student said "got it", "that makes sense", moved on without follow-up
- preference: student expressed HOW they process material ("give me an example", "just the formula", "show me code")

Only emit high-confidence signals. Empty array is fine.
target_id must be one of the concept ids from the retrieved context; use the concept a signal is about.`,
      userText: `Retrieved concepts (id: name):
${hitsSummary}

Student: ${args.userQuestion}
Assistant: ${args.assistantAnswer}`,
      schema,
      maxTokens: 400,
    })
    const signals = parsed?.signals ?? []
    if (signals.length === 0) return
    const rows = signals.map(s => ({
      user_id: args.userId,
      session_id: args.sessionId,
      turn_id: args.turnId,
      target_id: s.target_id,
      target_type: s.target_type,
      signal_type: s.signal_type,
      signal_value: { intensity: s.intensity, note: s.note ?? null },
      source: s.source,
      confidence: s.intensity,
    }))
    await args.admin.from('learner_signals').insert(rows)
  } catch (err) {
    console.warn('[tutor] signal capture failed:', err)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const userId = await getUserIdFromRequest(req)
  if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401)

  let body: TutorRequestBody
  try {
    body = (await req.json()) as TutorRequestBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  const question = body.question?.trim()
  if (!question) return jsonResponse({ error: 'question is required' }, 400)

  const admin = createAdminClient()
  const g = neo4j()

  // 1. Session
  let conversationId = body.conversation_id
  if (!conversationId) {
    const { data: newSession, error: newErr } = await admin
      .from('tutor_sessions')
      .insert({ user_id: userId, title: question.slice(0, 60) })
      .select('id')
      .single()
    if (newErr || !newSession) {
      return jsonResponse({ error: 'session create failed', detail: newErr?.message }, 500)
    }
    conversationId = newSession.id as string
  }

  const history = await loadRecentTurns(admin, conversationId)

  // 2. Mode + entity classification
  const mode = await classifyMode(question, history)

  // 3. Retrieval
  let hits: RetrievalHit[] = []
  let coursesForPrompt: Array<{ code: string | null; name: string | null; term: string | null }> = []
  const needsConceptEmbed = mode.mode === 'within_course' || mode.mode === 'cross_course'
  const conceptEmbeds = needsConceptEmbed
    ? await geminiEmbedBatch([mode.concept_query || question])
    : []
  const conceptEmb = conceptEmbeds[0]

  let topScore: number | null = null
  let runnerUpScore: number | null = null
  let resolvedCourseCode: string | null = null

  if (mode.mode === 'list_courses') {
    const scope = mode.list_scope ?? 'current'
    const courses = await listCourses(g, { userId, currentOnly: scope === 'current' })
    coursesForPrompt = courses.map(c => ({ code: c.code, name: c.name, term: c.term }))
    // No RetrievalHit rows here — surface only the course list. Confidence
    // depends purely on whether we found any.
    topScore = courses.length > 0 ? 1 : 0
  } else if (mode.mode === 'within_course') {
    // Even if no course_reference, try to resolve the whole question against
    // course names (helps when the router leaves the field empty).
    const ref = mode.course_reference || mode.concept_query || question
    let courses = ref ? await resolveCourseByCode(g, { userId, code: ref }) : []
    if (courses.length === 0 && ref) {
      const courseEmbeds = await geminiEmbedBatch([ref])
      if (courseEmbeds[0]) {
        const withScore = await resolveCourseByEmbedding(g, {
          userId,
          embedding: courseEmbeds[0],
        })
        courses = withScore.slice(0, 3).map(c => ({ id: c.id, code: c.code, name: c.name, term: c.term }))
      }
    }
    if (courses.length > 0) {
      resolvedCourseCode = courses[0].code
      // Concept-guided retrieval if we have a concept embedding, else a plain
      // overview of what's in that course.
      if (conceptEmb) {
        hits = await retrieveWithinCourse(g, {
          userId,
          courseId: courses[0].id,
          conceptEmbedding: conceptEmb,
        })
      }
      if (hits.length === 0) {
        hits = await retrieveCourseOverview(g, { userId, courseId: courses[0].id })
      }
      topScore = hits.length > 0 ? 0.9 : 0.4
    } else {
      // Course resolution failed. Instead of the LLM guessing, hand it the
      // full course list so it can suggest the closest match by name.
      const allCourses = await listCourses(g, { userId, currentOnly: false })
      coursesForPrompt = allCourses.map(c => ({ code: c.code, name: c.name, term: c.term }))
      topScore = 0.25 // low: retrieval failed but we know what they *could* mean
    }
  } else if (mode.mode === 'cross_course' && conceptEmb) {
    const resolved = await resolveConcept(g, { userId, embedding: conceptEmb })
    if (resolved.length > 0) {
      topScore = resolved[0].score
      runnerUpScore = resolved[1]?.score ?? null
      hits = await retrieveAcrossCourses(g, { userId, conceptId: resolved[0].id })
    }
  }

  // 3.5. Semantic fan-out — query embedding hits every content label's
  // body_embedding index + chunk embeddings in parallel. Adds SEMANTIC layer
  // on top of the concept-based retrieval above.
  let docHits: DocHit[] = []
  let chunkHits: ChunkHit[] = []
  if (conceptEmb && mode.mode !== 'list_courses' && mode.mode !== 'small_talk') {
    const questionEmbeds = await geminiEmbedBatch([question])
    const questionEmb = questionEmbeds[0] ?? conceptEmb
    const [docs, chunks] = await Promise.all([
      fanOutDocSearch(g, { userId, embedding: questionEmb, perLabelK: 4, minScore: 0.55 }),
      chunkFanOutSearch(g, { userId, embedding: questionEmb, topK: 5, minScore: 0.55 }),
    ])
    docHits = docs
    chunkHits = chunks
    // Fold semantic hit strength into confidence — the highest doc score is a
    // strong signal even when concept-path retrieval came back empty.
    if (docs.length > 0 && (topScore == null || docs[0].score > topScore)) {
      topScore = docs[0].score
    }
  }

  const totalHitCount = hits.length + docHits.length + chunkHits.length
  const confidence = computeConfidence({ topScore, runnerUpScore, hitCount: totalHitCount })

  // 4. LLM answer
  const retrievalText = formatRetrievalForPrompt(hits, coursesForPrompt, docHits, chunkHits)
  const answer = await generateAnswer({ question, history, retrievalText, mode: mode.mode })
  void resolvedCourseCode // available for future prompt hints; unused for now

  // 5. Persist turns
  const now = new Date().toISOString()
  const { error: userTurnErr } = await admin.from('tutor_turns').insert({
    session_id: conversationId,
    user_id: userId,
    role: 'user',
    content: question,
    mode: mode.mode,
    created_at: now,
  })
  if (userTurnErr) console.warn('[tutor] user turn insert:', userTurnErr.message)

  const { data: astTurn, error: astErr } = await admin
    .from('tutor_turns')
    .insert({
      session_id: conversationId,
      user_id: userId,
      role: 'assistant',
      content: answer,
      retrieval_ids: hits.map(h => h.concept_id),
      confidence,
      mode: mode.mode,
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (astErr) console.warn('[tutor] assistant turn insert:', astErr.message)

  await admin
    .from('tutor_sessions')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  // 6. Fire-and-forget signal capture (don't block on it)
  if (astTurn?.id) {
    void captureSignals({
      admin,
      userId,
      sessionId: conversationId,
      turnId: astTurn.id as string,
      userQuestion: question,
      assistantAnswer: answer,
      retrievalHits: hits,
    })
  }

  let sourceEntries: Array<{
    title: string
    url: string | null
    course: string | null
    term: string | null
    slide_number: number | null
  }>
  if (mode.mode === 'list_courses') {
    sourceEntries = coursesForPrompt.map(c => ({
      title: c.code || c.name || 'Course',
      url: null,
      course: c.name,
      term: c.term,
      slide_number: null,
    }))
  } else {
    // Merge semantic doc hits + concept-based hits, dedup by source_id.
    const seen = new Set<string>()
    const merged: Array<{
      title: string
      url: string | null
      course: string | null
      term: string | null
      slide_number: number | null
    }> = []
    for (const d of docHits.slice(0, 6)) {
      if (seen.has(d.source_id)) continue
      seen.add(d.source_id)
      merged.push({
        title: d.source_title,
        url: d.source_url,
        course: d.course_code || d.course_name,
        term: d.course_term,
        slide_number: null,
      })
    }
    for (const h of hits.slice(0, 6)) {
      if (seen.has(h.source_id)) continue
      seen.add(h.source_id)
      merged.push({
        title: h.source_title,
        url: h.source_url,
        course: h.course_code || h.course_name,
        term: h.course_term,
        slide_number: h.slide_number,
      })
    }
    sourceEntries = merged.slice(0, 10)
  }

  return jsonResponse({
    conversation_id: conversationId,
    answer,
    mode: mode.mode,
    confidence,
    sources: sourceEntries,
    turn_id: astTurn?.id ?? null,
  })
})
