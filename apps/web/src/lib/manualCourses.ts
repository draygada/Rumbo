import { supabase } from './supabase'

export interface ManualCourseInput {
  name: string
  institution: string
  term: string
  course_code?: string
  instructor_name?: string
  start_date?: string | null
  end_date?: string | null
  website_url?: string | null
}

export interface ManualCourse extends ManualCourseInput {
  id: string
  user_id: string
  archived_at: string | null
  linked_canvas_course_id: string | null
  created_at: string
  updated_at: string
}

export interface ManualUpload {
  id: string
  manual_course_id: string
  original_filename: string
  stored_path: string
  mime_type: string
  file_size_bytes: number
  document_type: string | null
  uploaded_at: string
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
])

// -----------------------------------------------------------------
// CRUD on manual_courses (client-side via RLS)
// -----------------------------------------------------------------

export async function listManualCourses(includeArchived = false): Promise<ManualCourse[]> {
  const query = supabase
    .from('manual_courses')
    .select('*')
    .order('created_at', { ascending: false })
  const { data, error } = includeArchived ? await query : await query.is('archived_at', null)
  if (error) throw error
  return (data ?? []) as ManualCourse[]
}

export async function createManualCourse(input: ManualCourseInput): Promise<ManualCourse> {
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) throw new Error('Not signed in')
  const { data, error } = await supabase
    .from('manual_courses')
    .insert({ ...input, user_id: user.id })
    .select('*')
    .single()
  if (error) throw error
  return data as ManualCourse
}

export async function updateManualCourse(id: string, patch: Partial<ManualCourseInput>): Promise<ManualCourse> {
  const { data, error } = await supabase
    .from('manual_courses')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data as ManualCourse
}

export async function archiveManualCourse(id: string): Promise<void> {
  const { error } = await supabase
    .from('manual_courses')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function unarchiveManualCourse(id: string): Promise<void> {
  const { error } = await supabase
    .from('manual_courses')
    .update({ archived_at: null })
    .eq('id', id)
  if (error) throw error
}

// -----------------------------------------------------------------
// File uploads
// -----------------------------------------------------------------

function slugify(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
}

export async function uploadManualCourseFile(courseId: string, file: File): Promise<ManualUpload> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is over 25MB.')
  if (!ALLOWED_MIME.has(file.type)) throw new Error(`Unsupported file type: ${file.type || 'unknown'}`)
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) throw new Error('Not signed in')

  const path = `${user.id}/${courseId}/${crypto.randomUUID()}-${slugify(file.name)}`
  const { error: upErr } = await supabase.storage
    .from('manual-uploads')
    .upload(path, file, { contentType: file.type, upsert: false })
  if (upErr) throw upErr

  // Client cannot INSERT manual_uploads (no policy) — use the edge function so
  // ownership + normalized_event linkage happens server-side.
  // We insert a lightweight row via a service-role edge helper called
  // manual-upload-process. That function reads the file from storage, extracts
  // text, classifies doc type, and inserts both manual_uploads and
  // normalized_events. For that to work we first create a minimal upload row
  // via a small helper endpoint — collapsed into manual-upload-process here,
  // which accepts stored_path + filename + mime + size and creates the row.
  const { data, error } = await supabase.functions.invoke('manual-upload-process', {
    body: {
      manual_course_id: courseId,
      stored_path: path,
      original_filename: file.name,
      mime_type: file.type,
      file_size_bytes: file.size,
    },
  })
  if (error) throw error
  return data as ManualUpload
}

export async function listUploadsForCourse(courseId: string): Promise<ManualUpload[]> {
  const { data, error } = await supabase
    .from('manual_uploads')
    .select('*')
    .eq('manual_course_id', courseId)
    .order('uploaded_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as ManualUpload[]
}

// -----------------------------------------------------------------
// Website fetch
// -----------------------------------------------------------------

export interface WebsiteFetchResult {
  ok: boolean
  word_count?: number
  normalized_event_id?: string
  error?: string
}

export async function fetchCourseWebsite(courseId: string, url: string): Promise<WebsiteFetchResult> {
  const { data, error } = await supabase.functions.invoke('manual-website-fetch', {
    body: { manual_course_id: courseId, url },
  })
  if (error) {
    // Extract "context" body on non-2xx returns.
    // deno-lint-ignore no-explicit-any
    const ctx = (error as any).context
    const msg = ctx?.error ?? (error instanceof Error ? error.message : 'Fetch failed')
    return { ok: false, error: msg }
  }
  return data as WebsiteFetchResult
}
