// brain-extraction-v2 — Fast-tier batched concept extraction (Phase 6).
//
// Per tiered-pipeline.md §4 and entity-extraction.md §4.5–§4.6:
//   - 10 records per Gemini Flash call, structured JSON out
//   - per-source-type system prompt
//   - concept-only output (name + is_primary) — resolution & edge writes
//     happen downstream in neo4j-graph-writer.ts
//
// Does NOT touch Postgres entity_candidates. Deprecates ./brain-extraction.ts
// once /brain reads Neo4j-only concepts.

import { geminiClassifyJson, type GeminiJsonSchema } from './gemini.ts'

// Source authority per node type / source_type. Mirrors the Brain.tsx constant
// so styling and edge weights agree.
export const SOURCE_AUTHORITY: Record<string, number> = {
  canvas_course:         0.90,
  manual_course:         0.90,
  canvas_syllabus:       1.00,
  manual_syllabus:       1.00,
  canvas_file_syllabus:  1.00,
  canvas_file_rubric:    0.85,
  canvas_file_project:   0.90,
  canvas_file_study:     0.80,
  canvas_assignment:     0.75,
  manual_assignment:     0.75,
  canvas_lecture:        0.80,
  google_calendar:       0.70,
}

export interface NormalizedEventLite {
  id: string
  source_type: string
  normalized_text: string | null
  raw_payload: Record<string, unknown> | null
}

export interface ExtractedConcept {
  name: string
  is_primary: boolean
}

export interface RecordConcepts {
  record_id: string
  concepts: ExtractedConcept[]
}

// ---------------------------------------------------------------------------
// Per-source-type prompt variants
// ---------------------------------------------------------------------------

const PROMPT_PREAMBLE = `Return concepts as short (1-4 word) noun phrases. Prefer the concept name a professor would say in class. Don't emit filler concepts like 'homework', 'lecture', 'chapter'. If a record has no substantive concepts (like an empty file), return [].`

const SOURCE_TYPE_INSTRUCTION: Record<string, string> = {
  canvas_syllabus:      `extract the concepts this course COVERS, weighted toward the syllabus's own topics list`,
  canvas_file_syllabus: `extract the concepts this course COVERS, weighted toward the syllabus's own topics list`,
  manual_syllabus:      `extract the concepts this course COVERS, weighted toward the syllabus's own topics list`,
  canvas_lecture:       `extract the concept this lecture is about; often derivable from the module + item title alone`,
  canvas_file_project:  `extract concepts this project applies`,
  canvas_file_rubric:   `extract concepts this rubric assesses`,
  canvas_file_study:    `extract concepts this study material covers`,
  canvas_assignment:    `extract concepts this assignment tests`,
  manual_assignment:    `extract concepts this assignment tests`,
  canvas_course:        `extract concepts this course belongs to (subject area)`,
  manual_course:        `extract concepts this course belongs to (subject area)`,
  google_calendar:      `extract concepts if the event title is clearly academic`,
}

function instructionFor(sourceType: string): string {
  return SOURCE_TYPE_INSTRUCTION[sourceType] ?? `extract 2-8 academic concepts covered by this record`
}

// ---------------------------------------------------------------------------
// Concept name normalization
// ---------------------------------------------------------------------------

export function normalizeConceptName(name: string): string {
  let s = (name ?? '').toLowerCase().trim()
  s = s.replace(/\s+/g, ' ')
  s = s.replace(/[.,;:!?"'`]+$/g, '')
  // Singularize simple English plurals per token.
  s = s.split(' ').map(singularize).join(' ')
  return s.trim()
}

function singularize(word: string): string {
  if (word.length <= 3) return word
  if (/(ss|us|is|os)$/.test(word)) return word
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y'
  if (/ses$/.test(word)) return word.slice(0, -2)
  if (/xes$/.test(word) || /ches$/.test(word) || /shes$/.test(word)) return word.slice(0, -2)
  if (/s$/.test(word)) return word.slice(0, -1)
  return word
}

// ---------------------------------------------------------------------------
// Batched Gemini extraction
// ---------------------------------------------------------------------------

const BATCH_SIZE = 10

const RESPONSE_SCHEMA: GeminiJsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          record_id: { type: 'string' },
          concepts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                is_primary: { type: 'boolean' },
              },
              required: ['name', 'is_primary'],
            },
          },
        },
        required: ['record_id', 'concepts'],
      },
    },
  },
  required: ['results'],
}

// Group records into chunks that share a source_type when possible so we can
// use the source_type's dedicated instruction. Mixed batches fall back to a
// composite prompt.
function buildSystemPrompt(sourceTypes: string[]): string {
  const uniq = Array.from(new Set(sourceTypes))
  const perTypeLines = uniq
    .map(t => `- ${t}: ${instructionFor(t)}`)
    .join('\n')
  return [
    `You extract 2-8 academic concepts per record, marking exactly one as primary when possible.`,
    PROMPT_PREAMBLE,
    ``,
    `Records may be from different source types. Apply the matching per-source-type rule:`,
    perTypeLines,
    ``,
    `Return JSON of shape { "results": [ { "record_id": "...", "concepts": [ { "name": "...", "is_primary": true } ] } ] }. Include every input record_id, even if concepts is [].`,
  ].join('\n')
}

function serializeRecord(r: NormalizedEventLite): string {
  const text = (r.normalized_text ?? '').trim().slice(0, 4000)
  return `# record_id: ${r.id}\n# source_type: ${r.source_type}\n${text}`
}

async function extractOneBatch(chunk: NormalizedEventLite[]): Promise<RecordConcepts[]> {
  if (chunk.length === 0) return []
  const system = buildSystemPrompt(chunk.map(r => r.source_type))
  const userText = chunk.map(serializeRecord).join('\n\n---\n\n')
  const parsed = await geminiClassifyJson<{ results?: RecordConcepts[] }>({
    system,
    userText,
    schema: RESPONSE_SCHEMA,
    maxTokens: 3500,
  })
  const results = Array.isArray(parsed?.results) ? parsed!.results : []
  // Fill in any missing record_ids so callers always know which records the
  // batch covered (Gemini occasionally drops empty-concept records).
  const byId = new Map<string, RecordConcepts>()
  for (const r of results) if (r?.record_id) byId.set(r.record_id, { record_id: r.record_id, concepts: r.concepts ?? [] })
  return chunk.map(r => byId.get(r.id) ?? { record_id: r.id, concepts: [] })
}

export async function extractConceptsBatch(records: NormalizedEventLite[]): Promise<RecordConcepts[]> {
  const out: RecordConcepts[] = []
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE)
    try {
      const batch = await extractOneBatch(chunk)
      out.push(...batch)
    } catch (err) {
      console.warn('[brain-extraction-v2] batch failed:', err)
      for (const r of chunk) out.push({ record_id: r.id, concepts: [] })
    }
  }
  return out
}
