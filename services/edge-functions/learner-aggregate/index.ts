/*
 * learner-aggregate — the nightly job that turns the Layer 2 event log into
 * the Layer 1 learner-brain.
 *
 * Reads public.learner_signals (Postgres, append-only, written by Stage 9b of
 * the tutor) since each user's watermark, folds it into ConceptMastery nodes
 * in Neo4j with EWMA decay, and advances the watermark.
 *
 * Spec: Graph Pipeline/learner-brain-architecture.md — "Aggregation algorithm
 * — nightly job". Slice 3 of 9: Learner + ConceptMastery only. Deliberately
 * scoped OUT of this function, each with its own slice:
 *   - ExplanationRecord + skill rollup   (slice 4) — 'preference' signals are
 *     counted here but not yet materialized
 *   - Stage 3d retrieval + LEARNER CONTEXT (slices 5-6) — nothing reads these
 *     nodes yet, so this job cannot change a single word the tutor says
 *   - Layer 3 settings override           (slice 8)
 *   - Reflection surface                  (slice 9)
 *
 * V1 is EWMA, not an LLM. That is the spec's build ladder, not a shortcut:
 * LLM-driven distillation is V2, after there is a corpus worth distilling.
 *
 * INVARIANT (load-bearing, see the spec's "Load-bearing invariants"): this
 * function writes learner-brain labels only. The single point of contact with
 * the class brain is the ABOUT edge onto an existing :Concept — it MATCHes
 * that node, never MERGEs it. An aggregation run must not be able to invent
 * coursework.
 */

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j, type Neo4jClient } from '../_shared/neo4j.ts'
import {
  foldConceptMastery,
  decayUntouchedMastery,
  type ConceptBatch,
  type MasteryState,
} from '../_shared/learner-ewma.ts'

/** Signals read per user per run. A nightly batch is orders of magnitude smaller. */
const SIGNAL_LIMIT = 5_000

/** Untouched ConceptMastery nodes aged per user per run. */
const DECAY_LIMIT = 2_000

/** Users swept when the caller doesn't name one. */
const USER_LIMIT = 500

const EPOCH = '1970-01-01T00:00:00Z'

type Admin = ReturnType<typeof createAdminClient>

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// -----------------------------------------------------------------------------
// Postgres side
// -----------------------------------------------------------------------------

interface SignalRow {
  user_id: string
  target_id: string
  target_type: string
  signal_type: string
  signal_value: { intensity?: number; note?: string | null } | null
  confidence: number | null
  created_at: string
}

/**
 * Users with at least one signal newer than their own watermark.
 *
 * Filtered by the OLDEST watermark across all users, then narrowed per user
 * once their own mark is known — one query instead of one per user, at the
 * cost of pulling a few rows for users who turn out to be up to date.
 */
async function usersWithNewSignals(
  admin: Admin,
  watermarks: Map<string, string>,
): Promise<string[]> {
  let floor = new Date().toISOString()
  for (const mark of watermarks.values()) if (mark < floor) floor = mark
  if (watermarks.size === 0) floor = EPOCH

  const { data, error } = await admin
    .from('learner_signals')
    .select('user_id, created_at')
    .gt('created_at', floor)
    .order('created_at', { ascending: false })
    .limit(SIGNAL_LIMIT)
  if (error) throw new Error(`user sweep failed: ${error.message}`)

  const users: string[] = []
  const seen = new Set<string>()
  for (const row of (data ?? []) as Array<{ user_id: string; created_at: string }>) {
    if (seen.has(row.user_id)) continue
    // Now that we know whose row this is, apply their own watermark.
    if (row.created_at <= (watermarks.get(row.user_id) ?? EPOCH)) continue
    seen.add(row.user_id)
    users.push(row.user_id)
    if (users.length >= USER_LIMIT) break
  }
  return users
}

async function loadWatermarks(admin: Admin): Promise<Map<string, string>> {
  const { data, error } = await admin
    .from('learner_aggregate_state')
    .select('user_id, last_aggregated_at')
    .limit(USER_LIMIT)
  if (error) throw new Error(`watermark load failed: ${error.message}`)
  const map = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ user_id: string; last_aggregated_at: string }>) {
    map.set(row.user_id, row.last_aggregated_at)
  }
  return map
}

async function loadSignals(admin: Admin, userId: string, since: string): Promise<SignalRow[]> {
  const { data, error } = await admin
    .from('learner_signals')
    .select('user_id, target_id, target_type, signal_type, signal_value, confidence, created_at')
    .eq('user_id', userId)
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(SIGNAL_LIMIT)
  if (error) throw new Error(`signal load failed: ${error.message}`)
  return (data ?? []) as SignalRow[]
}

// -----------------------------------------------------------------------------
// Neo4j side
// -----------------------------------------------------------------------------

interface MasteryRow {
  concept_id: string
  struggle_score: number | null
  mastery_score: number | null
  interactions_count: number | null
  first_seen_at: number | null
  last_seen_at: number | null
  last_updated_at: number | null
}

