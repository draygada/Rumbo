import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import styles from './Brain.module.css'

// Brain — a graph where every node is a concrete thing (a task, a file, a
// syllabus, a course). Concepts extracted from each record become tags on
// the node, and edges form between nodes that share concepts. No standalone
// concept nodes.
//
// Runs off normalized_events + entity_candidates directly, not graph_nodes.
// The pipeline's concept-node output still exists in the DB but isn't
// visualized here.

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type NodeType = 'assignment' | 'file' | 'syllabus' | 'course' | 'event' | 'lecture' | 'home' | 'page' | 'announcement'

interface BrainNode {
  id: string                       // bundle key
  name: string
  type: NodeType
  courseId: string | null
  courseLabel: string | null
  concepts: string[]
  tokens: Set<string>              // union of meaningful words across concepts
  recordCount: number
  timestamps: string[]
  sourceAuthorityAvg: number
}

interface BrainEdge {
  source: string
  target: string
  sharedConcepts: string[]
  isCrossClass: boolean   // true when source and target belong to different courses
}

interface Positioned extends BrainNode {
  x: number
  y: number
  vx: number
  vy: number
  fixed: boolean
  r: number
  color: string
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TYPE_COLOR: Record<NodeType, string> = {
  assignment:   '#b18db1',   // plum
  file:         '#c9a34e',   // gold
  syllabus:     '#7fb7bd',   // teal
  course:       '#7791c2',   // blue (hubs)
  event:        '#c88a6a',   // burnt
  lecture:      '#6ba76b',   // green
  home:         '#c66d90',   // rose
  page:         '#98b16b',   // olive
  announcement: '#d68a3f',   // amber
}

const TYPE_LABEL: Record<NodeType, string> = {
  assignment:   'Assignment',
  file:         'File',
  syllabus:     'Syllabus',
  course:       'Course',
  event:        'Event',
  lecture:      'Lecture',
  home:         'Home Page',
  page:         'Page',
  announcement: 'Announcement',
}

// Source authority for tier-styling. Mirrors brain-extraction-v2.ts
// SOURCE_AUTHORITY exactly.
const SOURCE_AUTHORITY: Record<string, number> = {
  canvas_course:             0.90,
  manual_course:             0.90,
  canvas_syllabus:           1.00,
  manual_syllabus:           1.00,
  canvas_file_syllabus:      1.00,
  canvas_file_rubric:        0.85,
  canvas_file_project:       0.90,
  canvas_file_study:         0.80,
  canvas_file_reading:       0.85,
  canvas_file_document:      0.75,
  canvas_assignment:         0.75,
  manual_assignment:         0.75,
  canvas_assignment_rubric:  0.90,
  canvas_lecture:            0.80,
  canvas_home:               0.95,
  canvas_announcement:       0.75,
  canvas_page:               0.80,
  google_calendar:           0.70,
}

const FILTER_TYPES: NodeType[] = ['assignment', 'file', 'syllabus', 'course', 'event', 'lecture', 'home', 'page', 'announcement']

// Force simulation constants — tuned for ~50-400 nodes with dense edge sets.
// Center pull is strong so hundreds of nodes stay on-screen; repulsion cuts
// off at distance so far-apart clusters stop pushing each other into infinity.
// Warm-start is 0 to avoid the "1000 iterations then explode" divergence that
// happens when initial forces overshoot.
const REPULSION = 3400
const SPRING = 0.018
const SPRING_LENGTH = 180             // longer edges = more breathing room
const DAMPING = 0.88
const CENTER = 0.002                  // very weak — course-cohesion + repulsion do the work
const MIN_DIST_SQ = 0.5
const REPULSION_MAX_DIST_SQ = 250000  // ~500px reach
const MAX_VELOCITY = 10
const INITIAL_WARM_STEPS = 0          // let the raf loop settle live from spiral
// Nodes without a courseId get pushed OUT to a periphery ring rather than
// piling up at origin where CENTER pulls everything. Otherwise they form
// an oscillating central blob that never settles.
const ORPHAN_RING_RADIUS = 700
const ORPHAN_RING_PULL = 0.008

// Minimum center-to-center separation between any two nodes (independent of
// physics). Enforced as a positional resolve after each step — even if a spring
// wants to pull two nodes on top of each other, we push them back to this gap.
const MIN_NODE_SEPARATION = 22
const MIN_NODE_SEPARATION_SQ = MIN_NODE_SEPARATION * MIN_NODE_SEPARATION
// Course cohesion pulls same-course nodes together, but too strong and it
// swamps cross-class concept bridges. 0.005 keeps clusters visible without
// squeezing every node onto its centroid.
const COURSE_COHESION = 0.02   // was 0.005 — tighter clusters, more inter-cluster space
// Cross-class concept bridges get a bigger spring so they visibly draw the
// two clusters together instead of being dragged back into their own courses.
const CROSS_CLASS_SPRING_BOOST = 2.2
// A token appearing in > this fraction of nodes is generic and won't carry
// signal ("assignment", "reading", "week"). Ignored entirely.
const GENERIC_CONCEPT_MAX_FREQ = 0.20   // tighter — was 0.35, too permissive at 400 nodes

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

// Lightweight concept normalization so that "Linear Regression",
// "linear regressions", and "Linear-Regression" all collapse to the same key.
// This is what turns near-duplicate LLM-extracted concepts into real edges.
const CONCEPT_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'to', 'for', 'with', 'on',
  'is', 'are', 'was', 'were', 'be', 'been', 'as', 'by', 'at', 'from',
  'this', 'that', 'these', 'those', 'about', 'into', 'over',
])

