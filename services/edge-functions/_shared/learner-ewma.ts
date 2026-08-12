/*
 * Layer 1 aggregation math — EWMA decay and the ConceptMastery fold.
 *
 * Deliberately dependency-free: no Deno, no Neo4j, no Supabase. Everything
 * here is a pure function of (prior state, signals, clock), which is what
 * makes the one genuinely subtle part of the aggregator — time-weighted decay
 * across nightly batch boundaries — testable without standing up a stack.
 *
 * Spec: Graph Pipeline/learner-brain-architecture.md — "EWMA update rule
 * (reference)" and "ConceptMastery updates". V1 is deliberately EWMA, not an
 * LLM; LLM-driven distillation is V2 on the build ladder.
 */

const MS_PER_DAY = 86_400_000

// -----------------------------------------------------------------------------
// Half-lives, all from the spec.
//
// Note the asymmetry, which is the whole point and is easy to get backwards:
// when NEW signals arrive both scores fold at a 30-day half-life, but when a
// concept goes UNTOUCHED, mastery fades at 30 days while struggle fades at 90.
// Mastery decays without practice (Ebbinghaus); the memory of having struggled
// with something is more persistent than the memory of having understood it.
// -----------------------------------------------------------------------------

export const UPDATE_HALF_LIFE_DAYS = 30
export const MASTERY_IDLE_HALF_LIFE_DAYS = 30
export const STRUGGLE_IDLE_HALF_LIFE_DAYS = 90

/** Fraction of a value surviving `days` at the given half-life. */
export function decayFactor(days: number, halfLifeDays: number): number {
  if (!(days > 0)) return 1
  return Math.pow(0.5, days / halfLifeDays)
}

export interface TimedSignal {
  /** Epoch ms. */
  at: number
  /** Signal strength in [0, 1]. */
  value: number
}

export interface EwmaResult {
  value: number
  /** Epoch ms of the last signal folded, or `priorAt` if none were. */
  at: number
}

/**
 * Fold signals into a prior, weighting each by the time since the last update.
 *
 * The spec's reference pseudocode reads:
 *
 *     for each new signal (in chronological order):
 *       days_since_prior = signal.timestamp - prior_update_time
 *       decay = (1 - alpha_per_day) ^ days_since_prior
 *       prior_value = decay * prior_value + (1 - decay) * signal.value
 *
 * with `alpha_per_day = 1 - 0.5^(1/half_life)`, so `(1 - alpha_per_day)^days`
 * is just `0.5^(days/half_life)` — decayFactor above. We compute it in that
 * closed form rather than the two-step version: identical result, and it
 * cannot drift from the idle-decay path, which uses the same function.
 *
 * One reading the pseudocode leaves implicit: `prior_update_time` advances to
 * each signal's timestamp as the loop runs. It has to. Held fixed, every
 * signal in a batch would be weighted by its distance from the *previous
 * night*, so ten signals in one evening would each get near-full weight and
 * the tenth would erase the first nine. Advancing makes signals seconds apart
 * blend almost equally, which is the intended behaviour: a single conversation
 * is one piece of evidence, not ten.
 */
export function ewmaUpdate(
  prior: number,
  priorAt: number,
  signals: TimedSignal[],
  halfLifeDays: number,
): EwmaResult {
  let value = prior
  let at = priorAt
  // Chronological order is load-bearing, and the caller's sort is not
  // something this function should have to trust.
  for (const s of [...signals].sort((a, b) => a.at - b.at)) {
    const days = Math.max(0, (s.at - at) / MS_PER_DAY)
    const decay = decayFactor(days, halfLifeDays)
    value = decay * value + (1 - decay) * s.value
    at = s.at
  }
  return { value: clamp01(value), at }
}

/**
 * ewmaUpdate for a score with no history, where the first signal IS the prior.
 *
 * Folding a first signal into a zero prior does not work, and the failure is
 * silent: elapsed time from the signal's own timestamp is zero, so the decay
 * factor is 1, so the update keeps 100% of the zero prior and takes 0% of the
 * signal. A concept's first observation would score 0 and stay there until a
 * second signal arrived days later. Seeding from the first signal and folding
 * the rest is what "no history" actually means.
 *
 * A score with no signals at all legitimately stays at 0 — a concept the
 * student only ever struggled with has no evidence of mastery, and 0 is the
 * honest value, not a missing one.
 */
