// Canvas REST API adapter — pure functions returning parsed objects.
// Reference: Rumbo-Design-Docs/External Sources/canvas.md
//
// The adapter is deliberately thin: no caching, no side effects, no DB writes.
// Callers (canvas-verify, canvas-ingest) compose these helpers with the DB layer.

export interface CanvasCredentials {
  pat: string
  baseUrl: string  // e.g. "stanford.instructure.com" — no scheme
}

export interface CanvasCourse {
  id: number
  name: string
  course_code?: string
  syllabus_body?: string | null
  start_at?: string | null
  end_at?: string | null
  term?: { name?: string } | null
  workflow_state?: string
}

export interface CanvasAssignment {
  id: number
  name: string
  description?: string | null
  due_at?: string | null
  points_possible?: number | null
  assignment_group_id?: number | null
  submission_types?: string[]
  updated_at: string
  course_id: number
  workflow_state?: string
}

export interface CanvasUser {
  id: number
  name: string
  short_name?: string
  primary_email?: string
}

export interface CanvasFile {
  id: number
  display_name?: string
  filename?: string
  'content-type'?: string
  size?: number
  url?: string
  folder_id?: number
  created_at?: string
  updated_at?: string
  locked?: boolean
  hidden?: boolean
  workflow_state?: string
}

export type CanvasFileCategory = 'syllabus' | 'rubric' | 'project' | 'study' | 'reading' | 'document'

// Pull files that look like signal for the knowledge graph. Order matters —
// a filename like "Final Project Rubric.pdf" should classify as `rubric`
// (grading criteria), not `project` (spec). Highest-authority first.
const FILE_HEURISTICS: Array<{ category: CanvasFileCategory; pattern: RegExp }> = [
  {
    category: 'syllabus',
    pattern: /\bsyllabus\b|\bcourse[\s_-]*(info|overview|introduction|intro)\b|\bwelcome\b|\borientation\b/i,
  },
  {
    category: 'rubric',
    pattern: /\brubric\b|\bgrading[\s_-]*(criteria|guide|policy|policies|standard)?\b|\bguidelines?\b|\bpolicy\b|\bpolicies\b|\bexpectations?\b/i,
  },
  {
    category: 'project',
    pattern: /\bproject\b|\bfinal[\s_-]*project\b|\bcapstone\b|\bmilestone\b/i,
  },
  {
    category: 'study',
    pattern: /\bmidterm\b|\bfinal[\s_-]*exam\b|\bstudy[\s_-]*guide\b|\bpractice[\s_-]*(exam|midterm|final|test|quiz)\b|\breview[\s_-]*(sheet|packet|session)\b|\breading[\s_-]*list\b|\bbibliography\b|\b(course[\s_-]*)?schedule\b/i,
  },
  {
    category: 'reading',
    pattern: /\breading\b|\barticle\b|\bpaper\b|\bchapter\b|\bexcerpt\b|\bhandout\b|\bpacket\b/i,
  },
]

// Extensions we consider text-bearing document content (readings, lectures,
// notes). If a file matches no heuristic pattern but has one of these
// extensions AND passes size / state / mime checks, it gets ingested with
// category 'document' — the general fallback for text-y content.
const DOCUMENT_EXTENSIONS = /\.(pdf|docx?|pptx?|md|txt|rtf|odt|tex|html?)$/i

// Extensions / mimes we always exclude — pure noise for the graph.
const NOISE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|heic|mp4|mov|avi|mkv|webm|m4v|mp3|wav|ogg|flac|aac|zip|tar|gz|rar|7z|dmg|iso|exe|bin|apk|xcf|psd|ai|indd|dwg)$/i

// Files bigger than this are almost always non-textual (videos, large image
// packs, dataset dumps). Skip.
const MAX_INGEST_BYTES = 40 * 1024 * 1024

