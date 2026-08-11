-- Fix: llamaparse_poller_cron_tick could never run on Supabase Cloud.
--
-- 20260719000011_v0_llamaparse_poller_cron.sql defined the tick using the
-- PRE-VAULT pattern (current_setting('app.settings.*')), copied from
-- 20260707000007_v0_brain_pipeline.sql. But 20260707000010_v0_cron_vault_config
-- had already moved every other tick to Supabase Vault precisely because
-- Supabase Cloud denies `alter database ... set` to the postgres role — so
-- those GUCs can never be populated and the tick always hit its
-- "config missing; skipping" branch and returned.
--
-- Symptom this fixes: llamaparse_jobs rows stuck status='pending' with
-- polled_at IS NULL indefinitely (13 EDUC 475 lecture PDFs sat unextracted
-- from 2026-07-20), while cron.job_run_details recorded tens of thousands of
-- "succeeded" runs — pg_cron logs success because the SQL call itself
-- succeeded, not because any HTTP request was made.
--
-- This rewrites the tick to read config from _rumbo_cron_config() (vault),
-- matching the other six ticks. The pg_cron schedule calls the function by
-- name and needs no re-scheduling.
--
-- REQUIRES the one-time operator setup from 20260707000010 (run once in the
-- Supabase SQL editor, with real values):
--   select vault.create_secret('https://<ref>.supabase.co', 'rumbo_supabase_url');
--   select vault.create_secret('<service_role_key>',        'rumbo_service_role_key');
--   select vault.create_secret('<CRON_SECRET>',             'rumbo_cron_secret');
-- Verify with:  select name from vault.decrypted_secrets where name like 'rumbo_%';

create or replace function public.llamaparse_poller_cron_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'llamaparse_poller_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/llamaparse-poller',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
exception when others then raise warning 'llamaparse_poller_cron_tick failed: %', sqlerrm;
end;
$$;
