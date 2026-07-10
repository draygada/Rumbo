import type { BusyInterval as TimeInterval } from './scheduler.ts'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
// V0 scope: read-only Calendar + Drive as a single combined grant
// (data-ingestion.md §2). Scheduler write path (createGoogleCalendarEvent etc.)
// is deferred out of V0 — see Legacy/scheduler.md.
const V0_GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly'

export function getGoogleAuthUrl(redirectUri: string, state: string): string {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  if (!clientId) throw new Error('Missing GOOGLE_CLIENT_ID')

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: V0_GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params}`
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope?: string }> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!clientId || !clientSecret) throw new Error('Missing Google OAuth credentials')

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token exchange failed: ${text}`)
  }
  return res.json()
}

export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  access_token: string
  expires_in: number
}> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')
  if (!clientId || !clientSecret) throw new Error('Missing Google OAuth credentials')

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token refresh failed: ${text}`)
  }
  return res.json()
}

export async function fetchGoogleBusyIntervals(
  accessToken: string,
  timeMin: Date,
  timeMax: Date,
): Promise<TimeInterval[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  })

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Calendar events failed: ${text}`)
  }

  const data = await res.json()
  const items = (data.items ?? []) as Array<{
    start?: { dateTime?: string; date?: string }
    end?: { dateTime?: string; date?: string }
  }>

  return items
    .map(ev => {
      const startStr = ev.start?.dateTime ?? ev.start?.date
      const endStr = ev.end?.dateTime ?? ev.end?.date
      if (!startStr || !endStr) return null
      const start = new Date(startStr)
      let end = new Date(endStr)
      if (!ev.start?.dateTime) {
        end = new Date(end.getTime() - 1)
      }
      return { start, end }
    })
    .filter((x): x is TimeInterval => x !== null)
}

/** Returns IDs of all Google Calendar events whose summary starts with `[Rumbo]`, from timeMin onward. */
export async function listRumboCalendarEventIds(
  accessToken: string,
  timeMin: Date,
): Promise<string[]> {
  const ids: string[] = []
  let pageToken: string | undefined

  do {
    const params = new URLSearchParams({
      q: '[Rumbo]',
      timeMin: timeMin.toISOString(),
      singleEvents: 'true',
      maxResults: '250',
    })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Google Calendar list events failed: ${text}`)
    }

    const data = await res.json()
    for (const item of (data.items ?? []) as Array<{ id?: string; summary?: string }>) {
      if (item.id && item.summary?.startsWith('[Rumbo]')) ids.push(item.id)
    }
    pageToken = data.nextPageToken
  } while (pageToken)

  return ids
}

export async function createGoogleCalendarEvent(
  accessToken: string,
  title: string,
  start: Date,
  end: Date,
  description?: string,
  timeZone = 'UTC',
): Promise<string> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: `[Rumbo] ${title}`,
        description: description ?? 'Scheduled by Rumbo',
        start: { dateTime: start.toISOString(), timeZone },
        end: { dateTime: end.toISOString(), timeZone },
      }),
    },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google Calendar create event failed: ${text}`)
  }
  const data = await res.json()
  return data.id as string
}

export async function deleteGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`Google Calendar delete failed: ${text}`)
  }
}