export function classifyCanvasFile(file: CanvasFile): CanvasFileCategory | null {
  const state = (file.workflow_state ?? '').toLowerCase()
  if (state === 'deleted' || state === 'locked' || file.locked || file.hidden) return null
  const size = file.size ?? 0
  if (size > MAX_INGEST_BYTES) return null
  const mime = (file['content-type'] ?? '').toLowerCase()
  // Skip anything that's obviously non-text by mime.
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) return null
  if (mime === 'application/zip' || mime === 'application/x-tar' || mime === 'application/x-rar-compressed') return null
  const nameSource = `${file.display_name ?? ''} ${file.filename ?? ''}`.trim()
  if (!nameSource) return null
  if (NOISE_EXTENSIONS.test(nameSource)) return null
  // Match highest-authority heuristic first.
  for (const { category, pattern } of FILE_HEURISTICS) {
    if (pattern.test(nameSource)) return category
  }
  // Fallback: general document if the extension looks textual.
  if (DOCUMENT_EXTENSIONS.test(nameSource)) return 'document'
  // No extension match AND no heuristic hit — skip (probably a binary blob).
  return null
}

// -----------------------------------------------------------------------------
// URL + fetch helpers
// -----------------------------------------------------------------------------

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  return trimmed
}

function apiUrl(baseUrl: string, path: string, params?: Record<string, string | string[]>): string {
  const host = normalizeBaseUrl(baseUrl)
  const url = new URL(`https://${host}/api/v1${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item)
      } else {
        url.searchParams.set(k, v)
      }
    }
  }
  return url.toString()
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const [urlPart, ...relParts] = part.split(';')
    const rel = relParts.join(';')
    if (rel.includes('rel="next"')) {
      return urlPart.trim().replace(/^</, '').replace(/>$/, '')
    }
  }
  return null
}

// Public error type so callers can distinguish auth failure (expire the token)
// from transient failures (retry) and rate limits (backoff).
export type CanvasErrorKind = 'auth' | 'network' | 'server' | 'rate_limit' | 'unknown'

export class CanvasError extends Error {
  constructor(message: string, public readonly status: number, public readonly kind: CanvasErrorKind) {
    super(message)
  }
}

async function canvasFetch(url: string, pat: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' },
    })
  } catch (err) {
    throw new CanvasError(`Network error: ${err instanceof Error ? err.message : String(err)}`, 0, 'network')
  }
  if (response.status === 401 || response.status === 403) {
    throw new CanvasError(`Canvas auth failed (${response.status})`, response.status, 'auth')
  }
  if (response.status === 429) {
    throw new CanvasError(`Canvas rate limited`, 429, 'rate_limit')
  }
  if (response.status >= 500) {
    throw new CanvasError(`Canvas server error (${response.status})`, response.status, 'server')
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new CanvasError(`Canvas request failed (${response.status}): ${body.slice(0, 200)}`, response.status, 'unknown')
  }
  return response
}

async function paginate<T>(startUrl: string, pat: string, cap = 20): Promise<T[]> {
  const results: T[] = []
  let url: string | null = startUrl
  let pages = 0
  while (url && pages < cap) {
    const response = await canvasFetch(url, pat)
    const batch = (await response.json()) as T[]
    if (Array.isArray(batch)) {
      results.push(...batch)
    }
    url = parseNextLink(response.headers.get('Link'))
    pages += 1
  }
  return results
}

// -----------------------------------------------------------------------------
// High-level endpoints
// -----------------------------------------------------------------------------

export async function getSelf(creds: CanvasCredentials): Promise<CanvasUser> {
  const response = await canvasFetch(apiUrl(creds.baseUrl, '/users/self'), creds.pat)
  return (await response.json()) as CanvasUser
}

export async function listCourses(creds: CanvasCredentials): Promise<CanvasCourse[]> {
  const url = apiUrl(creds.baseUrl, '/courses', {
    'enrollment_state[]': ['active', 'completed'],
    // include[] pulls extra fields per course:
    //   term          - term.name / start_at / end_at, used to filter archives
    //   syllabus_body - the syllabus text (source_type: canvas_syllabus)
    //   total_scores  - drives enrollments[] with real state, needed for
    //                   isCanvasCourseCurrent to detect completed enrollments
    'include[]': ['term', 'syllabus_body', 'total_scores'],
    per_page: '50',
  })
  return await paginate<CanvasCourse>(url, creds.pat)
}

export async function listAssignments(creds: CanvasCredentials, courseId: number): Promise<CanvasAssignment[]> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/assignments`, {
    order_by: 'due_at',
    per_page: '50',
    // rubric attaches to Assignment.rubric as JSON on the payload — see
    // canvas-modules-and-files.md §backlog. Included in the same call so we
    // don't multiply requests per course.
    'include[]': ['rubric'],
  })
  const items = await paginate<CanvasAssignment>(url, creds.pat)
  // Canvas doesn't always echo course_id on the assignment when fetched by-course.
  return items.map(a => ({ ...a, course_id: a.course_id ?? courseId }))
}

