// tutor-v4 — end-to-end tutor endpoint wiring pipeline-v4.md Stages 1-9.
//
// Flow:
//   Stage 1  query-rewriter        (Gemini Flash — the only Gemini call in v4)
//   Stage 2  router-v4              (Haiku: learning_mode + template + hints)
//   Stage 2b metadata-shortcut      (skip 3-7 for pure lookups)
//   Stage 3-7 retrieval-v4          (Lane A/B fan-out, RRF, rerank, small-to-big)
//   Stage 8  answer-v4              (Sonnet/Haiku dispatched by learning_mode)
//   Stage 9  persistence            (tutor_turns + learner_signals fire-and-forget)
//
// Deployed alongside the existing /tutor endpoint (v3). New endpoint URL:
// /functions/v1/tutor-v4. Frontend can A/B or the eval harness can invoke this
// specifically.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'
import { rewriteQuery, type PriorTurn } from '../_shared/query-rewriter.ts'
import { routeQuery } from '../_shared/router-v4.ts'
import { runShortcut } from '../_shared/metadata-shortcut.ts'
import { retrieveV4 } from '../_shared/retrieval-v4.ts'
import { generateAnswer } from '../_shared/answer-v4.ts'

interface TutorRequest {
  user_id: string
  session_id?: string | null
  message: string
  prior_turns?: PriorTurn[]
}

interface TutorResponse {
  ok: boolean
  session_id?: string | null
  answer: string
  learning_mode: string
  template: string | null
  model_used: string
  is_clarifying: boolean
  sources: Array<{
    source_type: string
    title: string
    course_code: string | null
    slide_or_section: string | null
    rerank_score: number | null
  }>
  timing_ms: Record<string, number>
  error?: string
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
  }
  let body: TutorRequest
  try {
    body = (await req.json()) as TutorRequest
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  if (!body.user_id || !body.message) {
    return jsonResponse({ ok: false, error: 'user_id and message required' }, 400)
  }

  const timing: Record<string, number> = {}
  const t0 = Date.now()

  try {
    // Stage 1: query rewriter
    const t1a = Date.now()
    const rewritten = await rewriteQuery({
      currentMessage: body.message,
      priorTurns: body.prior_turns ?? [],
    })
    timing.stage1_rewriter = Date.now() - t1a

    // Stage 2: router
    const t2a = Date.now()
    const route = await routeQuery(rewritten.query)
    timing.stage2_router = Date.now() - t2a

    // Stage 2b: metadata shortcut path
    let response: TutorResponse

    if (route.learning_mode === 'lookup' && route.template) {
      const t2b = Date.now()
      const g = neo4j()
      const metaResult = await runShortcut(g, {
        userId: body.user_id,
        template: route.template,
        courseHint: route.course_hint,
        conceptHint: route.concept_hint,
      })
      timing.stage2b_shortcut = Date.now() - t2b

      const t8 = Date.now()
      const answer = await generateAnswer({
        query: rewritten.query,
        learningMode: 'lookup',
        sources: [],
        metadata: metaResult,
        clarifyingQuestion: null,
      })
      timing.stage8_answer = Date.now() - t8

      response = {
        ok: true,
        session_id: body.session_id ?? null,
        answer: answer.text,
        learning_mode: 'lookup',
        template: route.template,
        model_used: answer.model_used,
        is_clarifying: answer.is_clarifying,
        sources: metaResult.rows.map(r => ({
          source_type: r.kind,
          title: r.title,
          course_code: r.course_code ?? null,
          slide_or_section: null,
          rerank_score: null,
        })),
        timing_ms: timing,
      }
    } else if (route.learning_mode === 'small_talk') {
      const t8 = Date.now()
      const answer = await generateAnswer({
        query: rewritten.query,
        learningMode: 'small_talk',
        sources: [], metadata: null, clarifyingQuestion: null,
      })
      timing.stage8_answer = Date.now() - t8

      response = {
        ok: true,
        session_id: body.session_id ?? null,
        answer: answer.text,
        learning_mode: 'small_talk',
        template: null,
        model_used: answer.model_used,
        is_clarifying: false,
        sources: [],
        timing_ms: timing,
      }
    } else {
      // Full retrieval path (Stages 3-7 + 8)
      const t3 = Date.now()
      const g = neo4j()
      const retrieval = await retrieveV4(g, {
        userId: body.user_id,
        query: rewritten.query,
        learningMode: route.learning_mode as 'tutoring' | 'exploration' | 'cross_course',
        courseHint: route.course_hint,
        conceptHint: route.concept_hint,
      })
      timing.stage3to7_retrieval = Date.now() - t3

      const t8 = Date.now()
      const answer = await generateAnswer({
        query: rewritten.query,
        learningMode: route.learning_mode,
        sources: retrieval.sources,
        metadata: null,
        clarifyingQuestion: retrieval.clarifyingQuestion,
        learnerContext: null, // V0.1 populates
      })
      timing.stage8_answer = Date.now() - t8

      response = {
        ok: true,
        session_id: body.session_id ?? null,
        answer: answer.text,
        learning_mode: route.learning_mode,
        template: null,
        model_used: answer.model_used,
        is_clarifying: answer.is_clarifying,
        sources: retrieval.sources.map(s => ({
          source_type: s.source_type,
          title: s.title,
          course_code: s.course_code,
          slide_or_section: s.slide_or_section,
          rerank_score: s.rerank_score,
        })),
        timing_ms: timing,
      }
    }

    timing.total = Date.now() - t0

    // Stage 9: persistence (fire-and-forget so we don't block the response)
    void persistTurn({
      userId: body.user_id,
      sessionId: body.session_id ?? null,
      queryRaw: body.message,
      queryRewritten: rewritten.query,
      routerDecision: route,
      answer: response.answer,
      modelUsed: response.model_used,
      sourceCount: response.sources.length,
      timingMs: timing,
    }).catch(err => console.warn('[tutor-v4] persist failed:', err))

    return jsonResponse(response)
  } catch (err) {
    console.error('[tutor-v4] fatal:', err)
    return jsonResponse({ ok: false, error: errMsg(err) }, 500)
  }
}

