// brain-extraction — Stage 1 of the graph brain pipeline.
// Reads normalized_events rows, runs Gemini function-calling extraction, embeds
// candidates via Gemini embedding-001 (outputDimensionality=1536 to match the
// vector column), inserts entity_candidates.
//
// Reference: Rumbo-Design-Docs/Graph Pipeline/entity-extraction.md §4-§8,
// CLAUDE.md §10.3-§10.5.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { EMBEDDING_DIM, geminiCallTool, geminiEmbedBatch } from './gemini.ts'

const CHUNK_CHAR_LIMIT = 16000   // ~4000 tokens
const CHUNK_OVERLAP = 200
const CANDIDATE_INSERT_CHUNK = 200
const EXTRACTION_VERSION = 'extraction-v0.1'

// Source-authority weighting per entity-extraction.md §5.
const SOURCE_AUTHORITY: Record<string, number> = {
  canvas_syllabus: 1.0,
  canvas_file_syllabus: 1.0,   // syllabus / course-info uploads
  manual_syllabus: 1.0,
  canvas_assignment: 0.85,
  canvas_file_project: 0.85,   // detailed project spec doc
  canvas_file_rubric: 0.85,    // rubrics + grading policy docs
  canvas_file_study: 0.80,     // study guides, practice exams, schedules
  manual_assignment: 0.85,
  canvas_announcement: 0.75,
  google_calendar: 0.70,
  drive: 0.60,          // default drive metadata (student-owned)
  drive_content: 0.60,  // default; boosted to 0.80 when instructor-shared
  manual_website: 0.65,
  manual_document: 0.75,
  manual_course: 0.85,
  canvas_course: 0.85,
}

function sourceAuthorityFor(sourceType: string, rawPayload: Record<string, unknown> | null): number {
  let base = SOURCE_AUTHORITY[sourceType] ?? 0.60

  // Assignments — modulate by point weight so 1-point participation checks
  // contribute much less than a 100-point paper. Insignificant work should
  // exist in the graph but not dominate it.
  if ((sourceType === 'canvas_assignment' || sourceType === 'manual_assignment') && rawPayload) {
    const points = Number(rawPayload.points_possible ?? 0)
    const canonical = String(rawPayload.rumbo_canonical_name ?? '').toLowerCase()
    const isFillerName = /participation|attendance|weekly (reading|discussion|quiz)|pre-class/.test(canonical)
    if (points > 0 && points < 5) base *= 0.4                 // participation, attendance
    else if (points > 0 && points < 15) base *= 0.7            // small weekly work
    else if (isFillerName) base *= 0.5                          // no points but obviously filler
    // otherwise unchanged — papers, projects, exams, midterms
  }

  if ((sourceType === 'drive' || sourceType === 'drive_content') && rawPayload) {
    const sharedBy = (rawPayload.shared_by_email as string | undefined) ??
                     (rawPayload.owner_email as string | undefined) ?? ''
    const ownedByStudent = rawPayload.owned_by_me === true
    if (!ownedByStudent && sharedBy.toLowerCase().endsWith('.edu')) {
      return 0.80
    }
  }
  return base
}

export const EXTRACTION_SYSTEM_PROMPT = `
You are an academic knowledge extraction engine. Given a piece of academic content, extract all
distinct academic entities. Be precise — only extract things that are explicitly present in the text.
Do not infer or hallucinate entities. If unsure whether something is an entity, omit it.
`.trim()

export const EXTRACTION_TOOL = {
  name: 'extract_entities',
  description: 'Extract academic entities from the provided text',
  parameters: {
    type: 'object' as const,
    properties: {
      entities: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            name:       { type: 'string' as const },
            type:       { type: 'string' as const, enum: ['concept', 'topic', 'assignment', 'deadline', 'person', 'course_reference'] },
            context:    { type: 'string' as const, description: 'The exact phrase or sentence this was extracted from' },
            confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
          },
          required: ['name', 'type', 'context', 'confidence'],
        },
      },
    },
    required: ['entities'],
  },
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface NormalizedEventRow {
  id: string
  user_id: string
  source_type: string
  classification: string | null
  raw_payload: Record<string, unknown> | null
  normalized_text: string | null
}

interface RawEntity {
  name: string
  type: string
  context: string
  confidence: number
}

export interface CandidateInsert {
  user_id: string
  source_record_id: string
  name: string
  entity_type: string
  context_snippet: string
  extraction_confidence: number
  source_authority: number
  embedding: string   // pgvector literal
  pipeline_version: string
}

// -----------------------------------------------------------------------------
// Chunking
// -----------------------------------------------------------------------------

function chunkText(text: string, maxChars = CHUNK_CHAR_LIMIT, overlap = CHUNK_OVERLAP): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length)
    chunks.push(text.slice(start, end))
    if (end === text.length) break
    start = end - overlap
  }
  return chunks
}

