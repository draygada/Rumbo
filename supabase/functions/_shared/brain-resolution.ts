// brain-resolution — Stage 2 of the graph brain pipeline.
// Two-pass entity resolution: pgvector shortlist + LLM judge on the review band.
//
// Reference: Rumbo-Design-Docs/Graph Pipeline/entity-resolution.md,
// CLAUDE.md §10.3 (RESOLUTION_JUDGE_SYSTEM_PROMPT + RESOLUTION_JUDGE_TOOL).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { geminiCallTool } from './gemini.ts'

const SHORTLIST_TOP_K = 20
const RESOLUTION_VERSION = 'resolution-v0.1'

// Cosine-distance thresholds (distance = 1 - similarity).
// Loosened from 0.08 → 0.18: Gemini embeddings for semantically-close concepts
// across different courses land at ~0.82-0.90 similarity, which the old
// threshold treated as "distinct". Now we auto-merge anything above 0.82,
// and let the LLM judge decide the 0.70-0.82 band.
const MERGE_MAX_DISTANCE = 0.18
const NEW_MIN_DISTANCE = 0.30

export const RESOLUTION_JUDGE_SYSTEM_PROMPT = `
You are an entity resolution judge for a student's academic knowledge graph.

You will be given a NEW ENTITY extracted from a source record, and a CANDIDATE existing
node in the student's graph that is similar to it. Decide whether they refer to the
same underlying academic entity, are distinct entities that just share vocabulary,
or the evidence is genuinely ambiguous.

Rules:
- "same"      — the two refer to the same underlying concept, assignment, person, etc.
                Different course contexts alone are not enough to force "distinct" —
                the same concept can appear across courses (that is exactly what the
                graph is for). Use "same" only when the meaning is the same.
- "distinct"  — the two share vocabulary but refer to different underlying things.
                Example: "eigenvalues" in Linear Algebra vs. "eigenvalues" mentioned
                in passing in a Quantum Mechanics reading list. If in doubt about
                pedagogical intent, prefer "distinct" — the edge-inference stage can
                still connect them via a cross_course edge.
- "ambiguous" — you cannot confidently pick either. This is not a failure state; it
                creates a provisional node that later evidence can resolve.

Bias: when uncertain, prefer "distinct" over "same". A wrong merge is a trust cost;
a wrong split is invisible and can be corrected downstream by edge inference.
Never invent context that is not in the input.
`.trim()

