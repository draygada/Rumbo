-- Schedule calendar-renew to run daily via pg_cron + pg_net.
--
-- Runs at 08:30 UTC daily. calendar-renew's own logic decides which
-- channels need renewal and whether today's tick performs a forced-window
-- sync (Sundays). Push notifications from calendar-webhook keep the graph
-- fresh between renewal ticks — this job is maintenance, not primary sync.
--
-- Prerequisites (operator actions, same GUCs canvas-ingest already uses):
--   alter database postgres set app.settings.supabase_url = '<url>';
--   alter database postgres set app.settings.service_role_key = '<key>';
--   alter database postgres set app.settings.cron_secret = '<CRON_SECRET value>';
--
-- Reference: External Sources/google-calendar.md §7, CLAUDE.md §5 Phase 4 + §10.6.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.calendar_renew_cron_tick()
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
  ) || '/functions/v1/calendar-renew';

  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );

  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');

  if fn_url is null or fn_url = '/functions/v1/calendar-renew'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'calendar_renew_cron_tick: supabase_url / service_role_key / cron_secret GUC not configured; skipping';
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
    raise warning 'calendar_renew_cron_tick failed: %', sqlerrm;
end;
$$;

comment on function public.calendar_renew_cron_tick is
  'Schedule via pg_cron: select cron.schedule(''calendar-renew-daily'', ''30 8 * * *'', $$select public.calendar_renew_cron_tick()$$);';

do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'calendar-renew-daily';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;

  perform cron.schedule(
    'calendar-renew-daily',
    '30 8 * * *',  -- 08:30 UTC daily
    $job$ select public.calendar_renew_cron_tick() $job$
  );
end;
$$;
