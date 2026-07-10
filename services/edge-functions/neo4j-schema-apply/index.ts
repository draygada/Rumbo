// neo4j-schema-apply — one-shot, idempotent apply of the Rumbo Neo4j schema.
//
// Source of truth: Graph Pipeline/graph-schema.md §6.
//
// Auth: fails closed unless x-cron-secret matches CRON_SECRET (same shape as
// canvas-ingest / brain-pipeline ticks). Meant to be invoked manually via
// `supabase functions invoke` after deploy, then again after schema changes.
//
// Behavior: runs every CREATE ... IF NOT EXISTS statement, catches per-statement
// errors, returns a report. Safe to re-run.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { neo4j } from '../_shared/neo4j.ts'

interface SchemaStep {
  name: string
  statement: string
}

// Node uniqueness constraints — one per label. Matches graph-schema.md §5 keys.
const NODE_LABELS = [
  'User',
  'Course',
  'Lecture',
  'LectureSlide',
  'LectureSection',
  'Assignment',
  'File',
  'Syllabus',
  'Concept',
  'Person',
  'CalendarEvent',
  'LearnerNote', // reserved — see Features/learner-model.md
]

const uniquenessConstraints: SchemaStep[] = NODE_LABELS.map((label) => ({
  name: `constraint_${label.toLowerCase()}_id_unique`,
  statement: `CREATE CONSTRAINT ${label.toLowerCase()}_id_unique IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
}))

// Hot-path composite indexes.
const compositeIndexes: SchemaStep[] = [
  {
    name: 'index_assignment_by_user_due',
    statement:
      'CREATE INDEX assignment_by_user_due IF NOT EXISTS FOR (a:Assignment) ON (a.user_id, a.due_at)',
  },
  {
    name: 'index_concept_by_user',
    statement: 'CREATE INDEX concept_by_user IF NOT EXISTS FOR (c:Concept) ON (c.user_id)',
  },
  {
    name: 'index_lecture_by_course',
    statement: 'CREATE INDEX lecture_by_course IF NOT EXISTS FOR (l:Lecture) ON (l.course_id)',
  },
  {
    name: 'index_course_by_user',
    statement: 'CREATE INDEX course_by_user IF NOT EXISTS FOR (c:Course) ON (c.user_id)',
  },
  {
    name: 'index_calendar_event_by_user_start',
    statement:
      'CREATE INDEX calendar_event_by_user_start IF NOT EXISTS FOR (e:CalendarEvent) ON (e.user_id, e.start_time)',
  },
  // Reserved for Phase 2 learner-model queries — the retrieval query looks up
  // LearnerNotes attached to a target node (Concept/Assignment/Course).
  {
    name: 'index_learner_note_by_user_target',
    statement:
      'CREATE INDEX learner_note_by_user_target IF NOT EXISTS FOR (n:LearnerNote) ON (n.user_id, n.target_id)',
  },
]

// Full-text index for concept name search.
const fulltextIndexes: SchemaStep[] = [
  {
    name: 'fulltext_concept_name_search',
    statement:
      "CREATE FULLTEXT INDEX concept_name_search IF NOT EXISTS FOR (c:Concept) ON EACH [c.name, c.normalized_name]",
  },
]

// Vector indexes — must match gemini-embedding-001 outputDimensionality=1536.
const vectorIndexes: SchemaStep[] = [
  {
    name: 'vector_concept_embedding',
    statement: `CREATE VECTOR INDEX concept_embedding IF NOT EXISTS
      FOR (c:Concept) ON c.embedding
      OPTIONS { indexConfig: { \`vector.dimensions\`: 1536, \`vector.similarity_function\`: 'cosine' } }`,
  },
  {
    name: 'vector_course_description_embedding',
    statement: `CREATE VECTOR INDEX course_description_embedding IF NOT EXISTS
      FOR (c:Course) ON c.description_embedding
      OPTIONS { indexConfig: { \`vector.dimensions\`: 1536, \`vector.similarity_function\`: 'cosine' } }`,
  },
]

const ALL_STEPS: SchemaStep[] = [
  ...uniquenessConstraints,
  ...compositeIndexes,
  ...fulltextIndexes,
  ...vectorIndexes,
]

async function requireCronAuth(req: Request): Promise<Response | null> {
  const cronSecret = Deno.env.get('CRON_SECRET')
  const header = req.headers.get('x-cron-secret')
  if (!cronSecret) {
    return jsonResponse({ error: 'server_misconfigured', detail: 'CRON_SECRET not set' }, 500)
  }
  if (header !== cronSecret) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  const authFail = await requireCronAuth(req)
  if (authFail) return authFail

  const client = neo4j()
  const results: Array<{ name: string; ok: boolean; error?: string }> = []

  for (const step of ALL_STEPS) {
    try {
      await client.run(step.statement)
      results.push({ name: step.name, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      results.push({ name: step.name, ok: false, error: message })
    }
  }

  // Small diagnostic — how many things are in the graph now?
  let health: Array<{ label: string; count: number }> = []
  try {
    const rows = await client.run<{ label: string; count: number }>(
      'MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC',
    )
    health = rows as Array<{ label: string; count: number }>
  } catch {
    // Empty graph or vector-index warmup; ignore.
  }

  const okCount = results.filter((r) => r.ok).length
  return jsonResponse({
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    results,
    health,
  })
})
