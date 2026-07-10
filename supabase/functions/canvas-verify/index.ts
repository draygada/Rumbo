// canvas-verify — validates a Canvas PAT + base URL by calling /api/v1/users/self.
// Invoked from the onboarding flow before saving credentials so a bad token
// never reaches canvas_credentials.
//
// Requires an authenticated user (verify_jwt = true). The token is passed in
// the body; on success the credentials are stored in canvas_credentials and
// canvas_sync_state is seeded with token_status='valid'.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0'
import { corsHeaders, jsonResponse } from '../_shared/cors.ts'
import { createAdminClient } from '../_shared/supabase-admin.ts'
import { CanvasError, getSelf } from '../_shared/canvas.ts'

interface VerifyBody {
  pat?: string
  base_url?: string
  save?: boolean       // if true, persist to canvas_credentials on success
  disconnect?: boolean // if true, delete canvas_credentials + canvas_sync_state for the caller
}

// Kicks canvas-ingest for a specific user. Uses the same env vars canvas-ingest
// expects: CRON_SECRET header, service-role Authorization. Runs fire-and-forget.
async function kickFirstIngest(userId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  const isDev = Deno.env.get('SUPABASE_ENV') === 'dev'
  if (!supabaseUrl || !serviceKey) return
  // canvas-ingest fails closed unless CRON_SECRET is set or SUPABASE_ENV=dev.
  if (!cronSecret && !isDev) {
    console.warn('[canvas-verify] Skipping first-ingest: CRON_SECRET not set (and not dev)')
    return
  }
  const response = await fetch(`${supabaseUrl}/functions/v1/canvas-ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ user_id: userId }),
  })
  if (!response.ok) {
    console.warn(`[canvas-verify] first-ingest returned ${response.status}`)
  }
}

async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const jwt = authHeader.slice('Bearer '.length)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return null
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  let body: VerifyBody
  try {
    body = (await req.json()) as VerifyBody
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  const userId = await getUserIdFromRequest(req)
  if (!userId) {
    return jsonResponse({ error: 'Not authenticated' }, 401)
  }

  // Disconnect path: delete credentials + sync state for the caller.
  if (body.disconnect) {
    const admin = createAdminClient()
    const { error: credError } = await admin.from('canvas_credentials').delete().eq('user_id', userId)
    if (credError) {
      return jsonResponse({ ok: false, message: `Failed to disconnect: ${credError.message}` }, 500)
    }
    await admin.from('canvas_sync_state').delete().eq('user_id', userId)
    return jsonResponse({ ok: true, disconnected: true })
  }

  const pat = body.pat?.trim()
  const baseUrl = body.base_url?.trim()
  if (!pat || !baseUrl) {
    return jsonResponse({ error: 'pat and base_url are required' }, 400)
  }

  // Test the credentials against Canvas.
  let self
  try {
    self = await getSelf({ pat, baseUrl })
  } catch (err) {
    if (err instanceof CanvasError) {
      return jsonResponse({ ok: false, kind: err.kind, message: err.message }, err.kind === 'auth' ? 401 : 502)
    }
    return jsonResponse({ ok: false, message: 'Unknown error validating Canvas credentials' }, 500)
  }

  // Persist if requested. Rolls back the credentials write if the sync-state
  // seed fails, so we never leave orphan credentials without accompanying
  // sync state (which would cause the ingest job to poll without a state row).
  if (body.save) {
    const admin = createAdminClient()
    const { error: credError } = await admin
      .from('canvas_credentials')
      .upsert({ user_id: userId, pat, base_url: baseUrl, updated_at: new Date().toISOString() })
    if (credError) {
      return jsonResponse({ ok: false, message: `Failed to save credentials: ${credError.message}` }, 500)
    }

    const { error: syncError } = await admin
      .from('canvas_sync_state')
      .upsert({
        user_id: userId,
        canvas_domain: baseUrl,
        token_status: 'valid',
        updated_at: new Date().toISOString(),
      })
    if (syncError) {
      // Roll back the credentials write so the user isn't left in a half-saved state.
      await admin.from('canvas_credentials').delete().eq('user_id', userId)
      return jsonResponse({ ok: false, message: `Failed to seed sync state: ${syncError.message}` }, 500)
    }

    // Kick a first-ingest for this user so the dashboard populates without
    // waiting for the next 6h cron tick. Fire-and-forget: any failure surfaces
    // in canvas-ingest logs; cron will retry next tick regardless.
    kickFirstIngest(userId).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[canvas-verify] first-ingest kick failed:', err)
    })
  }

  return jsonResponse({
    ok: true,
    canvas_user: { id: self.id, name: self.name, short_name: self.short_name },
    saved: Boolean(body.save),
  })
})