function toState(row: MasteryRow): MasteryState {
  const updated = Number(row.last_updated_at ?? row.last_seen_at ?? Date.now())
  return {
    struggle_score: Number(row.struggle_score ?? 0),
    mastery_score: Number(row.mastery_score ?? 0),
    interactions_count: Number(row.interactions_count ?? 0),
    first_seen_at: Number(row.first_seen_at ?? updated),
    last_seen_at: Number(row.last_seen_at ?? updated),
    last_updated_at: updated,
    zpd_edge: null,
  }
}

async function loadPriorMastery(
  g: Neo4jClient,
  userId: string,
  conceptIds: string[],
): Promise<Map<string, MasteryState>> {
  const out = new Map<string, MasteryState>()
  if (conceptIds.length === 0) return out
  const rows = await g.run<MasteryRow>(
    `MATCH (m:ConceptMastery { user_id: $userId })
     WHERE m.concept_id IN $ids
     RETURN m.concept_id AS concept_id, m.struggle_score AS struggle_score,
            m.mastery_score AS mastery_score, m.interactions_count AS interactions_count,
            m.first_seen_at AS first_seen_at, m.last_seen_at AS last_seen_at,
            m.last_updated_at AS last_updated_at`,
    { userId, ids: conceptIds },
  )
  for (const r of rows) out.set(r.concept_id, toState(r))
  return out
}

interface MasteryWrite extends MasteryState {
  concept_id: string
}

/**
 * Upsert mastery rows and hang them off the Learner.
 *
 * MERGE on (user_id, concept_id) matches the uniqueness constraint from slice
 * 2, so a concurrent second run updates the same node rather than racing a
 * duplicate into existence.
 *
 * The ABOUT edge uses MATCH, not MERGE, on :Concept — see the invariant at the
 * top of this file. A concept that has since been deleted from the class brain
 * simply gets no edge; the mastery row survives, because the event log that
 * produced it is still true and the concept may come back on the next ingest.
 */
async function writeMastery(g: Neo4jClient, userId: string, rows: MasteryWrite[]): Promise<void> {
  if (rows.length === 0) return
  await g.run(
    `MERGE (l:Learner { user_id: $userId })
       ON CREATE SET l.created_at = $now
     SET l.last_aggregated_at = $now
     WITH l
     UNWIND $rows AS row
     MERGE (m:ConceptMastery { user_id: $userId, concept_id: row.concept_id })
       ON CREATE SET m.first_seen_at = row.first_seen_at
     SET m.struggle_score    = row.struggle_score,
         m.mastery_score     = row.mastery_score,
         m.interactions_count = row.interactions_count,
         m.last_seen_at      = row.last_seen_at,
         m.last_updated_at   = row.last_updated_at,
         m.zpd_edge          = row.zpd_edge
     MERGE (l)-[:HAS_MASTERY]->(m)
     WITH m, row
     OPTIONAL MATCH (c:Concept { user_id: $userId, id: row.concept_id })
     FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END |
       MERGE (m)-[:ABOUT]->(c))`,
    { userId, now: Date.now(), rows },
  )
}

/** Concepts with a mastery row that this batch did NOT touch — they still age. */
async function loadUntouchedMastery(
  g: Neo4jClient,
  userId: string,
  touched: string[],
): Promise<Map<string, MasteryState>> {
  const rows = await g.run<MasteryRow>(
    `MATCH (m:ConceptMastery { user_id: $userId })
     WHERE NOT m.concept_id IN $touched
     RETURN m.concept_id AS concept_id, m.struggle_score AS struggle_score,
            m.mastery_score AS mastery_score, m.interactions_count AS interactions_count,
            m.first_seen_at AS first_seen_at, m.last_seen_at AS last_seen_at,
            m.last_updated_at AS last_updated_at
     LIMIT $limit`,
    { userId, touched, limit: DECAY_LIMIT },
  )
  const out = new Map<string, MasteryState>()
  for (const r of rows) out.set(r.concept_id, toState(r))
  return out
}

// -----------------------------------------------------------------------------
// Per-user run
// -----------------------------------------------------------------------------

export interface UserRunResult {
  user_id: string
  signals: number
  concepts_updated: number
  concepts_decayed: number
  skipped_preference_signals: number
  watermark: string
}

/**
 * Signal strength, in [0, 1].
 *
 * `confidence` and `signal_value.intensity` are written from the same
 * classifier number today, but they are separate columns and only one is
 * NOT NULL-ish in practice, so read both. A signal that survived capture but
 * carries no usable strength is evidence of *something* — default to 0.5
 * rather than dropping it, which would silently bias the corpus toward turns
 * the classifier happened to be confident about.
 */
