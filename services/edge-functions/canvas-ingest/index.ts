// canvas-ingest — polls Canvas for every user with valid credentials, writes
// courses / syllabi / assignments into normalized_events.
//
// Invocation modes:
//   - Cron / batch: POST with no body → iterate every user with token_status='valid'.
//   - Single-user: POST { user_id: "..." } → sync just that user (used at onboarding
//     for the first-ingest backfill).
//
// Auth: verify_jwt = false. Requires header `x-cron-secret` matching CRON_SECRET
// env var (belt-and-suspenders against public invocation). When called from
// pg_cron via net.http_post, the secret comes from Supabase Vault.
//
// Reference: canvas.md §3-§5, CLAUDE.md §5 Phase 2, Infrastructure/storage.md §0.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import {
  CanvasCredentials,
  CanvasError,
  classifyCanvasFile,
  courseInEnrollmentWindow,
  getCourseFrontPage,
  getPageBody,
  isLectureModuleItem,
  listAnnouncements,
  listAssignments,
  listCourses,
  listFiles,
  listModuleItems,
  listModules,
  listPages,
  normalizeAssignment,
  normalizeAssignmentRubric,
  normalizeCanvasAnnouncement,
  normalizeCanvasFile,
  normalizeCanvasHome,
  normalizeCanvasLecture,
  normalizeCanvasPage,
  normalizeCourse,
  normalizeSyllabus,
  type NormalizedRow,
} from '../_shared/canvas.ts'
import { kickBrainPipeline } from '../_shared/brain-kick.ts'

interface IngestBody {
  user_id?: string
}

interface UserSyncResult {
  user_id: string
  courses_seen: number
  assignments_seen: number
  files_seen: number
  lectures_seen: number
  pages_seen: number
  announcements_seen: number
  homes_seen: number
  rubrics_seen: number
  rows_upserted: number
  /** Rows whose already-extracted document text this sync declined to overwrite. */
  extracted_preserved: number
  error?: string
}

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  // Fail closed: production must set CRON_SECRET. Only allow no-secret when
  // explicitly running the local dev harness (SUPABASE_ENV=dev in supabase start).
  if (!expected) {
    return Deno.env.get('SUPABASE_ENV') === 'dev'
  }
  return req.headers.get('x-cron-secret') === expected
}

async function markTokenExpired(admin: ReturnType<typeof createAdminClient>, userId: string): Promise<void> {
  await admin
    .from('canvas_sync_state')
    .update({ token_status: 'expired', updated_at: new Date().toISOString() })
    .eq('user_id', userId)
}

