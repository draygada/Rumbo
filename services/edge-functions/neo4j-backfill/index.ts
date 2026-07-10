// neo4j-backfill — one-time Postgres→Neo4j sync of the existing brain state.
//
// Purpose: warm-start Neo4j with what the current Postgres brain contains so
// /brain isn't blank at cutover. Phase 6 (batched Fast-tier extraction rewrite)
// will re-run extraction and layer in proper Canvas Lecture/File/Assignment
// nodes; this function is just enough to preserve today's ~28 concepts / ~88
// mentions / edges.
//
// Scope (per Rumbo-Design-Docs/Infrastructure/neo4j.md §4):
//   - User node
//   - Course nodes from public.manual_courses
//   - Concept / Person / Assignment nodes from public.graph_nodes
//     (course_reference and deadline entity_types are skipped — resolved
//      differently in Phase 6)
//   - Edges from public.graph_edges:
//       relationship_type='prerequisite' -> PREREQUISITE_OF
//       everything else                  -> RELATED_TO (with original_type prop)
//
// Not synced here (comes later):
//   - Canvas Lecture / File / Syllabus nodes                  → Phase 5
//   - LectureSlide / LectureSection sub-lecture chunks        → Phase 7
//   - CalendarEvent nodes                                     → Phase 6
//   - APPEARS_IN, COVERS denormalization edges                → Phase 6
//   - LearnerNote nodes                                       → Phase 2 (learner model, post-V0)
//
// Auth: CRON_SECRET header, same as other ticks.
// Body: { user_id?: string }  — omit to backfill all users.
// Idempotent — every write is a MERGE.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'

interface BackfillBody {
  user_id?: string
}

interface PgGraphNode {
  id: string
  user_id: string
  name: string
  entity_type: string
  embedding: number[] | null
  mention_count: number
  source_authority_avg: number | null
  created_at: string
  last_seen_at: string | null
}

interface PgGraphEdge {
  id: string
  user_id: string
  source_node_id: string
  target_node_id: string
  relationship_type: string
  direction: string
  weight: number | null
  extraction_confidence: number
  resolution_confidence: number
  relevance_score: number
}

interface PgManualCourse {
  id: string
  user_id: string
  name: string
  course_code: string | null
  term: string | null
  end_date: string | null
  instructor_name: string | null
}

function requireCronAuth(req: Request): Response | null {
  const cronSecret = Deno.env.get('CRON_SECRET')
  if (!cronSecret) {
    return jsonResponse({ error: 'server_misconfigured', detail: 'CRON_SECRET not set' }, 500)
  }
  if (req.headers.get('x-cron-secret') !== cronSecret) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }
  return null
}

// Normalize legacy Postgres entity_type -> Neo4j label + normalized name.
// 'topic' rows collapse into Concept (per graph-schema.md §2).
function neo4jLabelFor(entityType: string): 'Concept' | 'Person' | 'Assignment' | null {
  if (entityType === 'concept' || entityType === 'topic') return 'Concept'
  if (entityType === 'person') return 'Person'
  if (entityType === 'assignment') return 'Assignment'
  return null // course_reference, deadline → skipped
}

// Map legacy relationship_type -> Neo4j edge type.
function neo4jEdgeTypeFor(relType: string): 'PREREQUISITE_OF' | 'RELATED_TO' {
  return relType === 'prerequisite' ? 'PREREQUISITE_OF' : 'RELATED_TO'
}

