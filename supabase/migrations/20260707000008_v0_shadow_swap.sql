-- shadow_swap(user_id, version) — atomic per-user swap of shadow → live.
--
-- Contract (pipeline-versioning.md §5):
--   * Mark all live rows for this user with a non-null superseded_at.
--     Old rows are retained per the permanent-storage principle (never deleted).
--   * Copy shadow rows tagged with the target version into the live tables.
--   * Clear the promoted shadow rows.
--
-- Runs inside a single transaction. Security definer so the service-role RPC
-- can bypass RLS (writes are service-only anyway).

create or replace function public.shadow_swap(p_user_id uuid, p_version text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.graph_edges
    set superseded_at = now(), updated_at = now()
    where user_id = p_user_id and superseded_at is null;

  update public.graph_nodes
    set superseded_at = now(), updated_at = now()
    where user_id = p_user_id and superseded_at is null;

  -- Copy shadow → live. INSERT columns explicitly since the shadow tables use
  -- LIKE ... INCLUDING DEFAULTS which preserves the ivfflat index constraints.
  insert into public.graph_nodes
    select * from public.graph_nodes_shadow
    where user_id = p_user_id and pipeline_version = p_version;
  delete from public.graph_nodes_shadow
    where user_id = p_user_id and pipeline_version = p_version;

  insert into public.entity_candidates
    select * from public.entity_candidates_shadow
    where user_id = p_user_id and pipeline_version = p_version;
  delete from public.entity_candidates_shadow
    where user_id = p_user_id and pipeline_version = p_version;

  insert into public.graph_edges
    select * from public.graph_edges_shadow
    where user_id = p_user_id and pipeline_version = p_version;
  delete from public.graph_edges_shadow
    where user_id = p_user_id and pipeline_version = p_version;
end;
$$;

comment on function public.shadow_swap is
  'Atomic per-user shadow → live swap. Called by the shadow-rebuild Edge Function via RPC.';
