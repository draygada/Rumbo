// canvas-file-extract — pulls Canvas file content (PDF only for V0), runs it
// through Gemini for text extraction, updates the normalized_events row with
// real content, and resets extraction_status='pending' so brain-pipeline
// reprocesses with the new text.
//
// Records eligible: canvas_file_* where raw_payload.rumbo_content_extracted_at
// is null. That marker prevents re-extracting the same file every run.
//
// Auth: fail-closed x-cron-secret.
// Reference: External Sources/canvas.md + Graph Pipeline/entity-extraction.md §5.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { downloadCanvasFile } from '../_shared/canvas.ts'
import { uploadLlamaParseJob } from '../_shared/llamaparse.ts'

const MAX_SIZE_BYTES = 10 * 1024 * 1024
const MAX_FILES_PER_RUN = 15  // Enqueue-only — no blocking parse — so many files per invocation is fine.

// LlamaParse-supported MIME types we'll enqueue. See docs.
const SUPPORTED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',  // .docx
  'application/msword',                                                        // .doc
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-powerpoint',                                             // .ppt
  'text/html',
  'text/markdown',
  'text/plain',
])

interface Body {
  user_id?: string
  limit?: number
  /**
   * Restrict extraction to one course, e.g. 'canvas_course_221697'.
   *
   * Default order is oldest-ingested-first across every course, which is right
   * for steady-state draining but wrong when you need a specific course usable
   * now — you end up paying LlamaParse for every unrelated file that happens to
   * be older. Added when a backlog of 128 files needed exactly 14 of them
   * extracted before a demo.
   */
  course_id?: string
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

interface FileRow {
  id: string
  user_id: string
  external_id: string
  source_type: string
  raw_payload: Record<string, unknown>
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: Body = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text) as Body
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const limit = Math.min(body.limit ?? MAX_FILES_PER_RUN, 20)
  const admin = createAdminClient()

  // Pull candidate files. Two sources:
  //   - canvas_file_* (direct file rows)
  //   - canvas_lecture where raw_payload.item_type = 'File' (module items whose
  //     underlying content is a Canvas file — we derive fileId from content_id)
  // ExternalUrl / Page / Discussion / Quiz lecture items have no downloadable
  // content and are filtered out server-side to save the fetch.
  let query = admin
    .from('normalized_events')
    .select('id, user_id, external_id, source_type, raw_payload')
    .or('source_type.like.canvas_file_%,and(source_type.eq.canvas_lecture,raw_payload->>item_type.eq.File)')
    .is('cancelled_at', null)
    .is('raw_payload->>rumbo_content_extracted_at', null)
    .is('raw_payload->>rumbo_llamaparse_enqueued_at', null)
    .order('ingested_at', { ascending: true })
    .limit(limit)
  if (body.user_id) query = query.eq('user_id', body.user_id)
  if (body.course_id) query = query.eq('course_id', body.course_id)
  const { data: candidates, error } = await query
  if (error) return jsonResponse({ error: `read failed: ${error.message}` }, 500)

  if (!candidates || candidates.length === 0) {
    return jsonResponse({ ok: true, processed: 0, results: [] })
  }

  // Cache PATs per user so we hit canvas_credentials once even for many files.
  const credsCache = new Map<string, { pat: string; baseUrl: string } | null>()
  async function getCreds(userId: string) {
    if (credsCache.has(userId)) return credsCache.get(userId) ?? null
    const { data } = await admin
      .from('canvas_credentials')
      .select('pat, base_url')
      .eq('user_id', userId)
      .maybeSingle()
    const creds = data ? { pat: data.pat as string, baseUrl: data.base_url as string } : null
    credsCache.set(userId, creds)
    return creds
  }

  const results: Array<{
    id: string
    external_id: string
    status: 'done' | 'skipped' | 'failed'
    reason?: string
    bytes?: number
    text_length?: number
  }> = []
  const kickedUsers = new Set<string>()

