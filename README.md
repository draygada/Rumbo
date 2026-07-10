# Rumbo

Per-student academic knowledge graph. Ingests from Canvas, Google Calendar, and Google Drive; normalizes; runs extraction → resolution → inference → weighting; surfaces a dashboard.

**This is the build repo.** Design decisions live in `Rumbo-Design-Docs/` (symlinked in). When docs and code disagree, docs win — see `CLAUDE.md` for the reuse-pivot rules.

---

## Stack

- **Frontend:** React 18 + Vite + TypeScript + TanStack Query + Zustand
- **Backend:** Supabase (Postgres + pgvector + Auth + Storage + Edge Functions in Deno/TS)
- **Scheduled jobs:** Supabase Cron (pg_cron)
- **LLM:** Anthropic Claude via `@anthropic-ai/sdk` (Edge Functions only)
- **Embeddings:** `text-embedding-3-small` via OpenAI (Edge Functions only)

---

## Prereqs

- Node 18+ and npm
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) (`brew install supabase/tap/supabase`)
- Docker Desktop (required by `supabase start` for the local stack)
- Deno (bundled with Supabase CLI; standalone install optional for Edge Function development)

---

## First-time setup

```bash
git clone <this-repo> Rumbo
cd Rumbo
npm install

# Copy the env template and fill in values (see below).
cp .env.local.example .env.local  # if the template exists; otherwise create manually
```

**`.env.local` shape** (frontend only — no secrets):

```
# Public, safe to bundle into the browser
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

**Edge Function secrets** (never in the frontend — set via `supabase secrets set` or the dashboard):

```
SUPABASE_URL                   # auto-injected in the Supabase environment
SUPABASE_SERVICE_ROLE_KEY      # auto-injected
SUPABASE_ANON_KEY              # auto-injected
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI            # optional; defaults to <SUPABASE_URL>/functions/v1/calendar-oauth
APP_URL                        # e.g. http://localhost:5173 in dev
ANTHROPIC_API_KEY              # for LLM-backed Edge Functions
CRON_SECRET                    # required in prod; canvas-ingest / other cron jobs check this header
```

For local dev you can leave `CRON_SECRET` unset if `SUPABASE_ENV=dev` is set — `canvas-ingest` opens up in dev mode only, never in prod.

---

## Run locally

### Frontend (Vite dev server)

```bash
npm run dev              # http://localhost:5173
```

### Backend (local Supabase stack)

```bash
supabase start           # boots Postgres, Auth, Storage, Realtime, Studio (localhost:54323)
supabase db push         # applies migrations under supabase/migrations/ to the linked project
supabase functions serve # serves Edge Functions locally with auto-reload
```

Only run `supabase db push` against the linked remote project when you intend to apply migrations to it. For local-only work, migrations are applied automatically by `supabase start`.

### Serve a single Edge Function

```bash
supabase functions serve canvas-verify --env-file .env
supabase functions serve canvas-ingest --env-file .env
```

### Deploy an Edge Function

```bash
supabase functions deploy canvas-verify
supabase functions deploy canvas-ingest
```

### Tail logs

```bash
supabase functions logs canvas-ingest
```

---

## Migrations

Every schema change goes through a migration file in `supabase/migrations/`. Never edit the DB by hand.

```bash
# Create a new migration
supabase migration new <description>

# Apply pending migrations to the linked project
supabase db push

# Diff against the linked remote to verify the state matches your local migrations
supabase db diff --linked
```

The first two graph-brain migrations live at:
- `supabase/migrations/20260707000000_v0_bootstrap.sql` — enables pgvector, adds `scopes` to `calendar_connections`, adds `canvas_credentials`.
- `supabase/migrations/20260707000001_v0_graph_brain_schema.sql` — 14 graph-brain tables + 3 shadow tables + seed rows.

Scheduler-era migrations (`20250521999900_*` through `20260601000001_*`) are preserved — they define `tasks`, `work_blocks`, `learning_profile`, `calendar_connections`, and their RLS policies. Do not modify or drop them; the deterministic scheduler is hidden from V0 UI but its code and tables stay (see `Rumbo-Design-Docs/Legacy/scheduler.md`).

---

## Tests

```bash
npm test                 # Vitest, single run
npm run test:watch       # Vitest, watch mode
```

Edge Function tests use `deno test`. DB-touching tests hit a real Postgres (`supabase start`), never a mock — see `CLAUDE.md` §6.

---

## Where to look

- **Design docs (source of truth):** `Rumbo-Design-Docs/` (symlinked)
  - `Rumbo-overview.md` — north star
  - `rumbo-lld.md` — system LLD
  - `Frontend/`, `Graph Pipeline/`, `External Sources/`, `Infrastructure/`, `Features/`, `Legacy/`
- **Build-repo instructions for Claude:** `CLAUDE.md` — auto-loaded by Claude Code on session start
- **Frontend:** `src/pages/`, `src/components/`, `src/hooks/`, `src/lib/`
- **Backend:** `supabase/functions/`, `supabase/migrations/`, `supabase/config.toml`

---

## Common gotchas

- **`Rumbo-Design-Docs/` is a symlink** to `~/Rumbo-Design-Docs`. It's gitignored — running the app on a different machine requires either recreating the symlink or cloning the docs repo alongside.
- **RLS is on.** Every user-scoped table filters on `auth.uid() = user_id`. Service-role (Edge Functions) bypasses RLS; anon/authenticated app code goes through it. Cross-user queries do not exist in V0.
- **The deterministic scheduler is preserved but hidden.** Do not run cleanup passes that delete "unused" scheduler code. See `Rumbo-Design-Docs/Legacy/scheduler.md`.
- **Env vars: `VITE_` prefix = visible to the browser.** Anything without it (service role key, Anthropic key, Google client secret) must never appear in `src/`.