// -----------------------------------------------------------------------------
// Canvas Home Page (course front page)
// -----------------------------------------------------------------------------

export interface CanvasPage {
  page_id?: number
  url: string                    // page_url (slug), e.g. "welcome"
  title: string
  body?: string | null           // HTML
  updated_at?: string
  created_at?: string
  editing_roles?: string
  published?: boolean
  front_page?: boolean
  html_url?: string
}

export async function getCourseFrontPage(creds: CanvasCredentials, courseId: number): Promise<CanvasPage | null> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/front_page`)
  try {
    const response = await canvasFetch(url, creds.pat)
    return (await response.json()) as CanvasPage
  } catch (err) {
    // 404 when no front page is set — most courses. Return null quietly.
    if (err instanceof CanvasError && err.status === 404) return null
    // 401/403 tend to mean the course scopes are restricted — same swallow.
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) return null
    throw err
  }
}

export function normalizeCanvasHome(userId: string, courseId: number, page: CanvasPage): NormalizedRow | null {
  const bodyText = stripHtml(page.body ?? '')
  if (!bodyText && !page.title) return null
  const title = page.title?.trim() || 'Course home page'
  return {
    user_id: userId,
    source_type: 'canvas_home',
    external_id: `canvas_home_${courseId}`,
    timestamp: page.updated_at ?? page.created_at ?? null,
    course_id: `canvas_course_${courseId}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: {
      title,
      page_url: page.url,
      body_html: page.body,
      html_url: page.html_url,
      canvas_course_id: courseId,
    },
    normalized_text: `${title}\n\n${bodyText}`.trim(),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

// -----------------------------------------------------------------------------
// Canvas Announcements (course-scoped)
// -----------------------------------------------------------------------------

export interface CanvasAnnouncement {
  id: number
  title: string
  message?: string | null            // HTML
  posted_at?: string
  html_url?: string
  author?: { display_name?: string }
  context_code?: string              // 'course_1234'
}

export async function listAnnouncements(creds: CanvasCredentials, courseId: number, sinceIso?: string): Promise<CanvasAnnouncement[]> {
  // Canvas discussion_topics with only_announcements=true, filtered per course
  // via context_codes[]=course_<id>. Optional since= to constrain.
  const params: Record<string, string | string[]> = {
    'context_codes[]': [`course_${courseId}`],
    per_page: '50',
    active_only: 'true',
  }
  // Announcements endpoint requires start_date / end_date to be an actual
  // window; if we skip them, Canvas returns the last 14 days by default.
  if (sinceIso) params.start_date = sinceIso
  const url = apiUrl(creds.baseUrl, '/announcements', params)
  try {
    return await paginate<CanvasAnnouncement>(url, creds.pat)
  } catch (err) {
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) return []
    throw err
  }
}

export function normalizeCanvasAnnouncement(userId: string, courseId: number, ann: CanvasAnnouncement): NormalizedRow | null {
  const text = stripHtml(ann.message ?? '')
  const title = ann.title?.trim() || `Announcement ${ann.id}`
  // Skip trivial announcements ("class cancelled", one-liners) unless they have
  // real body content. Threshold is intentionally low — we want to keep
  // schedule-shift signal even if terse.
  if (!text && title.length < 8) return null
  return {
    user_id: userId,
    source_type: 'canvas_announcement',
    external_id: `canvas_announcement_${ann.id}`,
    timestamp: ann.posted_at ?? null,
    course_id: `canvas_course_${courseId}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: {
      title,
      message_html: ann.message,
      html_url: ann.html_url,
      author: ann.author?.display_name ?? null,
      canvas_course_id: courseId,
      canvas_announcement_id: ann.id,
    },
    normalized_text: `${title}\n\n${text}`.trim(),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

// -----------------------------------------------------------------------------
// Canvas Pages (non-Module wiki pages)
//
// Distinct from front_page (which is one specific page). listPages returns
// every published page in the course; getPageBody fetches body for one.
// -----------------------------------------------------------------------------

export async function listPages(creds: CanvasCredentials, courseId: number): Promise<CanvasPage[]> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/pages`, {
    per_page: '50',
    published: 'true',
  })
  try {
    return await paginate<CanvasPage>(url, creds.pat)
  } catch (err) {
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) return []
    throw err
  }
}

