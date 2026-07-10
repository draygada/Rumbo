// brain-kick — fire-and-forget helper that kicks the brain-pipeline Edge
// Function for a specific user. Called at the end of each successful ingest
// (canvas-ingest / drive-ingest / calendar-ingest) so the graph pipeline
// consumes fresh normalized_events without waiting for the next 6h cron tick.

export async function kickBrainPipeline(userId: string): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
  const isDev = Deno.env.get('SUPABASE_ENV') === 'dev'
  if (!supabaseUrl || !serviceKey) return
  if (!cronSecret && !isDev) {
    console.warn('[brain-kick] Skipping: CRON_SECRET not set (and not dev)')
    return
  }
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/brain-pipeline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
        'x-cron-secret': cronSecret,
      },
      body: JSON.stringify({ user_id: userId }),
    })
    if (!res.ok) {
      console.warn(`[brain-kick] brain-pipeline returned ${res.status}`)
    }
  } catch (err) {
    console.warn('[brain-kick] failed:', err)
  }
}
