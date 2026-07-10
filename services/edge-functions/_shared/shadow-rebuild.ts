// Per-student shadow rebuild orchestrator — Phase 11.
// Reference: Rumbo-Design-Docs/Graph Pipeline/pipeline-versioning.md §5.
//
// Contract per pipeline-versioning.md §5:
//   1. Populate graph_nodes_shadow / entity_candidates_shadow / graph_edges_shadow
//      for a single user with new-version outputs, tagged with the new pipeline_version.
//   2. Compare v_new vs v_current — produce a diff report (surfaced edge count + a
//      sample of differences). This is the manual canary gate (Q3).
//   3. If commit=true, run an atomic swap in one transaction — mark existing live
//      rows as superseded (superseded_at = now()), then move shadow rows into
//      live. Old rows are retained per the permanent-storage principle (never
//      deleted).
//
// This module deliberately does not do the actual re-extraction; it is the
// orchestrator layer that shadow-writers call into and that the swap function
// runs against. In V0 the rebuild is driven manually by an operator invoking
// the shadow-rebuild edge function.

// deno-lint-ignore no-explicit-any
type AdminClient = any

export interface RebuildDiff {
  user_id: string
  target_pipeline_version: string
  nodes_before: number
  nodes_after: number
  edges_before: number
  edges_after: number
  surfaced_before: number
  surfaced_after: number
  sample_added: Array<{ source: string; target: string; relationship: string; weight: number | null }>
  sample_removed: Array<{ source: string; target: string; relationship: string; weight: number | null }>
}

export async function diffRebuild(admin: AdminClient, userId: string, targetVersion: string): Promise<RebuildDiff> {
  const [
    { count: nodesBefore },
    { count: nodesAfter },
    { count: edgesBefore },
    { count: edgesAfter },
    { count: surfacedBefore },
    { count: surfacedAfter },
  ] = await Promise.all([
    admin.from('graph_nodes').select('id', { head: true, count: 'exact' }).eq('user_id', userId).is('superseded_at', null),
    admin.from('graph_nodes_shadow').select('id', { head: true, count: 'exact' }).eq('user_id', userId).eq('pipeline_version', targetVersion),
    admin.from('graph_edges').select('id', { head: true, count: 'exact' }).eq('user_id', userId).is('superseded_at', null),
    admin.from('graph_edges_shadow').select('id', { head: true, count: 'exact' }).eq('user_id', userId).eq('pipeline_version', targetVersion),
    admin.from('graph_edges').select('id', { head: true, count: 'exact' }).eq('user_id', userId).eq('is_surfaced', true).is('superseded_at', null),
    admin.from('graph_edges_shadow').select('id', { head: true, count: 'exact' }).eq('user_id', userId).eq('is_surfaced', true).eq('pipeline_version', targetVersion),
  ])

  // Sampled adds/removes — join by (source_node_id, target_node_id, relationship_type).
  const { data: shadowSample } = await admin
    .from('graph_edges_shadow')
    .select('source_node_id, target_node_id, relationship_type, weight, is_surfaced')
    .eq('user_id', userId)
    .eq('pipeline_version', targetVersion)
    .eq('is_surfaced', true)
    .limit(50)
  const { data: liveSample } = await admin
    .from('graph_edges')
    .select('source_node_id, target_node_id, relationship_type, weight, is_surfaced')
    .eq('user_id', userId)
    .is('superseded_at', null)
    .eq('is_surfaced', true)
    .limit(50)

  const liveKeys = new Set((liveSample ?? []).map(r => `${r.source_node_id}|${r.target_node_id}|${r.relationship_type}`))
  const shadowKeys = new Set((shadowSample ?? []).map(r => `${r.source_node_id}|${r.target_node_id}|${r.relationship_type}`))
  const added = (shadowSample ?? [])
    .filter(r => !liveKeys.has(`${r.source_node_id}|${r.target_node_id}|${r.relationship_type}`))
    .slice(0, 10)
    .map(r => ({ source: r.source_node_id, target: r.target_node_id, relationship: r.relationship_type, weight: r.weight }))
  const removed = (liveSample ?? [])
    .filter(r => !shadowKeys.has(`${r.source_node_id}|${r.target_node_id}|${r.relationship_type}`))
    .slice(0, 10)
    .map(r => ({ source: r.source_node_id, target: r.target_node_id, relationship: r.relationship_type, weight: r.weight }))

  return {
    user_id: userId,
    target_pipeline_version: targetVersion,
    nodes_before: nodesBefore ?? 0,
    nodes_after: nodesAfter ?? 0,
    edges_before: edgesBefore ?? 0,
    edges_after: edgesAfter ?? 0,
    surfaced_before: surfacedBefore ?? 0,
    surfaced_after: surfacedAfter ?? 0,
    sample_added: added,
    sample_removed: removed,
  }
}

// Atomic swap. Live rows are marked superseded (retained per permanent-storage);
// shadow rows are copied into live, then removed from shadow.
export async function commitShadowSwap(admin: AdminClient, userId: string, targetVersion: string): Promise<void> {
  // Best effort: this uses a helper SQL function `shadow_swap(user_id uuid, version text)`
  // defined by the accompanying migration. We call it as an RPC.
  const { error } = await admin.rpc('shadow_swap', { p_user_id: userId, p_version: targetVersion })
  if (error) throw new Error(`shadow_swap failed: ${error.message}`)
}