// Tokenize a concept name into meaningful words (lowercased, stopwords removed,
// short/plural stripped). Two concepts count as related if their token sets
// share ≥ SHARED_TOKEN_MIN tokens — much looser than requiring identical
// concept strings, which lets "gradient descent" and "gradient descent
// optimization" from different courses actually connect.
function conceptTokens(raw: string): Set<string> {
  const words = raw
    .toLowerCase()
    .replace(/[-_.,;:/]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !CONCEPT_STOPWORDS.has(w))
    .map(w => {
      if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
      if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
      return w
    })
  return new Set(words)
}
// Was 1 — created 7000+ edges on a 400-node graph (hairball). Bumped so an
// edge requires substantive semantic overlap, not one incidental shared word.
const SHARED_TOKEN_MIN = 2
// Cap edges per node to the top-N strongest to prevent hub nodes (courses with
// dozens of assignments) from creating a solid wall of pink lines.
const MAX_EDGES_PER_NODE = 10

function mapSourceTypeToNodeType(sourceType: string): NodeType | null {
  if (sourceType === 'canvas_assignment' || sourceType === 'manual_assignment') return 'assignment'
  if (sourceType === 'canvas_assignment_rubric') return 'assignment'   // rubric attaches to the assignment bundle
  if (sourceType === 'canvas_file_syllabus') return 'syllabus'
  if (sourceType.startsWith('canvas_file_')) return 'file'
  if (sourceType === 'canvas_page') return 'page'
  if (sourceType === 'canvas_syllabus' || sourceType === 'manual_syllabus') return 'syllabus'
  if (sourceType === 'canvas_course' || sourceType === 'manual_course') return 'course'
  if (sourceType === 'canvas_lecture') return 'lecture'
  if (sourceType === 'canvas_home') return 'home'
  if (sourceType === 'canvas_announcement') return 'announcement'
  if (sourceType === 'google_calendar') return 'event'
  return null
}

