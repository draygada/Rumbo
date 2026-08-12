-- Learner-brain slice 3: aggregation watermark.
--
-- The nightly aggregator (learner-aggregate) is idempotent by watermark: each
-- run reads learner_signals created strictly after the user's last successful
-- run, folds them into Neo4j, then advances the mark. Re-running the job an
-- hour later is a no-op; re-running it after a crash replays exactly the
-- signals that never landed.
--
-- Per-user, not global: users are independent, one user's Neo4j failure must
-- not stall everyone else's aggregation, and a partial batch must leave every
-- other user's watermark untouched.
--
-- Spec: Graph Pipeline/learner-brain-architecture.md — "Aggregation algorithm
-- — nightly job", steps 1 and 7.

create table if not exists public.learner_aggregate_state (
  user_id            uuid primary key references auth.users(id) on delete cascade,

  -- Exclusive lower bound for the next read of learner_signals. Epoch on first
  -- run so a brand-new user's entire history folds in on night one.
  last_aggregated_at timestamptz not null default '1970-01-01T00:00:00Z',

  -- Observability, not control flow. When a run fails these tell you whether
  -- the job is stuck on the same batch or quietly processing nothing.
  last_run_at        timestamptz,
  last_signal_count  integer not null default 0,
  last_error         text,

  updated_at         timestamptz not null default now()
);

-- The nightly sweep asks "who has signals to fold in?" by joining against
-- learner_signals; the watermark lookup itself is the primary-key hit.

alter table public.learner_aggregate_state enable row level security;

-- Server-only, exactly like learner_signals. The aggregator runs as
-- service_role (which bypasses RLS); nothing client-side has any business
-- reading a watermark. Students see the reflection surface (Layer 4), never
-- the machinery that produced it.
create policy learner_aggregate_state_none on public.learner_aggregate_state
  for select
  to authenticated
  using (false);
