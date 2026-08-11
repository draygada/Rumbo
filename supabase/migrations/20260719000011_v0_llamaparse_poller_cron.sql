-- V0 llamaparse-poller cron — drain llamaparse_jobs every 30s.
--
-- Pattern matches brain-pipeline cron in 20260707000007_v0_brain_pipeline.sql.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.llamaparse_poller_cron_tick()
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
  ) || '/functions/v1/llamaparse-poller';

  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );

  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');

  if fn_url is null or fn_url = '/functions/v1/llamaparse-poller'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'llamaparse_poller_cron_tick: config missing; skipping';
    return;
  end if;

  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'x-cron-secret', cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
exception
  when others then
    raise warning 'llamaparse_poller_cron_tick failed: %', sqlerrm;
end;
$$;

-- Schedule: every 30 seconds. pg_cron supports second-precision via '*/30 * * * * *'
-- syntax (6-field cron with seconds). Fallback: run twice per minute.
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'llamaparse-poller-30s';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
  perform cron.schedule(
    'llamaparse-poller-30s',
    '30 seconds',
    $job$ select public.llamaparse_poller_cron_tick() $job$
  );
end;
$$;
