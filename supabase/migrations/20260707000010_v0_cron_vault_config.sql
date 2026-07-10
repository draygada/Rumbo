-- Switch every cron tick from database GUCs to Supabase Vault.
--
-- Why: Supabase Cloud denies `alter database ... set` to the postgres role,
-- so app.settings.* GUCs can't be populated from the SQL editor. Vault is
-- available and readable via a security-definer helper.
--
-- Operator setup — one-time (SQL editor):
--   select vault.create_secret('<supabase_url>',   'rumbo_supabase_url');
--   select vault.create_secret('<service_role_key>','rumbo_service_role_key');
--   select vault.create_secret('<CRON_SECRET>',    'rumbo_cron_secret');
--
-- All six existing cron functions are rewritten in place; the pg_cron
-- schedules (canvas-ingest-6h, calendar-renew-daily, drive-ingest-6h,
-- drive-content-15m, brain-pipeline-6h, brain-decay-daily) call these
-- functions by name and don't need re-scheduling.

create or replace function public._rumbo_cron_config()
returns table(fn_url_base text, service_key text, cron_secret text)
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  return query
  select
    (select decrypted_secret from vault.decrypted_secrets where name = 'rumbo_supabase_url'),
    (select decrypted_secret from vault.decrypted_secrets where name = 'rumbo_service_role_key'),
    (select decrypted_secret from vault.decrypted_secrets where name = 'rumbo_cron_secret');
end;
$$;

create or replace function public.canvas_ingest_cron_tick()
returns void language plpgsql security definer set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'canvas_ingest_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/canvas-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb
  );
exception when others then raise warning 'canvas_ingest_cron_tick failed: %', sqlerrm;
end;
$$;

create or replace function public.calendar_renew_cron_tick()
returns void language plpgsql security definer set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'calendar_renew_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/calendar-renew',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb
  );
exception when others then raise warning 'calendar_renew_cron_tick failed: %', sqlerrm;
end;
$$;

create or replace function public.drive_ingest_cron_tick()
returns void language plpgsql security definer set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'drive_ingest_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/drive-ingest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb
  );
exception when others then raise warning 'drive_ingest_cron_tick failed: %', sqlerrm;
end;
$$;

create or replace function public.drive_content_cron_tick()
returns void language plpgsql security definer set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'drive_content_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/drive-content-extract',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb
  );
exception when others then raise warning 'drive_content_cron_tick failed: %', sqlerrm;
end;
$$;

create or replace function public.brain_pipeline_cron_tick()
returns void language plpgsql security definer set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'brain_pipeline_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/brain-pipeline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb
  );
exception when others then raise warning 'brain_pipeline_cron_tick failed: %', sqlerrm;
end;
$$;

create or replace function public.brain_decay_cron_tick()
returns void language plpgsql security definer set search_path = public
as $$
declare cfg record;
begin
  select * into cfg from public._rumbo_cron_config();
  if cfg.fn_url_base is null or cfg.service_key is null or cfg.cron_secret is null then
    raise notice 'brain_decay_cron_tick: vault secrets missing; skipping';
    return;
  end if;
  perform net.http_post(
    url := cfg.fn_url_base || '/functions/v1/brain-decay',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || cfg.service_key,
      'x-cron-secret', cfg.cron_secret
    ),
    body := '{}'::jsonb
  );
exception when others then raise warning 'brain_decay_cron_tick failed: %', sqlerrm;
end;
$$;
