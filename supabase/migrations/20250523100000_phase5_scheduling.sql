-- Phase 5: work_blocks, calendar_connections, RLS, nightly schedule refresh

-- work_blocks: scheduled study sessions for tasks
create table if not exists public.work_blocks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  start_time timestamptz not null,
  end_time timestamptz not null,
  calendar_event_id text,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint work_blocks_end_after_start check (end_time > start_time)
);

create index if not exists work_blocks_user_id_idx on public.work_blocks(user_id);
create index if not exists work_blocks_task_id_idx on public.work_blocks(task_id);
create index if not exists work_blocks_start_time_idx on public.work_blocks(start_time);

alter table public.work_blocks enable row level security;

-- Read-only for clients; writes only via service role (schedule-generator)
drop policy if exists "Users insert own work_blocks" on public.work_blocks;
drop policy if exists "Users update own work_blocks" on public.work_blocks;
drop policy if exists "Users delete own work_blocks" on public.work_blocks;

create policy "work_blocks_select_own"
  on public.work_blocks for select
  using (auth.uid() = user_id);

-- calendar_connections: OAuth tokens (service role reads in Edge Functions)
create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.calendar_connections enable row level security;

drop policy if exists "Users read own calendar_connections" on public.calendar_connections;

create policy "calendar_connections_select_own"
  on public.calendar_connections for select
  using (auth.uid() = user_id);

create policy "calendar_connections_delete_own"
  on public.calendar_connections for delete
  using (auth.uid() = user_id);

-- Inserts/updates only via service role (calendar-oauth Edge Function)
-- OAuth tokens are not readable by clients (column grants below)
revoke all on public.calendar_connections from authenticated;
grant select (id, user_id, provider, expires_at, created_at)
  on public.calendar_connections to authenticated;
grant delete on public.calendar_connections to authenticated;

revoke all on public.work_blocks from authenticated;
grant select on public.work_blocks to authenticated;

-- Invoke schedule-generator after new tasks (requires pg_net + vault secrets in production)
create or replace function public.trigger_schedule_on_task_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := coalesce(
      current_setting('app.settings.supabase_url', true),
      current_setting('supabase.url', true)
    ) || '/functions/v1/schedule-generator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        current_setting('app.settings.service_role_key', true),
        current_setting('supabase.service_role_key', true)
      )
    ),
    body := jsonb_build_object('user_id', new.user_id, 'task_id', new.id)
  );
  return new;
exception
  when others then
    -- pg_net may be unavailable locally; client also invokes schedule-generator
    return new;
end;
$$;

drop trigger if exists on_task_insert_schedule on public.tasks;
create trigger on_task_insert_schedule
  after insert on public.tasks
  for each row
  execute function public.trigger_schedule_on_task_insert();

-- Nightly refresh: reschedule all users (2:00 UTC). Configure secrets in Supabase Dashboard.
create or replace function public.nightly_schedule_refresh()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := coalesce(
      current_setting('app.settings.supabase_url', true),
      current_setting('supabase.url', true)
    ) || '/functions/v1/schedule-generator',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(
        current_setting('app.settings.service_role_key', true),
        current_setting('supabase.service_role_key', true)
      ),
      'x-cron-secret', coalesce(current_setting('app.settings.cron_secret', true), '')
    ),
    body := jsonb_build_object('mode', 'nightly')
  );
exception
  when others then
    null;
end;
$$;

comment on function public.nightly_schedule_refresh is
  'Schedule via pg_cron: select cron.schedule(''nightly-rumbo-schedule'', ''0 2 * * *'', $$select public.nightly_schedule_refresh()$$);';
