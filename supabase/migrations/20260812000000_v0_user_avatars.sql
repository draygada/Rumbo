-- Profile pictures.
--
-- Two parts: a column on public.users holding the public URL, and a storage
-- bucket for the files themselves.
--
-- The bucket is PUBLIC, unlike manual-uploads. An avatar is rendered by <img>
-- on every screen the rail appears on; a private bucket would mean minting a
-- signed URL per render and re-minting on expiry, for a file whose whole job
-- is to be looked at. Writes are still owner-only via the policies below, and
-- the object path carries a uuid so a URL can't be guessed from a user id.
--
-- Object path convention: `{user_id}/{uuid}.{ext}`
-- The RLS policies only check the leading user_id segment.

alter table public.users add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Public read: the bucket is public, but storage.objects still needs a select
-- policy for the authenticated role to list/read through the API.
drop policy if exists "avatars_select_all" on storage.objects;
create policy "avatars_select_all"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Unlike manual-course uploads, avatars are REPLACEABLE — changing your
-- picture overwrites, and removing it deletes. Both scoped to your own folder.
drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
