// brain-weighting — Stage 4 of the graph brain pipeline.
// Computes and reinforces edge weights; toggles is_surfaced against threshold.
//
// Reference: Rumbo-Design-Docs/Graph Pipeline/edge-weighting.md.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'

// Coefficients (§3). Sum to 1.0; relevance is a multiplier.
const AUTHORITY_COEF = 0.40
const CORROBORATION_COEF = 0.35
const DECAY_COEF = 0.25

export const SURFACING_THRESHOLD = 0.60
export const DEFAULT_HALF_LIFE_DAYS = 90   // dashboard/tutor default (edge-weighting.md §8 Q5)

export interface ComputeWeightInput {
  authority: number
  corroboration: number
  decay: number
  relevance: number
  half_life_days?: number
}

export function computeWeight(input: ComputeWeightInput): number {
  const base = AUTHORITY_COEF * input.authority
             + CORROBORATION_COEF * input.corroboration
             + DECAY_COEF * input.decay
  return base * input.relevance
}

// Corroboration score from independent (course_id, source_type) clusters.
// edge-weighting.md §2.2.
export function corroborationScore(
  sourceRecords: Array<{ course_id: string | null; source_type: string }>,
): number {
  const clusters = new Set<string>()
  for (const r of sourceRecords) {
    clusters.add(`${r.course_id ?? '_'}::${r.source_type}`)
  }
  const n = clusters.size
  return 1 - (1 / (1 + 0.5 * n))
}

export function decayScore(lastReinforcedAt: string | Date, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  const then = typeof lastReinforcedAt === 'string' ? new Date(lastReinforcedAt) : lastReinforcedAt
  const now = Date.now()
  const days = Math.max(0, (now - then.getTime()) / (1000 * 60 * 60 * 24))
  return Math.pow(0.5, days / halfLifeDays)
}

// Weighted-average authority update — mirrors graph_nodes running mean.
export function reinforceAuthority(existingAvg: number, existingN: number, newAuthority: number): number {
  if (existingN <= 0) return newAuthority
  return (existingAvg * existingN + newAuthority) / (existingN + 1)
}

// -----------------------------------------------------------------------------
// Edge-level operations
// -----------------------------------------------------------------------------

export interface EdgeSummary {
  id: string
  weight: number
  is_surfaced: boolean
  weight_authority: number
  weight_corroboration: number
  weight_decay: number
}

/**
 * Compute + persist weight for a freshly inserted or reinforced edge.
 * Loads current source-record set via `inferred_from` for corroboration.
 */
export async function computeAndPersistEdgeWeight(
  admin: SupabaseClient,
  edgeId: string,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): Promise<EdgeSummary | null> {
  const { data: edge, error } = await admin
    .from('graph_edges')
    .select('id, user_id, inferred_from, relevance_score, last_reinforced_at')
    .eq('id', edgeId)
    .single()
  if (error || !edge) return null

  const inferredFrom = (edge.inferred_from as string[] | null) ?? []

  // Look up source-record authority + (course_id, source_type) for corroboration.
  let authorityAvg = 0
  let corroboration = 0
  if (inferredFrom.length > 0) {
    const { data: recs } = await admin
      .from('normalized_events')
      .select('id, course_id, source_type')
      .in('id', inferredFrom)
    const records = recs ?? []

    // Use candidate.source_authority averaged across contributing candidates.
    const { data: cands } = await admin
      .from('entity_candidates')
      .select('source_authority')
      .in('source_record_id', inferredFrom)
      .eq('user_id', edge.user_id)
    const cs = cands ?? []
    if (cs.length > 0) {
      authorityAvg = cs.reduce((s, c) => s + (c.source_authority as number), 0) / cs.length
    }
    corroboration = corroborationScore(records.map(r => ({
      course_id: (r.course_id as string | null) ?? null,
      source_type: r.source_type as string,
    })))
  }

  const lastReinforced = (edge.last_reinforced_at as string | null) ?? new Date().toISOString()
  const dScore = decayScore(lastReinforced, halfLifeDays)
  const relevance = (edge.relevance_score as number) ?? 0

  const weight = computeWeight({
    authority: authorityAvg,
    corroboration,
    decay: dScore,
    relevance,
  })
  const isSurfaced = weight >= SURFACING_THRESHOLD

  const { error: upErr } = await admin
    .from('graph_edges')
    .update({
      weight,
      weight_authority: authorityAvg,
      weight_corroboration: corroboration,
      weight_decay: dScore,
      is_surfaced: isSurfaced,
      last_reinforced_at: lastReinforced,
      weight_computed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', edgeId)
  if (upErr) throw new Error(`edge weight update failed: ${upErr.message}`)

  return {
    id: edgeId,
    weight,
    is_surfaced: isSurfaced,
    weight_authority: authorityAvg,
    weight_corroboration: corroboration,
    weight_decay: dScore,
  }
}

/**
 * Reinforce an existing edge — resets last_reinforced_at to now, recomputes.
 * Used when new evidence mentions the same node pair (edge-weighting.md §6).
 */
export async function reinforceEdge(
  admin: SupabaseClient,
  edgeId: string,
  additionalSourceRecordIds: string[],
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
): Promise<EdgeSummary | null> {
  const { data: edge, error } = await admin
    .from('graph_edges')
    .select('inferred_from')
    .eq('id', edgeId)
    .single()
  if (error || !edge) return null

  const existing = (edge.inferred_from as string[] | null) ?? []
  const merged = Array.from(new Set([...existing, ...additionalSourceRecordIds]))
  await admin
    .from('graph_edges')
    .update({
      inferred_from: merged,
      last_reinforced_at: new Date().toISOString(),
    })
    .eq('id', edgeId)

  return computeAndPersistEdgeWeight(admin, edgeId, halfLifeDays)
}
