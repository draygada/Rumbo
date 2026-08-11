// Neo4j schema deltas for pipeline-v4. Wire into neo4j-schema-apply/index.ts
// to run alongside the v3 schema Cypher; all statements are idempotent
// (CREATE ... IF NOT EXISTS).
//
// What v4 adds on top of v3:
//   - BM25 fulltext indexes on chunk / doc-body / concept name+aliases.
//     Enables Lane A (BM25 + vector hybrid) in the retrieval fan-out.
//   - PARENT_CONCEPT edge type — two-tier concept hierarchy (tier-1 primary
//     concept → tier-2 sub-concept) written by the reasoning layer.
//   - Property indexes for concept tags (skill_dimensions, domain_tags,
//     bloom_typical_level) so learner-brain aggregation queries stay fast.
//
// References:
//   Graph Pipeline/pipeline-v4.md §5.6 (concept + edge writes), §6.4 (Lane A
//   BM25 fan-out), §6.6 (rerank input format).

export const NEO4J_V4_CYPHER: readonly string[] = [
  // ---------------------------------------------------------------------------
  // Fulltext indexes for Lane A (BM25 hybrid).
  //
  // One index per label so scoring stays label-local. Chunks and doc-body labels
  // index text; Concept indexes name + aliases so proper-noun queries hit even
  // when the concept name isn't the exact query term.
  // ---------------------------------------------------------------------------
  `CREATE FULLTEXT INDEX chunk_body_ft IF NOT EXISTS
     FOR (c:Chunk) ON EACH [c.text]`,

  `CREATE FULLTEXT INDEX lecture_body_ft IF NOT EXISTS
     FOR (n:Lecture) ON EACH [n.body_text, n.title]`,

  `CREATE FULLTEXT INDEX assignment_body_ft IF NOT EXISTS
     FOR (n:Assignment) ON EACH [n.body_text, n.name, n.canonical_name]`,

  `CREATE FULLTEXT INDEX file_body_ft IF NOT EXISTS
     FOR (n:File) ON EACH [n.body_text, n.display_name]`,

  `CREATE FULLTEXT INDEX syllabus_body_ft IF NOT EXISTS
     FOR (n:Syllabus) ON EACH [n.body_text]`,

  `CREATE FULLTEXT INDEX concept_name_ft IF NOT EXISTS
     FOR (n:Concept) ON EACH [n.name, n.normalized_name, n.aliases]`,

  // ---------------------------------------------------------------------------
  // Property indexes for concept-tag reads (learner-brain aggregation, filters
  // in Lane B walk).
  // ---------------------------------------------------------------------------
  `CREATE INDEX concept_bloom_idx IF NOT EXISTS
     FOR (c:Concept) ON (c.bloom_typical_level)`,

  // Note: skill_dimensions and domain_tags are stored as string arrays.
  // Neo4j property indexes on arrays match any element — sufficient for
  // "concepts tagged with `quantitative`" filters.
  `CREATE INDEX concept_skill_dims_idx IF NOT EXISTS
     FOR (c:Concept) ON (c.skill_dimensions)`,

  `CREATE INDEX concept_domain_tags_idx IF NOT EXISTS
     FOR (c:Concept) ON (c.domain_tags)`,

  // ---------------------------------------------------------------------------
  // Two-tier hierarchy — PARENT_CONCEPT relationships have no schema constraint
  // (Neo4j is schemaless), but we index a marker property on the edge for fast
  // "get all sub-concepts of this tier-1" queries. Written by the reasoning
  // layer during extraction.
  // ---------------------------------------------------------------------------
  `CREATE INDEX parent_concept_confidence_idx IF NOT EXISTS
     FOR ()-[r:PARENT_CONCEPT]-() ON (r.confidence)`,
]
