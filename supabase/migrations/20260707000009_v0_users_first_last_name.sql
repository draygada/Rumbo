-- Split public.users.name into first_name + last_name.
--
-- Rationale: signup collects first + last separately for correct initials and
-- name-based personalization. `name` is retained as a generated column so
-- downstream code that reads `name` keeps working without a migration.
--
-- Backfill splits existing name on the first whitespace: everything before →
-- first_name; everything after → last_name.

alter table public.users add column if not exists first_name text;
alter table public.users add column if not exists last_name text;

update public.users
set
  first_name = case
    when nullif(trim(name), '') is null then null
    when position(' ' in trim(name)) > 0 then split_part(trim(name), ' ', 1)
    else trim(name)
  end,
  last_name = case
    when nullif(trim(name), '') is null then null
    when position(' ' in trim(name)) > 0 then trim(substr(trim(name), position(' ' in trim(name)) + 1))
    else null
  end
where first_name is null and last_name is null;

alter table public.users drop column if exists name;
-- Generated column expression must be composed of IMMUTABLE functions only.
-- concat_ws is marked STABLE, so use string concatenation + coalesce + btrim
-- (all IMMUTABLE) to build the same result.
alter table public.users add column name text
  generated always as (
    nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
  ) stored;

-- Rewrite the auth-user → public.users trigger to read the split fields from
-- user_metadata. Backwards-compatible with the old signup path: if only the
-- old `name` metadata key is present, fall back to splitting it here.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_first text := new.raw_user_meta_data->>'first_name';
  meta_last  text := new.raw_user_meta_data->>'last_name';
  meta_full  text := new.raw_user_meta_data->>'name';
  derived_first text;
  derived_last  text;
begin
  if meta_first is null and meta_last is null and meta_full is not null then
    derived_first := split_part(trim(meta_full), ' ', 1);
    derived_last := nullif(trim(substr(trim(meta_full), position(' ' in trim(meta_full)) + 1)), meta_full);
  else
    derived_first := meta_first;
    derived_last := meta_last;
  end if;

  insert into public.users (id, email, first_name, last_name)
  values (new.id, new.email, derived_first, derived_last)
  on conflict (id) do update
    set email = excluded.email,
        first_name = coalesce(public.users.first_name, excluded.first_name),
        last_name  = coalesce(public.users.last_name,  excluded.last_name);
  return new;
end;
$$;