async function syncUser(admin: ReturnType<typeof createAdminClient>, userId: string, creds: CanvasCredentials): Promise<UserSyncResult> {
  const result: UserSyncResult = { user_id: userId, courses_seen: 0, assignments_seen: 0, files_seen: 0, lectures_seen: 0, pages_seen: 0, announcements_seen: 0, homes_seen: 0, rubrics_seen: 0, rows_upserted: 0, extracted_preserved: 0 }

  let courses
  try {
    courses = await listCourses(creds)
  } catch (err) {
    if (err instanceof CanvasError && err.kind === 'auth') {
      await markTokenExpired(admin, userId)
      result.error = 'canvas_auth_failed'
      return result
    }
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }

  const eligible = courses.filter(c => courseInEnrollmentWindow(c))
  result.courses_seen = eligible.length

  const rows: NormalizedRow[] = []

  for (const course of eligible) {
    rows.push(normalizeCourse(userId, course))
    const syllabus = normalizeSyllabus(userId, course)
    if (syllabus) rows.push(syllabus)

    try {
      const assignments = await listAssignments(creds, course.id)
      result.assignments_seen += assignments.length
      for (const assignment of assignments) {
        rows.push(normalizeAssignment(userId, assignment))
        // Attached rubric produces its own row (source_type=canvas_assignment_rubric)
        // so extraction can weight it separately. See canvas.ts normalizeAssignmentRubric.
        const rubricRow = normalizeAssignmentRubric(userId, assignment as never)
        if (rubricRow) {
          rows.push(rubricRow)
          result.rubrics_seen += 1
        }
      }

      // Only stamp last_assignment_updated_at when the fetch actually succeeded,
      // and derive it from the max assignment updated_at (change-detection
      // watermark, canvas.md §3.1). Falls back to null if no assignments yet.
      const maxUpdated = assignments.reduce<string | null>((acc, a) => {
        if (!a.updated_at) return acc
        if (!acc || a.updated_at > acc) return a.updated_at
        return acc
      }, null)
      await admin
        .from('canvas_course_sync')
        .upsert({
          user_id: userId,
          canvas_course_id: String(course.id),
          last_assignment_updated_at: maxUpdated,
        })

      // Files — only ingest signal-carrying ones (syllabus / rubric / project).
      // canvas.md §3.1 excludes generic files. Best-effort per course: failure
      // to list files never kills the sync (many Canvas installs restrict this
      // endpoint per-role).
      try {
        const files = await listFiles(creds, course.id)
        for (const file of files) {
          const category = classifyCanvasFile(file)
          if (!category) continue
          rows.push(normalizeCanvasFile(userId, file, category, course.id))
          result.files_seen += 1
        }
      } catch (fileErr) {
        console.warn(`[canvas-ingest] files for course ${course.id} skipped:`, fileErr instanceof Error ? fileErr.message : fileErr)
      }

      // Modules → Lecture rows. See canvas-modules-and-files.md §2.
      // Failure to list modules never kills the sync — some Canvas installs
      // restrict the endpoint per role.
      try {
        const modules = await listModules(creds, course.id)
        for (const mod of modules) {
          if (mod.workflow_state === 'unpublished' || mod.workflow_state === 'deleted') continue
          const items = await listModuleItems(creds, course.id, mod.id)
          for (const item of items) {
            if (!isLectureModuleItem(item)) continue
            rows.push(normalizeCanvasLecture(userId, course.id, mod, item))
            result.lectures_seen += 1
          }
        }
      } catch (modErr) {
        console.warn(`[canvas-ingest] modules for course ${course.id} skipped:`, modErr instanceof Error ? modErr.message : modErr)
      }

      // Home page — one per course when set. Per-course failure isolated.
      try {
        const home = await getCourseFrontPage(creds, course.id)
        if (home) {
          const homeRow = normalizeCanvasHome(userId, course.id, home)
          if (homeRow) {
            rows.push(homeRow)
            result.homes_seen += 1
          }
        }
      } catch (homeErr) {
        console.warn(`[canvas-ingest] home for course ${course.id} skipped:`, homeErr instanceof Error ? homeErr.message : homeErr)
      }

      // Announcements — the last 60 days per course. Bounded window keeps
      // ingestion cost predictable and matches what students actually
      // reference ("what did the prof announce this quarter?").
      try {
        const sinceIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
        const anns = await listAnnouncements(creds, course.id, sinceIso)
        for (const ann of anns) {
          const annRow = normalizeCanvasAnnouncement(userId, course.id, ann)
          if (annRow) {
            rows.push(annRow)
            result.announcements_seen += 1
          }
        }
      } catch (annErr) {
        console.warn(`[canvas-ingest] announcements for course ${course.id} skipped:`, annErr instanceof Error ? annErr.message : annErr)
      }

      // Pages — every published wiki page. Bodies come in a second call per
      // page since listPages only gives metadata. Capped at 40 pages per
      // course to keep the sync bounded; deprioritized long tails.
      try {
        const pages = await listPages(creds, course.id)
        for (const meta of pages.slice(0, 40)) {
          const full = await getPageBody(creds, course.id, meta.url)
          if (!full) continue
          const pageRow = normalizeCanvasPage(userId, course.id, full)
          if (pageRow) {
            rows.push(pageRow)
            result.pages_seen += 1
          }
        }
      } catch (pageErr) {
        console.warn(`[canvas-ingest] pages for course ${course.id} skipped:`, pageErr instanceof Error ? pageErr.message : pageErr)
      }
    } catch (err) {
      if (err instanceof CanvasError && err.kind === 'rate_limit') {
        // Bail out of the whole user sync; retry on next cron. Do not stamp
        // last_polled_at so the next run doesn't skip fresh data.
        result.error = 'canvas_rate_limited'
        return result
      }
      // Per-course failures (including 401/403 on assignments) are logged and
      // skipped — one archived / instructor-restricted course must not kill
      // the whole user sync. Whole-token auth failure is caught earlier at
      // listCourses; if we got here, the token can list courses at least.
      // eslint-disable-next-line no-console
      console.warn(`[canvas-ingest] course ${course.id} for ${userId} skipped:`, err instanceof Error ? err.message : err)
    }
  }

  // Upsert in chunks so large payloads don't hit Postgres limits. Each chunk
  // goes through preserveExtractedContent first — see the note on that
  // function; without it this sync silently destroys every parsed document.
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { rows: chunk, preserved } = await preserveExtractedContent(
      admin, userId, rows.slice(i, i + CHUNK),
    )
    const { error } = await admin
      .from('normalized_events')
      .upsert(chunk, { onConflict: 'user_id,source_type,external_id' })
    if (error) {
      result.error = `upsert_failed: ${error.message}`
      return result
    }
    result.rows_upserted += chunk.length
    result.extracted_preserved += preserved
  }

  await admin
    .from('canvas_sync_state')
    .update({ last_polled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId)

  return result
}

