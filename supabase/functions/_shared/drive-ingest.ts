// Google Drive ingestion adapter — metadata + on-demand content extraction.
// Reference: Rumbo-Design-Docs/External Sources/google-drive.md
//
// Two-speed sync (google-drive.md §3):
//   Metadata — every 6h, driven by drive-ingest cron. Uses Drive Changes API
//              with a startPageToken. First-run backfill via files.list() then
//              captures a fresh startPageToken.
//   Content  — lazy, on-demand. Triggered by dequeuing drive_content_queue.
//
// Relevance classifier (§5): Haiku per new/changed metadata record.
//   Fast-path exclusions before the LLM: non-extractable types, trashed files.
//   Shared-file rule: include only when (a) file is inside a folder the student
//   owns, or (b) sharer is on an .edu domain.
//
// Asymmetric suppression: any classifier failure → 'pending', never 'academic'.

import { INGESTION_PIPELINE_VERSION } from './canvas.ts'
import { refreshGoogleAccessToken } from './google-calendar.ts'
import { GoogleApiError, getFreshAccessToken as getFreshAccessTokenBase } from './google-calendar-ingest.ts'
import { geminiClassifyJson } from './gemini.ts'

export { GoogleApiError }

// deno-lint-ignore no-explicit-any
type AdminClient = any

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_FIELDS =
  'id, name, mimeType, modifiedTime, parents, owners(emailAddress,me), sharingUser(emailAddress), size, trashed, ownedByMe'
export const DRIVE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024 // 10 MB — google-drive.md §3.2 (Cat B)
export const DRIVE_CLASSIFY_COMMIT_THRESHOLD = 0.75 // slightly lower than calendar — more label surface
export const DRIVE_MAX_CLASSIFICATIONS_PER_RUN = 250

// Re-export the Calendar token helper — same connection row, same behavior.
export const getFreshAccessToken = getFreshAccessTokenBase

// -----------------------------------------------------------------------------
// Drive REST helpers
// -----------------------------------------------------------------------------

export interface DriveFile {
  id: string
  name?: string
  mimeType?: string
  modifiedTime?: string
  parents?: string[]
  owners?: Array<{ emailAddress?: string; me?: boolean }>
  sharingUser?: { emailAddress?: string }
  size?: string
  trashed?: boolean
  ownedByMe?: boolean
}

async function driveFetch(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw new GoogleApiError(`Drive ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
  }
  return res
}

export async function getStartPageToken(accessToken: string): Promise<string> {
  const res = await driveFetch(`${DRIVE_API}/changes/startPageToken`, accessToken)
  const data = await res.json()
  return data.startPageToken as string
}

export interface FilesPage {
  files: DriveFile[]
  nextPageToken?: string
}

export async function listFilesPage(
  accessToken: string,
  pageToken?: string,
  pageSize = 200,
): Promise<FilesPage> {
  const params = new URLSearchParams({
    fields: `nextPageToken, files(${DRIVE_FIELDS})`,
    pageSize: String(pageSize),
    q: 'trashed = false',
    corpora: 'user',
    spaces: 'drive',
  })
  if (pageToken) params.set('pageToken', pageToken)
  const res = await driveFetch(`${DRIVE_API}/files?${params}`, accessToken)
  return await res.json()
}

export interface ChangesPage {
  changes: Array<{ file?: DriveFile; fileId?: string; removed?: boolean }>
  nextPageToken?: string
  newStartPageToken?: string
}

export async function listChangesPage(
  accessToken: string,
  pageToken: string,
  pageSize = 200,
): Promise<ChangesPage> {
  const params = new URLSearchParams({
    pageToken,
    pageSize: String(pageSize),
    fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${DRIVE_FIELDS}))`,
    spaces: 'drive',
    includeRemoved: 'true',
    restrictToMyDrive: 'true',
  })
  const res = await driveFetch(`${DRIVE_API}/changes?${params}`, accessToken)
  return await res.json()
}

// -----------------------------------------------------------------------------
// Relevance classification (google-drive.md §5)
// -----------------------------------------------------------------------------

const NON_EXTRACTABLE_PREFIXES = ['image/', 'audio/', 'video/']
const NON_EXTRACTABLE_MIMES = new Set([
  'application/vnd.google-apps.folder',
  'application/vnd.google-apps.shortcut',
  'application/vnd.google-apps.form',
  'application/vnd.google-apps.site',
  'application/vnd.google-apps.map',
  'application/vnd.google-apps.drawing',
])

