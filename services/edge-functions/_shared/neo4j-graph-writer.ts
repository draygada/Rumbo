// neo4j-graph-writer — MERGE helpers for the Fast-tier (Phase 6) pipeline.
//
// Node shapes & merge keys per graph-schema.md §4-§5. Vector-similarity concept
// resolution uses the `concept_embedding` index at cosine >= 0.82.

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
     WHERE node.user_id = $userId AND score >= 0.82
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
// Edges — COVERS and APPEARS_IN
// ---------------------------------------------------------------------------

export interface LinkCoversArgs {
  userId: string
  sourceLabel: StructuralLabel
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