export async function getPageBody(creds: CanvasCredentials, courseId: number, pageUrl: string): Promise<CanvasPage | null> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/pages/${encodeURIComponent(pageUrl)}`)
  try {
    const response = await canvasFetch(url, creds.pat)
    return (await response.json()) as CanvasPage
  } catch (err) {
    if (err instanceof CanvasError && err.status === 404) return null
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) return null
    throw err
  }
}

export function normalizeCanvasPage(userId: string, courseId: number, page: CanvasPage): NormalizedRow | null {
  const bodyText = stripHtml(page.body ?? '')
  const title = page.title?.trim() || 'Page'
  // A page with no body and no meaningful title is noise. Requires either.
  if (!bodyText && title.length < 4) return null
  return {
    user_id: userId,
    source_type: 'canvas_page',
    external_id: `canvas_page_${courseId}_${page.url}`,
    timestamp: page.updated_at ?? page.created_at ?? null,
    course_id: `canvas_course_${courseId}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: {
      title,
      page_url: page.url,
      body_html: page.body,
      html_url: page.html_url,
      canvas_course_id: courseId,
    },
    normalized_text: `${title}\n\n${bodyText}`.trim(),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

// -----------------------------------------------------------------------------
// Rubric attached to an Assignment
//
// Canvas returns the rubric on the Assignment payload when we include[]=rubric
// on the listAssignments call. This normalizer produces a distinct rubric row
// only when there's substantive rubric content — the assignment itself is
// already ingested via normalizeAssignment.
// -----------------------------------------------------------------------------

export interface CanvasRubricCriterion {
  id?: string
  description?: string
  long_description?: string
  points?: number
  ratings?: Array<{ description?: string; points?: number; long_description?: string }>
}

export function extractAssignmentRubric(assignment: CanvasAssignment & { rubric?: CanvasRubricCriterion[] }): CanvasRubricCriterion[] | null {
  const rubric = assignment.rubric
  if (!Array.isArray(rubric) || rubric.length === 0) return null
  return rubric
}

export function normalizeAssignmentRubric(userId: string, assignment: CanvasAssignment & { rubric?: CanvasRubricCriterion[] }): NormalizedRow | null {
  const rubric = extractAssignmentRubric(assignment)
  if (!rubric) return null
  // Flatten rubric criteria into readable text — every criterion becomes a
  // paragraph so extraction sees each grading concept.
  const paragraphs = rubric.map(cr => {
    const heading = cr.description?.trim() || cr.long_description?.trim() || ''
    const points = typeof cr.points === 'number' ? ` (${cr.points} pts)` : ''
    const long = cr.long_description?.trim() && cr.long_description !== heading
      ? `\n${cr.long_description.trim()}`
      : ''
    const rating = (cr.ratings ?? [])
      .filter(r => (r.description || r.long_description) && typeof r.points === 'number')
      .map(r => `- ${r.description ?? r.long_description}${typeof r.points === 'number' ? ` (${r.points})` : ''}`)
      .join('\n')
    return `${heading}${points}${long}${rating ? `\n${rating}` : ''}`.trim()
  }).filter(Boolean)
  const body = paragraphs.join('\n\n')
  if (!body) return null
  return {
    user_id: userId,
    source_type: 'canvas_assignment_rubric',
    external_id: `canvas_rubric_${assignment.id}`,
    timestamp: assignment.updated_at ?? null,
    course_id: `canvas_course_${assignment.course_id}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: {
      canvas_assignment_id: assignment.id,
      assignment_name: assignment.name,
      rubric,
      canvas_course_id: assignment.course_id,
    },
    normalized_text: `Rubric for ${assignment.name}\n\n${body}`.trim(),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

// Fetches the file's fresh metadata (URL contains a short-lived verifier), then
// downloads the file bytes. Returns null on any failure so the caller can just
// skip that file and continue.
export async function downloadCanvasFile(
  creds: CanvasCredentials,
  fileId: number,
): Promise<{ bytes: Uint8Array; mime: string; size: number; displayName: string } | null> {
  try {
    const metaRes = await canvasFetch(apiUrl(creds.baseUrl, `/files/${fileId}`), creds.pat)
    const meta = (await metaRes.json()) as CanvasFile
    if (!meta.url) return null
    // Download the actual bytes. Canvas download URLs contain a verifier token
    // and don't need the Authorization header, but sending it is harmless.
    const dlRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${creds.pat}` } })
    if (!dlRes.ok) return null
    const ab = await dlRes.arrayBuffer()
    return {
      bytes: new Uint8Array(ab),
      mime: meta['content-type'] || 'application/octet-stream',
      size: meta.size ?? ab.byteLength,
      displayName: meta.display_name || meta.filename || `file_${fileId}`,
    }
  } catch {
    return null
  }
}

