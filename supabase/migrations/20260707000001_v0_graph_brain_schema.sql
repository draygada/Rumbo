-- V0 graph-brain schema: normalization layer + graph tables + sync state +
-- manual courses + pipeline versioning + shadow tables for pipeline-versioning
-- shadow rebuild (Phase 11).
--
-- Convention: user_id (not student_id) FK'd to auth.users(id) on delete cascade.
-- Every user-scoped table has RLS enabled with a select_own policy. Writes
-- happen via service-role Edge Functions; authenticated clients read only.
--
-- Reference: CLAUDE.md §5 Phase 1b, Rumbo-Design-Docs/Infrastructure/storage.md §0 + §2.

-- ---------------------------------------------------------------------------
-- normalized_events — permanent, replayable raw history. All ingested items
-- from every adapter land here after source-pair dedup + normalization.
-- ---------------------------------------------------------------------------
create table if not exists public.normalized_events (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  source_type           text not null,
    -- canvas_course | canvas_assignment | canvas_announcement | canvas_syllabus
    -- google_calendar | drive | drive_content
    -- manual_course | manual_syllabus | manual_assignment | manual_document | manual_website
  external_id           text not null,
  timestamp             timestamptz,
  course_id             text,
  classification        text,
    -- 'academic' | 'personal' | 'pending' | 'irrelevant' | 'out_of_window'
  classification_source text,
    -- 'heuristic' | 'llm'
  classification_confidence numeric,
  raw_payload           jsonb not null,
  normalized_text       text,
  ingested_at           timestamptz not null default now(),
  extraction_status     text not null default 'pending',
    -- 'pending' | 'done' | 'failed' | 'skipped'
  extracted_at          timestamptz,
  cancelled_at          timestamptz,
  pipeline_version      text not null,
  unique (user_id, source_type, external_id)
);

create index if not exists normalized_events_user_source_idx
  on public.normalized_events (user_id, source_type);
create index if not exists normalized_events_user_timestamp_idx
  on public.normalized_events (user_id, timestamp);
create index if not exists normalized_events_user_extraction_idx
  on public.normalized_events (user_id, extraction_status);
create index if not exists normalized_events_user_classification_idx
  on public.normalized_events (user_id, classification);

-- ---------------------------------------------------------------------------
-- graph_nodes — the durable graph. One row per resolved entity per user.
-- Provisional nodes live here with is_provisional=true until promoted.
-- ---------------------------------------------------------------------------
create table if not exists public.graph_nodes (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  name                    text not null,
  entity_type             text not null,
    -- 'concept' | 'topic' | 'assignment' | 'deadline' | 'person' | 'course_reference'
  embedding               vector(1536) not null,
  mention_count           integer not null default 1,
  source_count            integer not null default 1,
  source_authority_avg    float not null,
  is_provisional          boolean not null default false,
  created_at              timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  superseded_at           timestamptz,
  pipeline_version        text not null
);

create index if not exists graph_nodes_user_type_idx
  on public.graph_nodes (user_id, entity_type);
create index if not exists graph_nodes_user_last_seen_idx
  on public.graph_nodes (user_id, last_seen_at);
create index if not exists graph_nodes_user_provisional_idx
  on public.graph_nodes (user_id, is_provisional);
create index if not exists graph_nodes_embedding_ivfflat_idx
  on public.graph_nodes using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ---------------------------------------------------------------------------
-- entity_candidates — extraction output. Every candidate either merges into
-- an existing graph_node (resolved_node_id) or gets promoted to a new one.
-- ---------------------------------------------------------------------------
create table if not exists public.entity_candidates (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  source_record_id        uuid not null references public.normalized_events(id) on delete cascade,
  name                    text not null,
  entity_type             text not null,
  context_snippet         text not null,
  extraction_confidence   float not null,
  source_authority        float not null,
  embedding               vector(1536),
  resolution_status       text not null default 'pending',
    -- 'pending' | 'merged' | 'new_node' | 'held' | 'discarded'
  resolved_node_id        uuid references public.graph_nodes(id) on delete set null,
  extracted_at            timestamptz not null default now(),
  pipeline_version        text not null
);

create index if not exists entity_candidates_user_status_idx
  on public.entity_candidates (user_id, resolution_status);
create index if not exists entity_candidates_user_source_idx
  on public.entity_candidates (user_id, source_record_id);
