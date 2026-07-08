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
