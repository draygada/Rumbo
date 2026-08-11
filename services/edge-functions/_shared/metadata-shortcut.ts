// metadata-shortcut — 10 Cypher templates for pure-lookup intents.
//
// When the router picks learning_mode='lookup', a template is selected and
// we execute one canned Cypher query against the student's graph, skipping
// Stages 3-7 (retrieval fan-out, RRF, rerank, small-to-big). Answer prompt
// then just formats the result. ~1.2s TTFT target vs ~2s for full retrieval.
//
// Each template returns a MetadataResult with a stable shape the answer
// stage can format without further lookups.

import type { Neo4jClient } from './neo4j.ts'
import type { ShortcutTemplate } from './router-v4.ts'

export interface MetadataRow {
  kind: 'assignment' | 'lecture' | 'file' | 'course' | 'note'
  title: string
  course_code?: string | null
  course_name?: string | null
  due_at?: string | null
  url?: string | null
  detail?: string | null
}

export interface MetadataResult {
  template: ShortcutTemplate
  rows: MetadataRow[]
  empty: boolean
}

// ---------------------------------------------------------------------------

export async function runShortcut(
  g: Neo4jClient,
  args: {
    userId: string
    template: ShortcutTemplate
    courseHint: string | null
    conceptHint: string | null
  },
): Promise<MetadataResult> {
  if (!args.template) return { template: null, rows: [], empty: true }

  const runner = TEMPLATES[args.template]
  if (!runner) return { template: args.template, rows: [], empty: true }

  // Resolve human course hint ("EDUC 475") → internal Course.id values ONCE
  // upfront. Templates then filter by exact-match IN $courseIds instead of the
  // broken CONTAINS-against-mismatched-fields pattern.
  const courseIds = await resolveCourseHint(g, args.userId, args.courseHint)

  const rows = await runner(g, {
    userId: args.userId,
    courseHint: args.courseHint,
    courseIds,
    conceptHint: args.conceptHint,
  })
  return { template: args.template, rows, empty: rows.length === 0 }
}

// Resolve a human-shaped hint against Course.code + Course.name (both
// normalized to strip whitespace/dashes/underscores). Empty result when hint
// is null OR resolves to nothing — caller decides how to treat that.
async function resolveCourseHint(
  g: Neo4jClient,
  userId: string,
  hint: string | null,
): Promise<string[]> {
  if (!hint) return []
  const variants = [hint, hint.replace(/\s+/g, '-'), hint.replace(/\s+/g, '')]
  const rows = await g.run(
    `MATCH (c:Course { user_id: $userId })
     WHERE ANY(v IN $variants WHERE toLower(coalesce(c.code, '')) CONTAINS toLower(v))
        OR ANY(v IN $variants WHERE toLower(coalesce(c.name, '')) CONTAINS toLower(v))
     RETURN c.id AS id LIMIT 5`,
    { userId, variants },
  )
  return rows.map(r => r.id as string)
}

// ---------------------------------------------------------------------------

interface TemplateArgs {
  userId: string
  courseHint: string | null
  courseIds: string[]         // resolved from courseHint upfront (may be [])
  conceptHint: string | null
}

// hasCourseScope — templates use this to decide whether to apply an ID filter.
// If the user gave a hint but nothing resolved, treat as "no matches" so we
// don't accidentally return unscoped results.
function hasCourseScope(a: TemplateArgs): boolean {
  return !a.courseHint || a.courseIds.length > 0
}

type TemplateFn = (g: Neo4jClient, args: TemplateArgs) => Promise<MetadataRow[]>