export function fastPathExclusion(file: DriveFile): 'irrelevant' | null {
  if (file.trashed) return 'irrelevant'
  const mime = file.mimeType ?? ''
  if (NON_EXTRACTABLE_MIMES.has(mime)) return 'irrelevant'
  if (NON_EXTRACTABLE_PREFIXES.some(p => mime.startsWith(p))) return 'irrelevant'
  return null
}

// Shared-file gate — google-drive.md §5.
// Only files the student owns, OR files shared from an .edu domain, are eligible
// for the classifier. Anything else short-circuits to 'irrelevant'.
export function sharedFileGate(
  file: DriveFile,
  ownedFolderIds: Set<string>,
): 'irrelevant' | null {
  if (file.ownedByMe) return null
  const parents = file.parents ?? []
  if (parents.some(p => ownedFolderIds.has(p))) return null
  const sharerDomain = (file.sharingUser?.emailAddress ?? '').split('@')[1] ?? ''
  if (sharerDomain.endsWith('.edu')) return null
  return 'irrelevant'
}

export interface DriveClassificationResult {
  classification: 'academic' | 'personal' | 'irrelevant'
  confidence: number
}

const DRIVE_CLASSIFIER_SYSTEM_PROMPT =
  'You classify a Google Drive file as academic, personal, or irrelevant to a student\'s coursework.\n' +
  'academic: coursework, lecture notes, syllabi, homework, readings, study materials, papers, problem sets.\n' +
  'personal: personal writing, family photos, personal finance, non-course job docs, hobby projects.\n' +
  'irrelevant: system files, screenshots, downloaded random PDFs with no clear academic content.\n' +
  'Base your judgment on file name, MIME type, parent folder, owner, sharer. If unsure, use low confidence.'

