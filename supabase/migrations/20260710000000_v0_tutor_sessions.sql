-- Phase 8: tutor session state + learner signal capture.
-- See Features/ai-tutor.md §8 and Features/learner-model.md §2.
--
-- V0 usage:
--   - tutor_sessions / tutor_turns are read+written by the tutor Edge Function
--   - learner_signals is APPEND-ONLY by the signal-capture hook; nothing
--     reads it in V0. Phase 2 aggregation is a separate concern.

create table if not exists public.tutor_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  started_at        timestamptz not null default now(),
  last_message_at   timestamptz not null default now(),
  title             text,                       -- LLM-summarized on first turn
  concept_ids       text[] not null default '{}',  -- Neo4j node ids referenced this session
  created_at        timestamptz not null default now()
);

create index if not exists tutor_sessions_by_user_recent
  on public.tutor_sessions (user_id, last_message_at desc);

create table if not exists public.tutor_turns (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.tutor_sessions(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  role              text not null check (role in ('user', 'assistant')),
  content           text not null,
  retrieval_ids     text[] not null default '{}',
  confidence        float,
  mode              text,                        -- 'within_course'|'cross_course'|'ambiguous'|'small_talk'
  created_at        timestamptz not null default now()
);

create index if not exists tutor_turns_by_session
  on public.tutor_turns (session_id, created_at);

create index if not exists tutor_turns_by_user_recent
  on public.tutor_turns (user_id, created_at desc);

create table if not exists public.learner_signals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  target_id         text not null,               -- Neo4j node id
  target_type       text not null,               -- 'Concept'|'Assignment'|'Course'
  signal_type       text not null check (signal_type in ('struggle', 'understanding', 'preference')),
  signal_value      jsonb,
  session_id        uuid references public.tutor_sessions(id) on delete cascade,
  turn_id           uuid references public.tutor_turns(id) on delete cascade,
  source            text not null check (source in ('explicit', 'inferred')),
  confidence        float,
  created_at        timestamptz not null default now()
);

create index if not exists learner_signals_by_user_target
  on public.learner_signals (user_id, target_id, target_type, created_at desc);

-- RLS ---------------------------------------------------------------------

alter table public.tutor_sessions   enable row level security;
alter table public.tutor_turns      enable row level security;
alter table public.learner_signals  enable row level security;

-- Clients read+write their own sessions and turns. All server-side writes
-- go through service_role which bypasses RLS.

create policy tutor_sessions_own on public.tutor_sessions
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy tutor_turns_own on public.tutor_turns
  for select
  to authenticated
  using (user_id = auth.uid());

-- No client insert on tutor_turns — the Edge Function is the sole writer
-- (would otherwise let clients fake assistant turns).

-- Learner signals are read+written by the server only.
create policy learner_signals_none on public.learner_signals
  for select
  to authenticated
  using (false);
