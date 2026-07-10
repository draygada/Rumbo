-- V0 bootstrap: prepare Supabase for graph-brain schema.
-- Safe smoke test: enables pgvector, extends calendar_connections with a scopes
-- column, and adds canvas_credentials. Does not touch scheduler-era tables
-- (tasks, work_blocks, learning_profile) or existing RLS policies.
--
-- Reference: CLAUDE.md §5 Phase 1a, Rumbo-Design-Docs/Infrastructure/storage.md §0.

-- ---------------------------------------------------------------------------
-- pgvector — required for graph_nodes.embedding, entity_candidates.embedding.
-- Not consumed by this migration; declared here so later graph-brain
-- migrations can rely on it being enabled.
-- ---------------------------------------------------------------------------
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- calendar_connections: track which OAuth scopes each grant actually
-- authorizes. Pre-existing rows carry an empty array by default so the app
-- can detect pre-scope-expansion users and prompt reconnect.
-- See Rumbo-Design-Docs/Frontend/onboarding.md — Stage 3 reconnect path.
-- ---------------------------------------------------------------------------
alter table public.calendar_connections
  add column if not exists scopes text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- canvas_credentials: student-generated Canvas PAT + base URL.
-- Service-role writes only (from onboarding Edge Function). No client reads.
-- One row per user; delete cascades from auth.users.
-- ---------------------------------------------------------------------------
create table if not exists public.canvas_credentials (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  pat         text not null,
  base_url    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.canvas_credentials enable row level security;

-- No SELECT/INSERT/UPDATE/DELETE policies for authenticated role — the PAT
-- must never reach the browser. All access goes through service-role Edge
-- Functions. Explicit revokes are belt-and-suspenders in case future grants
-- get added at the schema level.
revoke all on public.canvas_credentials from authenticated;
revoke all on public.canvas_credentials from anon;

-- Allow the user themselves to know whether a connection exists (dashboard
-- can render "Canvas not connected" copy without leaking the PAT). Column
-- grant excludes the pat column.
grant select (user_id, base_url, created_at, updated_at)
  on public.canvas_credentials to authenticated;

drop policy if exists "canvas_credentials_select_own" on public.canvas_credentials;
create policy "canvas_credentials_select_own"
  on public.canvas_credentials for select
  using (auth.uid() = user_id);
