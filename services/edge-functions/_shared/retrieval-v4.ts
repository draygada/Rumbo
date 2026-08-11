// retrieval-v4 — Stages 3-7 of pipeline-v4.md.
//
// Stage 3: parallel setup
//   - course resolve (from courseHint or student's course list)
//   - query embed (Cohere embed-v4, input_type='search_query')
//   - concept resolve (top-K Concepts by cosine to query embed + fuzzy name match)
//
// Stage 4: fan-out
//   - within_course: Lane A (BM25 + vector, course-scoped) || Lane B (concept walk) IN PARALLEL
//   - cross_course:  Lane B FIRST (identify course set via APPEARS_IN) →
//                    Lane A SECOND (scoped to those courses only)
//   Lane A: BM25 fulltext on Chunk/{body labels} + vector cosine → RRF-fused
//   Lane B: walk COVERS from resolved Concepts (+ PARENT_CONCEPT 1 hop each direction)
//
// Stage 5: RRF fusion across lanes (k=60 constant)
//
// Stage 6: Cohere Rerank 4 on the fused candidate list. Documents formatted as
//   `[<source_type> · <title> · <slide|section>] <chunk_text>` per §6.6.
//
// Stage 7: small-to-big truncation
//   - whole body if <5000 chars; else ±2500-char window around chunk; 5000 cap.

import type { Neo4jClient } from './neo4j.ts'
import { cohereEmbedBatch, cohereRerank, COHERE_EMBED_DIM } from './cohere.ts'

