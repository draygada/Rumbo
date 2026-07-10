// tutor-retrieval — Cypher queries the tutor uses to ground its answers.
// See Features/ai-tutor.md §3 (three query modes) + §4 (grounding contract).

import type { Neo4jClient } from './neo4j.ts'

export interface CoursePeek {
  id: string
  code: string | null
  name: string | null
  term: string | null
}

export interface RetrievalHit {
  source_id: string
  source_label: string   // 'Lecture'|'Assignment'|'File'|'Syllabus'|'LectureSlide'
  source_title: string
  source_url: string | null
  course_id: string | null
  course_code: string | null
  course_name: string | null
  course_term: string | null
  concept_name: string
  concept_id: string
  slide_number: number | null
  is_primary: boolean
  weight: number | null
  first_seen_at: string | null
}

// -----------------------------------------------------------------------------
// Concept resolution: vector-similarity lookup by embedding.
// -----------------------------------------------------------------------------

export async function resolveConcept(
  g: Neo4jClient,
  args: { userId: string; embedding: number[] },
): Promise<Array<{ id: string; name: string; score: number }>> {
  return (await g.run<{ id: string; name: string; score: number }>(
    `CALL db.index.vector.queryNodes('concept_embedding', 5, $embedding)
     YIELD node, score
     WHERE node.user_id = $userId
     RETURN node.id AS id, node.name AS name, score
     ORDER BY score DESC`,
    { embedding: args.embedding, userId: args.userId },
  )) as Array<{ id: string; name: string; score: number }>
}

// -----------------------------------------------------------------------------
// Course resolution — three paths per Features/ai-tutor.md §6.
// -----------------------------------------------------------------------------

export async function resolveCourseByCode(
  g: Neo4jClient,
  args: { userId: string; code: string },
): Promise<CoursePeek[]> {
  // Case-insensitive prefix match on Course.code; falls back to name.
  return (await g.run<CoursePeek>(
    `MATCH (c:Course {user_id: $userId})
     WHERE toLower(coalesce(c.code, '')) STARTS WITH toLower($code)
        OR toLower(coalesce(c.name, '')) CONTAINS toLower($code)
     RETURN c.id AS id, c.code AS code, c.name AS name, c.term AS term
     LIMIT 5`,
    { userId: args.userId, code: args.code },
  )) as CoursePeek[]
}

export async function resolveCourseByEmbedding(
  g: Neo4jClient,
  args: { userId: string; embedding: number[] },
): Promise<Array<CoursePeek & { score: number }>> {
  return (await g.run<CoursePeek & { score: number }>(
    `CALL db.index.vector.queryNodes('course_description_embedding', 5, $embedding)
     YIELD node, score
     WHERE node.user_id = $userId
     RETURN node.id AS id, node.code AS code, node.name AS name, node.term AS term, score
     ORDER BY score DESC`,
    { userId: args.userId, embedding: args.embedding },
  )) as Array<CoursePeek & { score: number }>
}

// -----------------------------------------------------------------------------
// Retrieval mode 3.1 — within a course.
// -----------------------------------------------------------------------------

export async function retrieveWithinCourse(
  g: Neo4jClient,
  args: { userId: string; courseId: string; conceptEmbedding: number[]; limit?: number },
): Promise<RetrievalHit[]> {
  const limit = args.limit ?? 10
  return (await g.run<RetrievalHit>(
    `MATCH (course:Course {id: $courseId, user_id: $userId})-[:CONTAINS]->(source)
     -[cov:COVERS]->(concept:Concept)
     WITH source, cov, concept, course,
          reduce(s = 0.0, i IN range(0, size(concept.embedding)-1) |
            s + concept.embedding[i] * $conceptEmbedding[i]) AS dot
     WHERE dot > 0.7 OR cov.is_primary = true
     RETURN source.id AS source_id,
            labels(source)[0] AS source_label,
            coalesce(source.title, source.name, source.display_name) AS source_title,
            coalesce(source.url, source.html_url) AS source_url,
            course.id AS course_id,
            course.code AS course_code,
            course.name AS course_name,
            course.term AS course_term,
            concept.name AS concept_name,
            concept.id AS concept_id,
            null AS slide_number,
            cov.is_primary AS is_primary,
            cov.weight AS weight,
            concept.first_seen_at AS first_seen_at
     ORDER BY cov.is_primary DESC, cov.weight DESC
     LIMIT $limit`,
    { userId: args.userId, courseId: args.courseId, conceptEmbedding: args.conceptEmbedding, limit },
  )) as RetrievalHit[]
}

// -----------------------------------------------------------------------------
// Retrieval mode 3.2 — across courses, chronological ordering.
// -----------------------------------------------------------------------------

export async function retrieveAcrossCourses(
  g: Neo4jClient,
  args: { userId: string; conceptId: string; limit?: number },
): Promise<RetrievalHit[]> {
  const limit = args.limit ?? 10
  return (await g.run<RetrievalHit>(
    `MATCH (concept:Concept {id: $conceptId, user_id: $userId})
     MATCH (source)-[cov:COVERS]->(concept)
     WHERE source.user_id = $userId
     MATCH (course:Course {user_id: $userId})-[:CONTAINS]->(source)
     RETURN source.id AS source_id,
            labels(source)[0] AS source_label,
            coalesce(source.title, source.name, source.display_name) AS source_title,
            coalesce(source.url, source.html_url) AS source_url,
            course.id AS course_id,
            course.code AS course_code,
            course.name AS course_name,
            course.term AS course_term,
            concept.name AS concept_name,
            concept.id AS concept_id,
            source.slide_number AS slide_number,
            cov.is_primary AS is_primary,
            cov.weight AS weight,
            concept.first_seen_at AS first_seen_at
     ORDER BY course.term_end ASC, cov.weight DESC
     LIMIT $limit`,
    { userId: args.userId, conceptId: args.conceptId, limit },
  )) as RetrievalHit[]
}

// -----------------------------------------------------------------------------
// Confidence scoring (Features/ai-tutor.md §5).
// -----------------------------------------------------------------------------

export function computeConfidence(args: {
  topScore: number | null      // best cosine match on concept
  runnerUpScore: number | null // second-best
  hitCount: number             // number of retrieval hits
}): number {
  if (args.hitCount === 0) return 0
  const gap = args.topScore != null && args.runnerUpScore != null
    ? args.topScore - args.runnerUpScore
    : args.topScore ?? 0
  let c = 0
  if (args.topScore != null) c += Math.min(1, args.topScore) * 0.5
  c += Math.min(1, gap / 0.15) * 0.25
  c += Math.min(1, args.hitCount / 3) * 0.25
  return Math.min(1, Math.max(0, c))
}
