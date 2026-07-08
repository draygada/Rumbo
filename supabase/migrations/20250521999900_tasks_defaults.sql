-- Ensure tasks table can accept client inserts without explicit id/status/created_at.
-- Safe on existing tables: only sets column defaults, does not drop data.

create extension if not exists pgcrypto;

-- Create tasks if missing (fresh projects)
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  due_date timestamptz not null,
  estimated_mins integer not null,
  work_type text check (work_type in ('deep', 'shallow')),
  classifier_confidence numeric,
  shallow_score numeric,
  deep_score numeric,
  user_overrode_classifier boolean not null default false,
  pdf_url text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Fix existing tasks table missing defaults
alter table public.tasks
  alter column id set default gen_random_uuid();

alter table public.tasks
  alter column status set default 'active';

alter table public.tasks
  alter column created_at set default now();

alter table public.tasks
  alter column user_overrode_classifier set default false;