export async function listFiles(creds: CanvasCredentials, courseId: number): Promise<CanvasFile[]> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/files`, {
    per_page: '100',
  })
  try {
    return await paginate<CanvasFile>(url, creds.pat)
  } catch (err) {
    // Some Canvas installs restrict the files endpoint per-role. Treat as
    // no-files rather than blowing up the whole course sync.
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) {
      return []
    }
    throw err
  }
}

// -----------------------------------------------------------------------------
// Normalization: Canvas payload → normalized_events row shape
// -----------------------------------------------------------------------------

function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export const INGESTION_PIPELINE_VERSION = 'ingestion-v0.1'

// classification: 'academic' feeds the graph; 'administrative' is stored but
// excluded from extraction. 'personal' / 'pending' / 'irrelevant' /
// 'out_of_window' are used by other sources.
export type NormalizedClassification =
  | 'academic'
  | 'administrative'
  | 'personal'
  | 'pending'
  | 'irrelevant'
  | 'out_of_window'

export interface NormalizedRow {
  user_id: string
  source_type: string
  external_id: string
  timestamp: string | null
  course_id: string | null
  classification: NormalizedClassification
  classification_source: 'heuristic'
  raw_payload: unknown
  normalized_text: string
  pipeline_version: string
}

// Canonicalize repetitive assignment names so weekly participation / reading
// response / discussion posts don't spawn N separate graph nodes (one per
// week). Extraction sees the same normalized text across weeks and resolution
// merges them into a single canonical concept.
//
// Original name is kept in raw_payload for provenance / dashboard display.
export function canonicalizeAssignmentName(name: string): string {
  const patterns: Array<{ pattern: RegExp; canonical: string }> = [
    { pattern: /(week\s*\d+|w\d+|weekly|session\s*\d+|day\s*\d+)\s+(participation|attendance|show[\s\-_]*up|pre[\s\-_]*class|check[\s\-_]*in)/i, canonical: 'Weekly Participation' },
    { pattern: /(week\s*\d+|w\d+|weekly)\s+(reading[\s\-_]*response|response|reflection)/i, canonical: 'Weekly Reading Response' },
    { pattern: /(week\s*\d+|w\d+|weekly)\s+(discussion|forum|post|thread)/i, canonical: 'Weekly Discussion Post' },
    { pattern: /(week\s*\d+|w\d+|weekly)\s+(quiz|check|assessment)/i, canonical: 'Weekly Quiz' },
    { pattern: /(week\s*\d+|w\d+|weekly)\s+(reading|assignment)/i, canonical: 'Weekly Reading' },
    // Standalone (no week prefix)
    { pattern: /^\s*participation(\s*(assignment|task|score|grade))?\s*$/i, canonical: 'Participation' },
    { pattern: /^\s*attendance(\s*(record|check|grade))?\s*$/i, canonical: 'Attendance' },
    { pattern: /^\s*(pre|post)[\s\-_]*class(\s*(work|reading|assignment))?\s*$/i, canonical: 'Pre-Class Work' },
  ]
  for (const { pattern, canonical } of patterns) {
    if (pattern.test(name)) return canonical
  }
  return name.trim()
}

// Assignment "signal" heuristic — only `academic` items enter the graph
// (brain-extraction skips non-academic classifications). Administrative shells
// with no due date, no description, no points, and no submission target are
// preserved in normalized_events but never enrich the knowledge graph.
export function classifyAssignmentSignal(assignment: CanvasAssignment): NormalizedClassification {
  const state = (assignment.workflow_state ?? '').toLowerCase()
  // Explicit non-published states = administrative.
  if (state === 'unpublished' || state === 'deleted' || state === 'failed_to_import') {
    return 'administrative'
  }
  const description = stripHtml(assignment.description ?? '').trim()
  const hasDue = Boolean(assignment.due_at)
  const hasDescription = description.length >= 30
  const hasPoints = typeof assignment.points_possible === 'number' && assignment.points_possible >= 1
  const submissionTypes = assignment.submission_types ?? []
  const hasSubmission = submissionTypes.some(s => s && s !== 'none')
  return (hasDue || hasDescription || hasPoints || hasSubmission) ? 'academic' : 'administrative'
}

export function normalizeCourse(userId: string, course: CanvasCourse): NormalizedRow {
  const syllabusText = stripHtml(course.syllabus_body ?? '')
  const parts = [
    course.name,
    course.course_code ? `(${course.course_code})` : '',
    course.term?.name ?? '',
  ].filter(Boolean)
  return {
    user_id: userId,
    source_type: 'canvas_course',
    external_id: `canvas_course_${course.id}`,
    timestamp: course.start_at ?? null,
    course_id: `canvas_course_${course.id}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: { ...course, syllabus_available: Boolean(syllabusText) },
    normalized_text: parts.join(' '),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

