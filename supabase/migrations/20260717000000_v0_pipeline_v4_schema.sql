-- V0 pipeline-v4 schema additions.
--
-- Adds columns to normalized_events for the v4 ingest path:
--   - content_format: classifier output (slides|sectioned|paragraphed|flat)
--     drives chunker-v4 strategy dispatch.
--   - parse_mode: LlamaParse mode used (fast|balanced|premium) when the
--     record originated from a PDF; null for HTML/text sources.
--   - body_hash: sha256 of the normalized body_text. Used by the ingest
--     orchestrator to skip re-processing when a record's content hasn't
--     changed (hash-cache path in pipeline-v4.md §5.3).
--   - pipeline_version_v4: set once v4 has processed the record. Distinct
--     from the existing `pipeline_version` column (which tags v3 output),
--     so shadow-swap can compare v3 vs v4 output on the same record.
--
-- References:
--   Graph Pipeline/pipeline-v4.md §5 (narrative walkthrough), §5.3 (hash cache),
--   §5.4 (chunking strategies).

alter table public.normalized_events
  add column if not exists content_format       text,
  add column if not exists parse_mode           text,
  add column if not exists body_hash            text,
  add column if not exists pipeline_version_v4  text,
  add column if not exists extracted_at_v4      timestamptz;

-- content_format must be one of the four v4 chunker dispatch values (or null
-- for records not yet classified).
alter table public.normalized_events
  drop constraint if exists normalized_events_content_format_check;
alter table public.normalized_events
  add constraint normalized_events_content_format_check
  check (content_format is null or content_format in ('slides','sectioned','paragraphed','flat'));

-- parse_mode gates against the three LlamaParse tiers.
alter table public.normalized_events
  drop constraint if exists normalized_events_parse_mode_check;
alter table public.normalized_events
  add constraint normalized_events_parse_mode_check
  check (parse_mode is null or parse_mode in ('fast','balanced','premium'));

-- Hash cache lookups need to be fast: given (user_id, source_type, body_hash)
-- have we already produced a v4 extraction? Skip re-embedding + re-extracting.
create index if not exists normalized_events_body_hash_idx
  on public.normalized_events (user_id, source_type, body_hash)
  where body_hash is not null;

-- Selecting v4-pending records (not yet processed by v4) is the pipeline's
-- inner query — index it.
create index if not exists normalized_events_v4_pending_idx
  on public.normalized_events (user_id, source_type)
  where pipeline_version_v4 is null
    and classification = 'academic'
    and cancelled_at is null;
