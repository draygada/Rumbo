-- V0 llamaparse_jobs — async job queue for LlamaParse extractions.
--
-- Rationale: Supabase free-tier edge functions cap at 150s. A single realistic
-- PDF/DOCX through LlamaParse (upload + parse + result fetch) commonly exceeds
-- that. So canvas-file-extract now enqueues (fast) and a separate
-- llamaparse-poller drains this queue on a 30s pg_cron tick.
--
-- Lifecycle:
--   1. canvas-file-extract downloads the Canvas file, uploads to LlamaParse,
--      inserts { normalized_event_id, llamaparse_job_id, status: 'pending' }.
--   2. llamaparse-poller (cron) polls LlamaParse for each pending job.
--      On SUCCESS: fetches markdown, writes to normalized_events.normalized_text,
--                 resets pipeline_version_v4 so brain-pipeline-v4 reprocesses.
--                 Marks job 'done'.
--      On ERROR:  marks job 'error' with error message.

create table if not exists public.llamaparse_jobs (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  normalized_event_id     uuid not null references public.normalized_events(id) on delete cascade,
  llamaparse_job_id       text not null,
  source_mime             text not null,
  source_display_name     text,
  status                  text not null default 'pending'
                          check (status in ('pending', 'done', 'error', 'cancelled')),
  requested_at            timestamptz not null default now(),
  polled_at               timestamptz,
  completed_at            timestamptz,
  error                   text,
  chars_written           int
);

-- Uniqueness: one job per (event, llamaparse_job_id) so retries idempotent.
create unique index if not exists llamaparse_jobs_event_job_uidx
  on public.llamaparse_jobs (normalized_event_id, llamaparse_job_id);

-- Poller drain: fetch pending jobs oldest-first.
create index if not exists llamaparse_jobs_pending_idx
  on public.llamaparse_jobs (status, requested_at)
  where status = 'pending';

-- User-scoped lookups (debugging, admin dashboards).
create index if not exists llamaparse_jobs_by_user_idx
  on public.llamaparse_jobs (user_id, requested_at desc);

-- RLS: server-side only (service_role bypasses).
alter table public.llamaparse_jobs enable row level security;

create policy llamaparse_jobs_none on public.llamaparse_jobs
  for select
  to authenticated
  using (false);
