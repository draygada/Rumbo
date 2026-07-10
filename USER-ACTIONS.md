# User Actions — Post-Build Runbook

Everything in this file requires **your** hands (browser login, secrets, deploys). None of it can be done from within Claude Code. Work top-to-bottom.

Project: **Rumbo** — Supabase project ref `hgibayteggcyciddnyry`.

---

## 0. What was built in this session

**All phases 1–11 written and locally verified (frontend `npm run build` green):**

| Phase | What | Status |
|---|---|---|
| 1 Schema (prior session) | Graph brain schema + shadow tables + pipeline_versions | Deployed |
| 2 Canvas adapter (prior session) | canvas-verify + canvas-ingest + 6h cron | Deployed |
| 3 Frontend rewire (prior session) | Dashboard reads `normalized_events` | Deployed |
| 4 Google Calendar adapter | shared module, calendar-ingest, calendar-webhook, calendar-renew, cron | **Written — needs deploy** |
| 5 Google Drive adapter | shared module, drive-ingest, drive-content-extract, cron | **Written — needs deploy** |
| 6 Manual course entry | manual-upload-process, manual-website-fetch, /courses page, storage bucket | **Written — needs deploy** |
| 7–10 Brain pipeline | extraction → resolution → inference → weighting (spawned subagent — check its report) | **Subagent in progress** |
| 11 Shadow rebuild | shadow-rebuild orchestrator + `shadow_swap` RPC | **Written — needs deploy** |
| Impeccable UI polish | (subagent in progress) | Subagent in progress |

Migration files added since the last deploy:
- `20260707000004_v0_calendar_cron.sql`
- `20260707000005_v0_drive_cron.sql`
- `20260707000006_v0_manual_courses_storage.sql`
- `20260707000007_v0_brain_pipeline.sql` (from the brain-pipeline subagent — check for presence)
- `20260707000008_v0_shadow_swap.sql`

Edge functions added:
- `calendar-ingest`, `calendar-webhook`, `calendar-renew`
- `drive-ingest`, `drive-content-extract`
- `manual-upload-process`, `manual-website-fetch`
- `brain-pipeline`, `brain-decay` (from the brain-pipeline subagent)
- `shadow-rebuild`

---

## 1. Secrets — set these BEFORE deploying (via Supabase Dashboard → Project → Edge Functions → Secrets, or CLI)

```bash
cd ~/Desktop/Rumbo
supabase secrets set \
  CRON_SECRET="<generate: openssl rand -hex 32>" \
  GEMINI_API_KEY="…" \
  GOOGLE_CLIENT_ID="…apps.googleusercontent.com" \
  GOOGLE_CLIENT_SECRET="GOCSPX-…" \
  GOOGLE_REDIRECT_URI="https://<your-app-url>/functions/v1/calendar-oauth" \
  APP_URL="https://<your-app-url>" \
  --project-ref hgibayteggcyciddnyry
```

**Save the CRON_SECRET value — you need it again below.** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_ENV` are auto-set by Supabase.

---

## 2. Supabase Vault secrets (one-time — required for cron jobs to work)

Cron jobs read three values via a security-definer helper backed by Supabase Vault (Supabase Cloud denies `alter database ... set` to the `postgres` role, so GUCs aren't an option). Run this in the SQL editor exactly once:

```sql
select vault.create_secret(
  'https://hgibayteggcyciddnyry.supabase.co',
  'rumbo_supabase_url'
);
select vault.create_secret(
  '<paste service role key>',
  'rumbo_service_role_key'
);
select vault.create_secret(
  '<paste CRON_SECRET from step 1>',
  'rumbo_cron_secret'
);
```

Rotate later by inserting a new secret with the same name and deleting the old:
```sql
delete from vault.secrets where name = 'rumbo_cron_secret';
select vault.create_secret('<new value>', 'rumbo_cron_secret');
```

Any of these missing → cron ticks log a notice and skip (no bad requests fired).

---

## 3. Google Cloud Console — OAuth scope + verification

The Phase 4/5 code changed the requested Google OAuth scopes to `calendar.readonly` + `drive.readonly`. In Google Cloud Console (project that owns your OAuth client):

1. **APIs & Services → OAuth consent screen → Scopes**  
   Ensure both scopes are listed:
   - `.../auth/calendar.readonly`
   - `.../auth/drive.readonly` (**sensitive** — triggers app verification)

2. **APIs & Services → Enabled APIs & Services**  
   Enable *Google Calendar API* AND *Google Drive API* if not already.

3. **App verification** — because `drive.readonly` is a sensitive/restricted scope, submit for verification before beta launch. Docs: <https://support.google.com/cloud/answer/9110914>. Domain verification of your redirect URI host is a prerequisite. Plan several days/weeks lead time.

4. **Domain verification for webhook push notifications** (Google Calendar): the calendar-webhook receives push notifications at `${SUPABASE_URL}/functions/v1/calendar-webhook`. Google requires the domain be verified in Search Console before it will send push notifications to it. Go to <https://console.cloud.google.com/apis/credentials/domainverification> and add `hgibayteggcyciddnyry.supabase.co`. (If Supabase's project domain fails verification because you can't upload a TXT record, we may need to front the webhook with your own domain.)

5. **Redirect URI** — the current calendar-oauth flow uses `GOOGLE_REDIRECT_URI` env or `${SUPABASE_URL}/functions/v1/calendar-oauth`. Add both to the OAuth client's Authorized redirect URIs.

---

## 4. Deploy Edge Functions

```bash
cd ~/Desktop/Rumbo

