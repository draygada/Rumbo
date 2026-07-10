-- Manual course uploads bucket. Private, per-user file scoping enforced via
-- RLS on storage.objects. Files are permanent (no delete policy) per the
-- permanent-storage principle (Rumbo-Design-Docs/manual-course-entry.md §6, §8).
--
-- Object path convention: `{user_id}/{manual_course_id}/{uuid}-{filename}`
-- The RLS policies below only check the leading user_id segment.

insert into storage.buckets (id, name, public)
values ('manual-uploads', 'manual-uploads', false)
on conflict (id) do nothing;

drop policy if exists "manual_uploads_insert_own" on storage.objects;
create policy "manual_uploads_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'manual-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "manual_uploads_select_own" on storage.objects;
create policy "manual_uploads_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'manual-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No update / delete policies: manual-course uploads are permanent.
