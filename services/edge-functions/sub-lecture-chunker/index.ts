// sub-lecture-chunker — Phase 7. Turns a Canvas lecture-slides PDF into
// LectureSlide Neo4j nodes, one per slide, with per-slide concept extraction.
//
// Ref: External Sources/canvas-modules-and-files.md §4; graph-schema.md §2, §5.
// Runs in Tier 2 (batched off-hours) or Tier 3 (lazy on tutor query) per
// tiered-pipeline.md §5-§6. This function is the Tier 2 orchestrator: called
// manually with {user_id, limit} to process the next N unchunked Lecture rows.
//
// Auth: CRON_SECRET (verify_jwt=false).
// Body: { user_id: string, limit?: number }.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { neo4j } from '../_shared/neo4j.ts'
import {
  downloadCanvasFile,
  INGESTION_PIPELINE_VERSION,
  type CanvasCredentials,
} from '../_shared/canvas.ts'
import { EMBEDDING_DIM, geminiEmbedBatch, geminiReadPdfJson, type GeminiJsonSchema } from '../_shared/gemini.ts'
import {
  ensureConcept,
  linkAppearsIn,
  linkCovers,
} from '../_shared/neo4j-graph-writer.ts'
import { normalizeConceptName, SOURCE_AUTHORITY } from '../_shared/brain-extraction-v2.ts'

const HARD_CAP = 20
const DEFAULT_LIMIT = 5
const SLIDES_SOURCE_TYPE = 'canvas_lecture_slide'
const CHUNK_PIPELINE_VERSION = 'chunk-v0.1-2026-07-09'

interface RunBody {
  user_id?: string
  limit?: number
}

interface LectureRow {
  id: string
  user_id: string
  course_id: string | null
  external_id: string
  raw_payload: Record<string, unknown> | null
}

interface SlideExtraction {
  page_number: number
  title: string | null
  key_bullets: string[]
  primary_concept: string
  secondary_concepts: string[]
}

const SLIDE_SCHEMA: GeminiJsonSchema = {
  type: 'object',
  properties: {
    slides: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          page_number: { type: 'integer' },
          title: { type: 'string' },
          key_bullets: { type: 'array', items: { type: 'string' } },
          primary_concept: { type: 'string' },
          secondary_concepts: { type: 'array', items: { type: 'string' } },
        },
        required: ['page_number', 'key_bullets', 'primary_concept'],
      },
    },
  },
  required: ['slides'],
}

const SLIDE_PROMPT = `You are an academic content parser. For each page of this PDF, output structured data.

- page_number: 1-indexed page number
- title: top heading text if any, else null
- key_bullets: 3-8 short bullet strings capturing substantive content (not decorative page titles)
- primary_concept: the single most-central concept this page is about (1-4 word noun phrase)
- secondary_concepts: up to 5 additional concepts mentioned or applied (1-4 word noun phrases)

Skip decorative slides (title slides, thank-you slides, image-only slides with no text). Return them with empty key_bullets and primary_concept="".

Return JSON: { "slides": [ { ... } ] }`

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function loadCanvasCreds(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<CanvasCredentials | null> {
  const { data, error } = await admin
    .from('canvas_credentials')
    .select('pat, base_url')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.pat || !data.base_url) return null
  return { pat: data.pat as string, baseUrl: data.base_url as string }
}

// Base64 encode a Uint8Array without eating memory (Deno's btoa doesn't take bytes).
function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