const TEMPLATES: Record<Exclude<ShortcutTemplate, null>, TemplateFn> = {
  // 1. next_due — next assignment due for the student (or a specific course).
  next_due: async (g, args) => {
    if (!hasCourseScope(args)) return []
    const scoped = args.courseIds.length > 0
    const cypher = scoped
      ? `MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(a:Assignment)
         WHERE c.id IN $courseIds AND a.due_at IS NOT NULL AND a.due_at > toString(datetime())
         RETURN a.name AS title, c.code AS course_code, c.name AS course_name, a.due_at AS due_at
         ORDER BY a.due_at ASC LIMIT 1`
      : `MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(a:Assignment)
         WHERE a.due_at IS NOT NULL AND a.due_at > toString(datetime())
         RETURN a.name AS title, c.code AS course_code, c.name AS course_name, a.due_at AS due_at
         ORDER BY a.due_at ASC LIMIT 3`
    const rows = await g.run(cypher, { userId: args.userId, courseIds: args.courseIds })
    return rows.map(r => ({
      kind: 'assignment' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      course_name: (r.course_name as string) ?? null,
      due_at: (r.due_at as string) ?? null,
    }))
  },

  // 2. due_range — everything due in the next 14 days.
  due_range: async (g, args) => {
    if (!hasCourseScope(args)) return []
    const cypher = `
      MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(a:Assignment)
      WHERE a.due_at IS NOT NULL
        AND a.due_at > toString(datetime())
        AND a.due_at < toString(datetime() + duration('P14D'))
        ${args.courseIds.length > 0 ? 'AND c.id IN $courseIds' : ''}
      RETURN a.name AS title, c.code AS course_code, c.name AS course_name, a.due_at AS due_at
      ORDER BY a.due_at ASC LIMIT 20`
    const rows = await g.run(cypher, { userId: args.userId, courseIds: args.courseIds })
    return rows.map(r => ({
      kind: 'assignment' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      course_name: (r.course_name as string) ?? null,
      due_at: (r.due_at as string) ?? null,
    }))
  },

  // 3. list_assignments — all assignments for a specific course.
  list_assignments: async (g, args) => {
    if (args.courseIds.length === 0) return []
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(a:Assignment)
       WHERE c.id IN $courseIds
       RETURN a.name AS title, c.code AS course_code, c.name AS course_name, a.due_at AS due_at
       ORDER BY coalesce(a.due_at, 'zzz') ASC LIMIT 50`,
      { userId: args.userId, courseIds: args.courseIds },
    )
    return rows.map(r => ({
      kind: 'assignment' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      course_name: (r.course_name as string) ?? null,
      due_at: (r.due_at as string) ?? null,
    }))
  },

  // 4. list_lectures — all lectures for a specific course.
  list_lectures: async (g, args) => {
    if (args.courseIds.length === 0) return []
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(l:Lecture)
       WHERE c.id IN $courseIds
       RETURN l.title AS title, c.code AS course_code, c.name AS course_name, l.url AS url, l.position AS position
       ORDER BY coalesce(l.position, 0) ASC LIMIT 50`,
      { userId: args.userId, courseIds: args.courseIds },
    )
    return rows.map(r => ({
      kind: 'lecture' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      course_name: (r.course_name as string) ?? null,
      url: (r.url as string) ?? null,
    }))
  },

  // 5. list_courses — all courses the student is currently taking.
  list_courses: async (g, args) => {
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })
       RETURN c.code AS course_code, c.name AS title
       ORDER BY c.code ASC LIMIT 30`,
      { userId: args.userId },
    )
    return rows.map(r => ({
      kind: 'course' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
    }))
  },

  // 6. course_status — count of assignments, next-due summary.
  course_status: async (g, args) => {
    if (args.courseIds.length === 0) return []
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })
       WHERE c.id IN $courseIds
       OPTIONAL MATCH (c)-[:CONTAINS]->(a:Assignment)
       WITH c, count(a) AS assign_count,
            min(CASE WHEN a.due_at > toString(datetime()) THEN a.due_at END) AS next_due
       RETURN c.code AS course_code, c.name AS title,
              assign_count AS assign_count, next_due AS next_due`,
      { userId: args.userId, courseIds: args.courseIds },
    )
    return rows.map(r => ({
      kind: 'course' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      detail: `${r.assign_count ?? 0} assignments · next due ${r.next_due ?? '—'}`,
    }))
  },

  // 7. find_source — find the source (Lecture / File / etc.) covering a concept.
  find_source: async (g, args) => {
    if (!args.conceptHint) return []
    if (!hasCourseScope(args)) return []
    const rows = await g.run(
      `MATCH (n)-[cov:COVERS]->(concept:Concept { user_id: $userId })
       WHERE toLower(concept.name) CONTAINS toLower($concept)
         AND n.user_id = $userId
         ${args.courseIds.length > 0 ? 'AND n.course_id IN $courseIds' : ''}
       WITH n, cov ORDER BY cov.weight DESC LIMIT 10
       RETURN labels(n)[0] AS kind, coalesce(n.title, n.name, n.display_name, n.id) AS title,
              n.course_id AS course_code, n.url AS url, cov.excerpt AS detail`,
      { userId: args.userId, concept: args.conceptHint, courseIds: args.courseIds },
    )
    return rows.map(r => ({
      kind: ((r.kind as string)?.toLowerCase() as MetadataRow['kind']) ?? 'note',
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      url: (r.url as string) ?? null,
      detail: (r.detail as string) ?? null,
    }))
  },

  // 8. concept_home — which course(s) teach this concept.
  concept_home: async (g, args) => {
    if (!args.conceptHint) return []
    const rows = await g.run(
      `MATCH (concept:Concept { user_id: $userId })-[:APPEARS_IN]->(c:Course)
       WHERE toLower(concept.name) CONTAINS toLower($concept)
       RETURN c.code AS course_code, c.name AS title, concept.name AS detail
       LIMIT 10`,
      { userId: args.userId, concept: args.conceptHint },
    )
    return rows.map(r => ({
      kind: 'course' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      detail: (r.detail as string) ?? null,
    }))
  },

  // 9. grading_policy — pull from syllabus body.
  grading_policy: async (g, args) => {
    if (args.courseIds.length === 0) return []
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(s:Syllabus)
       WHERE c.id IN $courseIds
       RETURN c.code AS course_code, c.name AS title, s.body_text AS detail
       LIMIT 1`,
      { userId: args.userId, courseIds: args.courseIds },
    )
    return rows.map(r => ({
      kind: 'course' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      detail: (r.detail as string) ?? null,
    }))
  },

  // 10. week_summary — assignments + lectures for the next 7 days.
  week_summary: async (g, args) => {
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(a:Assignment)
       WHERE a.due_at IS NOT NULL
         AND a.due_at > toString(datetime())
         AND a.due_at < toString(datetime() + duration('P7D'))
       RETURN a.name AS title, c.code AS course_code, c.name AS course_name, a.due_at AS due_at
       ORDER BY a.due_at ASC LIMIT 20`,
      { userId: args.userId },
    )
    return rows.map(r => ({
      kind: 'assignment' as const,
      title: (r.title as string) ?? '',
      course_code: (r.course_code as string) ?? null,
      course_name: (r.course_name as string) ?? null,
      due_at: (r.due_at as string) ?? null,
    }))
  },
}