  for (const row of candidates as FileRow[]) {
    const payload = row.raw_payload ?? {}

    // For canvas_file_* the file id is on raw_payload.id.
    // For canvas_lecture the underlying content id is on raw_payload.content_id
    // AND the module item type must be 'File' (skip Pages, Discussions, etc.).
    let fileId = 0
    if (row.source_type === 'canvas_lecture') {
      // Canvas Modules API stores the module item's underlying type on
      // raw_payload.item_type ('File', 'Page', 'Discussion', 'ExternalUrl', ...).
      // Only 'File' items have a downloadable content_id we can hand to
      // Canvas Files API.
      const itemType = String(payload.item_type ?? '').toLowerCase()
      if (itemType !== 'file') {
        results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: `lecture item_type: ${itemType || 'unknown'}` })
        continue
      }
      fileId = Number(payload.content_id ?? 0)
    } else {
      fileId = Number(payload.id ?? 0)
    }

    const mimeType = String(payload['content-type'] ?? '')
    const size = Number(payload.size ?? 0)

    if (!fileId) {
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: 'no file id' })
      continue
    }
    if (mimeType && !SUPPORTED_MIMES.has(mimeType)) {
      // Unsupported by LlamaParse — mark extracted so we don't retry every run.
      await markExtracted(admin, row.id, payload, null, `unsupported mime: ${mimeType}`)
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: `unsupported mime: ${mimeType}` })
      continue
    }
    if (size && size > MAX_SIZE_BYTES) {
      await markExtracted(admin, row.id, payload, null, `size ${size} over ${MAX_SIZE_BYTES}`)
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: 'size_over_limit' })
      continue
    }

    const creds = await getCreds(row.user_id)
    if (!creds) {
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: 'no canvas credentials' })
      continue
    }

    const downloaded = await downloadCanvasFile(creds, fileId)
    if (!downloaded) {
      results.push({ id: row.id, external_id: row.external_id, status: 'failed', reason: 'download failed' })
      continue
    }
    if (!SUPPORTED_MIMES.has(downloaded.mime)) {
      await markExtracted(admin, row.id, payload, null, `downloaded mime: ${downloaded.mime}`)
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: `downloaded mime: ${downloaded.mime}` })
      continue
    }
    if (downloaded.size > MAX_SIZE_BYTES) {
      await markExtracted(admin, row.id, payload, null, `downloaded size ${downloaded.size} over ${MAX_SIZE_BYTES}`)
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: 'downloaded_size_over_limit' })
      continue
    }

    // Enqueue-only: upload to LlamaParse, get job_id, insert into queue.
    // Poller (separate cron) drains it and writes results back.
    const displayNameForParse = String(payload.display_name ?? payload.filename ?? downloaded.displayName ?? 'file')
    const upload = await uploadLlamaParseJob({
      fileBytes: downloaded.bytes,
      filename: displayNameForParse,
      mime: downloaded.mime,
      mode: 'parse_page_with_llm',  // balanced default per LlamaParse v1 enum
    })
    if ('error' in upload) {
      // Don't mark extracted — leave record eligible for retry on next run.
      // Only surface the reason in the response for immediate debugging.
      results.push({ id: row.id, external_id: row.external_id, status: 'failed', reason: `llamaparse upload: ${upload.error.slice(0, 200)}` })
      continue
    }

    // Insert queue row. Poller will drain.
    const { error: enqErr } = await admin.from('llamaparse_jobs').insert({
      user_id: row.user_id,
      normalized_event_id: row.id,
      llamaparse_job_id: upload.jobId,
      source_mime: downloaded.mime,
      source_display_name: displayNameForParse,
      status: 'pending',
    })
    if (enqErr) {
      // Job is at LlamaParse but we couldn't record it — mark file failed;
      // next run will re-enqueue (LlamaParse dedupes uploads by content).
      results.push({ id: row.id, external_id: row.external_id, status: 'failed', reason: `enqueue failed: ${enqErr.message.slice(0, 100)}` })
      continue
    }

    // Success path — mark the file as "extraction started" in raw_payload
    // so we don't re-enqueue. Poller will set normalized_text on completion.
    await markEnqueued(admin, row.id, payload, upload.jobId)
    results.push({
      id: row.id,
      external_id: row.external_id,
      status: 'done',
      bytes: downloaded.size,
      text_length: 0,
    })
    kickedUsers.add(row.user_id)
  }

  // No brain-pipeline kick here — content isn't written yet, poller will
  // kick brain-pipeline-v4 after each SUCCESS.
  void kickedUsers

  return jsonResponse({ ok: true, processed: results.length, results })
})

const EXTRACTION_PROMPT =
  'Extract the full readable text of this document exactly as written. Do not summarize. Do not comment. Reproduce section headings, tables (as tab-separated rows), lists (with their bullets), and dates in the same order they appear. If a page has no text, skip it silently.'

// Mark that a file has been enqueued for LlamaParse — set a marker in
// raw_payload so we don't re-enqueue it on the next canvas-file-extract run.
// The poller will call markExtracted (below) with the real text when the job
// completes.
async function markEnqueued(
  // deno-lint-ignore no-explicit-any
  admin: any,
  rowId: string,
  priorPayload: Record<string, unknown>,
  llamaparseJobId: string,
): Promise<void> {
  const now = new Date().toISOString()
  const rumbo = {
    rumbo_llamaparse_enqueued_at: now,
    rumbo_llamaparse_job_id: llamaparseJobId,
  }
  await admin
    .from('normalized_events')
    .update({ raw_payload: { ...priorPayload, ...rumbo } })
    .eq('id', rowId)
}

async function markExtracted(
  // deno-lint-ignore no-explicit-any
  admin: any,
  rowId: string,
  priorPayload: Record<string, unknown>,
  success: { normalized_text: string; bytes: number; chars: number } | null,
  errorReason: string | null,
): Promise<void> {
  const now = new Date().toISOString()
  const rumbo = {
    rumbo_content_extracted_at: now,
    rumbo_content_bytes: success?.bytes ?? null,
    rumbo_content_chars: success?.chars ?? null,
    rumbo_content_error: errorReason,
  }
  const update: Record<string, unknown> = {
    raw_payload: { ...priorPayload, ...rumbo },
  }
  if (success) {
    update.normalized_text = success.normalized_text
    update.extraction_status = 'pending'   // v3 re-extraction (if still enabled)
    update.extracted_at = null
    // v4 re-extraction: clear the v4 markers so brain-pipeline-v4 will re-run
    // this record against the newly-rich LlamaParse text. Also clear body_hash
    // so the hash-cache doesn't short-circuit.
    update.pipeline_version_v4 = null
    update.extracted_at_v4 = null
    update.body_hash = null
  }
  await admin.from('normalized_events').update(update).eq('id', rowId)
}

// Reuse the brain-kick pattern so newly-content-having files get processed
// without waiting for the 6h cron.
async function kickBrainPipeline(userId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  const isDev = Deno.env.get('SUPABASE_ENV') === 'dev'
  if (!supabaseUrl || !serviceKey || (!cronSecret && !isDev)) return
  await fetch(`${supabaseUrl}/functions/v1/brain-pipeline-v4`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ user_id: userId }),
  })
}
