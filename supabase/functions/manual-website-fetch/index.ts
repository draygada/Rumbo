// manual-website-fetch — fetch a class website URL, strip boilerplate, and
// write a manual_website normalized_events record.
//
// Auth: verify_jwt = true. Body: { manual_course_id, url }.
//
// Login-walled or empty pages return an error, not a silent empty record
// (manual-course-entry.md §4.2).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { stripHtmlBoilerplate, wordCount, writeManualWebsiteRecord } from '../_shared/manual-ingest.ts'

const MIN_WORDS = 50
const FETCH_TIMEOUT_MS = 15_000

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const jwt = authHeader.slice('Bearer '.length)
  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url || !anon) return null
  const client = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

function isValidHttpUrl(input: string): boolean {
  try {
    const u = new URL(input)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

interface Body { manual_course_id?: string; url?: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const userId = await getUserIdFromRequest(req)
  if (!userId) return jsonResponse({ error: 'Unauthorized' }, 401)

  let body: Body = {}
  try { body = await req.json() as Body } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const target = (body.url ?? '').trim()
  const manualCourseId = body.manual_course_id
  if (!manualCourseId || !target) return jsonResponse({ error: 'manual_course_id and url required' }, 400)
  if (!isValidHttpUrl(target)) return jsonResponse({ error: 'URL must be http(s)' }, 400)

  const admin = createAdminClient()

  // Confirm the course belongs to the caller (defense in depth beyond RLS).
  const { data: course, error: courseErr } = await admin
    .from('manual_courses')
    .select('id, user_id')
    .eq('id', manualCourseId)
    .maybeSingle()
  if (courseErr || !course) return jsonResponse({ error: 'Course not found' }, 404)
  if (course.user_id !== userId) return jsonResponse({ error: 'Forbidden' }, 403)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let html: string
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'RumboBot/0.1 (+https://rumbo.app)' },
    })
    if (!res.ok) {
      return jsonResponse({ error: `Fetch failed (${res.status})` }, 502)
    }
    html = await res.text()
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'Fetch failed' }, 502)
  } finally {
    clearTimeout(timer)
  }

  const text = stripHtmlBoilerplate(html)
  if (wordCount(text) < MIN_WORDS) {
    return jsonResponse({
      ok: false,
      error: "We couldn't read enough from that page — it may require a login. Try downloading the syllabus and uploading it as a file instead.",
    }, 422)
  }

  const fetchedAt = new Date().toISOString()
  const normalizedEventId = await writeManualWebsiteRecord(admin, {
    userId,
    manualCourseId,
    url: target,
    fetchedAt,
    normalizedText: text,
  })

  // If the manual_courses row has no website_url yet, capture it.
  await admin
    .from('manual_courses')
    .update({ website_url: target, updated_at: fetchedAt })
    .eq('id', manualCourseId)
    .is('website_url', null)

  return jsonResponse({
    ok: true,
    normalized_event_id: normalizedEventId,
    word_count: wordCount(text),
  })
})
