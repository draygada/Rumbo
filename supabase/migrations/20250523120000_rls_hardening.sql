-- Harden RLS for projects that already applied phase5 with permissive work_blocks policies.
-- Safe to run on fresh installs (drops/recreates policies).

-- ---------------------------------------------------------------------------
-- work_blocks: read-only for authenticated users
-- ---------------------------------------------------------------------------
drop policy if exists "Users read own work_blocks" on public.work_blocks;
drop policy if exists "Users insert own work_blocks" on public.work_blocks;
drop policy if exists "Users update own work_blocks" on public.work_blocks;
drop policy if exists "Users delete own work_blocks" on public.work_blocks;
drop policy if exists "work_blocks_select_own" on public.work_blocks;

create policy "work_blocks_select_own"
  on public.work_blocks for select
  using (auth.uid() = user_id);

revoke all on public.work_blocks from authenticated;
grant select on public.work_blocks to authenticated;

-- ---------------------------------------------------------------------------
-- calendar_connections: no token reads; disconnect only
-- ---------------------------------------------------------------------------
drop policy if exists "Users read own calendar_connections" on public.calendar_connections;
drop policy if exists "Users delete own calendar_connections" on public.calendar_connections;
drop policy if exists "calendar_connections_select_own" on public.calendar_connections;
drop policy if exists "calendar_connections_delete_own" on public.calendar_connections;

create policy "calendar_connections_select_own"
  on public.calendar_connections for select
  using (auth.uid() = user_id);

create policy "calendar_connections_delete_own"
  on public.calendar_connections for delete
  using (auth.uid() = user_id);

revoke all on public.calendar_connections from authenticated;
grant select (id, user_id, provider, expires_at, created_at)
  on public.calendar_connections to authenticated;
grant delete on public.calendar_connections to authenticated;

-- ---------------------------------------------------------------------------
-- Re-apply baseline policies if missing (idempotent)
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.learning_profile enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "users_select_own" on public.users;
drop policy if exists "users_insert_own" on public.users;
drop policy if exists "users_update_own" on public.users;

create policy "users_select_own"
  on public.users for select
  using (auth.uid() = id);

create policy "users_insert_own"
  on public.users for insert
  with check (auth.uid() = id);

create policy "users_update_own"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.prevent_user_tier_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.tier is distinct from old.tier then
    raise exception 'tier cannot be changed by client';
  end if;
  return new;
end;
$$;

drop trigger if exists users_prevent_tier_change on public.users;
create trigger users_prevent_tier_change
  before update on public.users
  for each row
  execute function public.prevent_user_tier_change();

drop policy if exists "learning_profile_select_own" on public.learning_profile;
drop policy if exists "learning_profile_insert_own" on public.learning_profile;
drop policy if exists "learning_profile_update_own" on public.learning_profile;

create policy "learning_profile_select_own"
  on public.learning_profile for select
  using (auth.uid() = user_id);

create policy "learning_profile_insert_own"
  on public.learning_profile for insert
  with check (auth.uid() = user_id);

create policy "learning_profile_update_own"
  on public.learning_profile for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "tasks_select_own" on public.tasks;
drop policy if exists "tasks_insert_own" on public.tasks;
drop policy if exists "tasks_update_own" on public.tasks;
drop policy if exists "tasks_delete_own" on public.tasks;

create policy "tasks_select_own"
  on public.tasks for select
  using (auth.uid() = user_id);

create policy "tasks_insert_own"
  on public.tasks for insert
  with check (auth.uid() = user_id);

create policy "tasks_update_own"
  on public.tasks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "tasks_delete_own"
  on public.tasks for delete
  using (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update on public.users to authenticated;
grant select, insert, update on public.learning_profile to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