// Strip week/session/day/HW/quiz/module/etc. labels and bare numbers from an
// assignment name so "Show Up 1" and "Show Up 8" collapse to the same template
// ("show up"), and "Homework 3" and "Homework 4" collapse to "homework".
// Applied AFTER any ingest-side canonicalization so it works on legacy records
// too.
function nameTemplate(rawName: string): string {
  let name = rawName.toLowerCase()
  // Prefix/inline labels with a trailing number (Week 3, W3, Session 2, HW 1,
  // Assignment 04, Quiz #7, etc.)
  name = name.replace(
    /\b(week|wk|w|session|day|quiz|hw|homework|assignment|module|unit|part|chapter|ch|lecture|lec|lab|discussion|response|reading|reflection)[\s\-\._#:]*\d+[a-z]?\b/g,
    '',
  )
  // Roman numeral suffixes ("Part II", "Section IV")
  name = name.replace(/\b(part|section|chapter)\s+([ivx]+)\b/g, '')
  // Standalone integers or dates (leftover after label strip)
  name = name.replace(/\b\d{1,4}([\/\-]\d{1,4}){0,2}\b/g, '')
  // Ordinals: "1st", "2nd", "3rd", "4th"
  name = name.replace(/\b\d+(st|nd|rd|th)\b/g, '')
  // Normalize separators + whitespace
  name = name.replace(/[\-\._:]+/g, ' ').replace(/\s+/g, ' ').trim()
  return name
}

// Bundle key — assignments with the same *stripped-of-numbers* name in the
// same course collapse into one node. Bundling is decided in a second pass
// (below) because we only want to bundle when there are actually multiple
// records sharing the template — a single "Show Up 1" should stay individual.
function bundleKeyFor(sourceType: string, courseId: string | null, payload: Record<string, unknown>, recordId: string): string {
  if (sourceType === 'canvas_assignment' || sourceType === 'manual_assignment') {
    const canonical = typeof payload.rumbo_canonical_name === 'string' && payload.rumbo_canonical_name
      ? payload.rumbo_canonical_name
      : typeof payload.name === 'string'
      ? payload.name
      : recordId
    const template = nameTemplate(canonical) || canonical.toLowerCase().trim()
    return `bundle::${courseId ?? 'none'}::${template}`
  }
  return `record::${recordId}`
}

function displayNameFor(sourceType: string, payload: Record<string, unknown>, normalizedText: string | null): string {
  if (sourceType === 'canvas_assignment' || sourceType === 'manual_assignment') {
    const canonical = typeof payload.rumbo_canonical_name === 'string' ? payload.rumbo_canonical_name : ''
    const orig = typeof payload.name === 'string' ? payload.name : ''
    return (canonical || orig || normalizedText?.split('\n')[0] || 'Assignment').trim()
  }
  if (sourceType === 'canvas_course' || sourceType === 'manual_course') {
    const code = typeof payload.course_code === 'string' ? payload.course_code.trim() : ''
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    return code || name || 'Course'
  }
  if (sourceType.startsWith('canvas_file_')) {
    const displayName = typeof payload.display_name === 'string' ? payload.display_name : ''
    const filename = typeof payload.filename === 'string' ? payload.filename : ''
    return (displayName || filename || 'File').trim()
  }
  if (sourceType === 'google_calendar') {
    const summary = typeof payload.summary === 'string' ? payload.summary : ''
    return summary || 'Event'
  }
  if (sourceType === 'canvas_syllabus') {
    return `Syllabus (${typeof payload.course_id === 'number' ? `course ${payload.course_id}` : 'course'})`
  }
  if (sourceType === 'manual_syllabus') return 'Syllabus'
  return normalizedText?.split('\n')[0]?.slice(0, 60) || 'Node'
}

async function fetchBrain(): Promise<{ nodes: BrainNode[]; edges: BrainEdge[] }> {
  // Concept nodes + concept→record mentions now come from Neo4j via the
  // brain-graph-read Edge Function (Phase 4 rewire). Source records still
  // live in Postgres — that's per Infrastructure/neo4j.md: normalized_events
  // is the source of truth.
  const brainReadPromise = supabase.functions.invoke<{
    concepts: Array<{ id: string; name: string; normalized_name: string; mention_count: number }>
    mentions: Array<{ concept_id: string; source_record_id: string }>
  }>('brain-graph-read', { body: {} })

  const [
    { data: records, error: recErr },
    graphRes,
    { data: canvasCourseRows },
    { data: manualCourseRows },
  ] = await Promise.all([
    supabase
      .from('normalized_events')
      .select('id, source_type, external_id, course_id, timestamp, raw_payload, normalized_text')
      .eq('classification', 'academic')
      .is('cancelled_at', null)
      .in('source_type', [
        'canvas_assignment', 'manual_assignment', 'canvas_assignment_rubric',
        'canvas_file_syllabus', 'canvas_file_rubric', 'canvas_file_project', 'canvas_file_study',
        'canvas_file_reading', 'canvas_file_document',
        'canvas_syllabus', 'manual_syllabus',
        'canvas_course', 'manual_course',
        'canvas_lecture', 'canvas_home', 'canvas_page', 'canvas_announcement',
        'google_calendar',
      ])
      .limit(3000),
    brainReadPromise,
    supabase
      .from('normalized_events')
      .select('external_id, raw_payload')
      .eq('source_type', 'canvas_course')
      .is('cancelled_at', null),
    supabase
      .from('manual_courses')
      .select('id, name, course_code')
      .is('archived_at', null),
  ])

  if (recErr) throw recErr
  if (graphRes.error) throw graphRes.error
  const resolvedNodes = graphRes.data?.concepts ?? []
  const mentions = graphRes.data?.mentions ?? []

  // course_id → short display label.
  const courseLabels = new Map<string, string>()
  for (const row of canvasCourseRows ?? []) {
    const payload = (row.raw_payload ?? {}) as Record<string, unknown>
    const code = typeof payload.course_code === 'string' ? payload.course_code.trim() : ''
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    courseLabels.set(row.external_id as string, code || name || 'Course')
  }
  for (const c of manualCourseRows ?? []) {
    const code = typeof c.course_code === 'string' ? c.course_code.trim() : ''
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    courseLabels.set(`manual_course_${c.id}`, code || name || 'Course')
  }

  // Build (concept id → display name) lookup.
  const conceptNameByNodeId = new Map<string, string>()
  for (const n of resolvedNodes) {
    conceptNameByNodeId.set(n.id, n.name)
  }

  // record_id → { concepts (display names), tokens (union of tokens from all
  //               concepts for this record) }.
  // Tokens still drive edge formation client-side. Phase 6 will populate
  // Neo4j COVERS edges with weights, at which point we can drop this fallback.
  const conceptsByRecord = new Map<string, { concepts: Set<string>; tokens: Set<string> }>()
  for (const m of mentions) {
    const conceptName = conceptNameByNodeId.get(m.concept_id)
    if (!conceptName) continue
    const key = m.source_record_id
    let bucket = conceptsByRecord.get(key)
    if (!bucket) {
      bucket = { concepts: new Set(), tokens: new Set() }
      conceptsByRecord.set(key, bucket)
    }
    bucket.concepts.add(conceptName)
    for (const t of conceptTokens(conceptName)) bucket.tokens.add(t)
  }

  // Aggregate records into nodes (bundling assignments by canonical name).
  const nodeByBundle = new Map<string, BrainNode>()
  for (const r of records ?? []) {
    const nodeType = mapSourceTypeToNodeType(r.source_type)
    if (!nodeType) continue
    const payload = (r.raw_payload ?? {}) as Record<string, unknown>
    const bundleKey = bundleKeyFor(r.source_type, r.course_id, payload, r.id)
    const displayName = displayNameFor(r.source_type, payload, r.normalized_text)
    const authority = SOURCE_AUTHORITY[r.source_type] ?? 0.60
    const recordConcepts = conceptsByRecord.get(r.id)
    const existing = nodeByBundle.get(bundleKey)
    if (existing) {
      existing.recordCount += 1
      if (r.timestamp) existing.timestamps.push(r.timestamp)
      if (recordConcepts) {
        for (const c of recordConcepts.concepts) existing.concepts.push(c)
        for (const t of recordConcepts.tokens) existing.tokens.add(t)
      }
      if (authority > existing.sourceAuthorityAvg) existing.sourceAuthorityAvg = authority
    } else {
      const courseId = nodeType === 'course' ? (r.external_id as string) : (r.course_id ?? null)
      nodeByBundle.set(bundleKey, {
        id: bundleKey,
        name: displayName,
        type: nodeType,
        courseId,
        courseLabel: courseId ? (courseLabels.get(courseId) ?? null) : null,
        concepts: recordConcepts ? Array.from(recordConcepts.concepts) : [],
        tokens: recordConcepts ? new Set(recordConcepts.tokens) : new Set(),
        recordCount: 1,
        timestamps: r.timestamp ? [r.timestamp] : [],
        sourceAuthorityAvg: authority,
      })
    }
  }

  // Dedupe concepts per node.
  const nodes: BrainNode[] = []
  for (const n of nodeByBundle.values()) {
    n.concepts = Array.from(new Set(n.concepts))
    nodes.push(n)
  }

  // Global token frequency — tokens appearing in a majority of nodes are too
  // generic ("assignment", "reading", "class") and would create noise edges.
  const tokenFreq = new Map<string, number>()
  for (const n of nodes) {
    for (const t of n.tokens) tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1)
  }
  const genericCutoff = Math.max(3, Math.ceil(nodes.length * GENERIC_CONCEPT_MAX_FREQ))
  for (const n of nodes) {
    const filtered = new Set<string>()
    for (const t of n.tokens) if ((tokenFreq.get(t) ?? 0) <= genericCutoff) filtered.add(t)
    n.tokens = filtered
  }

  // Edges — pairs of nodes sharing >=2 concepts. Course nodes also draw
  // "contains" edges to every member of their course (weak edge, always).
  const edges: BrainEdge[] = []
  const nodesByCourseId = new Map<string, BrainNode[]>()
  for (const n of nodes) {
    if (n.courseId) {
      let bucket = nodesByCourseId.get(n.courseId)
      if (!bucket) { bucket = []; nodesByCourseId.set(n.courseId, bucket) }
      bucket.push(n)
    }
  }

  // Course containment edges (weak, same-class by definition)
  for (const n of nodes) {
    if (n.type !== 'course' || !n.courseId) continue
    const members = nodesByCourseId.get(n.courseId) ?? []
    for (const m of members) {
      if (m.id === n.id) continue
      edges.push({ source: n.id, target: m.id, sharedConcepts: [], isCrossClass: false })
    }
  }

  // Shared-TOKEN edges — the pipeline's resolution didn't merge similar
  // concepts across courses, so we match on shared meaningful words instead.
  // Two-pass: (1) collect all candidate edges with a strength score; (2) keep
  // only the top-N per node so hub nodes don't create a wall of pink lines.
  interface Candidate { src: string; tgt: string; shared: string[]; isCrossClass: boolean; strength: number }
  const candidates: Candidate[] = []
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]
    if (a.tokens.size < SHARED_TOKEN_MIN) continue
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]
      if (b.tokens.size < SHARED_TOKEN_MIN) continue
      const shared: string[] = []
      for (const t of b.tokens) if (a.tokens.has(t)) shared.push(t)
      if (shared.length < SHARED_TOKEN_MIN) continue
      const isCrossClass = Boolean(a.courseId && b.courseId && a.courseId !== b.courseId)
      // Cross-class shared concepts weight more heavily (the real bridges).
      const strength = shared.length + (isCrossClass ? 1.5 : 0)
      candidates.push({ src: a.id, tgt: b.id, shared, isCrossClass, strength })
    }
  }
  // Sort strongest first, then greedily keep edges until each node hits its cap.
  candidates.sort((x, y) => y.strength - x.strength)
  const perNodeCount = new Map<string, number>()
  for (const c of candidates) {
    const srcCount = perNodeCount.get(c.src) ?? 0
    const tgtCount = perNodeCount.get(c.tgt) ?? 0
    if (srcCount >= MAX_EDGES_PER_NODE || tgtCount >= MAX_EDGES_PER_NODE) continue
    perNodeCount.set(c.src, srcCount + 1)
    perNodeCount.set(c.tgt, tgtCount + 1)
    edges.push({ source: c.src, target: c.tgt, sharedConcepts: c.shared, isCrossClass: c.isCrossClass })
  }

  // Prune orphan generic-name nodes — Course rows with no code AND no name
  // fall through to displayName="Course". If such a node also has zero edges
  // (no course-containment members, no shared-token bridges), it's noise —
  // usually an archived or bad-payload course. Drop it.
  const edgeCountById = new Map<string, number>()
  for (const e of edges) {
    edgeCountById.set(e.source, (edgeCountById.get(e.source) ?? 0) + 1)
    edgeCountById.set(e.target, (edgeCountById.get(e.target) ?? 0) + 1)
  }
  const keptIds = new Set<string>()
  for (const n of nodes) {
    const trimmed = n.name.trim()
    const isGenericCourse = n.type === 'course' && (
      !trimmed || /^(course|untitled|null|-)$/i.test(trimmed)
    )
    const isolated = (edgeCountById.get(n.id) ?? 0) === 0
    if (isGenericCourse && isolated) continue
    keptIds.add(n.id)
  }
  const prunedNodes = nodes.filter(n => keptIds.has(n.id))
  const prunedEdges = edges.filter(e => keptIds.has(e.source) && keptIds.has(e.target))
  return { nodes: prunedNodes, edges: prunedEdges }
}

