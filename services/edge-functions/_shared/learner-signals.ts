/*
 * Layer 2 event-log capture — Stage 9b of the tutor pipeline.
 *
 * After each answered turn, a small classifier reads the exchange and emits
 * zero or more learner signals into public.learner_signals. Nothing reads that
 * table yet; the nightly aggregator (learner-aggregate) does, and it can only
 * be as good as the corpus this writes.
 *
 * Spec: Graph Pipeline/learner-brain-architecture.md (Layer 2),
 *       Features/learner-model.md §2.
 *
 * History: this logic shipped in the v3 tutor and was dropped in the v4
 * rewrite — tutor-v4 deferred it to "a follow-up worker" and tutor-v4-stream,
 * the endpoint the app actually calls, never had it. The log was therefore
 * dormant from v4 onward. Extracted here so all three tutor paths share one
 * implementation and it cannot be missed again.
 *
 * TWO RULES, both load-bearing:
 *   1. Never awaited by a request. Hand it to runInBackground() after the
 *      answer is sent — a learner signal is worth strictly less than an
 *      answer. NOT a bare `void`: that is what kept this table empty through
 *      slice 1. See _shared/edge-background.ts.
 *   2. Never throws. Every failure is swallowed and logged.
 */

import { createAdminClient } from './supabase-admin.ts'
import { geminiClassifyJson, type GeminiJsonSchema } from './gemini.ts'
import { neo4j } from './neo4j.ts'

/** A concept the turn actually resolved to — the only valid signal target. */
export interface SignalConcept {
  id: string
  name: string
}

interface RawSignal {
  signal_type: 'struggle' | 'understanding' | 'preference'
  target_type: 'Concept' | 'Assignment' | 'Course'
  target_id: string
  intensity: number
  note?: string
  source: 'explicit' | 'inferred'
}