create index if not exists entity_candidates_embedding_ivfflat_idx
  on public.entity_candidates using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ---------------------------------------------------------------------------
-- node_mentions — provenance. Every time a candidate resolves to a node,
-- record which source record + which candidate produced the mention. Used
-- by corroboration-independence math in edge-weighting.
-- ---------------------------------------------------------------------------
create table if not exists public.node_mentions (
  id                  uuid primary key default gen_random_uuid(),
  node_id             uuid not null references public.graph_nodes(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  source_record_id    uuid not null references public.normalized_events(id) on delete cascade,
  candidate_id        uuid not null references public.entity_candidates(id) on delete cascade,
  mentioned_at        timestamptz not null default now()
);

create index if not exists node_mentions_node_idx on public.node_mentions (node_id);
create index if not exists node_mentions_user_source_idx
  on public.node_mentions (user_id, source_record_id);

-- ---------------------------------------------------------------------------
-- graph_edges — typed, weighted relationships between graph_nodes.
-- ---------------------------------------------------------------------------
create table if not exists public.graph_edges (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  source_node_id          uuid not null references public.graph_nodes(id) on delete cascade,
  target_node_id          uuid not null references public.graph_nodes(id) on delete cascade,
  relationship_type       text not null,
    -- 'prerequisite' | 'applies_to' | 'part_of' | 'assessed_by'
    -- | 'related_concept' | 'cross_course' | 'sequential'
  direction               text not null,
    -- 'directed' | 'bidirectional'
  extraction_confidence   float not null,
  resolution_confidence   float not null,
  relevance_score         float not null,
  weight_authority        float,
  weight_corroboration    float,
  weight_decay            float,
  weight                  float,
  is_surfaced             boolean not null default false,
  is_provisional          boolean not null default false,
  last_reinforced_at      timestamptz,
  weight_computed_at      timestamptz,
  inferred_from           uuid[],
  inference_reasoning     text,
  superseded_at           timestamptz,
  pipeline_version        text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id, source_node_id, target_node_id, relationship_type)
);

create index if not exists graph_edges_user_source_idx
  on public.graph_edges (user_id, source_node_id);
create index if not exists graph_edges_user_target_idx
  on public.graph_edges (user_id, target_node_id);
create index if not exists graph_edges_user_surfaced_weight_idx
  on public.graph_edges (user_id, is_surfaced, weight desc);
create index if not exists graph_edges_user_reinforced_idx
  on public.graph_edges (user_id, last_reinforced_at);

-- ---------------------------------------------------------------------------
-- Source-specific sync state
-- ---------------------------------------------------------------------------
create table if not exists public.canvas_sync_state (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  canvas_domain     text not null,
  last_polled_at    timestamptz,
  token_status      text not null default 'valid',
  updated_at        timestamptz not null default now()
);

create table if not exists public.canvas_course_sync (
  user_id                     uuid not null references auth.users(id) on delete cascade,
  canvas_course_id            text not null,
  last_assignment_updated_at  timestamptz,
  syllabus_hash               text,
  primary key (user_id, canvas_course_id)
);

create table if not exists public.calendar_sync_state (
  user_id             uuid not null references auth.users(id) on delete cascade,
  calendar_id         text not null,
  is_primary          boolean not null default false,
  sync_token          text,
  channel_id          text,
  channel_resource_id text,
  channel_expiry      timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (user_id, calendar_id)
);

create table if not exists public.drive_sync_state (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  changes_page_token    text not null,
  channel_id            text,
  channel_resource_id   text,
  channel_expiry        timestamptz,
  updated_at            timestamptz not null default now()
);

create table if not exists public.drive_exclusions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  external_id     text not null,
  exclusion_type  text not null,
  added_at        timestamptz not null default now(),
  unique (user_id, external_id)
);

create index if not exists drive_exclusions_user_idx on public.drive_exclusions (user_id);

-- drive_content_queue — lazy on-demand content extraction. Enqueued by the
-- pipeline; consumed by a Drive content-extraction Edge Function.
create table if not exists public.drive_content_queue (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  drive_file_id   text not null,
  requested_by    text not null,
    -- 'extraction' | 'manual' | 'reingest'
  status          text not null default 'pending',
    -- 'pending' | 'processing' | 'done' | 'failed' | 'skipped'
  attempts        integer not null default 0,
  last_error      text,
  queued_at       timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  unique (user_id, drive_file_id)
);

