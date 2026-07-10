-- Grant the authenticated user column-level select on their own canvas_sync_state
-- row so the dashboard can distinguish three empty states per dashboard.md §4:
--   (a) no sources connected     — no canvas_credentials row
--   (b) ingestion in progress     — canvas_sync_state.last_polled_at IS NULL
--   (c) all caught up             — last_polled_at recent, zero upcoming rows
-- Also lets the dashboard surface token_status='expired' as an inline alert.
--
-- Only non-sensitive columns are granted (no credentials leak — pat stays in
-- canvas_credentials, which already excludes it from client grants).

grant select (user_id, canvas_domain, last_polled_at, token_status, updated_at)
  on public.canvas_sync_state to authenticated;

drop policy if exists "canvas_sync_state_select_own" on public.canvas_sync_state;
create policy "canvas_sync_state_select_own"
  on public.canvas_sync_state for select
  using (auth.uid() = user_id);
