// manual-upload-process — process an uploaded file into a normalized record.
//
// Called by the client after a successful direct-to-Storage upload. The client
// passes the stored path + basic metadata; this function inserts the
// manual_uploads row (server-side, service-role), downloads the file, extracts
// text (PDF via Claude, text/plain direct), classifies the document type,
// writes a normalized_events row, and links it back.
//
// Auth: verify_jwt = true. Uses the caller's JWT to enforce ownership.
//
// Reference: External Sources/manual-course-entry.md §4.1

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  classifyDocumentType,
  extractPdfText,
  sourceTypeForDocument,
  writeManualDocumentRecord,
} from '../_shared/manual-ingest.ts'
import { kickBrainPipeline } from '../_shared/brain-kick.ts'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
])

interface Body {
  manual_course_id?: string
  stored_path?: string
  original_filename?: string
  mime_type?: string
  file_size_bytes?: number
}

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const jwt = authHeader.slice('Bearer '.length)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return null
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const userId = await getUserIdFromRequest(req)
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: Body = {}
  try { body = await req.json() as Body } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const { manual_course_id, stored_path, original_filename, mime_type, file_size_bytes } = body
  if (!manual_course_id || !stored_path || !original_filename || !mime_type || typeof file_size_bytes !== 'number') {
    return jsonResponse({ error: 'missing required fields' }, 400)
  }
  // stored_path must be under the caller's user_id folder (defense in depth).
  if (!stored_path.startsWith(`${userId}/`)) return jsonResponse({ error: 'Forbidden path' }, 403)
  if (file_size_bytes > MAX_UPLOAD_BYTES) return jsonResponse({ error: 'File is over 25MB.' }, 413)
  if (!ALLOWED_MIME.has(mime_type)) return jsonResponse({ error: `Unsupported file type: ${mime_type}` }, 415)

  const admin = createAdminClient()

  // Confirm the course belongs to the caller.
  const { data: course, error: courseErr } = await admin
    .from('manual_courses')
    .select('id, user_id')
    .eq('id', manual_course_id)
    .maybeSingle()
  if (courseErr || !course) return jsonResponse({ error: 'Course not found' }, 404)
  if (course.user_id !== userId) return jsonResponse({ error: 'Forbidden' }, 403)

  // Insert the manual_uploads row now that ownership is proven.
  const { data: uploadRow, error: insertErr } = await admin
    .from('manual_uploads')
    .insert({
      user_id: userId,
      manual_course_id,
      original_filename,
      stored_path,
      mime_type,
      file_size_bytes,
    })
    .select('id, original_filename, stored_path, mime_type, file_size_bytes, manual_course_id, uploaded_at')
    .single()
  if (insertErr || !uploadRow) return jsonResponse({ error: `insert failed: ${insertErr?.message ?? 'unknown'}` }, 500)

  // Download the file bytes from Storage.
  const { data: blob, error: dlError } = await admin.storage.from('manual-uploads').download(stored_path)
  if (dlError || !blob) return jsonResponse({ error: `download failed: ${dlError?.message ?? 'unknown'}` }, 500)
  const arrayBuffer = await blob.arrayBuffer()

  let text = ''
  try {
    if (mime_type === 'application/pdf') {
      const base64 = bytesToBase64(new Uint8Array(arrayBuffer))
      text = await extractPdfText(base64)
    } else if (mime_type === 'text/plain') {
      text = new TextDecoder().decode(arrayBuffer).trim()
    } else {
      // .docx / image OCR deferred to a post-V0 parsing worker. Store filename
      // as normalized_text so the extraction pipeline still has a course anchor.
      text = `[binary content pending parse: ${original_filename}]`
    }
  } catch (err) {
    console.warn('[manual-upload] extraction error:', err)
    text = `[extraction failed: ${original_filename}]`
  }

  const documentType = text.startsWith('[') ? 'other' : await classifyDocumentType(text)
  const sourceType = sourceTypeForDocument(documentType)

  const normalizedEventId = await writeManualDocumentRecord(admin, {
    userId,
    manualCourseId: manual_course_id,
    manualUploadId: uploadRow.id,
    sourceType,
    originalFilename: original_filename,
    mimeType: mime_type,
    fileSizeBytes: file_size_bytes,
    documentType,
    normalizedText: text,
  })

  await admin
    .from('manual_uploads')
    .update({ document_type: documentType, normalized_event_id: normalizedEventId })
    .eq('id', uploadRow.id)

  // Kick brain-pipeline so uploaded syllabus content extracts into the graph
  // without waiting for the 6h cron tick.
  kickBrainPipeline(userId).catch(err => console.warn('[manual-upload] brain kick failed:', err))

  return jsonResponse({
    id: uploadRow.id,
    manual_course_id: uploadRow.manual_course_id,
    original_filename: uploadRow.original_filename,
    stored_path: uploadRow.stored_path,
    mime_type: uploadRow.mime_type,
    file_size_bytes: uploadRow.file_size_bytes,
    document_type: documentType,
    source_type: sourceType,
    uploaded_at: uploadRow.uploaded_at,
    normalized_event_id: normalizedEventId,
    text_length: text.length,
  })
})