async function processOneLecture(
  admin: ReturnType<typeof createAdminClient>,
  creds: CanvasCredentials,
  row: LectureRow,
): Promise<{ ok: boolean; slides: number; concepts_created: number; concepts_merged: number; error?: string }> {
  const rp = row.raw_payload ?? {}
  const lectureType = String(rp.lecture_type ?? '')
  if (lectureType !== 'slides') return { ok: true, slides: 0, concepts_created: 0, concepts_merged: 0 }

  const contentId = rp.content_id
  if (typeof contentId !== 'number') {
    return { ok: false, slides: 0, concepts_created: 0, concepts_merged: 0, error: 'missing content_id' }
  }

  const download = await downloadCanvasFile(creds, contentId)
  if (!download) return { ok: false, slides: 0, concepts_created: 0, concepts_merged: 0, error: 'download failed' }
  if (!download.mime.toLowerCase().includes('pdf')) {
    // Skip non-PDF lectures for V0. Notes docs / video links come later.
    return { ok: true, slides: 0, concepts_created: 0, concepts_merged: 0 }
  }

  const base64 = toBase64(download.bytes)
  const parsed = await geminiReadPdfJson<{ slides: SlideExtraction[] }>({
    base64Pdf: base64,
    prompt: SLIDE_PROMPT,
    schema: SLIDE_SCHEMA,
    maxTokens: 12000,
  })
  if (!parsed || !Array.isArray(parsed.slides)) {
    return { ok: false, slides: 0, concepts_created: 0, concepts_merged: 0, error: 'PDF parse returned nothing' }
  }

  const g = neo4j()
  const lectureId = row.external_id
  const courseId = row.course_id
  const userId = row.user_id
  const slides = parsed.slides.filter(s => s.primary_concept?.trim() || (s.key_bullets ?? []).length > 0)
  if (slides.length === 0) return { ok: true, slides: 0, concepts_created: 0, concepts_merged: 0 }

  // Persist each slide as a normalized_events row AND a Neo4j LectureSlide node.
  const rows = slides.map(s => ({
    user_id: userId,
    source_type: SLIDES_SOURCE_TYPE,
    external_id: `canvas_slide_${lectureId}_${s.page_number}`,
    timestamp: null,
    course_id: courseId,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: {
      lecture_id: lectureId,
      slide_number: s.page_number,
      title: s.title ?? null,
      key_bullets: s.key_bullets,
      primary_concept: s.primary_concept,
      secondary_concepts: s.secondary_concepts ?? [],
      source_pdf_content_id: contentId,
    },
    normalized_text: [s.title ?? '', ...(s.key_bullets ?? [])].filter(Boolean).join('\n'),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }))

  const { error: upsertErr } = await admin
    .from('normalized_events')
    .upsert(rows, { onConflict: 'user_id,source_type,external_id' })
  if (upsertErr) {
    return { ok: false, slides: 0, concepts_created: 0, concepts_merged: 0, error: `upsert: ${upsertErr.message}` }
  }

  // Build Neo4j: LectureSlide nodes + HAS_SLIDE from Lecture + COVERS + APPEARS_IN.
  let created = 0
  let merged = 0
  const authority = SOURCE_AUTHORITY[SLIDES_SOURCE_TYPE] ?? 0.85

  // Batch concept embeddings across all slides on the deck to save calls.
  const allConceptStrings: Array<{ slide: SlideExtraction; name: string; is_primary: boolean }> = []
  for (const s of slides) {
    const primary = s.primary_concept?.trim()
    if (primary) allConceptStrings.push({ slide: s, name: primary, is_primary: true })
    for (const sec of s.secondary_concepts ?? []) {
      const n = sec.trim()
      if (n) allConceptStrings.push({ slide: s, name: n, is_primary: false })
    }
  }
  const normalizedNames = allConceptStrings.map(x => normalizeConceptName(x.name))
  const embeddings = normalizedNames.length > 0 ? await geminiEmbedBatch(normalizedNames) : []

  for (const s of slides) {
    const slideNodeId = `canvas_slide_${lectureId}_${s.page_number}`
    await g.run(
      `MERGE (ls:LectureSlide {id: $id})
       SET ls.user_id = $userId,
           ls.lecture_id = $lectureId,
           ls.slide_number = $slideNumber,
           ls.slide_title = $title,
           ls.slide_text = $text
       WITH ls
       MATCH (lec:Lecture {id: $lectureId, user_id: $userId})
       MERGE (lec)-[:HAS_SLIDE]->(ls)`,
      {
        id: slideNodeId,
        userId,
        lectureId,
        slideNumber: s.page_number,
        title: s.title ?? null,
        text: [s.title ?? '', ...(s.key_bullets ?? [])].filter(Boolean).join('\n'),
      },
    )
  }

  for (let idx = 0; idx < allConceptStrings.length; idx++) {
    const item = allConceptStrings[idx]
    const emb = embeddings[idx]
    if (!Array.isArray(emb) || emb.length !== EMBEDDING_DIM) continue
    const normalized = normalizedNames[idx]
    if (!normalized) continue
    try {
      const cRes = await ensureConcept(g, {
        userId,
        name: item.name,
        normalizedName: normalized,
        embedding: emb,
        sourceAuthority: authority,
      })
      if (cRes.merged) merged += 1
      else created += 1
      const slideNodeId = `canvas_slide_${lectureId}_${item.slide.page_number}`
      await linkCovers(g, {
        userId,
        sourceLabel: 'LectureSlide',
        sourceId: slideNodeId,
        conceptId: cRes.id,
        weight: authority * (item.is_primary ? 1.0 : 0.6),
        isPrimary: item.is_primary,
      })
      if (courseId) {
        await linkAppearsIn(g, { userId, conceptId: cRes.id, courseId })
      }
    } catch (err) {
      console.warn(`[sub-lecture-chunker] concept "${item.name}" slide ${item.slide.page_number}: ${errMsg(err)}`)
    }
  }

  return { ok: true, slides: slides.length, concepts_created: created, concepts_merged: merged }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: RunBody = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text) as RunBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  if (!body.user_id) return jsonResponse({ error: 'user_id required' }, 400)

  const admin = createAdminClient()
  const creds = await loadCanvasCreds(admin, body.user_id)
  if (!creds) return jsonResponse({ error: 'no Canvas credentials for user' }, 400)

  const limit = Math.min(body.limit ?? DEFAULT_LIMIT, HARD_CAP)

  // Find lectures that we haven't chunked yet. A lecture is "chunked" iff any
  // canvas_lecture_slide row references its external_id.
  const { data: lectures, error: lecErr } = await admin
    .from('normalized_events')
    .select('id, user_id, course_id, external_id, raw_payload')
    .eq('user_id', body.user_id)
    .eq('source_type', 'canvas_lecture')
    .eq('classification', 'academic')
    .is('cancelled_at', null)
    .limit(50)
  if (lecErr) return jsonResponse({ error: 'lecture load failed', detail: lecErr.message }, 500)

  const { data: alreadyChunked } = await admin
    .from('normalized_events')
    .select('raw_payload')
    .eq('user_id', body.user_id)
    .eq('source_type', SLIDES_SOURCE_TYPE)
  const chunkedLectureIds = new Set(
    (alreadyChunked ?? [])
      .map(r => (r.raw_payload as { lecture_id?: string } | null)?.lecture_id)
      .filter((x): x is string => typeof x === 'string'),
  )

  const candidates = (lectures ?? []) as LectureRow[]
  const pending = candidates
    .filter(r => {
      const rp = r.raw_payload ?? {}
      if (String(rp.lecture_type ?? '') !== 'slides') return false
      if (typeof rp.content_id !== 'number') return false
      if (chunkedLectureIds.has(r.external_id)) return false
      return true
    })
    .slice(0, limit)

  const results: Array<{ lecture_id: string; ok: boolean; slides: number; concepts_created: number; concepts_merged: number; error?: string }> = []
  for (const lec of pending) {
    try {
      const r = await processOneLecture(admin, creds, lec)
      results.push({ lecture_id: lec.external_id, ...r })
    } catch (err) {
      results.push({ lecture_id: lec.external_id, ok: false, slides: 0, concepts_created: 0, concepts_merged: 0, error: errMsg(err) })
    }
  }

  const totals = results.reduce(
    (acc, r) => ({
      slides: acc.slides + r.slides,
      concepts_created: acc.concepts_created + r.concepts_created,
      concepts_merged: acc.concepts_merged + r.concepts_merged,
      ok: acc.ok + (r.ok ? 1 : 0),
      failed: acc.failed + (r.ok ? 0 : 1),
    }),
    { slides: 0, concepts_created: 0, concepts_merged: 0, ok: 0, failed: 0 },
  )
  void CHUNK_PIPELINE_VERSION
  return jsonResponse({ ok: true, ...totals, candidates_scanned: pending.length, results })
})
