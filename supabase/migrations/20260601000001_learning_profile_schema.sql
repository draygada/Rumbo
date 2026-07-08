-- Define learning_profile table and ensure all scheduler-required columns exist.
-- Safe to run on existing tables: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

create table if not exists public.learning_profile (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  unavailable_before          integer not null default 8,   -- hour 0–23
  unavailable_after           integer not null default 22,  -- hour 0–23
  peak_hour_map               jsonb not null default '[]',
  block_ceiling_mins          integer not null default 60,
  target_block_mins           integer not null default 45,
  distribution_preference     text not null default 'even',
  deadline_proximity_buckets  jsonb not null default '{"early_avg":3,"middle_avg":3,"late_avg":3,"early_count":0,"middle_count":0,"late_count":0}',
  urgency_threshold           numeric not null default 2.0,
  shallow_before_deep         boolean not null default true,
  profile_stage               integer not null default 1,
  total_reflections           integer not null default 0,
  ceiling_last_adjusted_at    timestamptz,
  ceiling_adjustment_sessions integer not null default 0,
  updated_at                  timestamptz not null default now(),
  constraint learning_profile_user_id_key unique (user_id),
  constraint learning_profile_distribution_check
    check (distribution_preference in ('front_load', 'even', 'ramp')),
  constraint learning_profile_stage_check
    check (profile_stage in (1, 2, 3))
);

-- Add any missing columns on existing tables (idempotent)
alter table public.learning_profile
  add column if not exists unavailable_before          integer not null default 8,
  add column if not exists unavailable_after           integer not null default 22,
  add column if not exists peak_hour_map               jsonb not null default '[]',
  add column if not exists block_ceiling_mins          integer not null default 60,
  add column if not exists target_block_mins           integer not null default 45,
  add column if not exists distribution_preference     text not null default 'even',
  add column if not exists deadline_proximity_buckets  jsonb not null default '{"early_avg":3,"middle_avg":3,"late_avg":3,"early_count":0,"middle_count":0,"late_count":0}',
  add column if not exists urgency_threshold           numeric not null default 2.0,
  add column if not exists shallow_before_deep         boolean not null default true,
  add column if not exists profile_stage               integer not null default 1,
  add column if not exists total_reflections           integer not null default 0,
  add column if not exists ceiling_last_adjusted_at    timestamptz,
  add column if not exists ceiling_adjustment_sessions integer not null default 0,
  add column if not exists updated_at                  timestamptz not null default now();

-- Drop worker_type column if it was inserted by old onboarding code
alter table public.learning_profile drop column if exists worker_type;

-- Normalize any HH:MM strings that old onboarding code stored
update public.learning_profile
  set unavailable_before = cast(split_part(unavailable_before::text, ':', 1) as integer)
  where unavailable_before::text like '%:%';

update public.learning_profile
  set unavailable_after = cast(split_part(unavailable_after::text, ':', 1) as integer)
  where unavailable_after::text like '%:%';

-- Convert any Record<string,number> peak_hour_map to HourScore[] array format
-- e.g. {"8": 0.7, "9": 0.7} → [{"hour":0,"score":0.5},{"hour":8,"score":0.7},...]
update public.learning_profile
  set peak_hour_map = (
    select jsonb_agg(jsonb_build_object('hour', h, 'score', coalesce((peak_hour_map->>h::text)::numeric, 0.3)) order by h)
    from generate_series(0, 23) as h
  )
  where jsonb_typeof(peak_hour_map) = 'object';

create index if not exists learning_profile_user_id_idx on public.learning_profile(user_id);

alter table public.learning_profile enable row level security;
