// brain-extract-v4 — three-stage extraction pipeline.
//
// Stage 1 — Pass 1 (Haiku per-chunk):
//   For each chunk, extract raw concept mentions with a short contextual
//   prefix + definition/excerpt sourced from the chunk text. Preserves per-
//   chunk locality so an idea introduced in slide 4 doesn't get flattened
//   into a course-level bag.
//
// Stage 2 — Deterministic aggregation:
//   Dedupe by normalized name across chunks. Collapse to one canonical
//   proposal per name with occurrence count, first-chunk excerpt, and
//   union of definitions.
//
// Stage 3 — Opus 4.5 min-thinking reasoning layer:
//   Input: aggregated proposals + candidate concepts (existing pool) + doc
//   metadata. Output: tiered structure — tier1 primary concepts, tier2
//   sub-concepts with parent, PLUS pedagogical tags (skill_dimensions,
//   domain_tags, bloom_typical_level). This is the layer that gives the
//   graph "educational structure" rather than raw frequency-ranked mentions.
//
// Stage 4 — Pass 2 (Haiku file-level):
//   Given the reasoning output, produce the actual COVERS edges: for each
//   surviving concept (matched candidate OR newly-tiered proposal), decide
//   is_primary + confidence at the record level, and lift definition/excerpt
//   from Pass-1 records so the writer can wire COVERS.definition / .excerpt.

import {
  anthropicToolJson,
  HAIKU_MODEL,
  SONNET_MODEL,
} from './anthropic.ts'
import type { BloomLevel } from './neo4j-graph-writer-v4.ts'
import { SOURCE_AUTHORITY } from './brain-extraction-v2.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CandidateConcept {
  id: string
  name: string
}

export interface RawMention {
  name: string
  definition?: string | null
  excerpt?: string | null
  chunk_index: number
}

interface Pass1Output {
  concepts: RawMention[]
}

export interface AggregatedProposal {
  canonical_name: string   // display name for the pool
  normalized_name: string  // lowercase, whitespace-collapsed for dedup
  count: number
  definitions: string[]    // deduped, at most 3
  excerpts: string[]       // deduped, at most 3
  first_chunk_index: number
}

export interface TieredConcept {
  // Identity — one of these is set:
  candidate_id?: string | null   // matches an existing candidate concept
  proposal_name?: string | null  // new concept, canonical from aggregation
  // Tier assignment:
  tier: 1 | 2
  parent_name?: string | null    // required when tier=2, else null
  // Pedagogical tags (from reasoning layer):
  skill_dimensions: string[]
  domain_tags: string[]
  bloom_typical_level: BloomLevel | null
  // Reasoning confidence:
  confidence: number
}

interface ReasoningOutput {
  tiered_concepts: TieredConcept[]
  discard: string[]  // names the reasoner explicitly rejected (kept for logs)
}

export interface Pass2Match {
  identity: { candidate_id?: string; proposal_name?: string }
  is_primary: boolean
  confidence: number
  definition: string | null
  excerpt: string | null
}

interface Pass2Output {
  matches: Pass2Match[]
}

export interface ExtractionV4Result {
  proposals: AggregatedProposal[]
  tiered: TieredConcept[]
  matches: Pass2Match[]
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function normalizeConceptName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const BANNED_GENERIC_CONCEPTS = new Set([
  'class participation', 'grading', 'syllabus', 'assignments', 'homework',
  'lecture', 'quiz', 'exam', 'midterm', 'final exam', 'office hours',
  'attendance', 'learning objectives', 'reading', 'textbook', 'discussion',
  'requirements', 'prerequisites', 'course description', 'grading policy',
  'late policy', 'academic integrity', 'instructor', 'teaching assistant',
  'welcome',
])

// ---------------------------------------------------------------------------
// Stage 1 — Pass 1 per-chunk extraction (Haiku).
// ---------------------------------------------------------------------------

const PASS1_SYSTEM = `You are extracting substantive academic CONCEPTS from a single chunk of course material.

For each real academic concept the chunk introduces, teaches, or applies, emit:
- name: short (1-4 word) noun phrase, lowercase, singular where natural
- definition: 1-sentence definition GROUNDED IN THE CHUNK TEXT (not general knowledge). Null if the chunk doesn't define it.
- excerpt: the shortest verbatim span (≤ 25 words) from the chunk that surfaces the concept.

NEVER emit these generic categories: "class participation", "grading", "syllabus", "assignments", "homework", "lecture", "quiz", "exam", "midterm", "final exam", "office hours", "attendance", "learning objectives", "reading", "textbook", "discussion", "requirements", "prerequisites", "course description", "grading policy", "late policy", "academic integrity", "instructor", "teaching assistant", "welcome".

If the chunk is purely administrative or has no substantive concept, return concepts=[].
Aim for 0-4 concepts per chunk; more than 5 usually means over-extraction.`

const PASS1_SCHEMA = {
  type: 'object' as const,
  properties: {
    concepts: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          definition: { type: 'string' as const },
          excerpt: { type: 'string' as const },
        },
        required: ['name'],
      },
    },
  },
  required: ['concepts'],
}

