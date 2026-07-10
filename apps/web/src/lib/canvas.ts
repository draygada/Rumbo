import { supabase } from './supabase'

/** Extract a Canvas host from anything the student might paste — a full URL,
 *  a bare domain, an `https://` URL with path, etc. Returns the lowercase host
 *  or null when nothing parseable was found. */
export function extractCanvasDomain(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  // Try URL parsing first — handles "https://stanford.instructure.com/courses/12345".
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`
    const u = new URL(withScheme)
    const host = u.hostname.toLowerCase()
    if (host) return host
  } catch {
    // fall through to manual cleanup
  }

  // Fallback: strip a leading scheme, keep everything up to first slash/space.
  const cleaned = raw.replace(/^[a-z]+:\/\//i, '').split(/[\s/]/)[0]?.toLowerCase()
  return cleaned || null
}

export interface CanvasVerifyResult {
  ok: boolean
  saved?: boolean
  canvas_user?: { id: number; name: string; short_name?: string }
  kind?: string
  message?: string
}

// Calls the canvas-verify Edge Function. Set save=true after the user confirms
// they want to persist the credentials — do NOT save on a preview / test call.
export async function verifyCanvas(
  pat: string,
  baseUrl: string,
  save: boolean,
): Promise<CanvasVerifyResult> {
  const { data, error } = await supabase.functions.invoke('canvas-verify', {
    body: { pat, base_url: baseUrl, save },
  })
  if (error) {
    // The Edge Function returns 4xx/5xx as errors here; parse the context body.
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx === 'object' && 'json' in ctx) {
      try {
        const body = (await (ctx as unknown as Response).clone().json()) as CanvasVerifyResult
        return body
      } catch {
        // fall through
      }
    }
    return { ok: false, message: error.message ?? 'Canvas verification failed' }
  }
  return (data as CanvasVerifyResult) ?? { ok: false, message: 'Empty response' }
}

export async function getCanvasConnected(): Promise<boolean> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .select('user_id')
    .maybeSingle()
  if (error) throw error
  return !!data
}

export async function getCanvasDomain(): Promise<string | null> {
  const { data, error } = await supabase
    .from('canvas_credentials')
    .select('base_url')
    .maybeSingle()
  if (error) throw error
  return (data?.base_url as string | undefined) ?? null
}

// Disconnect goes through canvas-verify (disconnect: true branch), which does
// a service-role delete of canvas_credentials + canvas_sync_state. RLS on
// canvas_credentials denies client-side deletes, so this indirection is
// required, not a shortcut.
export async function disconnectCanvas(): Promise<void> {
  const { error } = await supabase.functions.invoke('canvas-verify', {
    body: { disconnect: true },
  })
  if (error) throw error
}
