// neo4j-graph-writer — MERGE helpers for the Fast-tier (Phase 6) pipeline.
//
// Node shapes & merge keys per graph-schema.md §4-§5. Vector-similarity concept
// resolution uses the `concept_embedding` index at cosine >= 0.88.
// (Was 0.82 initially; over-merged badly in real data — 464 records
// processed and stayed at 64 concepts. Bumped 2026-07-10.)

import type { Neo4jClient } from './neo4j.ts'

// ---------------------------------------------------------------------------
// Structural nodes (Course / Lecture / Assignment / File / Syllabus)
// ---------------------------------------------------------------------------

export type StructuralLabel = 'Course' | 'Lecture' | 'Assignment' | 'File' | 'Syllabus'

export interface StructuralArgs {
  userId: string
  label: StructuralLabel
  id: string                             // merge key per §5
  courseId?: string | null               // set to link CONTAINS from Course
  props: Record<string, unknown>
}

export async function ensureStructuralNode(
  client: Neo4jClient,
  args: StructuralArgs,
): Promise<void> {
  const setClauses = Object.keys(args.props)
    .map(k => `n.${k} = $props.${k}`)
    .join(', ')

  await client.run(
    `MERGE (n:${args.label} {id: $id})
     SET n.user_id = $userId${setClauses ? ', ' + setClauses : ''}`,
    { id: args.id, userId: args.userId, props: args.props },
  )

  if (args.label !== 'Course' && args.courseId) {
    await client.run(
      `MATCH (c:Course {id: $courseId, user_id: $userId})
       MATCH (n:${args.label} {id: $id, user_id: $userId})
       MERGE (c)-[:CONTAINS]->(n)`,
      { courseId: args.courseId, userId: args.userId, id: args.id },
    )
  }
}

// ---------------------------------------------------------------------------
// Concept upsert with vector-similarity resolve
// ---------------------------------------------------------------------------