interface Pass1Chunk {
  chunk_index: number
  heading: string | null
  text: string
}

export async function pass1PerChunk(args: {
  sourceType: string
  chunks: Pass1Chunk[]
}): Promise<RawMention[]> {
  const mentions: RawMention[] = []
  for (const chunk of args.chunks) {
    const userText = `SOURCE_TYPE: ${args.sourceType}
${chunk.heading ? `SECTION: ${chunk.heading}\n` : ''}
CHUNK TEXT:
${chunk.text.slice(0, 6000)}`

    const out = await anthropicToolJson<Pass1Output>({
      system: PASS1_SYSTEM,
      userText,
      toolName: 'emit_concepts',
      toolDescription: 'Emit concept mentions extracted from this chunk.',
      schema: PASS1_SCHEMA,
      model: HAIKU_MODEL,
      maxTokens: 900,
    })
    if (!out?.concepts) continue
    for (const c of out.concepts) {
      const name = (c.name ?? '').trim()
      if (!name) continue
      if (BANNED_GENERIC_CONCEPTS.has(name.toLowerCase())) continue
      mentions.push({
        name,
        definition: (c.definition ?? null) || null,
        excerpt: (c.excerpt ?? null) || null,
        chunk_index: chunk.chunk_index,
      })
    }
  }
  return mentions
}

// ---------------------------------------------------------------------------
// Stage 2 — Deterministic aggregation.
// ---------------------------------------------------------------------------

export function aggregate(mentions: RawMention[]): AggregatedProposal[] {
  const bucket = new Map<string, AggregatedProposal>()
  for (const m of mentions) {
    const normalized = normalizeConceptName(m.name)
    if (!normalized) continue
    if (BANNED_GENERIC_CONCEPTS.has(normalized)) continue
    let agg = bucket.get(normalized)
    if (!agg) {
      agg = {
        canonical_name: m.name.trim(),
        normalized_name: normalized,
        count: 0,
        definitions: [],
        excerpts: [],
        first_chunk_index: m.chunk_index,
      }
      bucket.set(normalized, agg)
    }
    agg.count += 1
    if (m.chunk_index < agg.first_chunk_index) agg.first_chunk_index = m.chunk_index
    if (m.definition && !agg.definitions.includes(m.definition) && agg.definitions.length < 3) {
      agg.definitions.push(m.definition)
    }
    if (m.excerpt && !agg.excerpts.includes(m.excerpt) && agg.excerpts.length < 3) {
      agg.excerpts.push(m.excerpt)
    }
  }
  return Array.from(bucket.values()).sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// Stage 3 — Opus 4.5 min-thinking reasoning layer.
// ---------------------------------------------------------------------------

const REASON_SYSTEM = `You are the pedagogical reasoning layer for a per-student academic knowledge graph.

You receive:
- CANDIDATES: existing concept nodes in the student's pool (with ids and names)
- PROPOSALS: new concept mentions the ingest pass extracted, with occurrence counts and first-mention chunks
- DOC METADATA: source_type, course context

Your job:
1. Decide which CANDIDATES apply to this document (reference by candidate_id) and which PROPOSALS deserve to be added to the pool (reference by proposal_name — must match one from PROPOSALS exactly).
2. For each surviving concept, assign a pedagogical TIER:
   - tier 1: primary concept — foundational for the class, taught/used across multiple lectures, would appear in a course description
   - tier 2: sub-concept — a specific method, example, framework, or application UNDER a tier-1 concept. Requires parent_name pointing to another surviving concept in this list.
3. For each surviving concept, emit pedagogical TAGS:
   - skill_dimensions: which academic skills it exercises. Values from: ["quantitative","writing","reading","analysis","synthesis","memorization","technical","design","argumentation","modeling"]. Zero or more.
   - domain_tags: subject-domain buckets. Values from: ["stem","humanities","social-science","arts","professional","interdisciplinary"]. Zero or more.
   - bloom_typical_level: the TYPICAL bloom level a student engages this concept at first. One of: "remember","understand","apply","analyze","evaluate","create", or null if unclear.
4. Reject PROPOSALS that are too vague, too generic, or duplicate an already-listed candidate. List them in "discard" (by name).

Rules:
- Only 1-3 tier-1 concepts per record. More is over-tiering.
- A tier-2 concept MUST have a parent that is itself in the surviving concept list (either a candidate or another proposal).
- confidence 0-1 = your confidence in the tier assignment.
- Prefer matching a candidate over creating a proposal when the meaning is the same.`

const REASON_SCHEMA = {
  type: 'object' as const,
  properties: {
    tiered_concepts: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          candidate_id: { type: 'string' as const },
          proposal_name: { type: 'string' as const },
          tier: { type: 'integer' as const, minimum: 1, maximum: 2 },
          parent_name: { type: 'string' as const },
          skill_dimensions: { type: 'array' as const, items: { type: 'string' as const } },
          domain_tags: { type: 'array' as const, items: { type: 'string' as const } },
          bloom_typical_level: {
            type: 'string' as const,
            enum: ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create'],
          },
          confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
        },
        required: ['tier', 'confidence'],
      },
    },
    discard: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
  },
  required: ['tiered_concepts'],
}