create index if not exists drive_content_queue_status_idx
  on public.drive_content_queue (status, queued_at);
create index if not exists drive_content_queue_user_idx
  on public.drive_content_queue (user_id);

-- ---------------------------------------------------------------------------
-- Manual course entry
-- ---------------------------------------------------------------------------
create table if not exists public.manual_courses (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  name                    text not null,
  institution             text not null,
  course_code             text,
  instructor_name         text,
  term                    text not null,
  start_date              date,
  end_date                date,
  website_url             text,
  linked_canvas_course_id text,
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists manual_courses_user_idx on public.manual_courses (user_id);
create index if not exists manual_courses_user_archived_idx
  on public.manual_courses (user_id, archived_at);

create table if not exists public.manual_uploads (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  manual_course_id    uuid not null references public.manual_courses(id) on delete cascade,
  original_filename   text not null,
  stored_path         text not null,
  mime_type           text not null,
  file_size_bytes     integer not null,
  document_type       text,
  normalized_event_id uuid references public.normalized_events(id) on delete set null,
  uploaded_at         timestamptz not null default now()
);

create index if not exists manual_uploads_user_course_idx
  on public.manual_uploads (user_id, manual_course_id);

-- ---------------------------------------------------------------------------
-- Pipeline versioning
-- ---------------------------------------------------------------------------
create table if not exists public.pipeline_versions (
  id              uuid primary key default gen_random_uuid(),
  stage           text not null,
    -- 'ingestion' | 'extraction' | 'resolution' | 'inference' | 'weighting'
  version         text not null,
  description     text not null,
  breaking_change boolean not null default false,
  released_at     timestamptz not null default now(),
  unique (stage, version)
);

-- Seed v0.1 rows so early ingestion has something to reference.
insert into public.pipeline_versions (stage, version, description)
values
  ('ingestion',  'ingestion-v0.1',  'Initial V0 ingestion + normalization'),
  ('extraction', 'extraction-v0.1', 'Initial V0 entity extraction'),
  ('resolution', 'resolution-v0.1', 'Initial V0 entity resolution'),
  ('inference',  'inference-v0.1',  'Initial V0 edge inference'),
  ('weighting',  'weighting-v0.1',  'Initial V0 edge weighting')
on conflict (stage, version) do nothing;

-- ---------------------------------------------------------------------------
-- Shadow tables — mirror the live graph_* schema exactly. Empty in V0;
-- populated by per-user shadow rebuilds (Phase 11 / pipeline-versioning.md §5).
-- Kept in sync with live schema; when a live table adds a column, add here too.
-- ---------------------------------------------------------------------------
create table if not exists public.graph_nodes_shadow (
  like public.graph_nodes including defaults including constraints
);
create index if not exists graph_nodes_shadow_user_type_idx
  on public.graph_nodes_shadow (user_id, entity_type);
create index if not exists graph_nodes_shadow_embedding_ivfflat_idx
  on public.graph_nodes_shadow using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table if not exists public.entity_candidates_shadow (
  like public.entity_candidates including defaults including constraints
);
create index if not exists entity_candidates_shadow_user_status_idx
  on public.entity_candidates_shadow (user_id, resolution_status);
create index if not exists entity_candidates_shadow_embedding_ivfflat_idx
  on public.entity_candidates_shadow using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table if not exists public.graph_edges_shadow (
  like public.graph_edges including defaults including constraints
);
create index if not exists graph_edges_shadow_user_source_idx
  on public.graph_edges_shadow (user_id, source_node_id);
create index if not exists graph_edges_shadow_user_target_idx
  on public.graph_edges_shadow (user_id, target_node_id);

-- ---------------------------------------------------------------------------
-- RLS: enable on every user-scoped table.
-- Read policies: user can select their own rows.
-- Write policies: none — writes are service-role only (Edge Functions).
-- Shadow tables: service-role only, no client access at all.
-- ---------------------------------------------------------------------------

-- normalized_events
alter table public.normalized_events enable row level security;
revoke all on public.normalized_events from authenticated, anon;
grant select on public.normalized_events to authenticated;
drop policy if exists "normalized_events_select_own" on public.normalized_events;
create policy "normalized_events_select_own"
  on public.normalized_events for select
  using (auth.uid() = user_id);

-- graph_nodes
alter table public.graph_nodes enable row level security;
revoke all on public.graph_nodes from authenticated, anon;
grant select on public.graph_nodes to authenticated;
drop policy if exists "graph_nodes_select_own" on public.graph_nodes;
create policy "graph_nodes_select_own"
  on public.graph_nodes for select
  using (auth.uid() = user_id);

-- entity_candidates — read allowed for user's own rows (dashboard may show
-- pending-extraction status); no writes.
alter table public.entity_candidates enable row level security;
revoke all on public.entity_candidates from authenticated, anon;
grant select on public.entity_candidates to authenticated;
drop policy if exists "entity_candidates_select_own" on public.entity_candidates;
create policy "entity_candidates_select_own"
  on public.entity_candidates for select
  using (auth.uid() = user_id);