// ---------------------------------------------------------------------------
// Protect extracted document text from the sync that would otherwise erase it.
//
// THE BUG THIS FIXES. The upsert below is a full-row write keyed on
// (user_id, source_type, external_id), and every row it builds carries a fresh
// `normalized_text` and a fresh `raw_payload`. For a file that text is just the
// display name (normalizeCanvasFile) and that payload is the raw Canvas object
// with no `rumbo_*` keys in it.
//
// LlamaParse extraction writes the parsed document INTO those same two columns.
// So every 6-hourly sync overwrote ~21,000 characters of parsed lecture with a
// filename, and wiped the extraction markers on the way out — which made the
// record look un-extracted, so nothing ever noticed. Measured on 2026-08-13:
// 123 of 123 successfully-parsed documents had been reduced to 10-39 characters,
// while the job rows still recorded chars_written averaging 21,226.
//
// Gating on `rumbo_content_extracted_at` is what keeps this narrow. Only rows
// something actually extracted are protected; Canvas stays authoritative for
// pages, assignments and announcements, whose bodies legitimately change
// upstream and must keep flowing through.
//
// Tradeoff, deliberate: once a file is extracted its text is pinned, so
// replacing a PDF in Canvas under the same file id will not re-extract. That
// was already true — canvas-file-extract skips any row carrying this same
// marker — so this preserves existing behaviour rather than adding a new
// limitation. Re-extraction on change needs a content hash, which is the
// separate-column redesign, not this fix.
// ---------------------------------------------------------------------------

/** Keys the extraction pipeline owns. Ingest must carry these forward, never author them. */
const EXTRACTION_KEYS = [
  'rumbo_content_extracted_at',
  'rumbo_content_chars',
  'rumbo_content_extractor',
  'rumbo_content_error',
  'rumbo_llamaparse_enqueued_at',
  'rumbo_llamaparse_job_id',
] as const

interface PriorRow {
  source_type: string
  external_id: string
  normalized_text: string | null
  raw_payload: Record<string, unknown> | null
}