export async function classifyDriveFile(
  file: DriveFile,
  parentFolderNames: string[],
): Promise<DriveClassificationResult | null> {
  const owner = file.owners?.[0]?.emailAddress ?? ''
  const sharer = file.sharingUser?.emailAddress ?? ''
  const summary = [
    `File name: ${file.name ?? '(unnamed)'}`,
    `MIME: ${file.mimeType ?? '(unknown)'}`,
    `Parent folders: ${parentFolderNames.join(', ') || '(none/root)'}`,
    `Owned by student: ${file.ownedByMe ? 'yes' : 'no'}`,
    `Owner email: ${owner}`,
    sharer ? `Shared by: ${sharer}` : '',
  ].filter(Boolean).join('\n')

  const parsed = await geminiClassifyJson<{ classification: string; confidence: number }>({
    system: DRIVE_CLASSIFIER_SYSTEM_PROMPT,
    userText: summary,
    schema: {
      type: 'object',
      properties: {
        classification: { type: 'string', enum: ['academic', 'personal', 'irrelevant'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['classification', 'confidence'],
    },
    maxTokens: 100,
  })
  if (!parsed) return null
  if (!['academic', 'personal', 'irrelevant'].includes(parsed.classification)) return null
  const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0
  return { classification: parsed.classification as 'academic' | 'personal' | 'irrelevant', confidence }
}

// -----------------------------------------------------------------------------
// Normalization
// -----------------------------------------------------------------------------

function externalIdFor(fileId: string): string {
  return `drive_${fileId}`
}

function timestampForFile(file: DriveFile): string | null {
  if (!file.modifiedTime) return null
  const d = new Date(file.modifiedTime)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// -----------------------------------------------------------------------------
// Owned-folder discovery (for shared-file gate)
// -----------------------------------------------------------------------------

async function fetchOwnedFolderIds(accessToken: string): Promise<Set<string>> {
  const ids = new Set<string>()
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.folder' and 'me' in owners and trashed = false",
      fields: 'nextPageToken, files(id)',
      pageSize: '1000',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const res = await driveFetch(`${DRIVE_API}/files?${params}`, accessToken)
    const data = await res.json()
    for (const f of (data.files ?? []) as DriveFile[]) if (f.id) ids.add(f.id)
    pageToken = data.nextPageToken
  } while (pageToken)
  return ids
}

// -----------------------------------------------------------------------------
// Upsert metadata rows into normalized_events
// -----------------------------------------------------------------------------

const CHUNK = 200

export interface DriveSyncStats {
  processed: number
  upserted: number
  removed: number
  classified: number
  pending: number
  irrelevant: number
}

interface FolderNameLookup {
  get(folderId: string): string
}

async function fetchFolderNames(accessToken: string, ids: Set<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const id of ids) {
    try {
      const res = await driveFetch(
        `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,name`,
        accessToken,
      )
      const data = await res.json()
      if (data.id && data.name) names.set(data.id, data.name)
    } catch {
      // Non-fatal — classifier gets '(unknown)' for that parent.
    }
  }
  return names
}

// Writes metadata rows for each file. Committed classifications are sticky.
// Removed files (from Changes API) get soft-deleted via cancelled_at.
async function upsertFileMetadata(
  admin: AdminClient,
  userId: string,
  files: DriveFile[],
  removedIds: Set<string>,
  ownedFolderIds: Set<string>,
  accessToken: string,
  classifierBudget: { remaining: number },
): Promise<DriveSyncStats> {
  const stats: DriveSyncStats = {
    processed: 0, upserted: 0, removed: 0, classified: 0, pending: 0, irrelevant: 0,
  }

  const nowIso = new Date().toISOString()
  const rows: Record<string, unknown>[] = []

  // Handle removed ids: soft-delete existing rows if present.
  if (removedIds.size > 0) {
    const externalIds = Array.from(removedIds).map(externalIdFor)
    for (let i = 0; i < externalIds.length; i += CHUNK) {
      const chunk = externalIds.slice(i, i + CHUNK)
      const { error } = await admin
        .from('normalized_events')
        .update({ cancelled_at: nowIso })
        .eq('user_id', userId)
        .eq('source_type', 'drive')
        .in('external_id', chunk)
        .is('cancelled_at', null)
      if (!error) stats.removed += chunk.length
    }
  }

  if (files.length === 0) return stats

  // Sticky classification: fetch prior classifications for these files.
  const externalIds = files.map(f => externalIdFor(f.id))
  const existing = new Map<string, { classification: string | null; confidence: number | null }>()
  for (let i = 0; i < externalIds.length; i += CHUNK) {
    const chunk = externalIds.slice(i, i + CHUNK)
    const { data, error } = await admin
      .from('normalized_events')
      .select('external_id, classification, classification_confidence')
      .eq('user_id', userId)
      .eq('source_type', 'drive')
      .in('external_id', chunk)
    if (error) throw new Error(`existing drive classifications read failed: ${error.message}`)
    for (const row of data ?? []) {
      existing.set(row.external_id, {
        classification: row.classification,
        confidence: row.classification_confidence,
      })
    }
  }

  // Resolve parent folder names once for classifier prompts.
  const parentIds = new Set<string>()
  for (const f of files) for (const p of f.parents ?? []) parentIds.add(p)
  const folderNames = await fetchFolderNames(accessToken, parentIds)
  const lookup: FolderNameLookup = { get: (id: string) => folderNames.get(id) ?? '(unknown)' }

  for (const file of files) {
    if (!file.id) continue
    stats.processed += 1
    const externalId = externalIdFor(file.id)
    const prior = existing.get(externalId)
    const priorCommitted =
      prior?.classification === 'academic' ||
      prior?.classification === 'personal' ||
      prior?.classification === 'irrelevant'

    let classification: string = prior?.classification ?? 'pending'
    let confidence: number | null = prior?.confidence ?? null
    let classificationSource: string | null = priorCommitted ? (prior?.confidence != null ? 'llm' : 'heuristic') : null

    if (!priorCommitted) {
      // Fast-path exclusions.
      const fastExclude = fastPathExclusion(file) ?? sharedFileGate(file, ownedFolderIds)
      if (fastExclude) {
        classification = fastExclude
        classificationSource = 'heuristic'
        stats.irrelevant += 1
      } else if (classifierBudget.remaining > 0) {
        classifierBudget.remaining -= 1
        const parentNames = (file.parents ?? []).map(p => lookup.get(p))
        const result = await classifyDriveFile(file, parentNames)
        if (result && result.confidence >= DRIVE_CLASSIFY_COMMIT_THRESHOLD) {
          classification = result.classification
          confidence = result.confidence
          classificationSource = 'llm'
          if (result.classification === 'irrelevant') stats.irrelevant += 1
          else stats.classified += 1
        } else {
          classification = 'pending'
          confidence = result?.confidence ?? null
          classificationSource = result ? 'llm' : null
          stats.pending += 1
        }
      } else {
        stats.pending += 1
      }
    }

    rows.push({
      user_id: userId,
      source_type: 'drive',
      external_id: externalId,
      timestamp: timestampForFile(file),
      course_id: null,
      classification,
      classification_source: classificationSource,
      classification_confidence: confidence,
      raw_payload: file,
      normalized_text: file.name ?? '',
      cancelled_at: null,
      pipeline_version: INGESTION_PIPELINE_VERSION,
    })
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await admin
      .from('normalized_events')
      .upsert(chunk, { onConflict: 'user_id,source_type,external_id' })
    if (error) throw new Error(`drive metadata upsert failed: ${error.message}`)
    stats.upserted += chunk.length
  }
  return stats
}

// -----------------------------------------------------------------------------
// Per-user orchestration
// -----------------------------------------------------------------------------

export async function syncUserDrive(admin: AdminClient, userId: string): Promise<DriveSyncStats> {
  const accessToken = await getFreshAccessToken(admin, userId)
  const budget = { remaining: DRIVE_MAX_CLASSIFICATIONS_PER_RUN }

  // Discover owned folders once per run — bounded and cheap versus per-file check.
  const ownedFolderIds = await fetchOwnedFolderIds(accessToken)

  const { data: stateRow, error: stateError } = await admin
    .from('drive_sync_state')
    .select('changes_page_token')
    .eq('user_id', userId)
    .maybeSingle()
  if (stateError) throw new Error(`drive_sync_state read failed: ${stateError.message}`)

  const stats: DriveSyncStats = {
    processed: 0, upserted: 0, removed: 0, classified: 0, pending: 0, irrelevant: 0,
  }

  if (!stateRow?.changes_page_token) {
    // First-run backfill: page through files.list(), then capture a fresh
    // startPageToken for future incremental syncs.
    let pageToken: string | undefined
    let pages = 0
    do {
      const page = await listFilesPage(accessToken, pageToken)
      const partial = await upsertFileMetadata(
        admin, userId, page.files ?? [], new Set(), ownedFolderIds, accessToken, budget,
      )
      stats.processed += partial.processed
      stats.upserted += partial.upserted
      stats.classified += partial.classified
      stats.pending += partial.pending
      stats.irrelevant += partial.irrelevant
      pageToken = page.nextPageToken
      pages += 1
    } while (pageToken && pages < 200 && budget.remaining > 0)

    const startPageToken = await getStartPageToken(accessToken)
    const { error: upsertError } = await admin
      .from('drive_sync_state')
      .upsert({ user_id: userId, changes_page_token: startPageToken, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' })
    if (upsertError) throw new Error(`drive_sync_state seed failed: ${upsertError.message}`)
    return stats
  }

  // Incremental via Changes API.
  let pageToken: string | undefined = stateRow.changes_page_token
  let newStartPageToken: string | null = null
  let pages = 0
  while (pageToken && pages < 100) {
    const page = await listChangesPage(accessToken, pageToken)
    const files: DriveFile[] = []
    const removedIds = new Set<string>()
    for (const change of page.changes ?? []) {
      if (change.removed || change.file?.trashed) {
        if (change.fileId) removedIds.add(change.fileId)
      } else if (change.file?.id) {
        files.push(change.file)
      }
    }
    const partial = await upsertFileMetadata(
      admin, userId, files, removedIds, ownedFolderIds, accessToken, budget,
    )
    stats.processed += partial.processed
    stats.upserted += partial.upserted
    stats.removed += partial.removed
    stats.classified += partial.classified
    stats.pending += partial.pending
    stats.irrelevant += partial.irrelevant
    if (page.newStartPageToken) newStartPageToken = page.newStartPageToken
    pageToken = page.nextPageToken
    pages += 1
  }

  if (newStartPageToken) {
    await admin
      .from('drive_sync_state')
      .update({ changes_page_token: newStartPageToken, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
  }
  return stats
}

// -----------------------------------------------------------------------------
// Content extraction — lazy, on-demand (google-drive.md §3.2)
// -----------------------------------------------------------------------------

const EXPORT_TARGETS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain', // export slides as plain text
}

// PDFs and .docx are downloaded as-is; V0 extracts nothing further and stores the
// raw filename + a marker for downstream. Full parsing (pdfplumber / python-docx)
// is deferred to a post-V0 worker — google-drive.md §3.2 table.
const BINARY_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

async function fetchFileMetadata(accessToken: string, fileId: string): Promise<DriveFile> {
  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(DRIVE_FIELDS)}`,
    accessToken,
  )
  return await res.json()
}

async function exportGoogleNativeText(accessToken: string, fileId: string, target: string): Promise<string> {
  const res = await driveFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(target)}`,
    accessToken,
  )
  return await res.text()
}

export interface ContentExtractionOutcome {
  status: 'done' | 'skipped' | 'failed'
  bytes?: number
  reason?: string
}

// Extracts content for one queued file id and writes a `drive_content` normalized
// record. Size gate + type gate (google-drive.md §3.2). Returns an outcome the
// queue consumer records back onto drive_content_queue.
export async function extractDriveContent(
  admin: AdminClient,
  userId: string,
  fileId: string,
): Promise<ContentExtractionOutcome> {
  const accessToken = await getFreshAccessToken(admin, userId)
  const file = await fetchFileMetadata(accessToken, fileId)
  if (file.trashed) return { status: 'skipped', reason: 'trashed' }
  const mime = file.mimeType ?? ''
  const size = Number(file.size ?? '0')
  if (size && size > DRIVE_SIZE_LIMIT_BYTES) return { status: 'skipped', reason: 'size_over_limit' }

  let text: string | null = null
  if (EXPORT_TARGETS[mime]) {
    try {
      text = await exportGoogleNativeText(accessToken, fileId, EXPORT_TARGETS[mime])
    } catch (err) {
      return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
    }
  } else if (BINARY_MIMES.has(mime)) {
    // V0 stores the metadata reference only — a parsing worker fills in real text.
    text = `[binary content pending parse: ${file.name ?? fileId}]`
  } else {
    return { status: 'skipped', reason: `unsupported mime: ${mime}` }
  }

  const externalId = `drive_${fileId}`
  const row = {
    user_id: userId,
    source_type: 'drive_content',
    external_id: externalId,
    timestamp: timestampForFile(file),
    course_id: null,
    classification: 'pending',
    classification_source: null,
    classification_confidence: null,
    raw_payload: {
      mime_type: mime,
      size_bytes: size || null,
      source_file_id: fileId,
      rumbo_extracted_at: new Date().toISOString(),
    },
    normalized_text: text,
    cancelled_at: null,
    pipeline_version: INGESTION_PIPELINE_VERSION,
  }
  const { error } = await admin
    .from('normalized_events')
    .upsert(row, { onConflict: 'user_id,source_type,external_id' })
  if (error) return { status: 'failed', reason: `content upsert failed: ${error.message}` }
  return { status: 'done', bytes: text.length }
}

// Called by drive-content-extract to process the queue.
export async function drainContentQueue(admin: AdminClient, limit = 20): Promise<{ processed: number; done: number; failed: number; skipped: number }> {
  const summary = { processed: 0, done: 0, failed: 0, skipped: 0 }
  const { data: items, error } = await admin
    .from('drive_content_queue')
    .select('id, user_id, drive_file_id')
    .eq('status', 'pending')
    .order('queued_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`drive_content_queue read failed: ${error.message}`)

  for (const item of items ?? []) {
    summary.processed += 1
    const startedAt = new Date().toISOString()
    await admin
      .from('drive_content_queue')
      .update({ status: 'processing', started_at: startedAt })
      .eq('id', item.id)
    try {
      const outcome = await extractDriveContent(admin, item.user_id, item.drive_file_id)
      await admin
        .from('drive_content_queue')
        .update({
          status: outcome.status === 'done' ? 'done' : outcome.status === 'skipped' ? 'skipped' : 'failed',
          last_error: outcome.reason ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq('id', item.id)
      if (outcome.status === 'done') summary.done += 1
      else if (outcome.status === 'skipped') summary.skipped += 1
      else summary.failed += 1
    } catch (err) {
      await admin
        .from('drive_content_queue')
        .update({
          status: 'failed',
          last_error: err instanceof Error ? err.message : String(err),
          attempts: (item as { attempts?: number }).attempts ? undefined : 1,
          completed_at: new Date().toISOString(),
        })
        .eq('id', item.id)
      summary.failed += 1
    }
  }
  return summary
}