export function normalizeSyllabus(userId: string, course: CanvasCourse): NormalizedRow | null {
  const text = stripHtml(course.syllabus_body ?? '')
  if (!text) return null
  return {
    user_id: userId,
    source_type: 'canvas_syllabus',
    external_id: `canvas_syllabus_${course.id}`,
    timestamp: course.start_at ?? null,
    course_id: `canvas_course_${course.id}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: { syllabus_body: course.syllabus_body, course_id: course.id },
    normalized_text: `${course.name}\n\n${text}`,
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

const FILE_CATEGORY_SOURCE_TYPE: Record<CanvasFileCategory, string> = {
  syllabus: 'canvas_file_syllabus',
  rubric:   'canvas_file_rubric',
  project:  'canvas_file_project',
  study:    'canvas_file_study',
  reading:  'canvas_file_reading',
  document: 'canvas_file_document',
}

// Metadata-only ingest for a signal-carrying Canvas file. Content extraction
// (PDF → text) is a follow-up; for now the graph sees filename + course link,
// which is enough to create the file node and connect it to the course.
export function normalizeCanvasFile(userId: string, file: CanvasFile, category: CanvasFileCategory, courseId: number): NormalizedRow {
  const displayName = file.display_name || file.filename || `Canvas file ${file.id}`
  return {
    user_id: userId,
    source_type: FILE_CATEGORY_SOURCE_TYPE[category],
    external_id: `canvas_file_${file.id}`,
    timestamp: file.updated_at ?? file.created_at ?? null,
    course_id: `canvas_course_${courseId}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: { ...file, canvas_course_id: courseId, file_category: category },
    normalized_text: displayName,
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

export function normalizeAssignment(userId: string, assignment: CanvasAssignment): NormalizedRow {
  const description = stripHtml(assignment.description ?? '')
  const pointsSuffix = assignment.points_possible != null ? ` Worth ${assignment.points_possible} points.` : ''
  const canonicalName = canonicalizeAssignmentName(assignment.name)
  return {
    user_id: userId,
    source_type: 'canvas_assignment',
    external_id: `canvas_assignment_${assignment.id}`,
    timestamp: assignment.due_at ?? null,
    course_id: `canvas_course_${assignment.course_id}`,
    classification: classifyAssignmentSignal(assignment),
    classification_source: 'heuristic',
    // raw_payload keeps the original name; rumbo_canonical_name is the
    // extraction-facing form. That way the dashboard still shows the real
    // "Week 3 Participation" while the graph sees "Weekly Participation".
    raw_payload: { ...assignment, rumbo_canonical_name: canonicalName },
    normalized_text: `${canonicalName}. ${description}${pointsSuffix}`.trim(),
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

// -----------------------------------------------------------------------------
// Enrollment window: current + prior academic year
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Canvas Modules — lecture-level ingestion (§Rumbo-Design-Docs/External Sources/canvas-modules-and-files.md)
// -----------------------------------------------------------------------------

export interface CanvasModule {
  id: number
  name: string
  position?: number
  workflow_state?: string
  updated_at?: string
}

export interface CanvasModuleItem {
  id: number
  module_id: number
  title: string
  type: string          // 'File' | 'Page' | 'ExternalUrl' | 'Assignment' | 'Quiz' | 'Discussion' | 'SubHeader'
  content_id?: number   // Canvas file/page/assignment id, per item type
  html_url?: string
  external_url?: string
  page_url?: string
  position?: number
  published?: boolean
  workflow_state?: string
}

// Item types the lecture ingester keeps. Assignments/quizzes/discussions are
// already ingested via other paths; SubHeaders are organizational text.
const LECTURE_ITEM_TYPES = new Set(['File', 'Page', 'ExternalUrl'])

export function isLectureModuleItem(item: CanvasModuleItem): boolean {
  if (!LECTURE_ITEM_TYPES.has(item.type)) return false
  if (item.workflow_state === 'unpublished' || item.workflow_state === 'deleted') return false
  return true
}

// Rough classifier for lecture item -> Neo4j Lecture.lecture_type property.
export function lectureTypeFor(item: CanvasModuleItem): 'slides' | 'notes' | 'external' | 'video_link' {
  if (item.type === 'ExternalUrl') {
    const url = (item.external_url || '').toLowerCase()
    if (/(zoom|panopto|youtube|vimeo|loom)/i.test(url)) return 'video_link'
    return 'external'
  }
  if (item.type === 'File') return 'slides'      // most File items in Modules are slide decks
  return 'notes'                                   // Pages are notes docs
}

export async function listModules(creds: CanvasCredentials, courseId: number): Promise<CanvasModule[]> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/modules`, { per_page: '100' })
  try {
    return await paginate<CanvasModule>(url, creds.pat)
  } catch (err) {
    // Not all Canvas instances expose Modules to every role. Treat as
    // no-modules rather than aborting the course sync.
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) return []
    throw err
  }
}

export async function listModuleItems(creds: CanvasCredentials, courseId: number, moduleId: number): Promise<CanvasModuleItem[]> {
  const url = apiUrl(creds.baseUrl, `/courses/${courseId}/modules/${moduleId}/items`, { per_page: '100' })
  try {
    return await paginate<CanvasModuleItem>(url, creds.pat)
  } catch (err) {
    if (err instanceof CanvasError && (err.kind === 'auth' || err.status === 403)) return []
    throw err
  }
}

export function normalizeCanvasLecture(
  userId: string,
  courseId: number,
  module: CanvasModule,
  item: CanvasModuleItem,
): NormalizedRow {
  const title = item.title?.trim() || `Module ${module.id} Item ${item.id}`
  const moduleName = module.name?.trim() || `Module ${module.id}`
  const normalizedText = `${moduleName}: ${title}`
  return {
    user_id: userId,
    source_type: 'canvas_lecture',
    external_id: `canvas_lecture_${item.id}`,
    timestamp: null, // Modules API doesn't expose a per-item date
    course_id: `canvas_course_${courseId}`,
    classification: 'academic',
    classification_source: 'heuristic',
    raw_payload: {
      module_id: module.id,
      module_name: moduleName,
      module_position: module.position,
      item_id: item.id,
      item_title: title,
      item_type: item.type,
      item_position: item.position,
      html_url: item.html_url,
      external_url: item.external_url,
      page_url: item.page_url,
      content_id: item.content_id,
      lecture_type: lectureTypeFor(item),
      canvas_course_id: courseId,
    },
    normalized_text: normalizedText,
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
}

// -----------------------------------------------------------------------------
// Enrollment window: current + prior academic year
// -----------------------------------------------------------------------------

export function courseInEnrollmentWindow(course: CanvasCourse, now = new Date()): boolean {
  if (!course.end_at) return true  // no end_at = keep (ongoing)
  const endAt = new Date(course.end_at)
  if (Number.isNaN(endAt.getTime())) return true
  const cutoff = new Date(now.getFullYear() - 1, 8, 1)  // Sep 1 of prior year
  return endAt >= cutoff
}
