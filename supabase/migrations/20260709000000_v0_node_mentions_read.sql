-- Grant authenticated users read access on their own node_mentions rows so
-- the client-side Brain view can compute each node's primary course.
-- Previously service-role only; now readable for provenance display.
-- Nothing sensitive in this table — just (node_id, source_record_id, candidate_id).

grant select on public.node_mentions to authenticated;

drop policy if exists "node_mentions_select_own" on public.node_mentions;
create policy "node_mentions_select_own"
  on public.node_mentions for select
  using (auth.uid() = user_id);
