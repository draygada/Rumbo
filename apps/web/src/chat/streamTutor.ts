// streamTutor — client helper for the streaming tutor endpoint
// (/functions/v1/tutor-v4-stream). POSTs the message and parses the Server-Sent
// Events response, dispatching meta / token / done / error to callbacks.
//
// SSE event contract (each frame: `event: <name>\ndata: <json>\n\n`):
//   meta   { learning_mode, template, session_id, sources }
//   token  { delta }
//   done   { answer, model_used }
//   error  { error }
//
// SUPABASE_URL / ANON are read the same way apps/web/src/lib/supabase.ts reads
// them (import.meta.env.VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export interface StreamTutorMeta {
  learning_mode: string
  template: string | null
  session_id: string | null
  sources: any[]
}

export interface StreamTutorDone {
  answer: string
  model_used: string
}

export interface StreamTutorArgs {
  userId: string
  message: string
  conversationId?: string | null
  /** course_id to scope this turn, or 'all'. */
  courseId?: string | null
  onMeta: (m: StreamTutorMeta) => void
  onToken: (delta: string) => void
  onDone: (d: StreamTutorDone) => void
  onError: (e: string) => void
  signal?: AbortSignal
}

export async function streamTutor(args: StreamTutorArgs): Promise<void> {
  if (!SUPABASE_URL || !ANON) {
    args.onError('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local')
    return
  }

  let res: Response
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/tutor-v4-stream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ANON}`,
        apikey: ANON,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: args.userId,
        message: args.message,
        session_id: args.conversationId ?? null,
      course_id: args.courseId ?? undefined,
      }),
      signal: args.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    args.onError(err instanceof Error ? err.message : String(err))
    return
  }

  if (!res.ok || !res.body) {
    let detail = `Request failed (${res.status})`
    try {
      const t = await res.text()
      if (t) detail = t.slice(0, 300)
    } catch {
      // ignore
    }
    args.onError(detail)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatchFrame = (frame: string) => {
    // A frame is one or more lines. Read the `event:` and `data:` lines.
    let event = 'message'
    const dataLines: string[] = []
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length === 0) return
    let data: any
    try {
      data = JSON.parse(dataLines.join('\n'))
    } catch {
      return // skip malformed frame
    }
    switch (event) {
      case 'meta':
        args.onMeta(data as StreamTutorMeta)
        break
      case 'token':
        if (typeof data?.delta === 'string') args.onToken(data.delta)
        break
      case 'done':
        args.onDone(data as StreamTutorDone)
        break
      case 'error':
        args.onError(typeof data?.error === 'string' ? data.error : 'Unknown error')
        break
      default:
        break
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split off complete SSE frames (separated by a blank line).
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        if (frame.trim()) dispatchFrame(frame)
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    args.onError(err instanceof Error ? err.message : String(err))
    return
  }

  // Flush any trailing frame that wasn't terminated by a blank line.
  const tail = buffer.trim()
  if (tail) dispatchFrame(tail)
}