// ---------------------------------------------------------------------------
// Stage 9: persistence — write tutor_turn row. Signal capture happens off-turn
// in a follow-up worker (or via an existing learner-signal writer once V0.1
// wires it). For V0 we just write the turn.
// ---------------------------------------------------------------------------

async function persistTurn(args: {
  userId: string
  sessionId: string | null
  queryRaw: string
  queryRewritten: string
  routerDecision: {
    learning_mode: string
    template: string | null
    course_hint: string | null
    concept_hint: string | null
    reasoning: string
  }
  answer: string
  modelUsed: string
  sourceCount: number
  timingMs: Record<string, number>
}): Promise<void> {
  const admin = createAdminClient()
  // Align with v3 schema: content + role are the load-bearing columns.
  // v4 metadata lands in the nullable extension columns added by
  // migration 20260719000000_v0_tutor_turns_v4.sql.
  await admin.from('tutor_turns').insert({
    user_id: args.userId,
    session_id: args.sessionId,
    role: 'assistant',
    content: args.answer,
    mode: args.routerDecision.learning_mode,
    query_raw: args.queryRaw,
    query_rewritten: args.queryRewritten,
    learning_mode: args.routerDecision.learning_mode,
    template: args.routerDecision.template,
    course_hint: args.routerDecision.course_hint,
    concept_hint: args.routerDecision.concept_hint,
    router_reasoning: args.routerDecision.reasoning,
    model_used: args.modelUsed,
    source_count: args.sourceCount,
    timing_ms: args.timingMs,
    pipeline_version: 'v4-2026-07-17',
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  return await handle(req)
})