async function backfillUser(userId: string) {
  const admin = createAdminClient()
  const g = neo4j()

  const report: Record<string, number> = {
    user_merged: 0,
    courses_merged: 0,
    concepts_merged: 0,
    persons_merged: 0,
    assignments_merged: 0,
    nodes_skipped: 0,
    edges_merged: 0,
    edges_skipped_missing_endpoint: 0,
  }

  // 1. User node
  await g.run(
    `MERGE (u:User {id: $userId})
     ON CREATE SET u.created_at = datetime()
     RETURN u.id AS id`,
    { userId },
  )
  report.user_merged = 1

  // 2. Manual courses -> Course nodes
  const { data: manualCourses, error: mcErr } = await admin
    .from('manual_courses')
    .select('id, user_id, name, course_code, term, end_date, instructor_name')
    .eq('user_id', userId)
    .is('archived_at', null)
  if (mcErr) throw new Error(`manual_courses read: ${mcErr.message}`)
  for (const c of (manualCourses ?? []) as PgManualCourse[]) {
    const nodeId = `manual_course_${c.id}`
    await g.run(
      `MERGE (course:Course {id: $id})
       SET course.user_id = $userId,
           course.name = $name,
           course.code = $code,
           course.term = $term,
           course.term_end = CASE WHEN $termEnd IS NULL THEN course.term_end ELSE datetime($termEnd) END,
           course.source = 'manual'
       WITH course
       MATCH (u:User {id: $userId})
       MERGE (u)-[:ENROLLED_IN]->(course)
       RETURN course.id AS id`,
      {
        id: nodeId,
        userId,
        name: c.name,
        code: c.course_code,
        term: c.term,
        termEnd: c.end_date,
      },
    )
    report.courses_merged++
  }

  // 3. graph_nodes -> Concept / Person / Assignment
  //    Map Postgres uuid -> Neo4j id so we can wire edges by the same key later.
  const pgIdToNeoId = new Map<string, { neoId: string; label: string }>()

  const { data: pgNodes, error: gnErr } = await admin
    .from('graph_nodes')
    .select(
      'id, user_id, name, entity_type, embedding, mention_count, source_authority_avg, created_at, last_seen_at',
    )
    .eq('user_id', userId)
    .is('superseded_at', null)
  if (gnErr) throw new Error(`graph_nodes read: ${gnErr.message}`)

  for (const n of (pgNodes ?? []) as PgGraphNode[]) {
    const label = neo4jLabelFor(n.entity_type)
    if (!label) {
      report.nodes_skipped++
      continue
    }
    // Neo4j id format for concepts: pg_concept_<uuid-first-16>.
    // Not the final Phase-6 id shape (hash of normalized name) but stable and
    // idempotent for the backfill window.
    const idPrefix =
      label === 'Concept' ? 'pg_concept_' : label === 'Person' ? 'pg_person_' : 'pg_assignment_'
    const neoId = `${idPrefix}${n.id.replace(/-/g, '').slice(0, 16)}`
    pgIdToNeoId.set(n.id, { neoId, label })

    const normalizedName = n.name.toLowerCase().trim()
    const embedding = Array.isArray(n.embedding) ? n.embedding : null

    if (label === 'Concept') {
      await g.run(
        `MERGE (c:Concept {id: $id})
         SET c.user_id = $userId,
             c.name = $name,
             c.normalized_name = $normalized,
             c.mention_count = $mentionCount,
             c.first_seen_at = CASE WHEN c.first_seen_at IS NULL THEN datetime($firstSeen) ELSE c.first_seen_at END,
             c.last_seen_at = datetime($lastSeen),
             c.embedding = CASE WHEN $embedding IS NULL THEN c.embedding ELSE $embedding END
         RETURN c.id AS id`,
        {
          id: neoId,
          userId,
          name: n.name,
          normalized: normalizedName,
          mentionCount: n.mention_count,
          firstSeen: n.created_at,
          lastSeen: n.last_seen_at ?? n.created_at,
          embedding,
        },
      )
      report.concepts_merged++
    } else if (label === 'Person') {
      await g.run(
        `MERGE (p:Person {id: $id})
         SET p.user_id = $userId,
             p.name = $name,
             p.canonical_name = $canonical,
             p.role = 'unknown'
         RETURN p.id AS id`,
        { id: neoId, userId, name: n.name, canonical: normalizedName },
      )
      report.persons_merged++
    } else if (label === 'Assignment') {
      // Phase 6 rewrites assignments as bundled Canvas items with proper
      // canonical_name. Backfill keeps the display name only.
      await g.run(
        `MERGE (a:Assignment {id: $id})
         SET a.user_id = $userId,
             a.name = $name,
             a.canonical_name = $canonical,
             a.record_count = 1,
             a.signal_level = 'medium'
         RETURN a.id AS id`,
        { id: neoId, userId, name: n.name, canonical: normalizedName },
      )
      report.assignments_merged++
    }
  }

  // 4. graph_edges -> RELATED_TO / PREREQUISITE_OF
  const { data: pgEdges, error: geErr } = await admin
    .from('graph_edges')
    .select(
      'id, user_id, source_node_id, target_node_id, relationship_type, direction, weight, extraction_confidence, resolution_confidence, relevance_score',
    )
    .eq('user_id', userId)
    .is('superseded_at', null)
    .eq('is_provisional', false)
  if (geErr) throw new Error(`graph_edges read: ${geErr.message}`)

  for (const e of (pgEdges ?? []) as PgGraphEdge[]) {
    const src = pgIdToNeoId.get(e.source_node_id)
    const tgt = pgIdToNeoId.get(e.target_node_id)
    if (!src || !tgt) {
      report.edges_skipped_missing_endpoint++
      continue
    }
    const edgeType = neo4jEdgeTypeFor(e.relationship_type)
    const weight = e.weight ?? e.relevance_score ?? 0.5
    await g.run(
      `MATCH (s {id: $srcId, user_id: $userId})
       MATCH (t {id: $tgtId, user_id: $userId})
       MERGE (s)-[r:${edgeType}]->(t)
       SET r.weight = $weight,
           r.original_type = $originalType,
           r.direction = $direction
       RETURN type(r) AS type`,
      {
        srcId: src.neoId,
        tgtId: tgt.neoId,
        userId,
        weight,
        originalType: e.relationship_type,
        direction: e.direction,
      },
    )
    report.edges_merged++
  }

  return report
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const authFail = requireCronAuth(req)
  if (authFail) return authFail

  let body: BackfillBody = {}
  try {
    body = (await req.json()) as BackfillBody
  } catch {
    // empty body -> backfill all users
  }

  const admin = createAdminClient()
  let userIds: string[] = []
  if (body.user_id) {
    userIds = [body.user_id]
  } else {
    // All users with any graph_nodes row.
    const { data, error } = await admin
      .from('graph_nodes')
      .select('user_id')
      .is('superseded_at', null)
    if (error) return jsonResponse({ error: 'user_scan_failed', detail: error.message }, 500)
    userIds = [...new Set((data ?? []).map((r) => r.user_id as string))]
  }

  const results: Array<{ user_id: string; ok: boolean; report?: unknown; error?: string }> = []
  for (const uid of userIds) {
    try {
      const report = await backfillUser(uid)
      results.push({ user_id: uid, ok: true, report })
    } catch (err) {
      results.push({
        user_id: uid,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Post-run health snapshot from Neo4j.
  let health: Array<{ label: string; count: number }> = []
  try {
    health = (await neo4j().run<{ label: string; count: number }>(
      'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC',
    )) as Array<{ label: string; count: number }>
  } catch {
    // ignore
  }

  return jsonResponse({
    users: results.length,
    results,
    health,
  })
})