async function preserveExtractedContent(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  chunk: NormalizedRow[],
): Promise<{ rows: NormalizedRow[]; preserved: number }> {
  if (chunk.length === 0) return { rows: chunk, preserved: 0 }

  const key = (sourceType: string, externalId: string) => `${sourceType} ${externalId}`

  const prior: PriorRow[] = []
  try {
    // Sub-batched because `.in()` goes on the query string: 200 external ids
    // is several KB of URL, close enough to proxy limits that a failure here
    // would trip the fail-closed path below and stall ingest entirely.
    const LOOKUP = 50
    const ids = chunk.map(r => r.external_id)
    for (let i = 0; i < ids.length; i += LOOKUP) {
      const { data, error } = await admin
        .from('normalized_events')
        .select('source_type, external_id, normalized_text, raw_payload')
        .eq('user_id', userId)
        .in('external_id', ids.slice(i, i + LOOKUP))
      if (error) throw new Error(error.message)
      prior.push(...((data ?? []) as PriorRow[]))
    }
  } catch (err) {
    // Fail CLOSED. If we can't tell which rows hold extracted text, upserting
    // anyway is exactly the data loss this exists to prevent — so skip the
    // whole chunk and let the next sync retry. A stale row beats a destroyed one.
    console.error(
      `[canvas-ingest] preserve lookup failed for ${userId}; skipping chunk to avoid ` +
      `overwriting extracted text:`, err instanceof Error ? err.message : err,
    )
    return { rows: [], preserved: 0 }
  }

  const byKey = new Map<string, PriorRow>()
  for (const row of prior) byKey.set(key(row.source_type, row.external_id), row)

  let preserved = 0
  const rows = chunk.map(row => {
    const existing = byKey.get(key(row.source_type, row.external_id))
    const payload = (existing?.raw_payload ?? {}) as Record<string, unknown>
    // Also protect rows that are mid-extraction. Wiping an enqueue marker makes
    // canvas-file-extract treat an in-flight file as untouched and submit it to
    // LlamaParse a second time — billed twice, and the later job's write races
    // the earlier one.
    const extracted = payload.rumbo_content_extracted_at
    const inFlight = payload.rumbo_llamaparse_enqueued_at
    if (!extracted && !inFlight) return row

    // Carry the extraction markers onto the FRESH Canvas payload, so updated
    // Canvas metadata still lands while the extraction record survives.
    const carried: Record<string, unknown> = {}
    for (const k of EXTRACTION_KEYS) {
      if (k in payload) carried[k] = payload[k]
    }
    preserved += 1
    return {
      ...row,
      normalized_text: existing?.normalized_text ?? row.normalized_text,
      raw_payload: { ...(row.raw_payload as Record<string, unknown>), ...carried },
    }
  })

  return { rows, preserved }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }
  if (!authorized(req)) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  let body: IngestBody = {}
  try {
    const text = await req.text()
    if (text) body = JSON.parse(text) as IngestBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const admin = createAdminClient()

  // Pull credentials for the target user(s).
  const query = admin
    .from('canvas_credentials')
    .select('user_id, pat, base_url')

  const { data: creds, error: credsError } = body.user_id
    ? await query.eq('user_id', body.user_id)
    : await query

  if (credsError) {
    return jsonResponse({ error: `Failed to load credentials: ${credsError.message}` }, 500)
  }

  const results: UserSyncResult[] = []
  for (const row of creds ?? []) {
    // Skip users flagged as expired in canvas_sync_state.
    const { data: state } = await admin
      .from('canvas_sync_state')
      .select('token_status')
      .eq('user_id', row.user_id)
      .maybeSingle()
    if (state?.token_status === 'expired') {
      results.push({ user_id: row.user_id, courses_seen: 0, assignments_seen: 0, files_seen: 0, lectures_seen: 0, pages_seen: 0, announcements_seen: 0, homes_seen: 0, rubrics_seen: 0, rows_upserted: 0, extracted_preserved: 0, error: 'token_expired' })
      continue
    }

    const result = await syncUser(admin, row.user_id, { pat: row.pat, baseUrl: row.base_url })
    results.push(result)
    if (!result.error && result.rows_upserted > 0) {
      kickBrainPipeline(row.user_id).catch(err => console.warn('[canvas-ingest] brain kick failed:', err))
    }
  }

  return jsonResponse({
    ok: true,
    processed: results.length,
    results,
  })
})