// -----------------------------------------------------------------------------
// Force simulation
// -----------------------------------------------------------------------------

// Cheap string -> uint32 hash so each orphan node gets a stable angle on the
// periphery ring instead of jitter-sharing the same target.
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function stepSim(nodes: Positioned[], edges: BrainEdge[], nodeById: Map<string, Positioned>) {
  const n = nodes.length

  // Course centroids
  const centroids = new Map<string, { x: number; y: number; n: number }>()
  for (const p of nodes) {
    if (!p.courseId) continue
    let c = centroids.get(p.courseId)
    if (!c) { c = { x: 0, y: 0, n: 0 }; centroids.set(p.courseId, c) }
    c.x += p.x; c.y += p.y; c.n += 1
  }
  for (const c of centroids.values()) { c.x /= c.n; c.y /= c.n }

  for (let i = 0; i < n; i += 1) {
    const a = nodes[i]
    if (a.fixed) continue
    let fx = 0, fy = 0
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue
      const b = nodes[j]
      const dx = a.x - b.x, dy = a.y - b.y
      const distSq = dx * dx + dy * dy
      if (distSq < MIN_DIST_SQ) continue
      if (distSq > REPULSION_MAX_DIST_SQ) continue  // far-apart nodes stop pushing
      const force = REPULSION / distSq
      const dist = Math.sqrt(distSq)
      fx += (dx / dist) * force
      fy += (dy / dist) * force
    }
    if (a.courseId) {
      const c = centroids.get(a.courseId)
      if (c && c.n > 1) {
        fx += (c.x - a.x) * COURSE_COHESION
        fy += (c.y - a.y) * COURSE_COHESION
      }
      fx += -a.x * CENTER
      fy += -a.y * CENTER
    } else {
      // Orphan node — push toward a peripheral ring instead of the origin.
      // Uses each node's stable-hash id as a "seat" on the ring so orphans
      // don't all target the same point.
      const seed = hashStr(a.id)
      const targetAngle = (seed / 0xffffffff) * Math.PI * 2
      const targetX = Math.cos(targetAngle) * ORPHAN_RING_RADIUS
      const targetY = Math.sin(targetAngle) * ORPHAN_RING_RADIUS
      fx += (targetX - a.x) * ORPHAN_RING_PULL
      fy += (targetY - a.y) * ORPHAN_RING_PULL
    }
    a.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, (a.vx + fx) * DAMPING))
    a.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, (a.vy + fy) * DAMPING))
  }

  for (const e of edges) {
    const a = nodeById.get(e.source)
    const b = nodeById.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) + 0.01
    // Concept-overlap edges pull proportionally to overlap; cross-class
    // concept bridges get an extra multiplier so they actually visually
    // bridge clusters instead of getting pulled back by course cohesion.
    let mult: number
    if (e.sharedConcepts.length > 0) {
      const base = Math.min(2, 1 + e.sharedConcepts.length * 0.2)
      mult = e.isCrossClass ? base * CROSS_CLASS_SPRING_BOOST : base
    } else {
      mult = 0.4  // course containment
    }
    const strength = (dist - SPRING_LENGTH) * SPRING * mult
    const nx = dx / dist, ny = dy / dist
    if (!a.fixed) { a.vx += nx * strength; a.vy += ny * strength }
    if (!b.fixed) { b.vx -= nx * strength; b.vy -= ny * strength }
  }

  // Clamp velocities AFTER spring loop too — springs contribute unclamped
  // deltas from every incident edge, so a highly-connected node can pile up
  // hundreds of pixels of velocity and fly to infinity in one frame.
  for (const p of nodes) {
    if (p.fixed) continue
    if (!Number.isFinite(p.vx)) p.vx = 0
    if (!Number.isFinite(p.vy)) p.vy = 0
    if (p.vx > MAX_VELOCITY) p.vx = MAX_VELOCITY
    else if (p.vx < -MAX_VELOCITY) p.vx = -MAX_VELOCITY
    if (p.vy > MAX_VELOCITY) p.vy = MAX_VELOCITY
    else if (p.vy < -MAX_VELOCITY) p.vy = -MAX_VELOCITY
    p.x += p.vx
    p.y += p.vy
    // Also guard positions — clamp to reasonable bounds so a bad frame can't
    // put a node at (Infinity, Infinity) and lose it forever.
    if (!Number.isFinite(p.x)) p.x = 0
    if (!Number.isFinite(p.y)) p.y = 0
    if (p.x > 5000) p.x = 5000
    else if (p.x < -5000) p.x = -5000
    if (p.y > 5000) p.y = 5000
    else if (p.y < -5000) p.y = -5000
  }

  // Minimum-separation resolve — after positions update, any pair closer than
  // MIN_NODE_SEPARATION gets pushed apart directly. This is what actually
  // prevents nodes from stacking, regardless of what the physics decided.
  // O(n^2) but for n=400 that's 160k comparisons per frame at ~10x/sec — fine.
  for (let i = 0; i < n; i += 1) {
    const a = nodes[i]
    if (a.fixed) continue
    const aMin = a.r + MIN_NODE_SEPARATION
    for (let j = i + 1; j < n; j += 1) {
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const minGap = aMin + b.r
      const minGapSq = minGap * minGap
      const distSq = dx * dx + dy * dy
      if (distSq >= minGapSq) continue
      if (distSq < 0.0001) {
        // Coincident — shove randomly a tiny bit so the next frame can resolve.
        a.x -= 0.5
        b.x += 0.5
        continue
      }
      const dist = Math.sqrt(distSq)
      const overlap = (minGap - dist) * 0.5
      const ux = dx / dist
      const uy = dy / dist
      if (!b.fixed) { b.x += ux * overlap; b.y += uy * overlap }
      if (!a.fixed) { a.x -= ux * overlap; a.y -= uy * overlap }
    }
  }
}
void MIN_NODE_SEPARATION_SQ // reserved for a future spatial-index optimization

