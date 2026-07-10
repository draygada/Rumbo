import { supabase } from './supabase'

export async function startGoogleCalendarConnect(returnTo = '/settings'): Promise<void> {
  const { data, error } = await supabase.functions.invoke('calendar-oauth', {
    body: { return_to: returnTo },
  })
  if (error) throw error
  if (!data?.url) throw new Error('No OAuth URL returned')
  window.location.href = data.url as string
}

export async function disconnectGoogleCalendar(): Promise<void> {
  const { error } = await supabase
    .from('calendar_connections')
    .delete()
    .eq('provider', 'google')
  if (error) throw error
}

export async function getGoogleCalendarConnected(): Promise<boolean> {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select('id')
    .eq('provider', 'google')
    .maybeSingle()
  if (error) throw error
  return !!data
}

const REQUIRED_V0_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
]

// True when the stored Google connection covers the V0 scope set. Pre-scopes
// connections (empty array) count as deficient — the user re-consents once to
// upgrade. Returns true when no connection exists at all (nothing to fix).
export async function getGoogleCalendarScopesOk(): Promise<boolean> {
  const { data, error } = await supabase
    .from('calendar_connections')
    .select('scopes')
    .eq('provider', 'google')
    .maybeSingle()
  if (error) throw error
  if (!data) return true
  const scopes = (data.scopes ?? []) as string[]
  return REQUIRED_V0_SCOPES.every(s => scopes.includes(s))
}