function ewmaSeed(signals: TimedSignal[], fallbackAt: number, halfLifeDays: number): EwmaResult {
  if (signals.length === 0) return { value: 0, at: fallbackAt }
  const sorted = [...signals].sort((a, b) => a.at - b.at)
  const [first, ...rest] = sorted
  return ewmaUpdate(clamp01(first.value), first.at, rest, halfLifeDays)
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

// -----------------------------------------------------------------------------
// ConceptMastery fold
// -----------------------------------------------------------------------------

export type ZpdEdge =
  | 'mastered'
  | 'can_apply_with_help'
  | 'needs_worked_example'
  | 'pre_conceptual'

export interface MasteryState {
  struggle_score: number
  mastery_score: number
  interactions_count: number
  /** Epoch ms. */
  first_seen_at: number
  /** Epoch ms — last signal folded. */
  last_seen_at: number
  /** Epoch ms — last time decay was applied, i.e. the score's "as of". */
  last_updated_at: number
  zpd_edge: ZpdEdge | null
}

/**
 * Vygotsky's ZPD edge, read off the two scores.
 *
 * Bucketed on net = mastery − struggle rather than on mastery alone, because
 * the interesting student is the one scoring high on both: they engage with
 * the concept repeatedly and keep hitting a wall. Mastery alone would call
 * that mastered.
 *
 * Returns null below three interactions. With one or two signals the net is
 * dominated by whichever way the last exchange happened to go, and a confident
 * "pre_conceptual" from a single confused question is worse for the tutor than
 * no label at all — Stage 3d omits the line rather than guessing.
 *
 * `bloom_level` and `misconceptions` are intentionally NOT derived here. Both
 * need an LLM reading the actual exchange; the spec puts LLM-driven
 * distillation in V2, and a fabricated Bloom level would be read by the tutor
 * as fact.
 */
export function deriveZpdEdge(
  mastery: number,
  struggle: number,
  interactions: number,
): ZpdEdge | null {
  if (interactions < 3) return null
  const net = mastery - struggle
  if (net >= 0.5) return 'mastered'
  if (net >= 0.15) return 'can_apply_with_help'
  if (net >= -0.3) return 'needs_worked_example'
  return 'pre_conceptual'
}

export interface ConceptBatch {
  struggle: TimedSignal[]
  understanding: TimedSignal[]
}

/**
 * Fold one concept's batch of signals into its prior state.
 *
 * `prior` is null for a concept this student has never triggered a signal on.
 */
export function foldConceptMastery(
  prior: MasteryState | null,
  batch: ConceptBatch,
  now: number,
): MasteryState {
  const signalCount = batch.struggle.length + batch.understanding.length
  const timestamps = [...batch.struggle, ...batch.understanding].map(s => s.at)
  const earliest = timestamps.length > 0 ? Math.min(...timestamps) : now
  const latest = timestamps.length > 0 ? Math.max(...timestamps) : now

  const base: MasteryState = prior ?? {
    struggle_score: 0,
    mastery_score: 0,
    interactions_count: 0,
    first_seen_at: earliest,
    last_seen_at: earliest,
    last_updated_at: earliest,
    zpd_edge: null,
  }

  // A concept with no history seeds from its first signal; one with history
  // folds against it. See ewmaSeed for why these cannot be the same call.
  const struggle = prior
    ? ewmaUpdate(base.struggle_score, base.last_updated_at, batch.struggle, UPDATE_HALF_LIFE_DAYS)
    : ewmaSeed(batch.struggle, earliest, UPDATE_HALF_LIFE_DAYS)
  const mastery = prior
    ? ewmaUpdate(base.mastery_score, base.last_updated_at, batch.understanding, UPDATE_HALF_LIFE_DAYS)
    : ewmaSeed(batch.understanding, earliest, UPDATE_HALF_LIFE_DAYS)

  // Each score decays independently against ITS OWN last update, not the
  // batch's. A turn where the student only expressed confusion carries no
  // evidence that their prior understanding survived, so mastery keeps ageing
  // through it rather than being frozen by an unrelated struggle signal.
  const interactions = base.interactions_count + signalCount
  const struggle_score = clamp01(
    struggle.value * decayFactor(daysBetween(struggle.at, now), STRUGGLE_IDLE_HALF_LIFE_DAYS),
  )
  const mastery_score = clamp01(
    mastery.value * decayFactor(daysBetween(mastery.at, now), MASTERY_IDLE_HALF_LIFE_DAYS),
  )

  return {
    struggle_score,
    mastery_score,
    interactions_count: interactions,
    first_seen_at: Math.min(base.first_seen_at, earliest),
    last_seen_at: signalCount > 0 ? Math.max(base.last_seen_at, latest) : base.last_seen_at,
    last_updated_at: now,
    zpd_edge: deriveZpdEdge(mastery_score, struggle_score, interactions),
  }
}

/**
 * Age a concept nobody touched this run.
 *
 * Same function as the tail of foldConceptMastery — an untouched concept is
 * just the empty-batch case — but exposed separately because the aggregator
 * reaches it through a different query (a Neo4j sweep, not a signal group).
 */
export function decayUntouchedMastery(prior: MasteryState, now: number): MasteryState {
  return foldConceptMastery(prior, { struggle: [], understanding: [] }, now)
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, (toMs - fromMs) / MS_PER_DAY)
}