// -----------------------------------------------------------------------------
// Gemini tool-use call
// -----------------------------------------------------------------------------

async function callExtraction(chunk: string): Promise<RawEntity[]> {
  const parsed = await geminiCallTool<{ entities?: RawEntity[] }>({
    system: EXTRACTION_SYSTEM_PROMPT,
    userText: chunk,
    tool: EXTRACTION_TOOL,
    maxTokens: 4096,
  })
  const entities = parsed?.entities ?? []
  return Array.isArray(entities) ? entities : []
}

// -----------------------------------------------------------------------------
// Gemini batch embedding
// -----------------------------------------------------------------------------

async function embedBatch(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return []
  const results = await geminiEmbedBatch(inputs)
  const vectors: number[][] = []
  for (let i = 0; i < inputs.length; i += 1) {
    const v = results[i]
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      throw new Error(`Embedding dim mismatch at index ${i}: got ${v?.length ?? 'null'}, expected ${EMBEDDING_DIM}`)
    }
    vectors.push(v)
  }
  return vectors
}

function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`
}

// -----------------------------------------------------------------------------
// Main entrypoint per record
// -----------------------------------------------------------------------------

export interface ExtractionResult {
  status: 'done' | 'skipped' | 'failed'
  error?: string
  candidates: string[]  // inserted candidate row IDs
  entities_extracted: number
}

export async function extractEntities(
  admin: SupabaseClient,
  record: NormalizedEventRow,
): Promise<ExtractionResult> {
  // Skip non-academic records — extraction only runs on academic content.
  if (record.classification && record.classification !== 'academic') {
    await admin
      .from('normalized_events')
      .update({ extraction_status: 'skipped', extracted_at: new Date().toISOString() })
      .eq('id', record.id)
    return { status: 'skipped', candidates: [], entities_extracted: 0 }
  }

  const text = (record.normalized_text ?? '').trim()
  if (!text) {
    await admin
      .from('normalized_events')
      .update({ extraction_status: 'skipped', extracted_at: new Date().toISOString() })
      .eq('id', record.id)
    return { status: 'skipped', candidates: [], entities_extracted: 0 }
  }

  try {
    const chunks = chunkText(text)
    const authority = sourceAuthorityFor(record.source_type, record.raw_payload)

    // Extract per chunk.
    const rawEntities: RawEntity[] = []
    for (const chunk of chunks) {
      const chunkEntities = await callExtraction(chunk)
      rawEntities.push(...chunkEntities)
    }

    // Dedupe by (name.toLowerCase(), type). Keep highest confidence.
    const seen = new Map<string, RawEntity>()
    for (const e of rawEntities) {
      if (!e?.name || !e?.type) continue
      const key = `${e.name.toLowerCase()}::${e.type}`
      const prev = seen.get(key)
      if (!prev || (e.confidence ?? 0) > (prev.confidence ?? 0)) {
        seen.set(key, e)
      }
    }
    const deduped = Array.from(seen.values())

    if (deduped.length === 0) {
      await admin
        .from('normalized_events')
        .update({ extraction_status: 'done', extracted_at: new Date().toISOString() })
        .eq('id', record.id)
      return { status: 'done', candidates: [], entities_extracted: 0 }
    }

    // Embed all deduped candidates in a single batch call.
    const embedInputs = deduped.map(e => `${e.name}: ${e.context ?? ''}`)
    const vectors = await embedBatch(embedInputs)

    const rows: CandidateInsert[] = deduped.map((e, i) => ({
      user_id: record.user_id,
      source_record_id: record.id,
      name: e.name,
      entity_type: e.type,
      context_snippet: e.context ?? '',
      extraction_confidence: e.confidence ?? 0,
      source_authority: authority,
      embedding: toPgVector(vectors[i]),
      pipeline_version: EXTRACTION_VERSION,
    }))

    const insertedIds: string[] = []
    for (let i = 0; i < rows.length; i += CANDIDATE_INSERT_CHUNK) {
      const chunkRows = rows.slice(i, i + CANDIDATE_INSERT_CHUNK)
      const { data, error } = await admin
        .from('entity_candidates')
        .insert(chunkRows)
        .select('id')
      if (error) throw new Error(`entity_candidates insert failed: ${error.message}`)
      for (const r of data ?? []) insertedIds.push(r.id as string)
    }

    await admin
      .from('normalized_events')
      .update({ extraction_status: 'done', extracted_at: new Date().toISOString() })
      .eq('id', record.id)

    return { status: 'done', candidates: insertedIds, entities_extracted: rows.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[brain-extraction] record ${record.id} failed:`, message)
    await admin
      .from('normalized_events')
      .update({ extraction_status: 'failed' })
      .eq('id', record.id)
    return { status: 'failed', error: message, candidates: [], entities_extracted: 0 }
  }
}