export interface EnsureConceptArgs {
  userId: string
  name: string                           // display form (post-normalization the caller controls)
  normalizedName: string
  embedding: number[]
  sourceAuthority: number
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface EnsureConceptResult {
  id: string
  merged: boolean                        // true = matched existing concept
}

export async function ensureConcept(
  client: Neo4jClient,
  args: EnsureConceptArgs,
): Promise<EnsureConceptResult> {
  // 1. Try vector-index resolve first.
  const hits = await client.run<{ id: string }>(
    `CALL db.index.vector.queryNodes('concept_embedding', 5, $embedding)
     YIELD node, score
     WHERE node.user_id = $userId AND score >= 0.88
     RETURN node.id AS id ORDER BY score DESC LIMIT 1`,
    { embedding: args.embedding, userId: args.userId },
  ).catch(err => {
    console.warn('[neo4j-graph-writer] vector resolve failed (index missing?):', err)
    return [] as { id: string }[]
  })

  if (hits.length > 0 && hits[0].id) {
    await client.run(
      `MATCH (c:Concept {id: $id, user_id: $userId})
       SET c.mention_count = coalesce(c.mention_count, 0) + 1,
           c.last_seen_at = datetime()`,
      { id: hits[0].id, userId: args.userId },
    )
    return { id: hits[0].id, merged: true }
  }

  // 2. Create a fresh concept with stable id.
  const hash = (await sha256Hex(args.userId + args.normalizedName)).slice(0, 16)
  const id = `concept_${hash}`

  await client.run(
    `MERGE (c:Concept {id: $id})
     ON CREATE SET c.user_id = $userId,
                   c.name = $name,
                   c.normalized_name = $normalized,
                   c.embedding = $embedding,
                   c.mention_count = 1,
                   c.first_seen_at = datetime(),
                   c.last_seen_at = datetime()
     ON MATCH SET  c.mention_count = coalesce(c.mention_count, 0) + 1,
                   c.last_seen_at = datetime()`,
    {
      id,
      userId: args.userId,
      name: args.name,
      normalized: args.normalizedName,
      embedding: args.embedding,
    },
  )
  return { id, merged: false }
}

// ---------------------------------------------------------------------------
// Combined upsert — one Cypher call resolves-or-creates the Concept, links
// COVERS, and links APPEARS_IN. Cuts 4 Neo4j round-trips down to 1 per concept,
// which is what actually keeps the Fast-tier extraction under the Edge
// Function wall-clock at 50-100 records per invocation.
// ---------------------------------------------------------------------------

export interface UpsertConceptAndLinkArgs {
  userId: string
  name: string
  normalizedName: string
  embedding: number[]
  sourceLabel: CoversSourceLabel
  sourceId: string
  weight: number
  isPrimary: boolean
  courseId: string | null
}

export interface UpsertResult {
  id: string
  merged: boolean
}

export async function upsertConceptAndLink(
  client: Neo4jClient,
  args: UpsertConceptAndLinkArgs,
): Promise<UpsertResult> {
  const hash = (await sha256Hex(args.userId + args.normalizedName)).slice(0, 16)
  const newId = `concept_${hash}`

  // The Cypher: vector-lookup a match; pick existing if any, else use newId.
  // Then a MERGE on that id (creates if new) with mention_count bump.
  // Then link COVERS. Then optionally link APPEARS_IN.
  const cypher = `
    CALL db.index.vector.queryNodes('concept_embedding', 3, $embedding) YIELD node, score
    WITH node, score
    WHERE node.user_id = $userId AND score >= 0.88
    WITH collect({id: node.id, score: score}) AS hits
    WITH CASE WHEN size(hits) > 0 THEN hits[0].id ELSE $newId END AS conceptId,
         size(hits) > 0 AS merged
    MERGE (c:Concept {id: conceptId})
    ON CREATE SET c.user_id = $userId,
                  c.name = $name,
                  c.normalized_name = $normalized,
                  c.embedding = $embedding,
                  c.mention_count = 1,
                  c.first_seen_at = datetime(),
                  c.last_seen_at = datetime()
    ON MATCH  SET c.mention_count = coalesce(c.mention_count, 0) + 1,
                  c.last_seen_at = datetime()
    WITH c, merged
    CALL {
      WITH c
      MATCH (s:${args.sourceLabel} {id: $sourceId, user_id: $userId})
      MERGE (s)-[r:COVERS]->(c)
      SET r.weight = $weight, r.is_primary = $isPrimary
      RETURN 1 AS covered
    }
    CALL {
      WITH c
      OPTIONAL MATCH (course:Course {id: $courseId, user_id: $userId})
      FOREACH (_ IN CASE WHEN course IS NOT NULL AND $courseId IS NOT NULL THEN [1] ELSE [] END |
        MERGE (c)-[a:APPEARS_IN]->(course)
        ON CREATE SET a.mention_count = 1
        ON MATCH  SET a.mention_count = coalesce(a.mention_count, 0) + 1
      )
      RETURN 1 AS appeared
    }
    RETURN c.id AS id, merged
  `

  const rows = await client.run<{ id: string; merged: boolean }>(cypher, {
    embedding: args.embedding,
    userId: args.userId,
    newId,
    name: args.name,
    normalized: args.normalizedName,
    sourceId: args.sourceId,
    weight: args.weight,
    isPrimary: args.isPrimary,
    courseId: args.courseId,
  })
  const row = rows[0]
  if (!row) return { id: newId, merged: false }
  return { id: row.id, merged: !!row.merged }
}

// ---------------------------------------------------------------------------
// v3 helpers — closed-vocab candidate lookup, doc-level body upserts, chunk children.
// ---------------------------------------------------------------------------

export interface DocBodyUpsertArgs {
  userId: string
  label: 'Lecture' | 'Assignment' | 'File' | 'Syllabus'
  id: string
  bodyText: string
  bodyEmbedding: number[] | null
}

// Idempotent — sets body_text and body_embedding on an existing doc node.
// Assumes ensureStructuralNode already created the node.
export async function upsertDocBody(client: Neo4jClient, args: DocBodyUpsertArgs): Promise<void> {
  await client.run(
    `MATCH (n:${args.label} {id: $id, user_id: $userId})
     SET n.body_text = $bodyText,
         n.body_embedding = $embedding`,
    {
      id: args.id,
      userId: args.userId,
      bodyText: args.bodyText,
      embedding: args.bodyEmbedding,
    },
  )
}

export interface ChunkUpsertArgs {
  userId: string
  parentLabel: string   // 'Lecture' | 'Assignment' | ...
  parentId: string
  chunkIndex: number
  heading: string | null
  text: string
  embedding: number[] | null
}

export async function upsertChunk(client: Neo4jClient, args: ChunkUpsertArgs): Promise<string> {
  const id = `chunk_${args.parentId}_${args.chunkIndex}`
  await client.run(
    `MERGE (c:Chunk {id: $id})
     SET c.user_id = $userId,
         c.parent_id = $parentId,
         c.parent_label = $parentLabel,
         c.chunk_index = $chunkIndex,
         c.heading = $heading,
         c.text = $text,
         c.body_embedding = $embedding
     WITH c
     MATCH (p:${args.parentLabel} {id: $parentId, user_id: $userId})
     MERGE (p)-[:HAS_CHUNK]->(c)`,
    {
      id,
      userId: args.userId,
      parentId: args.parentId,
      parentLabel: args.parentLabel,
      chunkIndex: args.chunkIndex,
      heading: args.heading,
      text: args.text,
      embedding: args.embedding,
    },
  )
  return id
}

// Fetch top-K candidate Concepts by cosine similarity to a record embedding.
// Used by brain-classify-v3 to seed the classifier's candidate list.
export async function getCandidateConcepts(
  client: Neo4jClient,
  args: { userId: string; embedding: number[]; topK?: number },
): Promise<Array<{ id: string; name: string; score: number }>> {
  const k = args.topK ?? 20
  const hits = await client.run<{ id: string; name: string; score: number }>(
    `CALL db.index.vector.queryNodes('concept_embedding', $k, $embedding)
     YIELD node, score
     WHERE node.user_id = $userId
     RETURN node.id AS id, node.name AS name, score
     ORDER BY score DESC`,
    { userId: args.userId, embedding: args.embedding, k },
  ).catch(() => [] as Array<{ id: string; name: string; score: number }>)
  return hits
}

// Create a brand-new Concept node with a deterministic id and its embedding.
// Used when the classifier proposes a concept not in the candidate list.
export async function createConceptWithEmbedding(
  client: Neo4jClient,
  args: {
    userId: string
    name: string
    normalizedName: string
    embedding: number[]
  },
): Promise<string> {
  const hash = (await sha256Hex(args.userId + args.normalizedName)).slice(0, 16)
  const id = `concept_${hash}`
  await client.run(
    `MERGE (c:Concept {id: $id})
     ON CREATE SET c.user_id = $userId,
                   c.name = $name,
                   c.normalized_name = $normalized,
                   c.embedding = $embedding,
                   c.mention_count = 1,
                   c.first_seen_at = datetime(),
                   c.last_seen_at = datetime()
     ON MATCH SET  c.mention_count = coalesce(c.mention_count, 0) + 1,
                   c.last_seen_at = datetime()`,
    {
      id,
      userId: args.userId,
      name: args.name,
      normalized: args.normalizedName,
      embedding: args.embedding,
    },
  )
  return id
}

// Bump mention count on an existing (matched) Concept — no vector op.
export async function bumpConceptMention(client: Neo4jClient, args: { userId: string; conceptId: string }): Promise<void> {
  await client.run(
    `MATCH (c:Concept {id: $conceptId, user_id: $userId})
     SET c.mention_count = coalesce(c.mention_count, 0) + 1,
         c.last_seen_at = datetime()`,
    { conceptId: args.conceptId, userId: args.userId },
  )
}

// ---------------------------------------------------------------------------
// Legacy per-hop helpers — kept for backfill / chunker code paths that need
// only one of the operations.
// ---------------------------------------------------------------------------

// COVERS is valid from any of the source-node labels defined in graph-schema.md §3.
export type CoversSourceLabel = StructuralLabel | 'LectureSlide' | 'LectureSection'

export interface LinkCoversArgs {
  userId: string
  sourceLabel: CoversSourceLabel
  sourceId: string
  conceptId: string
  weight: number
  isPrimary: boolean
}

export async function linkCovers(client: Neo4jClient, args: LinkCoversArgs): Promise<void> {
  await client.run(
    `MATCH (s:${args.sourceLabel} {id: $sourceId, user_id: $userId})
     MATCH (c:Concept {id: $conceptId, user_id: $userId})
     MERGE (s)-[r:COVERS]->(c)
     SET r.weight = $weight, r.is_primary = $isPrimary`,
    {
      sourceId: args.sourceId,
      conceptId: args.conceptId,
      userId: args.userId,
      weight: args.weight,
      isPrimary: args.isPrimary,
    },
  )
}

export interface LinkAppearsInArgs {
  userId: string
  conceptId: string
  courseId: string
}

export async function linkAppearsIn(client: Neo4jClient, args: LinkAppearsInArgs): Promise<void> {
  await client.run(
    `MATCH (c:Concept {id: $conceptId, user_id: $userId})
     MATCH (course:Course {id: $courseId, user_id: $userId})
     MERGE (c)-[r:APPEARS_IN]->(course)
     ON CREATE SET r.mention_count = 1
     ON MATCH SET  r.mention_count = coalesce(r.mention_count, 0) + 1`,
    { conceptId: args.conceptId, courseId: args.courseId, userId: args.userId },
  )
}
