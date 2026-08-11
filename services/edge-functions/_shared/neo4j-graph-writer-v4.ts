// neo4j-graph-writer-v4 — v4-only writes that extend the v3 writer.
//
// Adds:
//   - createConceptWithTags     — Concept + skill/domain/bloom tags at creation
//   - linkParentConcept         — PARENT_CONCEPT edge for two-tier hierarchy
//   - linkCoversWithContext     — COVERS with definition + excerpt properties
//   - setConceptTags            — patch existing Concept with tags (idempotent)
//
// v3 functions from neo4j-graph-writer.ts remain the primary interface for
// structural nodes, mentions, and APPEARS_IN — v4 writer only handles the
// diffs.

import type { Neo4jClient } from './neo4j.ts'

export type BloomLevel =
  | 'remember'
  | 'understand'
  | 'apply'
  | 'analyze'
  | 'evaluate'
  | 'create'

export interface ConceptTags {
  skill_dimensions?: string[]     // e.g. ['quantitative', 'writing', 'analysis']
  domain_tags?: string[]          // e.g. ['stem', 'humanities', 'social-science']
  bloom_typical_level?: BloomLevel | null
}

// ---------------------------------------------------------------------------
// Concept creation with pedagogical tags (from Opus reasoning layer output).
// ---------------------------------------------------------------------------

export async function createConceptWithTags(
  client: Neo4jClient,
  args: {
    userId: string
    name: string
    normalizedName: string
    embedding: number[]
    tags: ConceptTags
  },
): Promise<string> {
  const conceptId = `concept_${crypto.randomUUID()}`
  await client.run(
    `MERGE (c:Concept { user_id: $userId, normalized_name: $normalized })
     ON CREATE SET
       c.id = $id,
       c.name = $name,
       c.embedding = $embedding,
       c.mention_count = 0,
       c.created_at = timestamp(),
       c.skill_dimensions = $skill_dimensions,
       c.domain_tags = $domain_tags,
       c.bloom_typical_level = $bloom_level
     ON MATCH SET
       c.skill_dimensions =
         CASE WHEN c.skill_dimensions IS NULL THEN $skill_dimensions ELSE c.skill_dimensions END,
       c.domain_tags =
         CASE WHEN c.domain_tags IS NULL THEN $domain_tags ELSE c.domain_tags END,
       c.bloom_typical_level =
         CASE WHEN c.bloom_typical_level IS NULL THEN $bloom_level ELSE c.bloom_typical_level END
     RETURN c.id AS id`,
    {
      userId: args.userId,
      normalized: args.normalizedName,
      id: conceptId,
      name: args.name,
      embedding: args.embedding,
      skill_dimensions: args.tags.skill_dimensions ?? [],
      domain_tags: args.tags.domain_tags ?? [],
      bloom_level: args.tags.bloom_typical_level ?? null,
    },
  )
  const rows = await client.run(
    `MATCH (c:Concept { user_id: $userId, normalized_name: $normalized })
     RETURN c.id AS id`,
    { userId: args.userId, normalized: args.normalizedName },
  )
  return (rows[0]?.id as string) ?? conceptId
}

// ---------------------------------------------------------------------------
// Patch tags on an existing Concept (idempotent — only sets fields that are
// currently null). Used when reasoning-layer tags a concept that already
// exists in the pool.
// ---------------------------------------------------------------------------

export async function setConceptTags(
  client: Neo4jClient,
  args: { userId: string; conceptId: string; tags: ConceptTags },
): Promise<void> {
  await client.run(
    `MATCH (c:Concept { user_id: $userId, id: $conceptId })
     SET c.skill_dimensions =
           CASE WHEN c.skill_dimensions IS NULL OR size(c.skill_dimensions) = 0
                THEN $skill_dimensions ELSE c.skill_dimensions END,
         c.domain_tags =
           CASE WHEN c.domain_tags IS NULL OR size(c.domain_tags) = 0
                THEN $domain_tags ELSE c.domain_tags END,
         c.bloom_typical_level =
           CASE WHEN c.bloom_typical_level IS NULL
                THEN $bloom_level ELSE c.bloom_typical_level END`,
    {
      userId: args.userId,
      conceptId: args.conceptId,
      skill_dimensions: args.tags.skill_dimensions ?? [],
      domain_tags: args.tags.domain_tags ?? [],
      bloom_level: args.tags.bloom_typical_level ?? null,
    },
  )
}

// ---------------------------------------------------------------------------
// PARENT_CONCEPT edge — tier-2 sub-concept → tier-1 primary concept.
// Reasoning-layer output: for each sub-concept, one PARENT_CONCEPT edge with
// confidence in [0, 1]. Multiple PARENT_CONCEPT edges per Concept are allowed
// (a concept can appear as a sub-concept under different primaries across
// docs); merge by (child, parent) and update confidence to max.
// ---------------------------------------------------------------------------

export async function linkParentConcept(
  client: Neo4jClient,
  args: {
    userId: string
    childConceptId: string
    parentConceptId: string
    confidence: number
  },
): Promise<void> {
  if (args.childConceptId === args.parentConceptId) return
  await client.run(
    `MATCH (child:Concept { user_id: $userId, id: $childId })
     MATCH (parent:Concept { user_id: $userId, id: $parentId })
     MERGE (child)-[r:PARENT_CONCEPT]->(parent)
     ON CREATE SET r.confidence = $confidence, r.created_at = timestamp()
     ON MATCH SET r.confidence =
       CASE WHEN r.confidence < $confidence THEN $confidence ELSE r.confidence END`,
    {
      userId: args.userId,
      childId: args.childConceptId,
      parentId: args.parentConceptId,
      confidence: args.confidence,
    },
  )
}

// ---------------------------------------------------------------------------
// COVERS with definition + excerpt — v4 tutoring modes surface these as
// context in the answer prompt (per pipeline-v4.md §6.8 Stage 8 prompt).
// Merge by (source, concept); update weight/primary if new value is stronger,
// but always overwrite definition + excerpt (latest wins).
// ---------------------------------------------------------------------------

export async function linkCoversWithContext(
  client: Neo4jClient,
  args: {
    userId: string
    sourceLabel: 'Course' | 'Lecture' | 'Assignment' | 'File' | 'Syllabus'
    sourceId: string
    conceptId: string
    weight: number
    isPrimary: boolean
    definition?: string | null
    excerpt?: string | null
  },
): Promise<void> {
  await client.run(
    `MATCH (s:${args.sourceLabel} { user_id: $userId, id: $sourceId })
     MATCH (c:Concept { user_id: $userId, id: $conceptId })
     MERGE (s)-[r:COVERS]->(c)
     ON CREATE SET r.weight = $weight, r.is_primary = $isPrimary,
                   r.definition = $definition, r.excerpt = $excerpt,
                   r.created_at = timestamp()
     ON MATCH SET r.weight = CASE WHEN r.weight < $weight THEN $weight ELSE r.weight END,
                  r.is_primary = r.is_primary OR $isPrimary,
                  r.definition = coalesce($definition, r.definition),
                  r.excerpt = coalesce($excerpt, r.excerpt)`,
    {
      userId: args.userId,
      sourceId: args.sourceId,
      conceptId: args.conceptId,
      weight: args.weight,
      isPrimary: args.isPrimary,
      definition: args.definition ?? null,
      excerpt: args.excerpt ?? null,
    },
  )
}
