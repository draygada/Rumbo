export async function invokeCalendarSync(
  userId: string,
  timezone?: string,
): Promise<{ ok: boolean; synced?: number; message?: string; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }
  }

  const res = await fetch(`${supabaseUrl}/functions/v1/calendar-sync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, timezone }),
  })

  const text = await res.text()
  if (!res.ok) {
    console.error('calendar-sync failed', text)
    return { ok: false, error: text }
  }

  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: text }
  }
}
