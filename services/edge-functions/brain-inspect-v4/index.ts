// brain-inspect-v4 — diagnostic endpoint.
// Runs a fixed set of v4 sanity queries against Neo4j and returns JSON.
// Also supports ?course=<partial-code> to look up a specific course + its content.
// Auth: CRON_SECRET.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { neo4j } from '../_shared/neo4j.ts'

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return false
  return req.headers.get('x-cron-secret') === expected
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (!authorized(req)) return jsonResponse({ error: 'unauthorized' }, 401)

  const g = neo4j()
  const url = new URL(req.url)
  const courseHint = url.searchParams.get('course')
  const out: Record<string, unknown> = {}

  try {
    // ---- Concept-sprawl diagnostic (read-only). ?diag=dump&user=<user_id>
    if (url.searchParams.get('diag') === 'dump') {
      const userId = url.searchParams.get('user')
      out.mode = 'concept_dump'
      out.user_id = userId
      out.generated_at = new Date().toISOString()
      out.concepts = await g.run(
        `MATCH (c:Concept)
         WHERE $u IS NULL OR c.user_id = $u
         OPTIONAL MATCH (c)<-[cov:COVERS]-(src)
         WITH c, count(cov) AS covers_in, collect(DISTINCT labels(src)[0]) AS src_labels,
              collect(DISTINCT src.course_id) AS src_courses
         OPTIONAL MATCH (c)-[:PARENT_CONCEPT]->(p:Concept)
         WITH c, covers_in, src_labels, src_courses, count(p) AS parent_out
         OPTIONAL MATCH (c)<-[:PARENT_CONCEPT]-(ch:Concept)
         WITH c, covers_in, src_labels, src_courses, parent_out, count(ch) AS child_in
         OPTIONAL MATCH (c)-[:APPEARS_IN]->(course:Course)
         RETURN c.id AS id, c.name AS name, c.normalized_name AS norm,
                coalesce(c.mention_count, 0) AS mentions,
                c.created_at AS created_at,
                c.domain_tags AS domain_tags,
                c.bloom_typical_level AS bloom,
                covers_in, parent_out, child_in,
                [l IN src_labels WHERE l IS NOT NULL] AS src_labels,
                [x IN src_courses WHERE x IS NOT NULL] AS src_courses,
                collect(DISTINCT course.code) AS appears_in_courses
         ORDER BY c.created_at DESC`,
        { u: userId },
      )
      return jsonResponse(out)
    }

    if (courseHint) {
      // Course-scoped diagnostic
      out.mode = 'course_lookup'
      out.course_hint = courseHint
      out.matching_courses = await g.run(
        `MATCH (c:Course)
         WHERE toLower(c.code) CONTAINS toLower($h)
            OR toLower(c.name) CONTAINS toLower($h)
         RETURN c.code AS code, c.name AS name, c.id AS id
         LIMIT 10`,
        { h: courseHint },
      )
      out.content_for_matches = await g.run(
        `MATCH (c:Course)-[:CONTAINS]->(child)
         WHERE toLower(c.code) CONTAINS toLower($h)
            OR toLower(c.name) CONTAINS toLower($h)
         RETURN c.code AS course_code, labels(child)[0] AS label,
                coalesce(child.title, child.name, child.display_name) AS title,
                count(*) AS n
         ORDER BY n DESC LIMIT 20`,
        { h: courseHint },
      )
      out.concepts_in_matches = await g.run(
        `MATCH (c:Course)-[:CONTAINS]->(source)-[:COVERS]->(concept:Concept)
         WHERE toLower(c.code) CONTAINS toLower($h)
            OR toLower(c.name) CONTAINS toLower($h)
         RETURN concept.name AS concept, count(DISTINCT source) AS n
         ORDER BY n DESC LIMIT 15`,
        { h: courseHint },
      )
      return jsonResponse(out)
    }

    out.concepts_total = (await g.run<{ count: number }>(
      `MATCH (c:Concept) RETURN count(c) AS count`,
    ))[0]?.count ?? 0
    out.concepts_with_tags = (await g.run<{ count: number }>(
      `MATCH (c:Concept)
       WHERE c.skill_dimensions IS NOT NULL AND size(c.skill_dimensions) > 0
       RETURN count(c) AS count`,
    ))[0]?.count ?? 0
    out.top_concepts = await g.run(
      `MATCH (c:Concept)
       RETURN c.name AS name, c.skill_dimensions AS skill_dimensions,
              c.domain_tags AS domain_tags, c.bloom_typical_level AS bloom,
              c.mention_count AS mentions
       ORDER BY c.mention_count DESC LIMIT 10`,
    )
    out.parent_concept_total = (await g.run<{ count: number }>(
      `MATCH ()-[r:PARENT_CONCEPT]->() RETURN count(r) AS count`,
    ))[0]?.count ?? 0
    out.parent_concept_sample = await g.run(
      `MATCH (child:Concept)-[r:PARENT_CONCEPT]->(parent:Concept)
       RETURN parent.name AS tier1, child.name AS tier2, r.confidence AS confidence
       ORDER BY r.confidence DESC LIMIT 10`,
    )
    out.covers_total = (await g.run<{ count: number }>(
      `MATCH ()-[r:COVERS]->() RETURN count(r) AS count`,
    ))[0]?.count ?? 0
    out.covers_with_definition = (await g.run<{ count: number }>(
      `MATCH ()-[r:COVERS]->() WHERE r.definition IS NOT NULL RETURN count(r) AS count`,
    ))[0]?.count ?? 0
    out.appears_in_total = (await g.run<{ count: number }>(
      `MATCH ()-[r:APPEARS_IN]->() RETURN count(r) AS count`,
    ))[0]?.count ?? 0
    out.chunks_total = (await g.run<{ count: number }>(
      `MATCH (c:Chunk) RETURN count(c) AS count`,
    ))[0]?.count ?? 0
  } catch (err) {
    return jsonResponse({ error: (err instanceof Error ? err.message : String(err)), partial: out }, 500)
  }

  return jsonResponse(out)
})