const RRF_K = 60
const LANE_A_TOP = 25
const LANE_B_TOP = 25
const RERANK_TOP_N = 12
const CANDIDATE_TOP_K = 20
const FULLTEXT_INDEXES = [
  'chunk_body_ft', 'lecture_body_ft', 'assignment_body_ft',
  'file_body_ft', 'syllabus_body_ft',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalRequest {
  userId: string
  query: string
  learningMode: 'tutoring' | 'exploration' | 'cross_course'
  courseHint: string | null
  conceptHint: string | null
  /**
   * Explicit course scope for this turn, chosen by the student:
   *   '<course_id>' — answer only from that course
   *   'all'         — search every course
   *   undefined     — no explicit choice; fall back to DEMO_COURSE_ID if set
   *                   (used by the eval harness), else search everything.
   */
  courseScope?: string | null
}

export interface RetrievedSource {
  source_id: string
  source_type: string
  source_label: string       // Neo4j label: Lecture / Assignment / File / Syllabus / Chunk
  parent_id?: string | null  // for chunks — the parent doc
  title: string
  course_code: string | null
  course_name: string | null
  slide_or_section: string | null
  chunk_text: string          // the local chunk / passage
  body_text: string           // ready-to-use passage after small-to-big
  covers_definition?: string | null
  covers_excerpt?: string | null
  rrf_score: number
  rerank_score: number | null
}

export interface RetrievalResult {
  sources: RetrievedSource[]
  resolvedConcepts: Array<{ id: string; name: string }>
  resolvedCourseCodes: string[]
  clarifyingQuestion: string | null   // set when we should ask instead of answer
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

export async function retrieveV4(
  g: Neo4jClient,
  req: RetrievalRequest,
): Promise<RetrievalResult> {
  // Course scope. An explicit per-turn choice always wins — this is what makes
  // a chat "a chat about ONE class". DEMO_COURSE_ID remains only as a fallback
  // for callers that don't pass a scope (the eval harness); it must never
  // silently pin the product, which is what it did when it was the only
  // mechanism: every question, including "what's due this week?", came back
  // scoped to the demo course.
  //
  // Resolved BEFORE the fan-out below, because knowing the course up front is
  // what lets us skip work rather than redo it.
  const explicitScope = req.courseScope
  const scopedCourse =
    explicitScope === 'all'
      ? null
      : explicitScope
        ? explicitScope
        : (Deno.env.get('DEMO_COURSE_ID') || null)

  // Stage 3: parallel setup
  // Resolve course_hint UP FRONT to internal Course.id values. The router
  // hands us a human-shaped hint ("EDUC 475"); actual course.id is
  // `canvas_course_XXX` and course.code is `W26-EDUC-475-01`. Lane A/B then
  // filter by exact node.course_id IN $ids (no fragile CONTAINS).
  //
  // When the caller already knows the course — a chat started in a class space
  // sends its course_id — that resolution is a round-trip whose answer we
  // already have, and `pinnedCourseIds` below would discard it anyway. Skip it:
  // it's an apoc regex scan across every Course node for this user.
  const [queryEmbed, resolvedConcepts, courseIds] = await Promise.all([
    embedQuery(req.query),
    resolveConcepts(g, req),
    scopedCourse
      ? Promise.resolve([scopedCourse])
      : resolveCourseHint(g, req.userId, req.courseHint),
  ])

  const pinnedCourseIds = scopedCourse ? [scopedCourse] : courseIds
  const pinnedCrossCourse = req.learningMode === 'cross_course' && !scopedCourse

  // Empty-retrieval fallback. Previously this short-circuited whenever concept
  // resolution returned 0 — but Lane A (BM25 + vector) does NOT need concepts,
  // so factual questions with no concept in them ("who teaches this course and
  // when does it meet?") were answered with a clarifying question even though
  // the syllabus was sitting right there. Only cross_course genuinely requires
  // a concept up front, because Lane B is what discovers the course set.
  // For tutoring/exploration we now fan out first and clarify only if the
  // fused result really is empty (see after Stage 6).
  if (resolvedConcepts.length === 0 && req.learningMode === 'cross_course') {
    return {
      sources: [], resolvedConcepts: [], resolvedCourseCodes: [],
      clarifyingQuestion: `To trace this across your classes, I need a specific concept — like "linear regression" or "market segmentation". Which concept did you have in mind?`,
    }
  }

  // Stage 4: sequenced or parallel fan-out
  let laneA: FanOutHit[] = []
  let laneB: FanOutHit[] = []
  let resolvedCourseCodes: string[] = []

  if (pinnedCrossCourse) {
    // Lane B first, identify course set via APPEARS_IN
    laneB = await runLaneB(g, req, resolvedConcepts, [], false)
    resolvedCourseCodes = uniq(
      laneB.map(h => h.course_code).filter((c): c is string => !!c),
    )
    // For cross_course, use codes discovered by Lane B (they're actual course
    // codes from the traversal, not hints).
    const scopeIds = await codesToIds(g, req.userId, resolvedCourseCodes)
    laneA = queryEmbed
      ? await runLaneA(g, req, queryEmbed, scopeIds, false)
      : []
  } else {
    ;[laneA, laneB] = await Promise.all([
      // Lane A used to be skipped entirely when the query embedding was
      // unavailable — but only its VECTOR half needs the embedding; BM25 does
      // not. When Cohere embed fails (quota/rate-limit), that gate silently
      // removed keyword search too, so any query without a resolvable concept
      // (i.e. no Lane B either) retrieved nothing at all. Run Lane A always.
      runLaneA(g, req, queryEmbed, pinnedCourseIds, !!scopedCourse),
      runLaneB(g, req, resolvedConcepts, pinnedCourseIds, !!scopedCourse),
    ])
    resolvedCourseCodes = pinnedCourseIds  // report internal IDs for now
  }

  // Stage 5: RRF fusion
  const fused = rrfFuse([laneA, laneB])

  // Nothing matched at all — now it's honest to ask for direction rather than
  // answer from nothing. (Moved here from before the fan-out; see above.)
  if (fused.length === 0) {
    return {
      sources: [], resolvedConcepts, resolvedCourseCodes,
      clarifyingQuestion: `I couldn't find that in your coursework. Do you have a specific concept or reading in mind?`,
    }
  }

  // Stage 6: Cohere Rerank 4 (formatted per §6.6)
  const docs = fused.map(f => formatForRerank(f))
  const reranked = await cohereRerank({
    query: req.query, documents: docs, topN: Math.min(RERANK_TOP_N, docs.length),
  })

  // Materialize top-N with rerank scores
  const topHits: FanOutHit[] = reranked.length > 0
    ? reranked.map(r => ({ ...fused[r.index], rerank_score: r.relevance_score }))
    : fused.slice(0, RERANK_TOP_N).map(f => ({ ...f, rerank_score: null }))

  // Stage 7: small-to-big truncation — hydrate body_text per source.
  // Hydrate all hits concurrently: this was the dominant latency cost (one
  // sequential Neo4j round-trip per hit × up to RERANK_TOP_N hits).
  const sources: RetrievedSource[] = await Promise.all(
    topHits.map(async (hit): Promise<RetrievedSource> => {
      const body = await hydrateBody(g, hit, req.userId)
      return {
        source_id: hit.source_id,
        source_type: hit.source_type,
        source_label: hit.source_label,
        parent_id: hit.parent_id ?? null,
        title: hit.title,
        course_code: hit.course_code,
        course_name: hit.course_name,
        slide_or_section: hit.slide_or_section,
        chunk_text: hit.chunk_text,
        body_text: body,
        covers_definition: hit.covers_definition,
        covers_excerpt: hit.covers_excerpt,
        rrf_score: hit.rrf_score,
        rerank_score: hit.rerank_score ?? null,
      }
    }),
  )

  return {
    sources,
    resolvedConcepts,
    resolvedCourseCodes,
    clarifyingQuestion: null,
  }
}

// ---------------------------------------------------------------------------
// Stage 3 helpers
// ---------------------------------------------------------------------------

async function embedQuery(query: string): Promise<number[] | null> {
  const [emb] = await cohereEmbedBatch([query], 'search_query')
  return Array.isArray(emb) && emb.length === COHERE_EMBED_DIM ? emb : null
}

// ---------------------------------------------------------------------------
// Course-hint resolution: turn a human hint ("EDUC 475", "the ML class") into
// concrete Course.id values. Normalizes whitespace/dashes and matches against
// both Course.code and Course.name. Returns [] if hint is null (no scoping).
// ---------------------------------------------------------------------------

async function resolveCourseHint(
  g: Neo4jClient,
  userId: string,
  hint: string | null,
): Promise<string[]> {
  if (!hint) return []
  // Normalize the hint: lowercase, collapse space/dash/underscore into one char
  // so "EDUC 475" and "EDUC-475" and "educ475" all present the same substring.
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, '')
  const normHint = normalize(hint)
  if (!normHint) return []
  try {
    const rows = await g.run(
      `MATCH (c:Course { user_id: $userId })
       WITH c, apoc.text.regreplace(toLower(coalesce(c.code, '')), '[\\\\s\\\\-_.]+', '') AS ncode,
                apoc.text.regreplace(toLower(coalesce(c.name, '')), '[\\\\s\\\\-_.]+', '') AS nname
       WHERE ncode CONTAINS $h OR nname CONTAINS $h
       RETURN c.id AS id LIMIT 5`,
      { userId, h: normHint },
    )
    if (rows.length > 0) return rows.map(r => r.id as string)
  } catch {
    // apoc unavailable — fall back to simpler match
  }
  // Fallback without apoc: try raw + a hyphen-inserted variant of the hint
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

// codesToIds — turn a list of Course.code values into their Course.id values.
// Used by cross_course mode after Lane B surfaces course codes.
async function codesToIds(
  g: Neo4jClient,
  userId: string,
  codes: string[],
): Promise<string[]> {
  if (codes.length === 0) return []
  const rows = await g.run(
    `MATCH (c:Course { user_id: $userId })
     WHERE c.code IN $codes
     RETURN c.id AS id`,
    { userId, codes },
  )
  return rows.map(r => r.id as string)
}

async function resolveConcepts(
  g: Neo4jClient,
  req: RetrievalRequest,
): Promise<Array<{ id: string; name: string }>> {
  // If router extracted a concept_hint, use fuzzy name match first.
  const results: Array<{ id: string; name: string }> = []
  if (req.conceptHint) {
    const nameRows = await g.run(
      `MATCH (c:Concept { user_id: $userId })
       WHERE toLower(c.name) CONTAINS toLower($hint)
          OR toLower(c.normalized_name) CONTAINS toLower($hint)
       RETURN c.id AS id, c.name AS name
       LIMIT 5`,
      { userId: req.userId, hint: req.conceptHint },
    )
    for (const r of nameRows) {
      results.push({ id: r.id as string, name: r.name as string })
    }
  }
  if (results.length > 0) return dedupById(results)

  // Otherwise: vector similarity to query embedding
  const [emb] = await cohereEmbedBatch([req.query], 'search_query')
  if (!Array.isArray(emb) || emb.length !== COHERE_EMBED_DIM) return []
  const rows = await g.run(
    `CALL db.index.vector.queryNodes('concept_embedding', $topK, $emb)
     YIELD node, score
     WHERE node.user_id = $userId AND score > 0.5
     RETURN node.id AS id, node.name AS name, score
     LIMIT 5`,
    { userId: req.userId, emb, topK: CANDIDATE_TOP_K },
  )
  for (const r of rows) results.push({ id: r.id as string, name: r.name as string })
  return dedupById(results)
}

// ---------------------------------------------------------------------------
// Stage 4: Lane A — BM25 + vector, course-scoped
// ---------------------------------------------------------------------------

interface FanOutHit {
  source_id: string
  source_type: string
  source_label: string
  parent_id?: string | null
  title: string
  course_code: string | null
  course_name: string | null
  slide_or_section: string | null
  chunk_text: string
  covers_definition?: string | null
  covers_excerpt?: string | null
  rrf_score: number
  rerank_score?: number | null
  lane_scores: { bm25?: number; vector?: number; concept?: number }
}

async function runLaneA(
  g: Neo4jClient,
  req: RetrievalRequest,
  queryEmbed: number[] | null,
  courseCodes: string[],
  strict: boolean,
): Promise<FanOutHit[]> {
  const [bm25, vec] = await Promise.all([
    laneA_BM25(g, req, courseCodes, strict),
    queryEmbed ? laneA_Vector(g, req, queryEmbed, courseCodes, strict) : Promise.resolve([]),
  ])
  const fused = rrfFuse([bm25, vec])
  return fused.slice(0, LANE_A_TOP)
}

async function laneA_BM25(
  g: Neo4jClient,
  req: RetrievalRequest,
  courseCodes: string[],
  strict: boolean,
): Promise<FanOutHit[]> {
  // strict (demo pin): a Chunk has no course_id of its own, so resolve it via
  // its parent doc; drop the NULL escape so cross-course nodes can't leak.
  // Non-strict keeps the permissive NULL escape. Strict resolves a Chunk's
  // course via its parent doc — but WITHOUT an EXISTS{} subquery: that form was
  // silently failing on this Neo4j version, and laneA_BM25 fail-softs per index
  // (catch → []), so the whole BM25 lane returned zero hits with no error
  // surfaced. Content queries masked it because Lane B still supplied sources;
  // metadata queries (no concept → no Lane B) returned nothing at all.
  const bm25Filter = courseCodes.length === 0 ? ''
    : strict
      ? 'AND coalesce(node.course_id, parentDoc.course_id) IN $codes'
      : 'AND (node.course_id IS NULL OR node.course_id IN $codes)'
  // Strict mode needs the parent bound before the WHERE that references it.
  const bm25ParentMatch = courseCodes.length > 0 && strict
    ? 'OPTIONAL MATCH (parentDoc)-[:HAS_CHUNK]->(node)'
    : ''
  // Fire all fulltext indexes concurrently rather than one Neo4j round-trip
  // at a time.
  const perIndex = await Promise.all(FULLTEXT_INDEXES.map(async (idx): Promise<FanOutHit[]> => {
    try {
      const rows = await g.run(
        `CALL db.index.fulltext.queryNodes($idx, $q) YIELD node, score
         WITH node, score
         WHERE node.user_id = $userId
         ${bm25ParentMatch}
         WITH node, score${bm25ParentMatch ? ', parentDoc' : ''}
         WHERE true ${bm25Filter}
         WITH node, score ORDER BY score DESC LIMIT 15
         OPTIONAL MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(node)
         RETURN labels(node)[0] AS label, node.id AS id,
                coalesce(
                  node.title, node.name, node.display_name,
                  c.code + ' ' + labels(node)[0],
                  c.name + ' ' + labels(node)[0],
                  labels(node)[0] + ' ' + node.id
                ) AS title,
                node.body_text AS body, node.text AS chunk_text, node.heading AS heading,
                c.code AS course_code, c.name AS course_name, score`,
        { idx, q: req.query, userId: req.userId, codes: courseCodes },
      )
      return rows.map((r): FanOutHit => {
        const label = (r.label as string) ?? 'Node'
        const isChunk = label === 'Chunk'
        return {
          source_id: (r.id as string) ?? '',
          source_type: label.toLowerCase(),
          source_label: label,
          parent_id: null,
          title: (r.title as string) ?? '(untitled)',
          course_code: (r.course_code as string) ?? null,
          course_name: (r.course_name as string) ?? null,
          slide_or_section: (r.heading as string) ?? null,
          chunk_text: (isChunk ? r.chunk_text : r.body)?.toString().slice(0, 2500) ?? '',
          rrf_score: 0,
          lane_scores: { bm25: Number(r.score ?? 0) },
        }
      })
    } catch (err) {
      console.warn(`[retrieval-v4] BM25 ${idx} failed:`, err)
      return []
    }
  }))
  return perIndex.flat()
}

async function laneA_Vector(
  g: Neo4jClient,
  req: RetrievalRequest,
  queryEmbed: number[],
  courseCodes: string[],
  strict: boolean,
): Promise<FanOutHit[]> {
  const vecFilter = courseCodes.length === 0 ? ''
    : strict
      ? 'AND parent.course_id IN $codes'
      : 'AND (parent.course_id IS NULL OR parent.course_id IN $codes)'
  const hits: FanOutHit[] = []
  try {
    // Chunk-level vector search
    const rows = await g.run(
      `CALL db.index.vector.queryNodes('chunk_embedding', $topK, $emb)
       YIELD node, score
       WHERE node.user_id = $userId AND score > 0.4
       WITH node, score
       MATCH (parent)-[:HAS_CHUNK]->(node)
       WHERE parent.user_id = $userId
         ${vecFilter}
       OPTIONAL MATCH (c:Course { user_id: $userId })-[:CONTAINS]->(parent)
       RETURN labels(parent)[0] AS label, parent.id AS parent_id,
              node.id AS chunk_id, node.text AS chunk_text, node.heading AS heading,
              // Title fallback chain — some labels (Syllabus, some Files) don't
              // populate all name fields, so we synthesize a title using the
              // course name + label when nothing else works.
              coalesce(
                parent.title,
                parent.name,
                parent.display_name,
                c.code + ' ' + labels(parent)[0],
                c.name + ' ' + labels(parent)[0],
                labels(parent)[0] + ' ' + parent.id
              ) AS title,
              c.code AS course_code, c.name AS course_name, score`,
      { userId: req.userId, emb: queryEmbed, topK: LANE_A_TOP, codes: courseCodes },
    )
    for (const r of rows) {
      hits.push({
        source_id: (r.chunk_id as string) ?? '',
        source_type: 'chunk',
        source_label: 'Chunk',
        parent_id: (r.parent_id as string) ?? null,
        title: (r.title as string) ?? '(untitled)',
        course_code: (r.course_code as string) ?? null,
        course_name: (r.course_name as string) ?? null,
        slide_or_section: (r.heading as string) ?? null,
        chunk_text: (r.chunk_text as string)?.slice(0, 2500) ?? '',
        rrf_score: 0,
        lane_scores: { vector: Number(r.score ?? 0) },
      })
    }
  } catch (err) {
    console.warn('[retrieval-v4] vector fan-out failed:', err)
  }
  return hits
}

// ---------------------------------------------------------------------------
// Stage 4: Lane B — concept-first walk of COVERS (+ PARENT_CONCEPT 1 hop each direction)
// ---------------------------------------------------------------------------

async function runLaneB(
  g: Neo4jClient,
  req: RetrievalRequest,
  resolvedConcepts: Array<{ id: string; name: string }>,
  courseCodes: string[],
  strict: boolean,
): Promise<FanOutHit[]> {
  if (resolvedConcepts.length === 0) return []
  const conceptIds = resolvedConcepts.map(c => c.id)
  const srcFilter = courseCodes.length === 0 ? ''
    : strict
      ? 'AND (source.course_id IN $codes OR source.id IN $codes)'
      : 'AND (source.course_id IS NULL OR source.course_id IN $codes)'
  try {
    const rows = await g.run(
      `MATCH (concept:Concept { user_id: $userId })
       WHERE concept.id IN $ids
       // 1-hop PARENT_CONCEPT both directions to broaden
       OPTIONAL MATCH (concept)-[:PARENT_CONCEPT]-(related:Concept { user_id: $userId })
       WITH collect(DISTINCT concept) + collect(DISTINCT related) AS all_concepts
       UNWIND all_concepts AS c
       MATCH (source)-[cov:COVERS]->(c)
       WHERE source.user_id = $userId
         ${srcFilter}
       OPTIONAL MATCH (course:Course { user_id: $userId })-[:CONTAINS]->(source)
       WITH source, cov, course, c
       ORDER BY cov.weight DESC LIMIT $topK
       RETURN labels(source)[0] AS label, source.id AS id,
              coalesce(
                source.title, source.name, source.display_name,
                course.code + ' ' + labels(source)[0],
                course.name + ' ' + labels(source)[0],
                labels(source)[0] + ' ' + source.id
              ) AS title,
              source.body_text AS body,
              course.code AS course_code, course.name AS course_name,
              cov.weight AS weight, cov.is_primary AS is_primary,
              cov.definition AS definition, cov.excerpt AS excerpt`,
      { userId: req.userId, ids: conceptIds, codes: courseCodes, topK: LANE_B_TOP },
    )
    return rows.map(r => ({
      source_id: (r.id as string) ?? '',
      source_type: ((r.label as string) ?? 'node').toLowerCase(),
      source_label: (r.label as string) ?? 'Node',
      parent_id: null,
      title: (r.title as string) ?? '(untitled)',
      course_code: (r.course_code as string) ?? null,
      course_name: (r.course_name as string) ?? null,
      slide_or_section: null,
      chunk_text: ((r.excerpt as string) ?? (r.body as string) ?? '').slice(0, 2500),
      covers_definition: (r.definition as string) ?? null,
      covers_excerpt: (r.excerpt as string) ?? null,
      rrf_score: 0,
      lane_scores: { concept: Number(r.weight ?? 0) },
    }))
  } catch (err) {
    console.warn('[retrieval-v4] Lane B failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Stage 5: RRF fusion (k=60)
// ---------------------------------------------------------------------------

function rrfFuse(lanes: FanOutHit[][]): FanOutHit[] {
  const bucket = new Map<string, FanOutHit>()
  for (const lane of lanes) {
    for (let rank = 0; rank < lane.length; rank++) {
      const hit = lane[rank]
      const score = 1 / (RRF_K + rank + 1)
      const key = hit.parent_id
        ? `${hit.source_label}:${hit.parent_id}:${hit.source_id}`
        : `${hit.source_label}:${hit.source_id}`
      const existing = bucket.get(key)
      if (existing) {
        existing.rrf_score += score
        // merge lane scores + carry richer chunk text if longer
        for (const k of Object.keys(hit.lane_scores) as Array<keyof FanOutHit['lane_scores']>) {
          const v = hit.lane_scores[k]
          if (typeof v === 'number' && (existing.lane_scores[k] ?? 0) < v) {
            existing.lane_scores[k] = v
          }
        }
        if (hit.chunk_text.length > existing.chunk_text.length) {
          existing.chunk_text = hit.chunk_text
        }
        if (!existing.covers_definition && hit.covers_definition) {
          existing.covers_definition = hit.covers_definition
        }
      } else {
        bucket.set(key, { ...hit, rrf_score: score })
      }
    }
  }
  return Array.from(bucket.values()).sort((a, b) => b.rrf_score - a.rrf_score)
}

// ---------------------------------------------------------------------------
// Stage 6: Rerank formatting — `[<source_type> · <title> · <slide/section>] <chunk_text>`
// ---------------------------------------------------------------------------

function formatForRerank(hit: FanOutHit): string {
  const parts = [hit.source_type, hit.title]
  if (hit.slide_or_section) parts.push(hit.slide_or_section)
  const prefix = `[${parts.join(' · ')}]`
  return `${prefix} ${hit.chunk_text}`.slice(0, 3000)
}

// ---------------------------------------------------------------------------
// Stage 7: small-to-big truncation
// ---------------------------------------------------------------------------

const WHOLE_BODY_THRESHOLD = 5000
const WINDOW_HALF = 2500
const BODY_CAP = 5000

async function hydrateBody(
  g: Neo4jClient,
  hit: FanOutHit,
  userId: string,
): Promise<string> {
  // For chunks: load parent body, window ±WINDOW_HALF around the chunk text.
  if (hit.source_label === 'Chunk' && hit.parent_id) {
    try {
      const rows = await g.run(
        `MATCH (n) WHERE n.user_id = $userId AND n.id = $id
         RETURN n.body_text AS body`,
        { userId, id: hit.parent_id },
      )
      const body = (rows[0]?.body as string) ?? hit.chunk_text
      if (body.length < WHOLE_BODY_THRESHOLD) return body
      const pos = body.indexOf(hit.chunk_text.slice(0, 200))
      if (pos < 0) return body.slice(0, BODY_CAP)
      const start = Math.max(0, pos - WINDOW_HALF)
      const end = Math.min(body.length, pos + WINDOW_HALF)
      return body.slice(start, end)
    } catch (err) {
      console.warn('[retrieval-v4] hydrate chunk body failed:', err)
      return hit.chunk_text.slice(0, BODY_CAP)
    }
  }

  // For non-chunks (Lecture/Assignment/File/Syllabus): the Cypher hit gave us
  // chunk_text = body.slice(0, 2500). Load the WHOLE body_text so Sonnet gets
  // real substance. Cap at BODY_CAP so a huge lecture doesn't blow the prompt.
  try {
    const rows = await g.run(
      `MATCH (n) WHERE n.user_id = $userId AND n.id = $id
       RETURN n.body_text AS body`,
      { userId, id: hit.source_id },
    )
    const body = (rows[0]?.body as string) ?? hit.chunk_text
    return body.slice(0, BODY_CAP)
  } catch (err) {
    console.warn('[retrieval-v4] hydrate doc body failed:', err)
    return hit.chunk_text.slice(0, BODY_CAP)
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs))
}

function dedupById<T extends { id: string }>(xs: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of xs) {
    if (!seen.has(x.id)) { seen.add(x.id); out.push(x) }
  }
  return out
}