function signalStrength(row: SignalRow): number {
  const raw = row.signal_value?.intensity ?? row.confidence ?? 0.5
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

async function runForUser(
  admin: Admin,
  g: Neo4jClient,
  userId: string,
  since: string,
): Promise<UserRunResult> {
  const signals = await loadSignals(admin, userId, since)
  const now = Date.now()

  // Group Concept-targeted struggle/understanding signals by concept.
  //
  // Course- and Assignment-targeted signals are logged by the classifier but
  // have no ConceptMastery to land on — mastery is defined per concept. They
  // are counted, not folded, and stay in the append-only log for whichever
  // slice grows a home for them.
  const batches = new Map<string, ConceptBatch>()
  let skippedPreference = 0

  for (const row of signals) {
    if (row.signal_type === 'preference') {
      // Slice 4 (ExplanationRecord) consumes these. Counted so the log line
      // shows they are arriving rather than looking like a dead classifier.
      skippedPreference += 1
      continue
    }
    if (row.target_type !== 'Concept') continue
    const at = Date.parse(row.created_at)
    if (!Number.isFinite(at)) continue

    let batch = batches.get(row.target_id)
    if (!batch) {
      batch = { struggle: [], understanding: [] }
      batches.set(row.target_id, batch)
    }
    const signal = { at, value: signalStrength(row) }
    if (row.signal_type === 'struggle') batch.struggle.push(signal)
    else if (row.signal_type === 'understanding') batch.understanding.push(signal)
  }

  const touched = [...batches.keys()]
  const prior = await loadPriorMastery(g, userId, touched)

  const writes: MasteryWrite[] = []
  for (const [conceptId, batch] of batches) {
    writes.push({
      concept_id: conceptId,
      ...foldConceptMastery(prior.get(conceptId) ?? null, batch, now),
    })
  }

  // Everything else the student has ever touched ages tonight too — that decay
  // IS the model. Without it, a concept mastered in September still reads as
  // mastered in December and the tutor stops re-teaching things the student
  // has quietly forgotten.
  const untouched = await loadUntouchedMastery(g, userId, touched)
  for (const [conceptId, state] of untouched) {
    writes.push({ concept_id: conceptId, ...decayUntouchedMastery(state, now) })
  }

  await writeMastery(g, userId, writes)

  // Advance to the newest signal actually read, NOT to now(). A signal written
  // while this run was in flight would otherwise be skipped forever.
  const watermark = signals.length > 0
    ? signals[signals.length - 1].created_at
    : since

  return {
    user_id: userId,
    signals: signals.length,
    concepts_updated: batches.size,
    concepts_decayed: untouched.size,
    skipped_preference_signals: skippedPreference,
    watermark,
  }
}

async function recordRun(
  admin: Admin,
  userId: string,
  result: UserRunResult | null,
  error: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    user_id: userId,
    last_run_at: new Date().toISOString(),
    last_error: error,
    updated_at: new Date().toISOString(),
  }
  // The watermark advances ONLY on success. A failed run must replay its batch.
  if (result) {
    patch.last_aggregated_at = result.watermark
    patch.last_signal_count = result.signals
  }
  const { error: upsertError } = await admin
    .from('learner_aggregate_state')
    .upsert(patch, { onConflict: 'user_id' })
  if (upsertError) console.warn(`[learner-aggregate] watermark write failed: ${upsertError.message}`)
}

// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: { user_id?: string; since?: string } = {}
  try {
    body = await req.json()
  } catch {
    // No body is the normal cron shape — sweep everyone.
  }

  const admin = createAdminClient()
  const g = neo4j()
  const t0 = Date.now()

  try {
    const watermarks = await loadWatermarks(admin)

    // `user_id` runs one student (testing, or a targeted re-aggregation);
    // `since` overrides their watermark, which is how you replay the event log
    // after changing the algorithm — the spec's whole reason for keeping
    // Layer 2 append-only.
    const users = body.user_id
      ? [body.user_id]
      : await usersWithNewSignals(admin, watermarks)

    const results: UserRunResult[] = []
    const failures: Array<{ user_id: string; error: string }> = []

    for (const userId of users) {
      const since = body.since ?? watermarks.get(userId) ?? EPOCH
      try {
        const result = await runForUser(admin, g, userId, since)
        await recordRun(admin, userId, result, null)
        results.push(result)
        console.info(
          `[learner-aggregate] ${userId} signals=${result.signals} ` +
          `updated=${result.concepts_updated} decayed=${result.concepts_decayed} ` +
          `preference_deferred=${result.skipped_preference_signals}`,
        )
      } catch (err) {
        // One user's failure must not stall the sweep, and must not advance
        // their watermark — the batch replays tomorrow.
        const message = errMsg(err)
        failures.push({ user_id: userId, error: message })
        await recordRun(admin, userId, null, message)
        console.error(`[learner-aggregate] ${userId} failed: ${message}`)
      }
    }

    return jsonResponse({
      ok: true,
      users_processed: results.length,
      users_failed: failures.length,
      signals_total: results.reduce((n, r) => n + r.signals, 0),
      concepts_updated: results.reduce((n, r) => n + r.concepts_updated, 0),
      concepts_decayed: results.reduce((n, r) => n + r.concepts_decayed, 0),
      failures,
      results,
      duration_ms: Date.now() - t0,
    })
  } catch (err) {
    console.error('[learner-aggregate] fatal:', err)
    return jsonResponse({ ok: false, error: errMsg(err) }, 500)
  }
})
