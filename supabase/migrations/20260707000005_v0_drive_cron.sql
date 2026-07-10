-- Schedule drive-ingest (6h metadata sync) and drive-content-extract (every 15
-- minutes queue drain) via pg_cron + pg_net.
--
-- Prerequisites (same GUCs as canvas-ingest / calendar-renew).
-- Reference: External Sources/google-drive.md §3, CLAUDE.md §5 Phase 5 + §10.6.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.drive_ingest_cron_tick()
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
  fn_url := coalesce(
    current_setting('app.settings.supabase_url', true),
    current_setting('supabase.url', true)
  ) || '/functions/v1/drive-ingest';

  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );

  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');

  if fn_url is null or fn_url = '/functions/v1/drive-ingest'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'drive_ingest_cron_tick: GUCs not configured; skipping';
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
exception when others then
  raise warning 'drive_ingest_cron_tick failed: %', sqlerrm;
end;
$$;

create or replace function public.drive_content_cron_tick()
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
  fn_url := coalesce(
    current_setting('app.settings.supabase_url', true),
    current_setting('supabase.url', true)
  ) || '/functions/v1/drive-content-extract';
  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );
  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');
  if fn_url is null or fn_url = '/functions/v1/drive-content-extract'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'drive_content_cron_tick: GUCs not configured; skipping';
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
exception when others then
  raise warning 'drive_content_cron_tick failed: %', sqlerrm;
end;
$$;

do $$
declare existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'drive-ingest-6h';
  if existing_jobid is not null then perform cron.unschedule(existing_jobid); end if;
  perform cron.schedule('drive-ingest-6h', '15 */6 * * *',
    $job$ select public.drive_ingest_cron_tick() $job$);

  select jobid into existing_jobid from cron.job where jobname = 'drive-content-15m';
  if existing_jobid is not null then perform cron.unschedule(existing_jobid); end if;
  perform cron.schedule('drive-content-15m', '*/15 * * * *',
    $job$ select public.drive_content_cron_tick() $job$);
end;
$$;
