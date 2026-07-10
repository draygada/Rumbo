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
import { geminiReadPdf } from '../_shared/gemini.ts'

const MAX_SIZE_BYTES = 10 * 1024 * 1024
const MAX_FILES_PER_RUN = 8

interface Body {
  user_id?: string
  limit?: number
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

  // Pull candidate files. Filter Postgres-side to those without the extraction
  // marker in raw_payload. Optionally scope to one user.
  let query = admin
    .from('normalized_events')
    .select('id, user_id, external_id, source_type, raw_payload')
    .like('source_type', 'canvas_file_%')
    .is('cancelled_at', null)
    .is('raw_payload->>rumbo_content_extracted_at', null)
    .order('ingested_at', { ascending: true })
    .limit(limit)
  if (body.user_id) query = query.eq('user_id', body.user_id)
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
    const fileId = Number(payload.id)
    const mimeType = String(payload['content-type'] ?? '')
    const size = Number(payload.size ?? 0)

    if (!fileId) {
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: 'no file id' })
      continue
    }
    if (mimeType && mimeType !== 'application/pdf') {
      // V0: PDFs only. Mark extracted so we don't retry every run.
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
    if (downloaded.mime !== 'application/pdf') {
      await markExtracted(admin, row.id, payload, null, `downloaded mime: ${downloaded.mime}`)
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: `downloaded mime: ${downloaded.mime}` })
      continue
    }
    if (downloaded.size > MAX_SIZE_BYTES) {
      await markExtracted(admin, row.id, payload, null, `downloaded size ${downloaded.size} over ${MAX_SIZE_BYTES}`)
      results.push({ id: row.id, external_id: row.external_id, status: 'skipped', reason: 'downloaded_size_over_limit' })
      continue
    }

    const base64 = bytesToBase64(downloaded.bytes)
    const text = await geminiReadPdf({ base64Pdf: base64, prompt: EXTRACTION_PROMPT, maxTokens: 8000 })
    if (!text || text.length < 20) {
      // Gemini couldn't read it — mark extracted anyway to avoid retrying every run.
      await markExtracted(admin, row.id, payload, null, 'gemini returned empty')
      results.push({ id: row.id, external_id: row.external_id, status: 'failed', reason: 'gemini empty' })
      continue
    }

    // Success. Write the real content + reset extraction so brain-pipeline
    // reprocesses this record with the new text.
    const displayName = String(payload.display_name ?? payload.filename ?? downloaded.displayName)
    const normalizedText = `${displayName}\n\n${text}`.trim()
    await markExtracted(admin, row.id, payload, {
      normalized_text: normalizedText,
      bytes: downloaded.size,
      chars: normalizedText.length,
    }, null)
    results.push({
      id: row.id,
      external_id: row.external_id,
      status: 'done',
      bytes: downloaded.size,
      text_length: normalizedText.length,
    })
    kickedUsers.add(row.user_id)
  }

  // Fire-and-forget brain-pipeline kick per user whose files just got real
  // content, so the extraction queue gets drained without waiting for cron.
  for (const uid of kickedUsers) {
    kickBrainPipeline(uid).catch(err => console.warn('[canvas-file-extract] brain kick failed:', err))
  }

  return jsonResponse({ ok: true, processed: results.length, results })
})

const EXTRACTION_PROMPT =
  'Extract the full readable text of this document exactly as written. Do not summarize. Do not comment. Reproduce section headings, tables (as tab-separated rows), lists (with their bullets), and dates in the same order they appear. If a page has no text, skip it silently.'

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
    update.extraction_status = 'pending'  // brain-pipeline will re-extract from real text
    update.extracted_at = null
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
  await fetch(`${supabaseUrl}/functions/v1/brain-pipeline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ user_id: userId }),
  })
}
