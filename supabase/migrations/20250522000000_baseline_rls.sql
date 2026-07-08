-- Baseline RLS for core tables (users, learning_profile, tasks).
-- Assumes tables already exist from Supabase setup. Safe to re-run policy drops.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;

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

-- Prevent self-promotion to premium (Stripe / service role only)
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

-- ---------------------------------------------------------------------------
-- learning_profile
-- ---------------------------------------------------------------------------
alter table public.learning_profile enable row level security;

create unique index if not exists learning_profile_user_id_key
  on public.learning_profile (user_id);

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

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
alter table public.tasks enable row level security;

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

-- ---------------------------------------------------------------------------
-- Table grants: authenticated role only gets intended operations
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;

grant select, insert, update on public.users to authenticated;
grant select, insert, update on public.learning_profile to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
