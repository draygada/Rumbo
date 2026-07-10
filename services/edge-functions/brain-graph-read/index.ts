// brain-graph-read — user-scoped graph read for the /brain page.
//
// Phase 4: replaces the client's direct Postgres reads of `graph_nodes` +
// `node_mentions`. Returns the same shape /brain expects (list of concepts +
// mentions), but concepts now come from Neo4j. Mentions still come from
// Postgres until Phase 6 backfills them into Neo4j as COVERS edges.
//
// Auth: standard user JWT (verify_jwt = true). Every read is scoped by the
// caller's user_id so there's no cross-user leakage.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'

interface ConceptRow {
  id: string
  name: string
  normalized_name: string
  mention_count: number
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const userId = await getUserIdFromRequest(req)
  if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401)

  const g = neo4j()
  const admin = createAdminClient()

  // 1. All concepts for this user, ordered by mention count so the client
  //    can trivially pick the top-N if it wants to cap.
  const concepts = (await g.run<ConceptRow>(
    `MATCH (c:Concept {user_id: $userId})
     RETURN c.id AS id,
            c.name AS name,
            c.normalized_name AS normalized_name,
            coalesce(c.mention_count, 1) AS mention_count
     ORDER BY mention_count DESC`,
    { userId },
  )) as ConceptRow[]

  // Backfill maps Postgres graph_nodes.id -> Neo4j Concept id via the
  // `pg_concept_<uuid16>` prefix (see neo4j-backfill). We need the reverse
  // lookup to join Neo4j Concepts against Postgres node_mentions.
  const neoToPg = new Map<string, string>()

  // Pull the alive graph_nodes rows for this user; we only need the ids and
  // build the same short form the backfill uses.
  const { data: pgNodeRows, error: pgErr } = await admin
    .from('graph_nodes')
    .select('id, name, entity_type')
    .eq('user_id', userId)
    .in('entity_type', ['concept', 'topic'])
    .is('superseded_at', null)
  if (pgErr) return jsonResponse({ error: 'graph_nodes read failed', detail: pgErr.message }, 500)
  const pgNodeIdSet = new Set<string>()
  for (const row of pgNodeRows ?? []) {
    const shortId = `pg_concept_${(row.id as string).replace(/-/g, '').slice(0, 16)}`
    neoToPg.set(shortId, row.id as string)
    pgNodeIdSet.add(row.id as string)
  }

  // 2. Mentions from Postgres (moves to Neo4j in Phase 6).
  const { data: mentionsRaw, error: mErr } = await admin
    .from('node_mentions')
    .select('node_id, source_record_id')
    .eq('user_id', userId)
  if (mErr) return jsonResponse({ error: 'node_mentions read failed', detail: mErr.message }, 500)

  // Filter to mentions of alive nodes, then project Postgres node_id -> Neo4j
  // concept id so the client sees a single id-space.
  interface Mention {
    concept_id: string   // Neo4j id
    source_record_id: string
  }
  const mentions: Mention[] = []
  // Build reverse: pg uuid -> neoId
  const pgToNeo = new Map<string, string>()
  for (const [neoId, pgId] of neoToPg) pgToNeo.set(pgId, neoId)

  for (const m of (mentionsRaw ?? []) as Array<{ node_id: string; source_record_id: string }>) {
    const neoId = pgToNeo.get(m.node_id)
    if (!neoId) continue // node was skipped (course_reference / deadline) or superseded
    mentions.push({ concept_id: neoId, source_record_id: m.source_record_id })
  }

  return jsonResponse({
    concepts,
    mentions,
    counts: {
      concepts: concepts.length,
      mentions: mentions.length,
    },
  })
})
