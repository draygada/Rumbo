// LlamaParse adapter — async job pattern.
//
// The Supabase free-tier 150s edge-function limit makes upload+poll+result
// in a single invocation infeasible for realistic PDFs/DOCX. So this adapter
// exposes two split functions:
//
//   uploadLlamaParseJob  — returns { job_id } fast (~2-5s). Fire-and-forget.
//   fetchLlamaParseResult — checks a job by id, returns { status, markdown? }.
//
// The queue table `llamaparse_jobs` (Postgres) tracks in-flight jobs and a
// separate poller edge function drains it every 30s.
//
// Supports every format LlamaParse handles: PDF, DOCX, PPTX, HTML, images.
// Caller passes the actual MIME type so multipart uploads set the right
// Content-Type on the file part.
//
// Env: LLAMA_CLOUD_API_KEY.

const LLAMAPARSE_BASE = 'https://api.cloud.llamaindex.ai/api/v1/parsing'

// Parse mode — LlamaParse v1 enum (renamed from the older fast/balanced/premium set).
//   parse_page_without_llm  — text/OCR only, cheapest + fastest
//   parse_page_with_llm     — text + LLM cleanup, default balanced
//   parse_page_with_lvm     — visual-language model (best on complex layouts)
//   parse_page_with_agent   — agentic multi-pass, highest quality + cost
export type LlamaParseMode =
  | 'parse_page_without_llm'
  | 'parse_page_with_llm'
  | 'parse_page_with_lvm'
  | 'parse_page_with_agent'

export type LlamaParseStatus = 'PENDING' | 'SUCCESS' | 'ERROR' | 'CANCELLED'

function apiKey(): string | null {
  return Deno.env.get('LLAMA_CLOUD_API_KEY') ?? null
}

// ---------------------------------------------------------------------------
// Upload — returns job_id fast. Doesn't wait for parsing to complete.
// ---------------------------------------------------------------------------

export async function uploadLlamaParseJob(args: {
  fileBytes: Uint8Array
  filename: string
  mime: string           // real MIME from the downloaded file
  mode?: LlamaParseMode
}): Promise<{ jobId: string } | { error: string }> {
  const key = apiKey()
  if (!key) return { error: 'no api key' }

  const form = new FormData()
  form.append('file', new Blob([args.fileBytes], { type: args.mime }), args.filename)
  form.append('parse_mode', args.mode ?? 'parse_page_with_llm')
  form.append('result_type', 'markdown')

  try {
    const res = await fetch(`${LLAMAPARSE_BASE}/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: form,
    })
    if (!res.ok) {
      const body = await res.text()
      return { error: `upload ${res.status}: ${body.slice(0, 240)}` }
    }
    const data = await res.json()
    if (typeof data?.id !== 'string') return { error: 'upload returned no job id' }
    return { jobId: data.id }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Fetch — one-shot status check for an existing job_id.
// ---------------------------------------------------------------------------

export async function fetchLlamaParseResult(jobId: string): Promise<
  | { status: 'SUCCESS'; markdown: string }
  | { status: 'PENDING' }
  | { status: 'ERROR' | 'CANCELLED'; error: string }
  | { status: 'UNKNOWN'; error: string }
> {
  const key = apiKey()
  if (!key) return { status: 'UNKNOWN', error: 'no api key' }
  try {
    const jobRes = await fetch(`${LLAMAPARSE_BASE}/job/${jobId}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    if (!jobRes.ok) {
      return { status: 'UNKNOWN', error: `job check ${jobRes.status}` }
    }
    const jobData = await jobRes.json() as { status: LlamaParseStatus; error?: string }
    if (jobData.status === 'PENDING') return { status: 'PENDING' }
    if (jobData.status === 'ERROR' || jobData.status === 'CANCELLED') {
      return { status: jobData.status, error: jobData.error ?? '' }
    }
    // SUCCESS — fetch markdown
    const resultRes = await fetch(`${LLAMAPARSE_BASE}/job/${jobId}/result/markdown`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    if (!resultRes.ok) {
      return { status: 'UNKNOWN', error: `result fetch ${resultRes.status}` }
    }
    const resultData = await resultRes.json() as { markdown?: string }
    const md = typeof resultData?.markdown === 'string' ? resultData.markdown : ''
    if (!md.trim()) return { status: 'UNKNOWN', error: 'empty markdown result' }
    return { status: 'SUCCESS', markdown: md }
  } catch (err) {
    return { status: 'UNKNOWN', error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Back-compat: synchronous single-call parse (upload + poll in one).
// Kept for future use if we ever move to a longer-timeout runtime. Not used
// by canvas-file-extract anymore.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 100_000

export async function llamaParsePdf(args: {
  pdfBytes: Uint8Array
  filename: string
  mode?: LlamaParseMode
  mime?: string
}): Promise<string | null> {
  const upload = await uploadLlamaParseJob({
    fileBytes: args.pdfBytes,
    filename: args.filename,
    mime: args.mime ?? 'application/pdf',
    mode: args.mode ?? 'parse_page_with_llm',
  })
  if ('error' in upload) {
    console.warn('[llamaparse] upload error:', upload.error)
    return null
  }
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    const result = await fetchLlamaParseResult(upload.jobId)
    if (result.status === 'SUCCESS') return result.markdown
    if (result.status === 'ERROR' || result.status === 'CANCELLED') {
      console.warn(`[llamaparse] job ${upload.jobId} ${result.status}: ${result.error}`)
      return null
    }
    if (result.status === 'UNKNOWN') {
      console.warn(`[llamaparse] job ${upload.jobId} unknown: ${result.error}`)
      return null
    }
  }
  console.warn(`[llamaparse] job ${upload.jobId} timed out after ${POLL_TIMEOUT_MS}ms`)
  return null
}
