-- Core app tables required before baseline RLS migrations.
-- Safe on fresh local Supabase: uses IF NOT EXISTS only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- users — app profile row keyed to auth.users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  tier text not null default 'free' check (tier in ('free', 'premium')),
  onboarding_step text not null default 'start',
  onboarding_completed boolean not null default false,
  onboarding_q1 text,
  onboarding_q2_before text,
  onboarding_q2_after text,
  field_of_study text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- learning_profile — minimal shape; later migrations align to scheduler spec
-- ---------------------------------------------------------------------------
create table if not exists public.learning_profile (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  worker_type text check (worker_type in ('early_bird', 'morning', 'afternoon', 'night_owl')),
  unavailable_before text not null default '08:00',
  unavailable_after text not null default '22:00',
  peak_hour_map jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists learning_profile_user_id_key
  on public.learning_profile (user_id);

-- Auto-create public.users row when a new auth user signs up (local + hosted).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', null)
  )
  on conflict (id) do update
    set email = excluded.email,
        name = coalesce(public.users.name, excluded.name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();