const MAX_TIER1_PER_RECORD = 3
const MAX_TIER2_PER_RECORD = 5

// Keep the highest-confidence concepts within each tier's budget. Tier-2
// entries whose parent didn't survive still emit; the pipeline's PARENT_CONCEPT
// step already skips edges whose parent has no id.
function capTiers<T extends { tier: number; confidence?: number }>(items: T[]): T[] {
  const byConf = (a: T, b: T) => (b.confidence ?? 0.7) - (a.confidence ?? 0.7)
  const tier1 = items.filter(t => t.tier === 1).sort(byConf).slice(0, MAX_TIER1_PER_RECORD)
  const tier2 = items.filter(t => t.tier === 2).sort(byConf).slice(0, MAX_TIER2_PER_RECORD)
  return [...tier1, ...tier2]
}

export async function reasonTiers(args: {
  sourceType: string
  courseName: string | null
  candidates: CandidateConcept[]
  proposals: AggregatedProposal[]
}): Promise<TieredConcept[]> {
  if (args.candidates.length === 0 && args.proposals.length === 0) return []

  const candidateBlock = args.candidates.length > 0
    ? args.candidates.map(c => `- ${c.id}: "${c.name}"`).join('\n')
    : '(pool empty for this student)'
  const proposalBlock = args.proposals.length > 0
    ? args.proposals.map(p => `- "${p.canonical_name}" (count=${p.count})`).join('\n')
    : '(none)'

  const userText = `DOC METADATA:
- source_type: ${args.sourceType}
- course: ${args.courseName ?? '(unknown)'}
- source_authority_weight: ${(SOURCE_AUTHORITY[args.sourceType] ?? 0.6).toFixed(2)}

CANDIDATES:
${candidateBlock}

PROPOSALS:
${proposalBlock}`

  // Path A: Sonnet 4.6 without extended thinking. ~5-10s per record, fits
  // Supabase's 150s edge-function timeout at batches of 5. If reasoning
  // quality degrades vs Opus in eval, revisit with reasonWithThinkingJson +
  // Supabase Pro tier for a longer timeout.
  const out = await anthropicToolJson<ReasoningOutput>({
    system: REASON_SYSTEM,
    userText,
    toolName: 'emit_tiered_concepts',
    toolDescription: 'Emit the pedagogically-tiered concept structure for this document.',
    schema: REASON_SCHEMA,
    model: SONNET_MODEL,
    maxTokens: 4096,
  })
  if (!out?.tiered_concepts || !Array.isArray(out.tiered_concepts)) return []

  // REASON_SYSTEM asks for "only 1-3 tier-1 concepts per record" and says
  // nothing about tier-2, and nothing enforced either — so a long document
  // could mint an unbounded number of concepts. Enforce both in code, keeping
  // the highest-confidence ones. Purely reductive.
  const capped = capTiers(
    out.tiered_concepts.filter(t => t && (t.tier === 1 || t.tier === 2)),
  )
  return capped
    .map(t => ({
      candidate_id: t.candidate_id ?? null,
      proposal_name: t.proposal_name ?? null,
      tier: t.tier,
      parent_name: (t.parent_name ?? null) || null,
      skill_dimensions: Array.isArray(t.skill_dimensions) ? t.skill_dimensions : [],
      domain_tags: Array.isArray(t.domain_tags) ? t.domain_tags : [],
      bloom_typical_level: (t.bloom_typical_level ?? null) as BloomLevel | null,
      confidence: typeof t.confidence === 'number' ? t.confidence : 0.7,
    }))
}

