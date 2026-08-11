-- V0 tutor_turns extensions for pipeline-v4.
--
-- Motivation: v3 tutor writes chat-log style (one row per message, role +
-- content). v4 writes one row per full turn (query + answer + rich router /
-- retrieval / timing metadata). Both must coexist so v3 keeps running while
-- v4 rolls out via shadow.
--
-- Changes:
--   1. Relax session_id to nullable — v4 supports session-less one-shot turns
--      (eval-harness runs, ad-hoc curl invocations).
--   2. Add v4 metadata columns, all nullable. v3 rows leave them null; v4 rows
--      populate them.
--
-- References:
--   supabase/functions/tutor-v4/index.ts (writer)
--   Graph Pipeline/pipeline-v4.md §6.9 (Stage 9 persistence)

alter table public.tutor_turns
  alter column session_id drop not null;

alter table public.tutor_turns
  add column if not exists query_raw          text,
  add column if not exists query_rewritten    text,
  add column if not exists learning_mode      text,
  add column if not exists template           text,
  add column if not exists course_hint        text,
  add column if not exists concept_hint       text,
  add column if not exists router_reasoning   text,
  add column if not exists model_used         text,
  add column if not exists source_count       int,
  add column if not exists timing_ms          jsonb,
  add column if not exists pipeline_version   text;

-- Value check on learning_mode — matches router-v4 output set.
alter table public.tutor_turns
  drop constraint if exists tutor_turns_learning_mode_check;
alter table public.tutor_turns
  add constraint tutor_turns_learning_mode_check
  check (learning_mode is null
         or learning_mode in ('tutoring', 'exploration', 'lookup', 'cross_course', 'small_talk'));

-- Index for v4-specific pipeline analysis: "give me all v4 tutoring turns
-- with model_used=Sonnet from the last 7 days" is the eval-harness query.
create index if not exists tutor_turns_v4_pipeline_idx
  on public.tutor_turns (user_id, pipeline_version, created_at desc)
  where pipeline_version is not null;
