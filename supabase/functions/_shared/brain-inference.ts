// brain-inference — Stage 3 of the graph brain pipeline.
// Generates candidate node pairs from co-occurrence + proximity, runs the
// three-gate suppression, upserts graph_edges.
//
// Reference: Rumbo-Design-Docs/Graph Pipeline/edge-inference.md,
// CLAUDE.md §10.4 (EDGE_INFERENCE_SYSTEM_PROMPT).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { computeAndPersistEdgeWeight, reinforceEdge } from './brain-weighting.ts'
import { geminiCallTool } from './gemini.ts'

const INFERENCE_VERSION = 'inference-v0.1'
const PROXIMITY_DISTANCE_MAX = 0.45

// Tier system (see design discussion): high-authority sources like syllabi and
// project docs act as knowledge hubs and get a bigger candidate budget. Admin
// / participation-level nodes stay narrow.
//   T1 (structural): syllabus, course, syllabus-file, project, rubric.
//   T2 (assignments): assignments, rubrics, study docs, announcements.
//   T3 (low signal):  administrative, provisional, anything else.
// The numeric tier is derived from graph_nodes.source_authority_avg which is
// already populated during resolution.
function candidatesForTier(sourceAuthorityAvg: number): number {
  if (sourceAuthorityAvg >= 0.9) return 25 // T1 — hubs
  if (sourceAuthorityAvg >= 0.75) return 15 // T2 — deliverables
  return 6                                   // T3 — filler
}

// Three-gate thresholds — relaxed to produce a denser, more "brain-like" graph
// while still gating out clear noise.
const GATE_EXTRACTION_MIN = 0.65
const GATE_RESOLUTION_MIN = 0.8
const GATE_RELEVANCE_MIN = 0.55

export const EDGE_INFERENCE_SYSTEM_PROMPT = `
You are an academic-relationship reasoner for a student's knowledge graph. Given two
candidate nodes and the source records they appear in, decide whether there is a
meaningful academic relationship worth representing as an edge — and if so, what type.

Available relationship types (with strict meanings):
- prerequisite      — Node A must be understood before node B.
- applies_to        — Concept A is applied in context B (e.g. a technique used in an assignment).
- part_of           — A is a structural component of topic/course B.
- assessed_by       — Concept A is tested/evaluated by assignment B.
- related_concept   — A and B are related but neither is prerequisite; they inform each other.
- cross_course      — Same concept appears in different courses (usually paired with the
                      resolution decision that kept them as distinct nodes).
- sequential        — A precedes B in a course's ordering (lecture N then lecture N+1;
                      topic N then topic N+1). Not the same as prerequisite — sequential is
                      about ordering within a container, not conceptual dependency.
- none              — No meaningful academic relationship. Return this liberally.

Asymmetric-suppression rule (the core product principle):
- A wrong surfaced edge costs the student's trust. A missed edge costs a little value
  but is invisible. When uncertain, return "none".
- Do not invent relationships to fill a gap. Do not assert relationships from mere
  co-occurrence unless the source context supports the specific type you are claiming.

Relevance score: rate how relevant this connection is TO WHAT THE STUDENT IS DOING RIGHT
NOW, not how true it is in the abstract. A true-but-three-semesters-stale connection
should get a low relevance score.

Direction: prefer bidirectional only when the relationship is genuinely symmetric
(related_concept, cross_course). Prerequisite, applies_to, part_of, assessed_by, and
sequential are almost always directional.

Reasoning: one short sentence citing the specific source evidence that supports your call.
This reasoning is stored only for edges that end up surfaced — it is the debugging trail
if a wrong edge reaches a student.
`.trim()

