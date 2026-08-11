// brain-graph-read — user-scoped graph read for the /brain page.
//
// v3 update: reads concepts + COVERS edges from Neo4j. Maps Neo4j source
// node ids back to Postgres normalized_events UUIDs so the Brain.tsx
// record-node visualization stays intact.
//
// Response shape (backward-compatible):
//   concepts: [{id, name, normalized_name, mention_count}]
//   mentions: [{concept_id, source_record_id}]  — source_record_id is the
//             Postgres normalized_events.id UUID
//
// Auth: standard user JWT.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'

interface ConceptRow {
  id: string
  name: string
  normalized_name: string
  mention_count: number
  // v4 pedagogical tags (nullable — old v3 concepts don't have them,
  // but the graph has been wiped + rebuilt so should always be populated now).
  skill_dimensions: string[] | null
  domain_tags: string[] | null
  bloom_typical_level: string | null
}

interface CoversRow {
  concept_id: string
  source_id: string
  source_label: string
}

// v4 concept-to-concept edge — tier-2 child → tier-1 parent.
interface HierarchyRow {
  child_id: string
  parent_id: string
  confidence: number
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

// Neo4j source_id → set of Postgres normalized_events.id UUIDs.
// Some Neo4j nodes (Assignment) bundle multiple Postgres rows; a single COVERS
// edge from the bundled Assignment expands to one mention per record.
function buildSourceMap(
  events: Array<{
    id: string
    source_type: string
    external_id: string
    course_id: string | null
    raw_payload: Record<string, unknown> | null
  }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const push = (key: string, id: string) => {
    const arr = map.get(key) ?? []
    arr.push(id)
    map.set(key, arr)
  }
  for (const r of events) {
    const rp = r.raw_payload ?? {}
    const courseId = r.course_id
    switch (r.source_type) {
      case 'canvas_lecture': {
        const itemId = rp.item_id ?? rp.content_id
        if (itemId != null) push(`canvas_lecture_${itemId}`, r.id)
        break
      }
      case 'canvas_syllabus':
      case 'manual_syllabus':
      case 'canvas_file_syllabus': {
        if (courseId) push(`canvas_syllabus_${courseId.replace(/^canvas_course_/, '')}`, r.id)
        break
      }
      case 'canvas_assignment':
      case 'manual_assignment': {
        if (courseId) {
          const canonical = String(rp.rumbo_canonical_name ?? rp.name ?? '').trim()
          const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed'
          push(`assignment_${courseId}_${slug}`, r.id)
        }
        break
      }
      case 'canvas_file_project':
      case 'canvas_file_rubric':
      case 'canvas_file_study': {
        const fileId = rp.id ?? rp.canvas_file_id
        if (fileId != null) push(`canvas_file_${fileId}`, r.id)
        break
      }
      case 'canvas_page': {
        if (courseId) {
          const pageSlug = String(rp.page_url ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
          if (pageSlug) push(`canvas_page_${courseId.replace(/^canvas_course_/, '')}_${pageSlug}`, r.id)
        }
        break
      }
      case 'canvas_course':
      case 'manual_course':
      case 'canvas_home':
      case 'canvas_announcement': {
        if (courseId) push(courseId, r.id)
        break
      }
      case 'canvas_assignment_rubric': {
        if (courseId) {
          const canonical = String(rp.assignment_name ?? '').trim()
          const slug = canonical.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'unnamed'
          push(`assignment_${courseId}_${slug}`, r.id)
        }
        break
      }
    }
  }
  return map
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  const userId = await getUserIdFromRequest(req)
  if (!userId) return jsonResponse({ error: 'Not authenticated' }, 401)

  // Demo isolation: scope the whole graph to a single course when a course
  // filter is supplied (POST body { course_id } or ?course_id=), falling back
  // to the DEMO_COURSE_ID env var. When unset, behaves as before (full graph).
  let courseFilter: string | null = null
  if (req.method === 'POST') {
    try {
      const body = await req.json()
      if (body && typeof body.course_id === 'string' && body.course_id) courseFilter = body.course_id
    } catch { /* empty/invalid body — fall through to env default */ }
  } else {
    courseFilter = new URL(req.url).searchParams.get('course_id')
  }
  courseFilter = courseFilter || Deno.env.get('DEMO_COURSE_ID') || null

  const g = neo4j()
  const admin = createAdminClient()

  // 1. Concepts from Neo4j — with v4 pedagogical tags.
  const concepts = (await g.run<ConceptRow>(
    `MATCH (c:Concept {user_id: $userId})
     RETURN c.id AS id,
            c.name AS name,
            coalesce(c.normalized_name, c.name) AS normalized_name,
            coalesce(c.mention_count, 1) AS mention_count,
            c.skill_dimensions AS skill_dimensions,
            c.domain_tags AS domain_tags,
            c.bloom_typical_level AS bloom_typical_level
     ORDER BY mention_count DESC`,
    { userId },
  )) as ConceptRow[]

  // 1b. PARENT_CONCEPT hierarchy (child → parent, both Concepts).
  const hierarchy = (await g.run<HierarchyRow>(
    `MATCH (child:Concept {user_id: $userId})-[r:PARENT_CONCEPT]->(parent:Concept {user_id: $userId})
     RETURN child.id AS child_id, parent.id AS parent_id, r.confidence AS confidence
     ORDER BY r.confidence DESC`,
    { userId },
  )) as HierarchyRow[]

  // 2. COVERS edges — source node → concept.
  const covers = (await g.run<CoversRow>(
    `MATCH (source)-[:COVERS]->(c:Concept {user_id: $userId})
     WHERE source.user_id = $userId
     RETURN c.id AS concept_id, source.id AS source_id, labels(source)[0] AS source_label`,
    { userId },
  )) as CoversRow[]

  // 3. Pull normalized_events for source-id → record-uuid mapping.
  // When a course filter is active, restrict records to that course — this is
  // what actually scopes the graph, since concepts/mentions are derived from
  // these records below.
  let evQuery = admin
    .from('normalized_events')
    .select('id, source_type, external_id, course_id, raw_payload')
    .eq('user_id', userId)
    .eq('classification', 'academic')
    .is('cancelled_at', null)
  if (courseFilter) evQuery = evQuery.eq('course_id', courseFilter)
  const { data: events, error: evErr } = await evQuery
  if (evErr) return jsonResponse({ error: 'events read failed', detail: evErr.message }, 500)

  const sourceMap = buildSourceMap((events ?? []) as Array<{
    id: string
    source_type: string
    external_id: string
    course_id: string | null
    raw_payload: Record<string, unknown> | null
  }>)

  // 4. Expand each COVERS edge into per-record mentions.
  const mentions: Array<{ concept_id: string; source_record_id: string }> = []
  for (const c of covers) {
    const recordIds = sourceMap.get(c.source_id)
    if (!recordIds || recordIds.length === 0) continue
    for (const rid of recordIds) {
      mentions.push({ concept_id: c.concept_id, source_record_id: rid })
    }
  }

  // 5. When scoped to a course, keep only concepts that are actually covered
  // by this course's materials (i.e. have ≥1 mention from the filtered
  // records), and prune hierarchy edges to that concept set. Without a filter,
  // pass everything through unchanged.
  let conceptsOut = concepts
  let hierarchyOut = hierarchy
  if (courseFilter) {
    const liveConceptIds = new Set(mentions.map((m) => m.concept_id))
    conceptsOut = concepts.filter((c) => liveConceptIds.has(c.id))
    hierarchyOut = hierarchy.filter(
      (h) => liveConceptIds.has(h.child_id) && liveConceptIds.has(h.parent_id),
    )
  }

  return jsonResponse({
    concepts: conceptsOut,
    mentions,
    hierarchy: hierarchyOut,
    course_filter: courseFilter,
    counts: {
      concepts: conceptsOut.length,
      covers_edges: covers.length,
      mentions: mentions.length,
      hierarchy_edges: hierarchyOut.length,
    },
  })
})
