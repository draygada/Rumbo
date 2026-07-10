-- Schedule canvas-ingest to run every 6h via pg_cron + pg_net.
--
-- Pattern follows the existing nightly_schedule_refresh() in
-- 20250523100000_phase5_scheduling.sql — a SECURITY DEFINER wrapper function
-- reads config from Supabase Vault, then POSTs to the Edge Function.
--
-- Prerequisites (operator actions, not migration steps):
--   1. Set the Edge Function env var CRON_SECRET (used by canvas-ingest's
--      authorized() check):
--        supabase secrets set CRON_SECRET=<strong-random-value>
--   2. Expose the same secret + service-role key + supabase URL to Postgres as
--      GUCs so this function can read them via current_setting(...). Supabase
--      Vault does NOT auto-expose entries as app.settings.* GUCs; run once:
--        alter database postgres set app.settings.supabase_url = '<url>';
--        alter database postgres set app.settings.service_role_key = '<key>';
--        alter database postgres set app.settings.cron_secret = '<same-value>';
--      Rotate by re-running the ALTER DATABASE statements. If any GUC is
--      missing, this function skips (raises notice, does not fire a bad request).
--
-- Reference: canvas.md §3, CLAUDE.md §5 Phase 2 + §10.6.

-- ---------------------------------------------------------------------------
-- Extensions: pg_net for outbound HTTP, pg_cron for scheduling.
-- Both are managed by Supabase — safe to declare with IF NOT EXISTS.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- canvas_ingest_cron_tick — invoked by pg_cron every 6h. POSTs to the
-- canvas-ingest Edge Function with the cron secret in the header. Body is
-- empty so the function iterates all users with valid Canvas credentials.
--
-- SECURITY DEFINER so the function can read Vault secrets without RLS. Fails
-- soft on network errors (pg_net is fire-and-forget); Edge Function logs are
-- the source of truth for per-run success.
-- ---------------------------------------------------------------------------
create or replace function public.canvas_ingest_cron_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  fn_url        text;
  service_key   text;
  cron_secret   text;
begin
  -- Resolve config from Vault-backed settings (set via supabase secrets set / dashboard).
  fn_url := coalesce(
    current_setting('app.settings.supabase_url', true),
    current_setting('supabase.url', true)
  ) || '/functions/v1/canvas-ingest';

  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );

  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');

  -- Skip if not configured — avoid firing an invalid request every 6h in dev.
  -- fn_url can be NULL if both supabase_url settings are missing (concat with
  -- NULL propagates), which would produce a null URL for net.http_post.
  if fn_url is null or fn_url = '/functions/v1/canvas-ingest'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'canvas_ingest_cron_tick: supabase_url / service_role_key / cron_secret GUC not configured; skipping';
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb
  );
exception
  when others then
    -- Do not abort the cron worker on transient issues; Edge Function logs
    -- capture per-run detail.
    raise warning 'canvas_ingest_cron_tick failed: %', sqlerrm;
end;
$$;

comment on function public.canvas_ingest_cron_tick is
  'Schedule via pg_cron: select cron.schedule(''canvas-ingest-6h'', ''0 */6 * * *'', $$select public.canvas_ingest_cron_tick()$$);';

-- ---------------------------------------------------------------------------
-- Schedule the job. Idempotent: unschedule any existing entry with the same
-- name before scheduling (in case cadence changes across migrations).
-- ---------------------------------------------------------------------------
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'canvas-ingest-6h';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;

  perform cron.schedule(
    'canvas-ingest-6h',
    '0 */6 * * *',  -- top of every 6th hour: 00:00, 06:00, 12:00, 18:00 UTC
    $job$ select public.canvas_ingest_cron_tick() $job$
  );
end;
$$;