function radiusFor(node: BrainNode): number {
  const base = node.type === 'course' ? 10 : node.type === 'syllabus' ? 8 : node.type === 'file' ? 6 : 5
  const authorityBoost = node.sourceAuthorityAvg >= 0.9 ? 3 : node.sourceAuthorityAvg >= 0.75 ? 1.5 : 0
  const bundleBoost = Math.log(1 + node.recordCount) * 1.5
  return base + authorityBoost + bundleBoost
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function Brain() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['brain-v2'],
    queryFn: fetchBrain,
    staleTime: 10_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const positioned = useRef<Positioned[]>([])
  const nodeById = useRef<Map<string, Positioned>>(new Map())
  const rafRef = useRef<number | null>(null)
  const freezeControls = useRef<{ unfreeze: () => void } | null>(null)
  const unfreezeSim = useCallback(() => { freezeControls.current?.unfreeze() }, [])
  const dprRef = useRef<number>(1)

  const view = useRef({ x: 0, y: 0, zoom: 1 })
  const panState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const dragState = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null)

  const [enabledTypes, setEnabledTypes] = useState<Set<NodeType>>(new Set(FILTER_TYPES))
  const [hover, setHover] = useState<{
    id: string
    node: BrainNode
    sharedWith: string[]  // concept names when hovering a specific node's connection
    screenX: number
    screenY: number
  } | null>(null)

  const filteredEdges = useRef<BrainEdge[]>([])

  const filteredData = useMemo(() => {
    if (!data) return { nodes: [] as BrainNode[], edges: [] as BrainEdge[] }
    const nodes = data.nodes.filter(n => enabledTypes.has(n.type))
    const ids = new Set(nodes.map(n => n.id))
    const edges = data.edges.filter(e => ids.has(e.source) && ids.has(e.target))
    return { nodes, edges }
  }, [data, enabledTypes])

  useEffect(() => {
    const existing = nodeById.current
    // Cluster-seeded initial layout: pre-place each course at a distinct
    // ring seat, then place its members inside a small radius around it.
    // Orphans go on an outer ring (matches the ORPHAN_RING physics).
    const courseSeeds = new Map<string, { cx: number; cy: number; idx: number }>()
    let seedCount = 0
    for (const n of filteredData.nodes) {
      if (n.courseId && !courseSeeds.has(n.courseId)) {
        const angle = seedCount * 2.399963229728653
        const radius = 240 + Math.sqrt(seedCount) * 60
        courseSeeds.set(n.courseId, {
          cx: Math.cos(angle) * radius,
          cy: Math.sin(angle) * radius,
          idx: 0,
        })
        seedCount += 1
      }
    }
    const next: Positioned[] = filteredData.nodes.map((n, idx) => {
      const prior = existing.get(n.id)
      const color = TYPE_COLOR[n.type]
      const r = radiusFor(n)
      if (prior) {
        return { ...n, x: prior.x, y: prior.y, vx: 0, vy: 0, fixed: prior.fixed, r, color }
      }
      let sx: number
      let sy: number
      if (n.courseId && courseSeeds.has(n.courseId)) {
        const seed = courseSeeds.get(n.courseId)!
        // Ring of members inside each course centroid.
        const memberAngle = seed.idx * 1.2 + hashStr(n.id) * 0.0000001
        const memberR = 20 + (seed.idx % 8) * 6
        sx = seed.cx + Math.cos(memberAngle) * memberR
        sy = seed.cy + Math.sin(memberAngle) * memberR
        seed.idx += 1
      } else {
        // Orphan — spiral out at ORPHAN_RING_RADIUS. Using idx keeps it stable.
        const angle = idx * 2.399963229728653
        sx = Math.cos(angle) * ORPHAN_RING_RADIUS
        sy = Math.sin(angle) * ORPHAN_RING_RADIUS
      }
      return {
        ...n,
        x: sx,
        y: sy,
        vx: 0,
        vy: 0,
        fixed: false,
        r,
        color,
      }
    })
    positioned.current = next
    const map = new Map<string, Positioned>()
    for (const p of next) map.set(p.id, p)
    nodeById.current = map

    const isFirstMount = existing.size === 0
    if (isFirstMount) {
      for (let i = 0; i < INITIAL_WARM_STEPS; i += 1) stepSim(next, filteredData.edges, map)
    } else {
      for (const p of next) {
        if (!existing.get(p.id)) {
          p.vx = (Math.random() - 0.5) * 2
          p.vy = (Math.random() - 0.5) * 2
        }
      }
    }
    filteredEdges.current = filteredData.edges
    // Data changed — resume physics until it settles again.
    unfreezeSim()
  }, [filteredData, unfreezeSim])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const observer = new ResizeObserver(() => resize())
    observer.observe(wrap)
    resize()
    return () => observer.disconnect()

    function resize() {
      if (!canvas || !wrap) return
      const dpr = window.devicePixelRatio || 1
      dprRef.current = dpr
      const rect = wrap.getBoundingClientRect()
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
    }
  }, [])

  useEffect(() => {
    let alive = true
    // Auto-freeze: after N consecutive frames where total kinetic energy is
    // below a threshold, stop stepping physics. The draw loop keeps running
    // so redraws (hover, pan, zoom) still work. Physics resumes on any event
    // that unfreezes (drag, filter change, data reload — see unfreezeSim).
    let frozen = false
    let lowEnergyFrames = 0
    const LOW_ENERGY_THRESHOLD = 0.15  // stricter — was 0.5, missed slow oscillations
    const LOW_ENERGY_FRAMES_NEEDED = 60 // ~1s at 60fps
    freezeControls.current = {
      unfreeze: () => {
        frozen = false
        lowEnergyFrames = 0
      },
    }
    const draw = () => {
      if (!alive) return
      const canvas = canvasRef.current
      if (canvas) {
        if (!frozen) {
          stepSim(positioned.current, filteredEdges.current, nodeById.current)
          // Measure kinetic energy — if below threshold N frames in a row, freeze.
          let sumSpeedSq = 0
          const n = positioned.current.length
          for (let i = 0; i < n; i += 1) {
            const p = positioned.current[i]
            sumSpeedSq += p.vx * p.vx + p.vy * p.vy
          }
          const avgSpeedSq = n > 0 ? sumSpeedSq / n : 0
          if (avgSpeedSq < LOW_ENERGY_THRESHOLD) {
            lowEnergyFrames += 1
            if (lowEnergyFrames >= LOW_ENERGY_FRAMES_NEEDED) {
              frozen = true
              // Zero out residual velocity so the freeze holds perfectly still.
              for (let i = 0; i < n; i += 1) {
                positioned.current[i].vx = 0
                positioned.current[i].vy = 0
              }
            }
          } else {
            lowEnergyFrames = 0
          }
        }
        const ctx = canvas.getContext('2d')
        if (ctx) drawFrame(ctx, canvas)
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      alive = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  function drawFrame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    const dpr = dprRef.current
    const w = canvas.width, h = canvas.height
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const zoom = view.current.zoom * dpr
    const tx = w / 2 + view.current.x * zoom
    const ty = h / 2 + view.current.y * zoom
    ctx.setTransform(zoom, 0, 0, zoom, tx, ty)

    const primary = getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim() || '#8a708a'
    const accent  = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#5b969c'
    const border = getComputedStyle(document.documentElement).getPropertyValue('--color-border').trim() || '#dbd9e2'
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--color-text').trim() || '#2b2a2e'

    // Draw same-class edges first, then cross-class on top so bridges are
    // always visible above the intra-cluster web.
    const drawEdge = (e: BrainEdge, onTop: boolean) => {
      const a = nodeById.current.get(e.source)
      const b = nodeById.current.get(e.target)
      if (!a || !b) return
      const dx = b.x - a.x, dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist === 0) return
      const nx = dx / dist, ny = dy / dist
      const x1 = a.x + nx * a.r, y1 = a.y + ny * a.r
      const x2 = b.x - nx * b.r, y2 = b.y - ny * b.r
      const highlight = hover && (e.source === hover.id || e.target === hover.id)
      const isConcept = e.sharedConcepts.length > 0
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      if (isConcept && e.isCrossClass) {
        ctx.strokeStyle = accent
        ctx.globalAlpha = highlight ? 1 : 0.7
        ctx.lineWidth = Math.max(1.3, Math.min(3, 1 + e.sharedConcepts.length * 0.3)) / view.current.zoom
      } else if (isConcept) {
        ctx.strokeStyle = primary
        ctx.globalAlpha = highlight ? 1 : 0.45
        ctx.lineWidth = Math.max(0.7, Math.min(2, 0.6 + e.sharedConcepts.length * 0.2)) / view.current.zoom
      } else {
        ctx.strokeStyle = border
        ctx.globalAlpha = highlight ? 0.95 : 0.5
        ctx.lineWidth = 1.2 / view.current.zoom
      }
      ctx.stroke()
      void onTop  // parameter kept for clarity even though painting order already handles it
    }
    for (const e of filteredEdges.current) if (!e.isCrossClass) drawEdge(e, false)
    for (const e of filteredEdges.current) if (e.isCrossClass) drawEdge(e, true)
    ctx.globalAlpha = 1

    for (const p of positioned.current) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = p.color
      ctx.fill()
      if (p.recordCount > 1) {
        ctx.lineWidth = 2 / view.current.zoom
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-page').trim() || '#f4f3f6'
        ctx.stroke()
      }
      if (hover && hover.id === p.id) {
        ctx.lineWidth = 2.5 / view.current.zoom
        ctx.strokeStyle = textColor
        ctx.stroke()
      }
    }

  }

  const screenToWorld = useCallback((sx: number, sy: number): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const cx = sx - rect.left - rect.width / 2
    const cy = sy - rect.top - rect.height / 2
    return { x: cx / view.current.zoom - view.current.x, y: cy / view.current.zoom - view.current.y }
  }, [])

  const nodeAt = useCallback((sx: number, sy: number): Positioned | null => {
    const world = screenToWorld(sx, sy)
    for (let i = positioned.current.length - 1; i >= 0; i -= 1) {
      const p = positioned.current[i]
      const dx = world.x - p.x, dy = world.y - p.y
      if (dx * dx + dy * dy <= (p.r + 2) * (p.r + 2)) return p
    }
    return null
  }, [screenToWorld])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      const c = canvasRef.current
      if (!c) return
      const rect = c.getBoundingClientRect()
      const anchor = screenToWorld(e.clientX, e.clientY)
      const factor = Math.exp(-e.deltaY * 0.0015)
      const nextZoom = Math.min(4, Math.max(0.15, view.current.zoom * factor))
      view.current.zoom = nextZoom
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      view.current.x = cx / nextZoom - anchor.x
      view.current.y = cy / nextZoom - anchor.y
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [screenToWorld])

  function onPointerDown(e: React.PointerEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(e.pointerId)
    const p = nodeAt(e.clientX, e.clientY)
    if (p) {
      p.fixed = true
      const world = screenToWorld(e.clientX, e.clientY)
      dragState.current = { nodeId: p.id, offsetX: world.x - p.x, offsetY: world.y - p.y }
      unfreezeSim()
      return
    }
    panState.current = { startX: e.clientX, startY: e.clientY, origX: view.current.x, origY: view.current.y }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (dragState.current) {
      const p = nodeById.current.get(dragState.current.nodeId)
      if (p) {
        const world = screenToWorld(e.clientX, e.clientY)
        p.x = world.x - dragState.current.offsetX
        p.y = world.y - dragState.current.offsetY
        p.vx = 0; p.vy = 0
      }
      return
    }
    if (panState.current) {
      const pan = panState.current
      const dx = (e.clientX - pan.startX) / view.current.zoom
      const dy = (e.clientY - pan.startY) / view.current.zoom
      view.current.x = pan.origX + dx
      view.current.y = pan.origY + dy
      return
    }
    const p = nodeAt(e.clientX, e.clientY)
    if (p) {
      setHover(prev =>
        prev?.id === p.id && Math.abs(prev.screenX - e.clientX) < 2 && Math.abs(prev.screenY - e.clientY) < 2
          ? prev
          : { id: p.id, node: p, sharedWith: [], screenX: e.clientX, screenY: e.clientY }
      )
    } else if (hover) {
      setHover(null)
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const canvas = canvasRef.current
    canvas?.releasePointerCapture?.(e.pointerId)
    if (dragState.current) {
      const p = nodeById.current.get(dragState.current.nodeId)
      if (p) p.fixed = false
      dragState.current = null
      return
    }
    panState.current = null
  }

  function toggleType(type: NodeType) {
    setEnabledTypes(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function resetView() {
    view.current = { x: 0, y: 0, zoom: 1 }
  }

  const showEmpty = !isLoading && !isError && (data?.nodes.length ?? 0) === 0

  const tooltipStyle = useMemo(() => {
    if (!hover || !wrapRef.current) return { display: 'none' as const }
    const rect = wrapRef.current.getBoundingClientRect()
    return { left: hover.screenX - rect.left + 14, top: hover.screenY - rect.top + 14 }
  }, [hover])

  return (
    <div className={styles.page}>
      <header className={styles.toolbar}>
        <div className={styles.headingBlock}>
          <h1 className={styles.title}>Brain</h1>
          <p className={styles.subtitle}>
            Every node is a task, file, syllabus, or course. Edges form when nodes share concepts.
          </p>
        </div>
        <div className={styles.filters} role="group" aria-label="Filter nodes by type">
          {FILTER_TYPES.map(t => (
            <button
              key={t}
              type="button"
              className={[styles.filterChip, enabledTypes.has(t) ? styles.filterChipActive : ''].join(' ')}
              onClick={() => toggleType(t)}
              aria-pressed={enabledTypes.has(t)}
              style={{ borderColor: TYPE_COLOR[t] }}
            >
              <span className={styles.filterDot} style={{ background: TYPE_COLOR[t] }} />
              {TYPE_LABEL[t]}
            </button>
          ))}
          <button type="button" className={styles.resetButton} onClick={resetView}>
            Reset view
          </button>
        </div>
      </header>

      <div ref={wrapRef} className={styles.canvasWrap}>
        {isLoading && <div className={styles.overlayMessage}>Loading graph…</div>}
        {isError && <div className={styles.overlayMessage}>Could not load the graph.</div>}
        {showEmpty && (
          <div className={styles.emptyState}>
            <h2 className={styles.emptyTitle}>Your brain is still growing</h2>
            <p className={styles.emptyBody}>
              Once Rumbo processes what your connected sources have, tasks and files start showing up here.
            </p>
          </div>
        )}

        <canvas
          ref={canvasRef}
          className={styles.canvas}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          aria-label="Knowledge graph"
        />

        {hover && (
          <div className={styles.tooltip} style={tooltipStyle} role="tooltip">
            <div className={styles.tooltipName}>{hover.node.name}</div>
            <div className={styles.tooltipMeta}>
              <span className={styles.tooltipType}>{TYPE_LABEL[hover.node.type]}</span>
              {hover.node.courseLabel && (
                <>
                  <span className={styles.tooltipDot} aria-hidden="true">·</span>
                  <span className={styles.tooltipClass}>{hover.node.courseLabel}</span>
                </>
              )}
              {hover.node.recordCount > 1 && (
                <>
                  <span className={styles.tooltipDot} aria-hidden="true">·</span>
                  <span className={styles.tooltipBundle}>×{hover.node.recordCount}</span>
                </>
              )}
            </div>
            {hover.node.concepts.length > 0 && (
              <div className={styles.tooltipConcepts}>
                {hover.node.concepts.slice(0, 6).join(' · ')}
                {hover.node.concepts.length > 6 && ` · +${hover.node.concepts.length - 6}`}
              </div>
            )}
          </div>
        )}

        {data && data.nodes.length > 0 && (
          <div className={styles.counters}>
            {filteredData.nodes.length} nodes · {filteredData.edges.length} edges
          </div>
        )}
      </div>
    </div>
  )
}