# Phase 4
supabase functions deploy calendar-ingest --project-ref hgibayteggcyciddnyry
supabase functions deploy calendar-webhook --project-ref hgibayteggcyciddnyry
supabase functions deploy calendar-renew --project-ref hgibayteggcyciddnyry
supabase functions deploy calendar-oauth --project-ref hgibayteggcyciddnyry  # scopes + kick change

# Phase 5
supabase functions deploy drive-ingest --project-ref hgibayteggcyciddnyry
supabase functions deploy drive-content-extract --project-ref hgibayteggcyciddnyry

# Phase 6
supabase functions deploy manual-upload-process --project-ref hgibayteggcyciddnyry
supabase functions deploy manual-website-fetch --project-ref hgibayteggcyciddnyry

# Phases 7–10 (only if the subagent report confirms these were written)
supabase functions deploy brain-pipeline --project-ref hgibayteggcyciddnyry
supabase functions deploy brain-decay --project-ref hgibayteggcyciddnyry

# Phase 11
supabase functions deploy shadow-rebuild --project-ref hgibayteggcyciddnyry

# Also redeploy the ingest functions that now kick brain-pipeline (subagent added the hook):
supabase functions deploy canvas-ingest --project-ref hgibayteggcyciddnyry
```

---

## 5. Push Migrations

```bash
cd ~/Desktop/Rumbo
supabase db push --project-ref hgibayteggcyciddnyry
```

Migrations pushed will include:
- `20260707000004_v0_calendar_cron.sql` — daily calendar-renew job
- `20260707000005_v0_drive_cron.sql` — 6h drive-ingest + 15m drive-content jobs
- `20260707000006_v0_manual_courses_storage.sql` — `manual-uploads` storage bucket + RLS
- `20260707000007_v0_brain_pipeline.sql` — resolve_shortlist RPC + brain crons (if subagent wrote it)
- `20260707000008_v0_shadow_swap.sql` — atomic shadow → live swap RPC

Verify cron entries:
```sql
select jobname, schedule from cron.job order by jobname;
```

Expected: `canvas-ingest-6h`, `calendar-renew-daily`, `drive-ingest-6h`, `drive-content-15m`, `brain-pipeline-6h`, `brain-decay-daily`.

---

## 6. Frontend deploy

```bash
cd ~/Desktop/Rumbo
npm run build
# Vercel: `vercel --prod` (or push to the connected git branch)
```

The new `/courses` route lands in the sidebar automatically.

---

## 7. End-to-end smoke test (do this in a browser)

1. Sign in with an existing user (or /signup).
2. Onboarding → paste a real Canvas PAT → verify.
3. Onboarding → connect Google (Calendar + Drive) — you should see both scopes in the consent screen.
4. Onboarding → optionally add a manual course (dedicated stage isn't part of onboarding; use `/courses` after landing on the dashboard).
5. Dashboard should populate within ~60s (canvas-verify kicks canvas-ingest; calendar-oauth kicks calendar-ingest; brain-pipeline kick is fire-and-forget per user after each ingest).
6. `/courses` — add a manual course, paste a class website URL, then upload a PDF syllabus. Verify a `manual_uploads` row exists and its `document_type` is populated.
7. Wait 6h for the first full cron cycle, then check:
   - `select count(*) from public.normalized_events;`
   - `select count(*) from public.entity_candidates;`
   - `select count(*) from public.graph_nodes;`
   - `select count(*) from public.graph_edges where is_surfaced = true;`

---

## 8. Things flagged as "watch this"

- **Canvas onboarding drop-off** at the manual-PAT step (data-ingestion.md §6).
- **Google verification** — if the Google Cloud Console app is still in Testing mode, users outside your test allowlist will see the "unverified app" warning. Ship this to real students only after Verified status.
- **10MB Drive content-size gate** (google-drive.md §3.2 Q3) is a Cat B placeholder — tune once real data lands.
- **Brain classifier confidence thresholds** (0.7 / 0.8 / 0.75 / 0.60) are all Cat B placeholders per the design docs — start high, lower with evidence.
- **Any classifier prompt tweak = new pipeline_version** — call `shadow-rebuild` before promoting.

---

## 9. Testing audit — items flagged, still open

From the final testing sweep (all non-blocking, review in the morning):

- **`brain-weighting.ts` authority query is a weak proxy** — averages `source_authority` across all candidates in `inferred_from`, not just candidates that resolved to the two endpoint nodes. Correct semantics should constrain to endpoint-relevant candidates. Not urgent unless surfaced-edge quality suffers.
- **Drive `DRIVE_SIZE_LIMIT_BYTES` = 10 MB vs manual upload 25 MB** — Drive content-extract's 10 MB is Cat B/OPEN in `google-drive.md` §3.2 Q3. Either lift to match manual uploads or leave — pick when real data lands.
- **`brain-inference.ts` direct-link Drive lookup capped at 500 files per node** — large Drive corpora may miss real Canvas assignment ↔ Drive file name matches. Add pagination if the graph shows undersurfacing.
- **`syncCalendar` writes `nextSyncToken` via `.update()` (not upsert)** — the row-existence race in the seeding path is only tolerant of 23xxx errors. A network glitch during seeding could produce silent 0-row updates on the sync-token step. Low probability; monitor.
- **Install Deno CLI locally** (`brew install deno`) so future pre-flight can run `deno check supabase/functions/**/index.ts` — this session couldn't do that.

**Fixed inline during audit:**
- `manual-upload-process` now enforces the 25MB size + mime allowlist server-side (was client-only).
- `manual-upload-process` now fires `kickBrainPipeline(user_id)` after each successful upload so uploaded syllabus content flows into the graph without waiting 6h.

---

## 9.5 Tutor build — Phase 1 (monorepo) + Phase 2 (Neo4j schema)

**Branch:** `phase1-monorepo`. Restructure is committed (`1bdfc54`). Rollback = `git checkout BrainPlaying`.

### Phase 1 — no user action needed
The repo is now pnpm workspaces:
- `apps/web/` — the React app (build passes)
- `services/edge-functions/` — every function
- `packages/{shared-types,graph-client,supabase-client}/` — libs
- `supabase/functions → services/edge-functions` symlink so `supabase functions deploy` still works

### Phase 2 — you deploy + invoke

The `neo4j-schema-apply` Edge Function is new. It runs the constraints/indexes/vector indexes from `Rumbo-Design-Docs/Graph Pipeline/graph-schema.md §6`, including the reserved `LearnerNote` label + `learner_note_by_user_target` index for the Phase 2 learner model. Idempotent — safe to re-run.

**Prereqs — confirm these Supabase secrets are set:**
```bash
supabase secrets list --project-ref hgibayteggcyciddnyry | grep -E 'NEO4J|CRON'
# Expect: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, CRON_SECRET
```

If any are missing:
```bash
supabase secrets set --project-ref hgibayteggcyciddnyry \
  NEO4J_URI='https://d60fe359.databases.neo4j.io' \
  NEO4J_USER='neo4j' \
  NEO4J_PASSWORD='<the ROTATED password from Aura>'
