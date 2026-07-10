import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { exchangeGoogleCode, getGoogleAuthUrl } from '../_shared/google-calendar.ts'

function redirectUri(): string {
  const explicit = Deno.env.get('GOOGLE_REDIRECT_URI')
  if (explicit) return explicit
  const url = Deno.env.get('SUPABASE_URL')
  if (!url) throw new Error('Missing SUPABASE_URL')
  return `${url}/functions/v1/calendar-oauth`
}

function appRedirect(path: string): string {
  const base = Deno.env.get('APP_URL') ?? 'http://localhost:5173'
  return `${base.replace(/\/$/, '')}${path}`
}

function withQuery(path: string, params: Record<string, string>): string {
  const separator = path.includes('?') ? '&' : '?'
  const query = new URLSearchParams(params).toString()
  return `${path}${separator}${query}`
}

function redirectWithError(path: string, reason: string): Response {
  const safeReason = reason.slice(0, 180)
  return Response.redirect(appRedirect(withQuery(path, { calendar: 'error', reason: safeReason })), 302)
}

async function kickFirstIngest(userId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  const isDev = Deno.env.get('SUPABASE_ENV') === 'dev'
  if (!supabaseUrl || !serviceKey) return
  if (!cronSecret && !isDev) {
    console.warn('[calendar-oauth] Skipping first-ingest: CRON_SECRET not set (and not dev)')
    return
  }
  const response = await fetch(`${supabaseUrl}/functions/v1/calendar-ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ user_id: userId }),
  })
  if (!response.ok) {
    console.warn(`[calendar-oauth] first-ingest returned ${response.status}`)
  }
}

function encodeState(payload: Record<string, string>): string {
  return btoa(JSON.stringify(payload))
}

function decodeState(state: string): Record<string, string> | null {
  try {
    return JSON.parse(atob(state))
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateRaw = url.searchParams.get('state')

  try {
    if (req.method === 'GET' && code && stateRaw) {
      if (!code || !stateRaw) {
        return Response.redirect(appRedirect('/settings?calendar=error'), 302)
      }

      const state = decodeState(stateRaw)
      const userId = state?.user_id
      if (!userId) {
        return redirectWithError('/settings', 'Invalid OAuth state')
      }

      const tokens = await exchangeGoogleCode(code, redirectUri())
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

      const admin = createAdminClient()
      const scopes = (tokens.scope ?? '').split(' ').filter(Boolean)
      // deno-lint-ignore no-explicit-any
      const row: Record<string, any> = {
        user_id: userId,
        provider: 'google',
        access_token: tokens.access_token,
        expires_at: expiresAt,
        scopes,
      }
      // Google omits refresh_token on re-consent; keep the existing one.
      if (tokens.refresh_token) {
        row.refresh_token = tokens.refresh_token
      }
      await admin.from('calendar_connections').upsert(row, { onConflict: 'user_id,provider' })

      // Fire-and-forget first-ingest so the dashboard populates without waiting
      // for the next cron tick. Copy of canvas-verify's kickFirstIngest pattern.
      kickFirstIngest(userId).catch(err => console.warn('[calendar-oauth] first-ingest kick failed:', err))

      const returnTo = state.return_to ?? '/settings'
      return Response.redirect(appRedirect(withQuery(returnTo, { calendar: 'connected' })), 302)
    }

    if (req.method === 'POST') {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } },
      )

      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError || !user) {
        return jsonResponse({ error: 'Unauthorized' }, 401)
      }

      const body = await req.json().catch(() => ({})) as { return_to?: string }
      const state = encodeState({
        user_id: user.id,
        return_to: body.return_to ?? '/settings',
      })
      const authUrl = getGoogleAuthUrl(redirectUri(), state)
      return jsonResponse({ url: authUrl })
    }

    return jsonResponse({ error: 'Invalid request' }, 400)
  } catch (e) {
    console.error(e)
    if (req.method === 'GET' && code) {
      const reason = e instanceof Error ? e.message : 'OAuth callback failed'
      return redirectWithError('/settings', reason)
    }
    return jsonResponse({ error: e instanceof Error ? e.message : 'Unknown error' }, 500)
  }
})
