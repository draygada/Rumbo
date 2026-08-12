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
 *   1. Never awaited by a request. Call with `void` after the answer is sent.
 *      A learner signal is worth strictly less than an answer.
 *   2. Never throws. Every failure is swallowed and logged.
 */

import { createAdminClient } from './supabase-admin.ts'
import { geminiClassifyJson, type GeminiJsonSchema } from './gemini.ts'

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

export interface CaptureArgs {
  userId: string
  sessionId: string | null
  turnId: string | null
  userQuestion: string
  assistantAnswer: string
  /** Concepts the retrieval actually resolved. Empty ⇒ nothing to attach to. */
  concepts: SignalConcept[]
}

export async function captureLearnerSignals(args: CaptureArgs): Promise<void> {
  try {
    // No resolved concept means no valid target_id. Pinning a signal to a
    // chunk or a guess would poison the aggregate, so skip the turn instead —
    // a sparse honest log beats a dense wrong one.
    if (args.concepts.length === 0) return
    if (!args.userQuestion.trim() || !args.assistantAnswer.trim()) return

    const conceptList = args.concepts
      .slice(0, 6)
      .map(c => `${c.id}: ${c.name}`)
      .join('\n')

    const parsed = await geminiClassifyJson<{ signals: RawSignal[] }>({
      system: CLASSIFIER_SYSTEM,
      userText: `Retrieved concepts (id: name):\n${conceptList}\n\nStudent: ${args.userQuestion}\nAssistant: ${args.assistantAnswer}`,
      schema: SIGNAL_SCHEMA,
      maxTokens: 400,
    })

    const validIds = new Set(args.concepts.map(c => c.id))
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

    if (rows.length === 0) return

    const { error } = await createAdminClient().from('learner_signals').insert(rows)
    if (error) console.warn('[learner-signals] insert failed:', error.message)
  } catch (err) {
    console.warn('[learner-signals] capture failed:', err)
  }
}