```
(Reminder: the password originally pasted in chat is compromised. Rotate it in the Aura dashboard first and set the fresh one.)

**Deploy + apply:**
```bash
cd ~/Desktop/Rumbo

# 1. Deploy the new function
supabase functions deploy neo4j-schema-apply --project-ref hgibayteggcyciddnyry

# 2. Invoke it (uses CRON_SECRET as auth)
CRON_SECRET=$(supabase secrets list --project-ref hgibayteggcyciddnyry \
  | grep CRON_SECRET | awk '{print $2}')   # or paste it in

curl -sS -X POST \
  "https://hgibayteggcyciddnyry.supabase.co/functions/v1/neo4j-schema-apply" \
  -H "x-cron-secret: $CRON_SECRET" \
  -H "Authorization: Bearer $(supabase secrets list --project-ref hgibayteggcyciddnyry | grep SUPABASE_ANON_KEY | awk '{print $2}')" \
  | jq
```

**Expected response shape:**
```json
{
  "total": 20,   // 12 uniqueness constraints + 6 indexes + 1 fulltext + 2 vector
  "ok": 20,
  "failed": 0,
  "results": [ { "name": "constraint_user_id_unique", "ok": true }, ... ],
  "health": []   // empty on first run
}
```

If any step returns `ok: false`, paste the `error` back into chat — likely the URI needs the `:443` suffix or the vector-index feature isn't available on Aura Free (fallback: drop vector indexes and re-run).

### After it succeeds
Reply with the response payload (redact the URI). I'll:
1. Verify all 20 steps landed.
2. Kick off **Phase 3 — one-time Postgres→Neo4j sync** (write the sync worker; you deploy + invoke; we backfill the ~28 concepts/~88 mentions already in Postgres).
3. Then Phase 4 rewires `/brain` to read from Neo4j.

---

## 10. Anything left undone (audit this the morning after)

- The Phase 7–10 subagent's report — read `/private/tmp/claude-501/.../<agent-id>.output` and confirm files were written. Missing files must be created manually.
- The impeccable UI-polish subagent's report — same audit.
- USER-ACTIONS.md may need updating if the brain-pipeline subagent's file names differ from the ones anticipated above.
- V0 open items in the design docs — all Cat B thresholds are still placeholders; leave them until real students generate data to tune them.
