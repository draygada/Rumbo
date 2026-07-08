# Rumbo Supabase backend

## Row Level Security (RLS)

Every app table has RLS enabled. Summary:

| Table | Client can | Client cannot |
|-------|------------|---------------|
| `users` | Read/update own row | Change `tier` (trigger blocks self-promotion) |
| `learning_profile` | Read/insert/update own row | Touch other users' rows |
| `tasks` | Full CRUD on own tasks | Insert with another user's `user_id` |
| `work_blocks` | **Read only** own blocks | Insert/update/delete (scheduler only, service role) |
| `calendar_connections` | Read metadata (no tokens), delete own | Read tokens, insert/update (OAuth edge function only) |

Migrations: `20250522000000_baseline_rls.sql`, phase5 table policies, `20250523120000_rls_hardening.sql`.

Verify in SQL editor (as authenticated user):

```sql
-- Should return only your rows
select * from tasks;
-- Should fail or return permission denied for insert with wrong user_id
insert into work_blocks (task_id, user_id, start_time, end_time)
values ('...', '00000000-0000-0000-0000-000000000000', now(), now() + interval '1 hour');
```

## Deploy

1. Install [Supabase CLI](https://supabase.com/docs/guides/cli)
2. Link project: `supabase link --project-ref <your-ref>`
3. Run migrations: `supabase db push`
4. Set Edge Function secrets (Dashboard → Edge Functions → Secrets):

| Secret | Purpose |
|--------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `GOOGLE_REDIRECT_URI` | Optional explicit OAuth callback URI override |
| `APP_URL` | e.g. `https://your-app.vercel.app` or `http://localhost:5173` |
| `CRON_SECRET` | Optional header for nightly cron |

5. Deploy functions: `supabase functions deploy schedule-generator calendar-sync calendar-oauth`

## Google OAuth setup

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs → enable **Google Calendar API**
2. OAuth consent screen → add test users
3. Credentials → OAuth 2.0 Client → Web application
4. Authorized redirect URI (must match **exactly** what the function sends):
   ```
   https://<project-ref>.supabase.co/functions/v1/calendar-oauth
   ```
   If needed, set `GOOGLE_REDIRECT_URI` secret to force an exact callback URI.

## Nightly schedule refresh

In Supabase SQL editor (requires `pg_cron` + `pg_net`):

```sql
select cron.schedule(
  'nightly-rumbo-schedule',
  '0 2 * * *',
  $$select public.nightly_schedule_refresh()$$
);
```

Set database settings for the trigger/cron HTTP calls:

```sql
alter database postgres set app.settings.supabase_url = 'https://<project-ref>.supabase.co';
alter database postgres set app.settings.service_role_key = '<service-role-key>';
alter database postgres set app.settings.cron_secret = '<CRON_SECRET>';
```

The app also invokes `schedule-generator` after each task is created.
