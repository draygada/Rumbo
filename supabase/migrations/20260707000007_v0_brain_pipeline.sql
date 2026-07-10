-- V0 brain pipeline: resolution shortlist + proximity-neighbors RPC helpers,
-- and pg_cron schedules for brain-pipeline (every 6h at :45 UTC — offset from
-- canvas :00 and drive :15) and brain-decay (daily at 09:00 UTC).
--
-- Same GUC-reading + skip-if-unconfigured pattern as 20260707000002_v0_canvas_cron.sql.
--
-- Reference: entity-resolution.md §2, edge-inference.md §2, CLAUDE.md §5 Phases 7–10.

create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- resolve_shortlist — same-type top-K neighbor lookup for entity resolution.
-- Uses pgvector cosine distance (<->) via the <=> operator, returning distance
-- explicitly so the caller can bucket against merge / review / new thresholds.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_shortlist(
  p_user_id     uuid,
  p_entity_type text,
  p_embedding   vector(1536),
  p_limit       int
)
returns table (
  id                   uuid,
  name                 text,
  entity_type          text,
  source_authority_avg float,
  embedding_distance   float
)
language sql
security definer
set search_path = public
as $$
  select
    g.id,
    g.name,
    g.entity_type,
    g.source_authority_avg,
    (g.embedding <=> p_embedding)::float as embedding_distance
  from public.graph_nodes g
  where g.user_id = p_user_id
    and g.entity_type = p_entity_type
    and g.superseded_at is null
  order by g.embedding <=> p_embedding
  limit p_limit;
$$;

grant execute on function public.resolve_shortlist(uuid, text, vector, int) to service_role;

-- ---------------------------------------------------------------------------
-- proximity_neighbors — top-K nodes within a cosine-distance cutoff for edge
-- inference. Excludes the origin node and any node beyond p_max_distance.
-- ---------------------------------------------------------------------------
create or replace function public.proximity_neighbors(
  p_user_id      uuid,
  p_node_id      uuid,
  p_embedding    vector(1536),
  p_max_distance float,
  p_limit        int
)
returns table (
  id             uuid,
  user_id        uuid,
  name           text,
  entity_type    text,
  is_provisional boolean,
  embedding      vector(1536)
)
language sql
security definer
set search_path = public
as $$
  select
    g.id, g.user_id, g.name, g.entity_type, g.is_provisional, g.embedding
  from public.graph_nodes g
  where g.user_id = p_user_id
    and g.id <> p_node_id
    and g.superseded_at is null
    and (g.embedding <=> p_embedding) < p_max_distance
  order by g.embedding <=> p_embedding
  limit p_limit;
$$;

grant execute on function public.proximity_neighbors(uuid, uuid, vector, float, int) to service_role;

-- ---------------------------------------------------------------------------
-- Cron wrapper: brain-pipeline (every 6h at :45 UTC).
-- ---------------------------------------------------------------------------
create or replace function public.brain_pipeline_cron_tick()
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
  ) || '/functions/v1/brain-pipeline';

  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );

  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');

  if fn_url is null or fn_url = '/functions/v1/brain-pipeline'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'brain_pipeline_cron_tick: config missing; skipping';
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
    raise warning 'brain_pipeline_cron_tick failed: %', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cron wrapper: brain-decay (daily at 09:00 UTC).
-- ---------------------------------------------------------------------------
create or replace function public.brain_decay_cron_tick()
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
  ) || '/functions/v1/brain-decay';

  service_key := coalesce(
    current_setting('app.settings.service_role_key', true),
    current_setting('supabase.service_role_key', true)
  );

  cron_secret := coalesce(current_setting('app.settings.cron_secret', true), '');

  if fn_url is null or fn_url = '/functions/v1/brain-decay'
     or service_key is null or service_key = ''
     or cron_secret = '' then
    raise notice 'brain_decay_cron_tick: config missing; skipping';
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
    raise warning 'brain_decay_cron_tick failed: %', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- Schedule jobs. Idempotent — unschedule if the name already exists, then
-- reschedule at the current cadence.
-- ---------------------------------------------------------------------------
do $$
declare
  existing_jobid bigint;
begin
  -- brain-pipeline: every 6h at :45 UTC (00:45, 06:45, 12:45, 18:45).
  select jobid into existing_jobid from cron.job where jobname = 'brain-pipeline-6h';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
  perform cron.schedule(
    'brain-pipeline-6h',
    '45 */6 * * *',
    $job$ select public.brain_pipeline_cron_tick() $job$
  );

  -- brain-decay: daily at 09:00 UTC.
  select jobid into existing_jobid from cron.job where jobname = 'brain-decay-daily';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
  perform cron.schedule(
    'brain-decay-daily',
    '0 9 * * *',
    $job$ select public.brain_decay_cron_tick() $job$
  );
end;
$$;