export const RESOLUTION_JUDGE_TOOL = {
  name: 'resolve_entity',
  description: 'Judge whether the new entity and candidate node refer to the same thing.',
  parameters: {
    type: 'object' as const,
    properties: {
      verdict:    { type: 'string' as const, enum: ['same', 'distinct', 'ambiguous'] },
      reasoning:  { type: 'string' as const },
      confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
    },
    required: ['verdict', 'reasoning', 'confidence'],
  },
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CandidateRow {
  id: string
  user_id: string
  source_record_id: string
  name: string
  entity_type: string
  context_snippet: string
  extraction_confidence: number
  source_authority: number
  embedding: string | number[] | null
}

export interface ResolutionOutcome {
  status: 'merged' | 'new_node' | 'held'
  node_id: string
}

interface ShortlistRow {
  id: string
  name: string
  entity_type: string
  source_authority_avg: number
  embedding_distance: number
}

// -----------------------------------------------------------------------------
// Person-name normalization (entity-resolution.md §7 Q4).
// TODO: "F. Last" ↔ "First Last" canonicalization is deferred — needs a first-name
// lookup we don't have in V0. Documented deviation.
// -----------------------------------------------------------------------------

const TITLE_PATTERN = /^(prof\.?|professor|dr\.?|mr\.?|ms\.?|mrs\.?)\s+/i

export function normalizePersonName(name: string): string {
  let n = name.trim()
  while (TITLE_PATTERN.test(n)) {
    n = n.replace(TITLE_PATTERN, '').trim()
  }
  return n.replace(/\s+/g, ' ')
}

// -----------------------------------------------------------------------------
// Embedding helpers
// -----------------------------------------------------------------------------

function embeddingLiteral(embedding: string | number[] | null): string {
  if (embedding == null) throw new Error('Candidate has no embedding')
  if (typeof embedding === 'string') return embedding
  return `[${embedding.join(',')}]`
}

// -----------------------------------------------------------------------------
// LLM judge
// -----------------------------------------------------------------------------

interface JudgeVerdict {
  verdict: 'same' | 'distinct' | 'ambiguous'
  reasoning: string
  confidence: number
}

async function callJudge(candidate: CandidateRow, existing: ShortlistRow): Promise<JudgeVerdict> {
  const userMessage = JSON.stringify({
    new_entity: {
      name: candidate.name,
      type: candidate.entity_type,
      context: candidate.context_snippet,
    },
    candidate_node: {
      name: existing.name,
      type: existing.entity_type,
      source_authority_avg: existing.source_authority_avg,
      embedding_distance: existing.embedding_distance,
    },
  })

  const verdict = await geminiCallTool<JudgeVerdict>({
    system: RESOLUTION_JUDGE_SYSTEM_PROMPT,
    userText: userMessage,
    tool: RESOLUTION_JUDGE_TOOL,
    maxTokens: 1024,
  })
  if (!verdict) throw new Error('Resolution judge returned no verdict')
  return verdict
}

// -----------------------------------------------------------------------------
// Node create/merge
// -----------------------------------------------------------------------------

async function mergeIntoNode(
  admin: SupabaseClient,
  candidate: CandidateRow,
  nodeId: string,
): Promise<void> {
  // Load current stats then update. Not transactional — pipeline is single-threaded
  // per user so races are limited.
  const { data: node, error } = await admin
    .from('graph_nodes')
    .select('mention_count, source_count, source_authority_avg')
    .eq('id', nodeId)
    .single()
  if (error || !node) throw new Error(`node ${nodeId} not found`)

  const oldCount = node.mention_count as number
  const oldAvg = node.source_authority_avg as number
  const newAvg = (oldAvg * oldCount + candidate.source_authority) / (oldCount + 1)

  const now = new Date().toISOString()
  const { error: upErr } = await admin
    .from('graph_nodes')
    .update({
      mention_count: oldCount + 1,
      source_count: (node.source_count as number) + 1,
      source_authority_avg: newAvg,
      last_seen_at: now,
      updated_at: now,
    })
    .eq('id', nodeId)
  if (upErr) throw new Error(`node update failed: ${upErr.message}`)

  await admin.from('node_mentions').insert({
    node_id: nodeId,
    user_id: candidate.user_id,
    source_record_id: candidate.source_record_id,
    candidate_id: candidate.id,
  })

  await admin
    .from('entity_candidates')
    .update({ resolution_status: 'merged', resolved_node_id: nodeId })
    .eq('id', candidate.id)
}

async function createNewNode(
  admin: SupabaseClient,
  candidate: CandidateRow,
  isProvisional: boolean,
): Promise<string> {
  const embedding = embeddingLiteral(candidate.embedding)
  const now = new Date().toISOString()

  const { data, error } = await admin
    .from('graph_nodes')
    .insert({
      user_id: candidate.user_id,
      name: candidate.name,
      entity_type: candidate.entity_type,
      embedding,
      mention_count: 1,
      source_count: 1,
      source_authority_avg: candidate.source_authority,
      is_provisional: isProvisional,
      created_at: now,
      last_seen_at: now,
      updated_at: now,
      pipeline_version: RESOLUTION_VERSION,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`graph_nodes insert failed: ${error?.message}`)

  const nodeId = data.id as string

  await admin.from('node_mentions').insert({
    node_id: nodeId,
    user_id: candidate.user_id,
    source_record_id: candidate.source_record_id,
    candidate_id: candidate.id,
  })

  const status = isProvisional ? 'held' : 'new_node'
  await admin
    .from('entity_candidates')
    .update({ resolution_status: status, resolved_node_id: nodeId })
    .eq('id', candidate.id)

  return nodeId
}

// -----------------------------------------------------------------------------
// Main entrypoint
// -----------------------------------------------------------------------------

export async function resolveCandidate(
  admin: SupabaseClient,
  candidate: CandidateRow,
): Promise<ResolutionOutcome> {
  // Person normalization is applied to the search name; the candidate row itself
  // keeps its original name. This mirrors the doc's "normalize before embedding
  // + lookup" note, without rewriting user-facing values.
  const searchName = candidate.entity_type === 'person'
    ? normalizePersonName(candidate.name)
    : candidate.name
  void searchName  // reserved for future name-based prefilter

  const embedding = embeddingLiteral(candidate.embedding)

  const { data: shortlist, error } = await admin.rpc('resolve_shortlist', {
    p_user_id: candidate.user_id,
    p_entity_type: candidate.entity_type,
    p_embedding: embedding,
    p_limit: SHORTLIST_TOP_K,
  })
  if (error) throw new Error(`resolve_shortlist rpc failed: ${error.message}`)

  const rows = (shortlist ?? []) as ShortlistRow[]
  const top = rows[0]

  if (!top) {
    const nodeId = await createNewNode(admin, candidate, false)
    return { status: 'new_node', node_id: nodeId }
  }

  const dist = Number(top.embedding_distance)

  if (dist <= MERGE_MAX_DISTANCE) {
    await mergeIntoNode(admin, candidate, top.id)
    return { status: 'merged', node_id: top.id }
  }

  if (dist >= NEW_MIN_DISTANCE) {
    const nodeId = await createNewNode(admin, candidate, false)
    return { status: 'new_node', node_id: nodeId }
  }

  // Review band — LLM judge on the top shortlist row.
  let verdict: JudgeVerdict
  try {
    verdict = await callJudge(candidate, top)
  } catch (err) {
    console.warn(`[brain-resolution] judge failed, treating as ambiguous:`, err)
    verdict = { verdict: 'ambiguous', reasoning: 'judge_error', confidence: 0.5 }
  }

  if (verdict.verdict === 'same') {
    await mergeIntoNode(admin, candidate, top.id)
    return { status: 'merged', node_id: top.id }
  }
  if (verdict.verdict === 'distinct') {
    const nodeId = await createNewNode(admin, candidate, false)
    return { status: 'new_node', node_id: nodeId }
  }
  // ambiguous → provisional node.
  const nodeId = await createNewNode(admin, candidate, true)
  return { status: 'held', node_id: nodeId }
}