// ---------------------------------------------------------------------------
// Stage 4 — Pass 2 (Haiku file-level match with definition/excerpt lift).
// ---------------------------------------------------------------------------

const PASS2_SYSTEM = `You produce the record-level COVERS decisions for a per-student knowledge graph.

You receive the TIERED CONCEPTS surviving from the reasoning layer (each with tier, tags, and either a candidate_id or a proposal_name) plus the full RECORD TEXT (up to 12k chars).

For each tiered concept, decide whether the RECORD actually COVERS it, and if so:
- is_primary: true for exactly the SINGLE most-central concept in this record (or zero if no clear primary — but strongly prefer picking one)
- confidence: 0-1 — how strongly the record is about this concept. Skip (do not emit) if < 0.5.
- definition: lift the shortest verbatim sentence-fragment from the record that DEFINES the concept, or null if the record doesn't define it
- excerpt: the shortest verbatim span (≤ 30 words) from the record where the concept surfaces most clearly

Only emit matches with confidence ≥ 0.5. Emitting nothing is valid if the record is off-topic to all tiered concepts.`

const PASS2_SCHEMA = {
  type: 'object' as const,
  properties: {
    matches: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          candidate_id: { type: 'string' as const },
          proposal_name: { type: 'string' as const },
          is_primary: { type: 'boolean' as const },
          confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
          definition: { type: 'string' as const },
          excerpt: { type: 'string' as const },
        },
        required: ['is_primary', 'confidence'],
      },
    },
  },
  required: ['matches'],
}

export async function pass2FileLevel(args: {
  recordText: string
  sourceType: string
  tiered: TieredConcept[]
}): Promise<Pass2Match[]> {
  if (args.tiered.length === 0) return []

  const tieredBlock = args.tiered.map((t, i) => {
    const ident = t.candidate_id ? `candidate_id=${t.candidate_id}` : `proposal_name="${t.proposal_name}"`
    return `${i + 1}. ${ident} | tier=${t.tier}${t.parent_name ? ` | parent="${t.parent_name}"` : ''}`
  }).join('\n')

  const userText = `SOURCE_TYPE: ${args.sourceType}

TIERED CONCEPTS (from reasoning layer):
${tieredBlock}

RECORD TEXT:
${args.recordText.slice(0, 12000)}`

  const out = await anthropicToolJson<Pass2Output>({
    system: PASS2_SYSTEM,
    userText,
    toolName: 'emit_matches',
    toolDescription: 'Emit COVERS decisions for this record.',
    schema: PASS2_SCHEMA,
    model: HAIKU_MODEL,
    maxTokens: 2000,
  })
  if (!out?.matches) return []

  return out.matches
    .filter(m => (m.confidence ?? 0) >= 0.5)
    .map(m => ({
      identity: m.candidate_id
        ? { candidate_id: m.candidate_id }
        : { proposal_name: (m as Pass2Match & { proposal_name?: string }).proposal_name ?? undefined },
      is_primary: Boolean(m.is_primary),
      confidence: m.confidence,
      definition: (m.definition ?? null) || null,
      excerpt: (m.excerpt ?? null) || null,
    }))
}

// ---------------------------------------------------------------------------
// Top-level orchestrator.
// ---------------------------------------------------------------------------

export async function extractV4(args: {
  sourceType: string
  courseName: string | null
  recordText: string
  chunks: Pass1Chunk[]
  candidates: CandidateConcept[]
}): Promise<ExtractionV4Result> {
  const mentions = await pass1PerChunk({
    sourceType: args.sourceType,
    chunks: args.chunks,
  })
  const proposals = aggregate(mentions)
  const tiered = await reasonTiers({
    sourceType: args.sourceType,
    courseName: args.courseName,
    candidates: args.candidates,
    proposals,
  })
  const matches = await pass2FileLevel({
    recordText: args.recordText,
    sourceType: args.sourceType,
    tiered,
  })
  return { proposals, tiered, matches }
}
