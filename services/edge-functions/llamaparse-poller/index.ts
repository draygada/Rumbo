// llamaparse-poller — drains the llamaparse_jobs queue.
//
// Called by pg_cron every 30s. Each invocation:
//   1. Loads up to BATCH pending jobs (oldest first)
//   2. For each: fetches LlamaParse status
//      - SUCCESS → writes markdown to normalized_events.normalized_text,
//                  resets pipeline_version_v4/body_hash/extracted_at_v4,
//                  marks canvas file "extracted" in raw_payload,
//                  marks job 'done'
//      - PENDING → updates polled_at and moves on
//      - ERROR   → marks job 'error' + records failure on the file
//   3. Fires a fire-and-forget brain-pipeline-v4 kick per user that got
//      new content (so v4 re-processes the newly enriched records fast).
//
// Auth: CRON_SECRET.

import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { fetchLlamaParseResult } from '../_shared/llamaparse.ts'

const BATCH = 20
const STALE_MINUTES = 30  // if a job's been pending > this, we mark it errored

function authorized(req: Request): boolean {
  const expected = Deno.env.get('CRON_SECRET')
  if (!expected) return Deno.env.get('SUPABASE_ENV') === 'dev'
  return req.headers.get('x-cron-secret') === expected
}

interface JobRow {
  id: string
  user_id: string
  normalized_event_id: string
  llamaparse_job_id: string
  source_display_name: string | null
  requested_at: string
}

interface EventRow {
  id: string
  raw_payload: Record<string, unknown> | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ error: 'method' }, 405)
  if (!authorized(req)) return jsonResponse({ error: 'unauthorized' }, 401)

  const admin = createAdminClient()
  const results: Array<{ job_id: string; status: string; chars?: number; reason?: string }> = []
  const kickedUsers = new Set<string>()

  // Load pending jobs
  const { data: pending, error: loadErr } = await admin
    .from('llamaparse_jobs')
    .select('id, user_id, normalized_event_id, llamaparse_job_id, source_display_name, requested_at')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    .limit(BATCH)
  if (loadErr) return jsonResponse({ error: `load: ${loadErr.message}` }, 500)

  const jobs = (pending ?? []) as JobRow[]
  if (jobs.length === 0) return jsonResponse({ ok: true, processed: 0, results: [] })

  for (const job of jobs) {
    const result = await fetchLlamaParseResult(job.llamaparse_job_id)

    if (result.status === 'PENDING') {
      // Check staleness — if very old and still pending, mark error.
      const ageMinutes = (Date.now() - new Date(job.requested_at).getTime()) / 60_000
      if (ageMinutes > STALE_MINUTES) {
        await markJobError(admin, job, `stale after ${ageMinutes.toFixed(1)} min`)
        results.push({ job_id: job.llamaparse_job_id, status: 'stale' })
      } else {
        await admin.from('llamaparse_jobs').update({ polled_at: new Date().toISOString() }).eq('id', job.id)
        results.push({ job_id: job.llamaparse_job_id, status: 'pending' })
      }
      continue
    }

    if (result.status === 'ERROR' || result.status === 'CANCELLED' || result.status === 'UNKNOWN') {
      const reason = result.status === 'UNKNOWN' ? result.error : `${result.status}: ${result.error}`
      await markJobError(admin, job, reason)
      results.push({ job_id: job.llamaparse_job_id, status: 'error', reason: reason.slice(0, 200) })
      continue
    }

    // SUCCESS — write markdown into normalized_events + reset v4 markers.
    const displayName = job.source_display_name ?? '(file)'
    const normalizedText = `${displayName}\n\n${result.markdown}`.trim()

    // Load current raw_payload so we can preserve+extend it.
    const { data: eventData } = await admin
      .from('normalized_events')
      .select('raw_payload')
      .eq('id', job.normalized_event_id)
      .single()
    const priorPayload = (eventData?.raw_payload ?? {}) as Record<string, unknown>
    const now = new Date().toISOString()
    const rumbo = {
      rumbo_content_extracted_at: now,
      rumbo_content_chars: normalizedText.length,
      rumbo_content_extractor: 'llamaparse',
      rumbo_content_error: null,
    }
    await admin.from('normalized_events').update({
      normalized_text: normalizedText,
      raw_payload: { ...priorPayload, ...rumbo },
      extraction_status: 'pending',   // v3 (if enabled) will re-extract
      extracted_at: null,
      pipeline_version_v4: null,       // v4 will re-process with real content
      extracted_at_v4: null,
      body_hash: null,
    }).eq('id', job.normalized_event_id)

    await admin.from('llamaparse_jobs').update({
      status: 'done',
      completed_at: new Date().toISOString(),
      chars_written: normalizedText.length,
    }).eq('id', job.id)

    kickedUsers.add(job.user_id)
    results.push({ job_id: job.llamaparse_job_id, status: 'done', chars: normalizedText.length })
  }

  // Fire-and-forget brain-pipeline-v4 kick per user with new content.
  for (const uid of kickedUsers) {
    kickBrainPipelineV4(uid).catch(err => console.warn('[poller] brain kick failed:', err))
  }

  return jsonResponse({ ok: true, processed: results.length, kicked: kickedUsers.size, results })
})

async function markJobError(
  // deno-lint-ignore no-explicit-any
  admin: any,
  job: JobRow,
  reason: string,
): Promise<void> {
  await admin.from('llamaparse_jobs').update({
    status: 'error',
    error: reason.slice(0, 500),
    completed_at: new Date().toISOString(),
  }).eq('id', job.id)

  // Also mark the file as failed in raw_payload so we don't retry forever.
  const { data: eventData } = await admin
    .from('normalized_events')
    .select('raw_payload')
    .eq('id', job.normalized_event_id)
    .single()
  const prior = (eventData?.raw_payload ?? {}) as Record<string, unknown>
  const rumbo = {
    rumbo_content_extracted_at: new Date().toISOString(),
    rumbo_content_extractor: 'llamaparse-failed',
    rumbo_content_error: reason.slice(0, 500),
    // Clear enqueue marker so a manual reset could retry
  }
  delete (prior as Record<string, unknown>).rumbo_llamaparse_enqueued_at
  delete (prior as Record<string, unknown>).rumbo_llamaparse_job_id
  await admin
    .from('normalized_events')
    .update({ raw_payload: { ...prior, ...rumbo } })
    .eq('id', job.normalized_event_id)
}

async function kickBrainPipelineV4(userId: string): Promise<void> {
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
    body: JSON.stringify({ user_id: userId, limit: 5 }),
  })
}