const SIGNAL_SCHEMA: GeminiJsonSchema = {
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

const CLASSIFIER_SYSTEM = `Review a tutor exchange and emit zero or more learner signals.
- struggle: student said "I don't get it", "confused", asked the same thing twice, or their phrasing implies confusion
- understanding: student said "got it", "that makes sense", moved on without follow-up
- preference: student expressed HOW they process material ("give me an example", "just the formula", "show me code")

Only emit high-confidence signals. Empty array is fine.
target_id must be one of the concept ids from the retrieved context; use the concept a signal is about.

For a preference signal, put the style the student asked for in "note" — one of:
analogy, worked_example, step_by_step, visual, concrete_case. The aggregator reads it.`

/**
 * Which concepts a turn's signals should attach to.
 *
 * Prefers what the query resolved to — that is the concept the student was
 * actually asking about. Falls back to what the returned sources cover, which
 * is what they were actually shown.
 *
 * The fallback is the point: resolvedConcepts requires either a router
 * concept_hint that name-matches or a query embedding whose nearest Concept
 * clears score > 0.5, and neither is guaranteed. Without this, a turn could
 * retrieve twelve good sources, answer well, and record nothing.
 */
export function signalTargets(retrieval: {
  resolvedConcepts: SignalConcept[]
  coveredConcepts: SignalConcept[]
}): SignalConcept[] {
  return retrieval.resolvedConcepts.length > 0
    ? retrieval.resolvedConcepts
    : retrieval.coveredConcepts
}

export interface CaptureArgs {
  userId: string
  sessionId: string | null
  turnId: string | null
  userQuestion: string
  assistantAnswer: string
  /** Concepts the retrieval actually resolved. May legitimately be empty. */
  concepts: SignalConcept[]
  /**
   * Node ids of the documents the answer was actually built from — for a
   * chunk, its parent doc, since COVERS never attaches to a Chunk.
   * Used to recover targets when `concepts` is empty (see below).
   */
  sourceIds?: string[]
}

/**
 * Recover concept targets from the documents the answer cited.
 *
 * resolveConcepts (retrieval Stage 3) is a vector lookup gated on cosine
 * `score > 0.5`, and it returns [] outright when the Cohere embed fails. A
 * perfectly good tutoring turn — one that retrieved the right lecture and
 * answered from it — routinely resolves zero concepts. Skipping capture on
 * that basis threw away most of the corpus.
 *
 * The retrieved documents know better: each carries COVERS edges to the
 * concepts it teaches. Walking backwards from the sources is a cheaper and
 * more faithful answer to "what was this turn about" than a similarity
 * threshold on the raw question. Ordered by COVERS weight so the concepts a
 * document primarily teaches win over ones it mentions in passing.
 *
 * Runs off the response path, so its round-trip costs the student nothing.
 */
async function conceptsFromSources(
  userId: string,
  sourceIds: string[],
): Promise<SignalConcept[]> {
  if (sourceIds.length === 0) return []
  try {
    const rows = await neo4j().run<{ id: string; name: string }>(
      `MATCH (s { user_id: $userId })-[cov:COVERS]->(c:Concept { user_id: $userId })
       WHERE s.id IN $sourceIds
       WITH c, max(coalesce(cov.weight, 0)) AS w
       RETURN c.id AS id, c.name AS name
       ORDER BY w DESC
       LIMIT 6`,
      { userId, sourceIds: sourceIds.slice(0, 40) },
    )
    return rows
      .filter(r => r.id && r.name)
      .map(r => ({ id: r.id, name: r.name }))
  } catch (err) {
    console.warn('[learner-signals] COVERS fallback failed:', err)
    return []
  }
}

export async function captureLearnerSignals(args: CaptureArgs): Promise<void> {
  try {
    if (!args.userQuestion.trim() || !args.assistantAnswer.trim()) return

    // Prefer the concepts retrieval resolved; fall back to what the cited
    // documents cover. Only if BOTH are empty is there no valid target_id —
    // pinning a signal to a guess would poison the aggregate, so skip the turn
    // instead. A sparse honest log beats a dense wrong one.
    let concepts = args.concepts
    if (concepts.length === 0) {
      concepts = await conceptsFromSources(args.userId, args.sourceIds ?? [])
    }
    if (concepts.length === 0) {
      console.log(
        `[learner-signals] skipped: no concept target (sources=${args.sourceIds?.length ?? 0})`,
      )
      return
    }

    const conceptList = concepts
      .slice(0, 6)
      .map(c => `${c.id}: ${c.name}`)
      .join('\n')

    const parsed = await geminiClassifyJson<{ signals: RawSignal[] }>({
      system: CLASSIFIER_SYSTEM,
      userText: `Retrieved concepts (id: name):\n${conceptList}\n\nStudent: ${args.userQuestion}\nAssistant: ${args.assistantAnswer}`,
      schema: SIGNAL_SCHEMA,
      maxTokens: 400,
    })

    const validIds = new Set(concepts.map(c => c.id))
    const rows = (parsed?.signals ?? [])
      // The model occasionally invents a plausible-looking id. An aggregate
      // built on ids that match no node is worse than a missing signal.
      .filter(s => s.target_type !== 'Concept' || validIds.has(s.target_id))
      .map(s => ({
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

    // One line per turn, enough to tell the three failure modes apart from the
    // dashboard without adding a read path to a server-only table: classifier
    // returned nothing (emitted=0), model invented ids (emitted>0, kept=0), or
    // the insert itself failed (kept>0 plus an insert warning).
    console.log(
      `[learner-signals] concepts=${concepts.length} emitted=${parsed?.signals?.length ?? 0} kept=${rows.length}`,
    )
    if (rows.length === 0) return

    const { error } = await createAdminClient().from('learner_signals').insert(rows)
    if (error) console.warn('[learner-signals] insert failed:', error.message)
  } catch (err) {
    console.warn('[learner-signals] capture failed:', err)
  }
}
