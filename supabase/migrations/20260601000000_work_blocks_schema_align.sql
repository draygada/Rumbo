-- Align work_blocks schema with SchedulerBlock spec:
--   start_time  → starts_at
--   end_time    → ends_at
--   completed boolean → status text ('scheduled'|'active'|'completed'|'skipped')
-- Add missing scheduler output columns.

-- Rename timestamp columns
alter table public.work_blocks rename column start_time to starts_at;
alter table public.work_blocks rename column end_time to ends_at;

-- Fix check constraint that referenced old column names
alter table public.work_blocks drop constraint if exists work_blocks_end_after_start;
alter table public.work_blocks add constraint work_blocks_end_after_start check (ends_at > starts_at);

-- Replace index on old column name
drop index if exists work_blocks_start_time_idx;
create index if not exists work_blocks_starts_at_idx on public.work_blocks(starts_at);

-- Replace completed boolean with status enum-like text column
alter table public.work_blocks add column if not exists status text not null default 'scheduled';
update public.work_blocks set status = 'completed' where completed = true;
alter table public.work_blocks drop column if exists completed;
alter table public.work_blocks add constraint work_blocks_status_check
  check (status in ('scheduled', 'active', 'completed', 'skipped'));

-- Add scheduler output columns that were previously dropped on insert
alter table public.work_blocks add column if not exists duration_mins integer not null default 0;
alter table public.work_blocks add column if not exists slot_score numeric not null default 0;
alter table public.work_blocks add column if not exists placement_score numeric not null default 0;
alter table public.work_blocks add column if not exists scheduled_by text not null default 'algorithm';
alter table public.work_blocks add column if not exists confidence_adjusted boolean not null default false;
alter table public.work_blocks add column if not exists deadline_proximity numeric not null default 0;