-- node_mentions — internal provenance; no client access at all.
alter table public.node_mentions enable row level security;
revoke all on public.node_mentions from authenticated, anon;

-- graph_edges — user can read their own edges (V1 features will consume this;
-- V0 UI does not surface graph output, but read grant is here for completeness).
alter table public.graph_edges enable row level security;
revoke all on public.graph_edges from authenticated, anon;
grant select on public.graph_edges to authenticated;
drop policy if exists "graph_edges_select_own" on public.graph_edges;
create policy "graph_edges_select_own"
  on public.graph_edges for select
  using (auth.uid() = user_id);

-- Sync-state tables — internal, no client access.
alter table public.canvas_sync_state enable row level security;
revoke all on public.canvas_sync_state from authenticated, anon;

alter table public.canvas_course_sync enable row level security;
revoke all on public.canvas_course_sync from authenticated, anon;

alter table public.calendar_sync_state enable row level security;
revoke all on public.calendar_sync_state from authenticated, anon;

alter table public.drive_sync_state enable row level security;
revoke all on public.drive_sync_state from authenticated, anon;

alter table public.drive_exclusions enable row level security;
revoke all on public.drive_exclusions from authenticated, anon;

alter table public.drive_content_queue enable row level security;
revoke all on public.drive_content_queue from authenticated, anon;

-- Manual courses — user can read + write their own; service-role also writes
-- (for AI-extracted content back into normalized_events, which lands via the
-- Edge Function, not the manual_courses row itself).
alter table public.manual_courses enable row level security;
revoke all on public.manual_courses from authenticated, anon;
grant select, insert, update on public.manual_courses to authenticated;
drop policy if exists "manual_courses_select_own" on public.manual_courses;
drop policy if exists "manual_courses_insert_own" on public.manual_courses;
drop policy if exists "manual_courses_update_own" on public.manual_courses;
create policy "manual_courses_select_own"
  on public.manual_courses for select
  using (auth.uid() = user_id);
create policy "manual_courses_insert_own"
  on public.manual_courses for insert
  with check (auth.uid() = user_id);
create policy "manual_courses_update_own"
  on public.manual_courses for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
-- No delete policy: manual courses are archived (archived_at), never deleted.
-- Consistent with the permanent-storage principle.

-- Manual uploads — user can read own (list); insert happens via Edge Function
-- (Supabase Storage upload path plus normalization pass).
alter table public.manual_uploads enable row level security;
revoke all on public.manual_uploads from authenticated, anon;
grant select on public.manual_uploads to authenticated;
drop policy if exists "manual_uploads_select_own" on public.manual_uploads;
create policy "manual_uploads_select_own"
  on public.manual_uploads for select
  using (auth.uid() = user_id);

-- pipeline_versions — global metadata, safe for everyone to read.
alter table public.pipeline_versions enable row level security;
revoke all on public.pipeline_versions from authenticated, anon;
grant select on public.pipeline_versions to authenticated;
drop policy if exists "pipeline_versions_read_all" on public.pipeline_versions;
create policy "pipeline_versions_read_all"
  on public.pipeline_versions for select
  using (true);

-- Shadow tables — internal only, no client access.
alter table public.graph_nodes_shadow enable row level security;
revoke all on public.graph_nodes_shadow from authenticated, anon;

alter table public.entity_candidates_shadow enable row level security;
revoke all on public.entity_candidates_shadow from authenticated, anon;

alter table public.graph_edges_shadow enable row level security;
revoke all on public.graph_edges_shadow from authenticated, anon;