const INFERENCE_TOOL = {
  name: 'infer_relationship',
  description: 'Infer whether an academic relationship exists between two nodes.',
  parameters: {
    type: 'object' as const,
    properties: {
      relationship_type: {
        type: 'string' as const,
        enum: ['prerequisite', 'applies_to', 'part_of', 'assessed_by', 'related_concept', 'cross_course', 'sequential', 'none'],
      },
      reasoning:       { type: 'string' as const },
      relevance_score: { type: 'number' as const, minimum: 0, maximum: 1 },
      direction:       { type: 'string' as const, enum: ['A_to_B', 'B_to_A', 'bidirectional'] },
    },
    required: ['relationship_type', 'reasoning', 'relevance_score', 'direction'],
  },
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface NodeSummary {
  id: string
  user_id: string
  name: string
  entity_type: string
  is_provisional: boolean
  embedding: string | number[] | null
  source_authority_avg?: number
}

interface Pair {
  a: NodeSummary
  b: NodeSummary
  sharedSourceRecords: string[]  // for inferred_from
  isDirectLink: boolean
}

interface InferenceOutput {
  relationship_type: string
  reasoning: string
  relevance_score: number
  direction: 'A_to_B' | 'B_to_A' | 'bidirectional'
}

// -----------------------------------------------------------------------------
// Candidate-pair generation
// -----------------------------------------------------------------------------

function embeddingLiteral(embedding: string | number[] | null): string | null {
  if (embedding == null) return null
  if (typeof embedding === 'string') return embedding
  return `[${embedding.join(',')}]`
}

async function getCoOccurrenceNeighbors(
  admin: SupabaseClient,
  node: NodeSummary,
): Promise<Array<{ node: NodeSummary; sharedRecords: string[] }>> {
  // Find source records that mention this node.
  const { data: mentions } = await admin
    .from('node_mentions')
    .select('source_record_id')
    .eq('node_id', node.id)
  const srcIds = Array.from(new Set((mentions ?? []).map(m => m.source_record_id as string)))
  if (srcIds.length === 0) return []

  // Find other nodes mentioned by the same source records.
  const { data: peers } = await admin
    .from('node_mentions')
    .select('node_id, source_record_id')
    .in('source_record_id', srcIds)
    .eq('user_id', node.user_id)
    .neq('node_id', node.id)

  const grouped = new Map<string, string[]>()
  for (const p of peers ?? []) {
    const nid = p.node_id as string
    const sid = p.source_record_id as string
    if (!grouped.has(nid)) grouped.set(nid, [])
    grouped.get(nid)!.push(sid)
  }
  if (grouped.size === 0) return []

  const { data: nodes } = await admin
    .from('graph_nodes')
    .select('id, user_id, name, entity_type, is_provisional, embedding, source_authority_avg')
    .in('id', Array.from(grouped.keys()))
  const results: Array<{ node: NodeSummary; sharedRecords: string[] }> = []
  for (const n of nodes ?? []) {
    results.push({
      node: n as NodeSummary,
      sharedRecords: Array.from(new Set(grouped.get(n.id as string) ?? [])),
    })
  }
  return results
}

async function getProximityNeighbors(
  admin: SupabaseClient,
  node: NodeSummary,
): Promise<NodeSummary[]> {
  const embed = embeddingLiteral(node.embedding)
  if (!embed) return []
  const { data, error } = await admin.rpc('proximity_neighbors', {
    p_user_id: node.user_id,
    p_node_id: node.id,
    p_embedding: embed,
    p_max_distance: PROXIMITY_DISTANCE_MAX,
    p_limit: candidatesForTier(node.source_authority_avg ?? 0.6),
  })
  if (error) {
    // proximity_neighbors is a nice-to-have; missing RPC shouldn't kill inference.
    console.warn('[brain-inference] proximity_neighbors rpc missing or failed:', error.message)
    return []
  }
  return (data ?? []) as NodeSummary[]
}

// -----------------------------------------------------------------------------
// Gates
// -----------------------------------------------------------------------------

async function extractionConfidenceFor(admin: SupabaseClient, nodeId: string): Promise<number> {
  // Highest-confidence candidate that mentions this node (approx per spec).
  const { data } = await admin
    .from('node_mentions')
    .select('candidate_id, entity_candidates!inner(extraction_confidence)')
    .eq('node_id', nodeId)
    .order('mentioned_at', { ascending: false })
    .limit(20)
  const rows = data ?? []
  let maxC = 0
  for (const r of rows) {
    // Supabase join return shape: entity_candidates may be an object or array.
    const raw = (r as { entity_candidates?: unknown }).entity_candidates
    const c = Array.isArray(raw) ? (raw[0] as { extraction_confidence?: number })?.extraction_confidence
                                 : (raw as { extraction_confidence?: number })?.extraction_confidence
    if (typeof c === 'number' && c > maxC) maxC = c
  }
  return maxC
}

function resolutionConfidenceFor(a: NodeSummary, b: NodeSummary): number {
  return (!a.is_provisional && !b.is_provisional) ? 1.0 : 0.5
}

// -----------------------------------------------------------------------------
// LLM inference
// -----------------------------------------------------------------------------

async function callInference(a: NodeSummary, b: NodeSummary, sharedRecords: string[]): Promise<InferenceOutput | null> {
  const userMessage = JSON.stringify({
    node_a: { name: a.name, type: a.entity_type },
    node_b: { name: b.name, type: b.entity_type },
    shared_source_record_ids: sharedRecords,
  })
  return await geminiCallTool<InferenceOutput>({
    system: EDGE_INFERENCE_SYSTEM_PROMPT,
    userText: userMessage,
    tool: INFERENCE_TOOL,
    maxTokens: 1024,
  })
}

// -----------------------------------------------------------------------------
// Special case: Canvas assignment ↔ Drive file direct links (edge-inference.md §6)
// -----------------------------------------------------------------------------

async function findDirectLinkNeighbors(
  admin: SupabaseClient,
  node: NodeSummary,
): Promise<Array<{ node: NodeSummary; sharedRecords: string[] }>> {
  // Only assignments and course_references trigger a Drive-file name lookup.
  if (node.entity_type !== 'assignment') return []

  // Get raw_payload names of Drive files for this user; match by case-insensitive
  // substring of the assignment name.
  const { data: driveEvents } = await admin
    .from('normalized_events')
    .select('id, raw_payload')
    .eq('user_id', node.user_id)
    .in('source_type', ['drive', 'drive_content'])
    .limit(500)
  const matches: Array<{ recordId: string; fileName: string }> = []
  const needle = node.name.toLowerCase()
  for (const ev of driveEvents ?? []) {
    const payload = (ev.raw_payload as Record<string, unknown> | null) ?? {}
    const name = (payload.name as string | undefined) ?? (payload.title as string | undefined) ?? ''
    if (name && needle && name.toLowerCase().includes(needle)) {
      matches.push({ recordId: ev.id as string, fileName: name })
    }
  }
  if (matches.length === 0) return []

  // Find graph_nodes derived from those matching source records.
  const recordIds = matches.map(m => m.recordId)
  const { data: cands } = await admin
    .from('entity_candidates')
    .select('resolved_node_id, source_record_id')
    .in('source_record_id', recordIds)
    .not('resolved_node_id', 'is', null)
  const byNode = new Map<string, string[]>()
  for (const c of cands ?? []) {
    const nid = c.resolved_node_id as string
    if (nid === node.id) continue
    if (!byNode.has(nid)) byNode.set(nid, [])
    byNode.get(nid)!.push(c.source_record_id as string)
  }
  if (byNode.size === 0) return []

  const { data: nodes } = await admin
    .from('graph_nodes')
    .select('id, user_id, name, entity_type, is_provisional, embedding, source_authority_avg')
    .in('id', Array.from(byNode.keys()))
  return (nodes ?? []).map(n => ({
    node: n as NodeSummary,
    sharedRecords: Array.from(new Set(byNode.get(n.id as string) ?? [])),
  }))
}

// -----------------------------------------------------------------------------
// Upsert helper
// -----------------------------------------------------------------------------

function directionToStored(direction: 'A_to_B' | 'B_to_A' | 'bidirectional'): 'directed' | 'bidirectional' {
  return direction === 'bidirectional' ? 'bidirectional' : 'directed'
}

async function upsertEdge(
  admin: SupabaseClient,
  sourceNodeId: string,
  targetNodeId: string,
  relationshipType: string,
  storedDirection: 'directed' | 'bidirectional',
  extractionConfidence: number,
  resolutionConfidence: number,
  relevanceScore: number,
  isProvisional: boolean,
  inferredFrom: string[],
  reasoning: string | null,
): Promise<{ id: string; isNew: boolean } | null> {
  // Try to find existing edge first (unique on user_id, source, target, relationship).
  const { data: existing } = await admin
    .from('graph_edges')
    .select('id, inferred_from')
    .eq('source_node_id', sourceNodeId)
    .eq('target_node_id', targetNodeId)
    .eq('relationship_type', relationshipType)
    .maybeSingle()

  if (existing) {
    // Reinforce existing.
    const prior = (existing.inferred_from as string[] | null) ?? []
    const merged = Array.from(new Set([...prior, ...inferredFrom]))
    await admin
      .from('graph_edges')
      .update({
        inferred_from: merged,
        last_reinforced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id as string)
    return { id: existing.id as string, isNew: false }
  }

  // Need user_id for the row.
  const { data: node } = await admin.from('graph_nodes').select('user_id').eq('id', sourceNodeId).single()
  const userId = node?.user_id as string | undefined
  if (!userId) return null

  const { data, error } = await admin
    .from('graph_edges')
    .insert({
      user_id: userId,
      source_node_id: sourceNodeId,
      target_node_id: targetNodeId,
      relationship_type: relationshipType,
      direction: storedDirection,
      extraction_confidence: extractionConfidence,
      resolution_confidence: resolutionConfidence,
      relevance_score: relevanceScore,
      is_provisional: isProvisional,
      inferred_from: inferredFrom,
      inference_reasoning: reasoning,
      last_reinforced_at: new Date().toISOString(),
      pipeline_version: INFERENCE_VERSION,
    })
    .select('id')
    .single()
  if (error) {
    console.warn(`[brain-inference] edge insert failed: ${error.message}`)
    return null
  }
  return { id: data!.id as string, isNew: true }
}

// -----------------------------------------------------------------------------
// Main entrypoint per (newly resolved/created) node
// -----------------------------------------------------------------------------

export interface InferenceStats {
  pairs_considered: number
  edges_written: number
  surfaced: number
}

export async function inferEdgesForNode(
  admin: SupabaseClient,
  node: NodeSummary,
): Promise<InferenceStats> {
  const stats: InferenceStats = { pairs_considered: 0, edges_written: 0, surfaced: 0 }

  // Tier-scaled candidate budget. High-authority hubs (syllabi, projects) get
  // a bigger fan-out; low-signal filler stays narrow.
  const candidateCap = candidatesForTier(node.source_authority_avg ?? 0.6)

  const pairs: Pair[] = []
  const seen = new Set<string>()

  // Direct-link pairs (Canvas assignment ↔ Drive file).
  for (const nb of await findDirectLinkNeighbors(admin, node)) {
    const key = [node.id, nb.node.id].sort().join('::')
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ a: node, b: nb.node, sharedSourceRecords: nb.sharedRecords, isDirectLink: true })
  }

  // Co-occurrence pairs.
  for (const nb of await getCoOccurrenceNeighbors(admin, node)) {
    const key = [node.id, nb.node.id].sort().join('::')
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ a: node, b: nb.node, sharedSourceRecords: nb.sharedRecords, isDirectLink: false })
    if (pairs.length >= candidateCap) break
  }

  // Proximity pairs to fill remaining slots.
  if (pairs.length < candidateCap) {
    for (const nb of await getProximityNeighbors(admin, node)) {
      const key = [node.id, nb.id].sort().join('::')
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push({ a: node, b: nb, sharedSourceRecords: [], isDirectLink: false })
      if (pairs.length >= candidateCap) break
    }
  }

  stats.pairs_considered = pairs.length

  for (const pair of pairs) {
    // Gate 1: extraction confidence.
    let extractionConfidence: number
    if (pair.isDirectLink) {
      extractionConfidence = 1.0
    } else {
      const cA = await extractionConfidenceFor(admin, pair.a.id)
      const cB = await extractionConfidenceFor(admin, pair.b.id)
      extractionConfidence = Math.min(cA, cB)
      if (extractionConfidence < GATE_EXTRACTION_MIN) continue  // drop
    }

    // Gate 2: resolution confidence.
    const resolutionConfidence = pair.isDirectLink ? 1.0 : resolutionConfidenceFor(pair.a, pair.b)
    const gate2Passed = resolutionConfidence >= GATE_RESOLUTION_MIN

    // Gate 3: LLM relevance + type.
    let inference: InferenceOutput | null = null
    try {
      inference = await callInference(pair.a, pair.b, pair.sharedSourceRecords)
    } catch (err) {
      console.warn('[brain-inference] LLM call failed, dropping pair:', err)
      continue
    }
    if (!inference || inference.relationship_type === 'none') continue

    const relevance = inference.relevance_score
    const gate3Passed = relevance >= GATE_RELEVANCE_MIN

    // Determine outcome.
    if (!gate2Passed && !gate3Passed) {
      // Provisional resolution + failed relevance → discard (drop entirely).
      continue
    }

    const isProvisional = !gate2Passed || !gate3Passed
    // Surface only when both gate2 and gate3 pass.
    const willSurface = gate2Passed && gate3Passed
    const reasoning = willSurface ? inference.reasoning : null

    // Determine source/target ordering from direction.
    let sourceNodeId = pair.a.id
    let targetNodeId = pair.b.id
    if (inference.direction === 'B_to_A') {
      sourceNodeId = pair.b.id
      targetNodeId = pair.a.id
    }
    const storedDirection = directionToStored(inference.direction)

    const inferredFrom = pair.sharedSourceRecords

    const edge = await upsertEdge(
      admin,
      sourceNodeId,
      targetNodeId,
      inference.relationship_type,
      storedDirection,
      extractionConfidence,
      resolutionConfidence,
      relevance,
      isProvisional,
      inferredFrom,
      reasoning,
    )
    if (!edge) continue

    // Weighting.
    try {
      const summary = edge.isNew
        ? await computeAndPersistEdgeWeight(admin, edge.id)
        : await reinforceEdge(admin, edge.id, inferredFrom)
      stats.edges_written += 1
      if (summary?.is_surfaced) stats.surfaced += 1
    } catch (err) {
      console.warn('[brain-inference] weighting failed:', err)
    }
  }

  return stats
}
