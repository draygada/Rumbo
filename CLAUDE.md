# CLAUDE.md — Rumbo (build repo)

This file provides guidance to Claude Code (claude.ai/code) when working on the Rumbo build repository.

The full design-doc tree is symlinked at `Rumbo-Design-Docs/`. Read it liberally — it is the source of truth for every product and architecture decision. This file is a working reference to the shared principles and the current build state; the design repo is where the reasoning lives.

---

## 1. What Rumbo is

Rumbo is a per-student academic knowledge graph. It ingests data from Canvas, Google Calendar, Google Drive, and a manual course-entry escape hatch; normalizes everything into one shared table; and runs an extraction → resolution → inference → weighting pipeline (the "brain") over that normalized history. The dashboard reads the normalized layer directly and is the only user-facing surface in V0.

**Read `Rumbo-Design-Docs/Rumbo-overview.md` before making any non-trivial decision.** That doc is the north star; if a code change would drift from it, that's a bug to flag, not build past.

---

## 2. Two-repo relationship

- **`Rumbo-Design-Docs/`** — authoritative for *why* (decisions, tradeoffs, product boundaries, resolved OPEN items). Never fork a decision here; if you disagree, propose a doc change first.
- **This repo (build)** — authoritative for *how* (schema, code, tests, deploys). Never encode a design decision that isn't first documented in the design repo.

When a design doc and this repo disagree, the design doc wins **unless the doc is clearly out of date with the running system**. In that case, update the doc as part of the same PR that changes the code — do not let them drift.

Design-doc paths in this file are relative to this repo's root — the design repo is symlinked in at `./Rumbo-Design-Docs/`.

### 2.1 What this codebase already is

This is not a greenfield project. It is a working React + Vite + TypeScript web app on Supabase, originally built as a deterministic task-scheduling product and now being **rewired as the V0 shell for the graph brain** (see `Rumbo-Design-Docs/rumbo-lld.md` §13).

**Load-bearing docs to read first when working on any V0 feature:**
- `Rumbo-Design-Docs/Rumbo-overview.md` §7 — implementation status (why we're reusing).
- `Rumbo-Design-Docs/rumbo-lld.md` §13 — reuse & legacy decision (what's kept, rewired, hidden).
- `Rumbo-Design-Docs/Frontend/README.md` — V0 web app inventory + tech stack.
- `Rumbo-Design-Docs/Frontend/page-flows.md` — page-by-page V0 spec.
- `Rumbo-Design-Docs/Frontend/onboarding.md` — V0 onboarding flow.
- `Rumbo-Design-Docs/Legacy/scheduler.md` — inventory of what's preserved but hidden.

**Preserve, don't delete.** Everything catalogued in `Legacy/scheduler.md` — the deterministic scheduler code (`supabase/functions/schedule-generator`, `_shared/scheduler.ts`), the `AddTask` page, the classifier, the `tasks` / `work_blocks` tables, the reflection loop. Hidden from V0 UI; source stays in the repo. Do not run cleanup passes that delete "unused" scheduler code — it is deliberately preserved.

**When docs and reality diverge.** The rewire is fresh; some edges will be rough. If a design doc says "add table X" and the code already has table X from the scheduler era, that's an integration question — do not blindly apply the migration. Read the existing schema, then ask.

---

## 3. Non-negotiable principles

These are product boundaries, not preferences. Any code change that violates them is wrong even if it works.

1. **Asymmetric error tolerance.** A confidently wrong surfaced connection costs trust — the entire product. A missed connection costs a little value but is invisible to the student. **When uncertain, suppress rather than surface.** This must appear as a real threshold in code, not just live as a comment. (`Rumbo-Design-Docs/rumbo-graph-brain.md` §6.)

2. **Hard product line: Rumbo surfaces context, it does not produce submittable work.** Rumbo drafts an email, the student sends it. Rumbo flags a gap, the student closes it. Any code path that would send outbound communication in the student's name, or produce a submittable artifact autonomously, is wrong. This is why the agent layer uses `gmail.compose` (draft) and not `gmail.send`. (`Rumbo-overview.md` §5, `rumbo-lld.md` §12.)

3. **Permanent raw storage.** Nothing ingested is ever deleted — not personal calendar events, not irrelevant Drive files, not superseded pipeline outputs. Everything is either kept live or marked `superseded`. This is what makes the graph a *derived, rebuildable view* rather than a lossy destination. (`rumbo-lld.md` §5.)

4. **Per-user scoping from day one.** Every new table has a `user_id` column. Every query filters by it. Postgres RLS (Supabase) enforces it at the DB layer *in addition to* app-layer `WHERE` clauses. There is no such thing as a cross-user query in V0. `user_id` = `auth.users.id` from Supabase Auth (UUID). The existing `public.users` table is the student profile — do not create a separate `students` table. Design docs sometimes say `student_id`; treat it as a synonym for `user_id`. See §10.6 and `Rumbo-Design-Docs/Infrastructure/storage.md` §0.

5. **`pipeline_version` on every produced record.** Every row the pipeline writes carries which version of the extraction / resolution / inference / weighting logic produced it. Without this, the shadow-rebuild capability is incoherent. (`Graph Pipeline/pipeline-versioning.md`.)

6. **V0 has one user-facing surface: the dashboard.** No tutor, no advising, no agent layer, no proactive surfacing of graph output. V1 is where features that consume the graph ship. This is deliberate — the graph has to be worth trusting before it's exposed. (`rumbo-lld.md` §1.)

7. **The scheduler stays hidden.** No V0 code path invokes `schedule-generator` or writes to `work_blocks`. Do not "quickly plug in" scheduler output because it happens to be sitting there — this is not a build cleanup problem, it's a product-boundary problem. See `Legacy/scheduler.md`.

---

## 4. Stack decisions (already made — don't re-litigate)

- **Frontend:** React 18 + Vite + TypeScript. React Router v6, CSS Modules, TanStack Query, Zustand. Lives in `src/`.
- **Server logic:** Supabase Edge Functions in Deno (TypeScript). Lives in `supabase/functions/`. All AI calls, all third-party OAuth handshakes, all cross-user queries happen here — never in the browser.
- **Database + auth + storage:** Supabase (Postgres + pgvector + Supabase Auth + Supabase Storage). Existing project with RLS baseline already applied. `Infrastructure/storage.md` §3.
- **Migrations:** SQL files in `supabase/migrations/`, applied via Supabase CLI (`supabase db push`). Existing migrations are load-bearing (RLS + scheduler-era tables); add new migrations forward-only. Never edit the DB by hand.
- **Vector index:** IVFFlat. `Infrastructure/storage.md` §4 Q2.
- **Embedding model:** `text-embedding-3-small` (1536d). Locked — swapping this is the most expensive breaking change in the pipeline. Called from Edge Functions via OpenAI SDK. `entity-extraction.md` §9 Q3.
- **LLM tier:** Anthropic Claude via `@anthropic-ai/sdk` in Edge Functions. Haiku (fast, cheap) for classification tasks (calendar academic/personal, Drive relevance); Sonnet or Opus for extraction and edge inference (reasoning-heavy). See per-stage docs. API key lives in Edge Function env only — never `VITE_`-prefixed.
- **Scheduled jobs:** Supabase Cron (pg_cron under the hood) for the 6h ingestion polls, daily webhook renewals, weekly reclassification, and daily decay. Not an in-process scheduler. See §10.6.
- **Third-party APIs:** Canvas REST (student PAT), Google Calendar API v3 + Google Drive API v3 (single OAuth grant, `calendar.readonly` + `drive.readonly`). Google Calendar OAuth already wired at `supabase/functions/calendar-oauth`; scope will expand to include Drive.
- **Repo shape:** single repo. `src/` = frontend, `supabase/` = backend + migrations. Splitting invites premature versioning problems at V0 scale.

If a stack decision isn't listed here or in a design doc, it's an open call — flag it and ask, don't just pick.

---

## 5. Build order (V0 phases)

The V0 milestone is: student can connect Canvas + Google, sees their normalized data on the dashboard, and the graph pipeline is running end-to-end underneath (nothing graph-derived shown to the student in V0).

Each phase has an exit criterion; do not start a later phase until the previous one meets it. The phases are ordered so each one forces the previous to be production-quality — e.g., the dashboard rewire is the forcing function that proves the normalization layer is real, before the harder brain phases start depending on it.

**Already done (do not redo):**
- Supabase project + Auth wired.
- RLS baseline applied (`supabase/migrations/20250522*`, `_rls_hardening.sql`).
- Google Calendar OAuth flow (`supabase/functions/calendar-oauth`, `src/lib/calendar.ts`).
- Auth pages, onboarding shell, dashboard layout, settings, account — all shipped. Design system in `Rumbo-Design-Docs/Frontend/design-system.md`.
- Deterministic scheduler + task capture (**preserved, hidden**, not touched — see `Legacy/scheduler.md`).

Verify pgvector is enabled on the existing Supabase project before Phase 1 — the scheduler era didn't need it, so it may not be turned on yet.

### Phase 1 — Storage schema (graph-brain tables)

**Goal:** all V0 graph-brain tables exist alongside the preserved scheduler tables, with RLS policies and no data.

Read (in order): `Rumbo-Design-Docs/Infrastructure/storage.md` §0 (reality alignment — read this first), then §2 (canonical schema — interpret through §0).

Steps:
1. **Phase 1a — extension + existing-table extensions** (single small migration; safe smoke test for the docs → code → deploy loop):
   - `create extension if not exists vector;`
   - `alter table public.calendar_connections add column if not exists scopes text[] not null default '{}';`
   - `create table public.canvas_credentials (user_id uuid primary key references auth.users(id) on delete cascade, pat text not null, base_url text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now());` — RLS enabled; service-role writes only from onboarding Edge Function; no client `select` on `pat`.
2. **Phase 1b — graph-brain tables.** Forward-only migration. Use `user_id` (not `student_id`) in every new table. Do NOT create a `students` table — `public.users` is the student profile.
3. Create tables in FK order: `normalized_events`, `manual_courses`, `manual_uploads`, `drive_sync_state`, `drive_exclusions`, `drive_content_queue`, `calendar_sync_state`, `canvas_sync_state`, `canvas_course_sync`, `graph_nodes`, `node_mentions`, `entity_candidates`, `graph_edges`, `pipeline_versions`. See `Infrastructure/storage.md` §2 (with §0 overrides).
4. Add pgvector columns per the schema; create IVFFlat indexes.
5. Add `user_id`-scoped RLS policies on every new table (`using (auth.uid() = user_id)`). Service-role code (Edge Functions with `SERVICE_ROLE_KEY`) bypasses RLS; anon/authenticated app code goes through RLS. Get this right now.
6. Add shadow tables (`graph_nodes_shadow`, `graph_edges_shadow`, `entity_candidates_shadow`) mirroring the live schema. They stay empty until Phase 11 uses them.
7. Seed `pipeline_versions` with the initial v0.1 row per stage.

**Exit criterion:** all new tables created, RLS policies verified with an insert-as-user-A / select-as-user-B test that returns zero rows. Existing scheduler tables (`tasks`, `work_blocks`, `learning_profile`, `calendar_connections`) are untouched except for the additive `scopes` column on `calendar_connections`.

### Phase 2 — Canvas adapter (Edge Function)

**Goal:** Canvas assignments flow into `normalized_events` on a 6h Supabase Cron schedule.

Read: `Rumbo-Design-Docs/External Sources/canvas.md`, `data-ingestion.md` §3.2, `rumbo-lld.md` §3.2.

Why Canvas first: student-generated Personal Access Token means no OAuth flow to build. Isolates ingestion → normalization work from the auth complexity.

Steps:
1. New Edge Function `supabase/functions/canvas-ingest/` (Deno / TypeScript).
2. Store Canvas PAT + base URL encrypted per student — new `canvas_credentials` table (RLS-scoped, service-role writes from onboarding).
3. Adapter helpers in `_shared/canvas.ts`: `listCourses(pat, baseUrl)`, `listAssignments(pat, baseUrl, courseId)`, etc. Pure functions returning parsed objects.
4. Normalization: Canvas API response → `normalized_events` row with `source_type='canvas_assignment'`, full `raw_payload`, flattened `normalized_text`, `pipeline_version='ingestion-v0.1'`.
5. Change detection via `updated_at` per `canvas.md` §3.
6. Cancelled / deleted items: soft-delete via `cancelled_at`, never hard-delete.
7. Wire Supabase Cron entry to invoke the function every 6h.

**Exit criterion:** a real Canvas account connected end-to-end lands assignments in `normalized_events` with correct `student_id`, `source_type`, `raw_payload`, and `pipeline_version`.

**What not to do:** do not build a Canvas-specific dashboard. Do not ingest grades (out of scope per `canvas.md`).

### Phase 3 — Frontend rewire (onboarding + dashboard + settings + hide `/add-task`)

**Goal:** the student sees their Canvas data. This is the earliest point where the rewire is end-to-end visible, which forces the ingestion + normalization work to be real.

Read: `Rumbo-Design-Docs/Frontend/onboarding.md`, `Frontend/page-flows.md`, `Features/dashboard.md`.

Steps:
1. **Onboarding rewire** (`src/pages/Onboarding/Onboarding.tsx`). Match `Frontend/onboarding.md`: drop worker-type stage, drop unavailable-hours stage, keep field-of-study, add Canvas PAT stage (calls a new `canvas-verify` Edge Function to validate before saving), keep Google Calendar connect (expand its scope in Phase 4), add manual-courses stage. `learning_profile` row still created with defaults (compatibility carry — LLD §13).
2. **Dashboard rewire** (`src/pages/Dashboard/Dashboard.tsx`). Replace the `useTasks`/`useWorkBlocksRealtime` reads with a new hook that queries `normalized_events` per `Features/dashboard.md` §3. Section grouping becomes Recently added / Today / Upcoming (by course) / Still open (collapsed). `TaskCard` repurposed as assignment card (name, course, due date, points, source badge). Remove the `+ Add Task` button.
3. **Settings rewire** (`src/pages/Settings/Settings.tsx`). Replace work-hours/peak-hours editors with a Sources section (Canvas status + connect/disconnect, Google status + connect, Manual courses subpanel). Field-of-study editor kept.
4. **Hide `/add-task`.** Remove the route from `src/router/index.tsx`. Leave `src/pages/AddTask/` in place, untouched. Remove the `+ Add Task` link from the dashboard header.
5. **Account page.** Hide the tier/upgrade UI (nothing gates on tier in V0). Keep user info + sign out.

**Exit criterion:** a new user can sign up → onboard (field of study → Canvas PAT → Google Calendar connect → optional manual courses) → land on a dashboard that shows Canvas assignments grouped by course. `/add-task` returns 404 via the catch-all redirect. Design system tokens unchanged.

**Watch out for:** the `TaskCard` classifier badge (deep/shallow) is a prop the component still accepts — do not render it in V0. Do not delete the classifier code.

### Phase 4 — Google Calendar adapter (scope + classifier + webhooks)

**Goal:** Calendar events flow in via push webhook; academic-vs-personal classifier runs at ingest.

Read: `Rumbo-Design-Docs/External Sources/google-calendar.md`, `data-ingestion.md` §3.1.

The OAuth flow already exists (`supabase/functions/calendar-oauth`). This phase adds the classifier, webhook handling, and Drive-scope expansion (see Phase 5).

Steps:
1. Expand OAuth scope to `calendar.readonly` + `drive.readonly` in a single grant. Start Google app verification now — `drive.readonly` is sensitive and verification takes time.
2. Enumerate calendars on connect (`calendarList.list()`); register a watch channel per calendar per student. All calendars, not just primary (§3 opening).
3. New Edge Function `supabase/functions/calendar-webhook/` receives push notifications; use `syncToken` per calendar for incremental pulls.
4. New Edge Function `supabase/functions/calendar-classifier/` (or inline in the webhook handler): per-event Haiku call → `academic` / `personal` / `pending_classification` + confidence. Store confidence on `normalized_events.classification_confidence`. Prompt in `google-calendar.md` §5.
5. Recurring events: expand each occurrence within current + next semester (~6 months). One row per occurrence.
6. Supabase Cron: daily job renews any watch channel within 7 days of expiry; weekly job re-runs the classifier on `pending_classification` rows.

**Exit criterion:** a real Google account connected; events flow in classified; a recurring event produces one row per occurrence; simulated 8-days-before-expiry triggers renewal.

**Watch out for:** don't collapse `personal` and `pending_classification` — distinct states. Don't ingest `status='cancelled'` events as active — soft-delete instead.

### Phase 5 — Google Drive adapter (metadata poll + LLM relevance)

**Goal:** Drive metadata flows in on a 6h poll; content extraction is lazy and on-demand.

Read: `Rumbo-Design-Docs/External Sources/google-drive.md`.

Rides the Google OAuth grant expanded in Phase 4.

Steps:
1. First-run backfill Edge Function: `files.list` to seed, then `changes.getStartPageToken` → store on `drive_sync_state`.
2. Incremental Edge Function on 6h Supabase Cron: `changes.list(pageToken=...)`. Never re-list the whole Drive.
3. Relevance classifier (Haiku): inputs = name, MIME type, parent folder names, owner vs. student, sharer domain. Outputs `academic` / `personal` / `irrelevant` / `pending_classification` + confidence. Prompt in §10.5 of this file.
4. Fast-path exclusions before the LLM call: non-extractable MIME types (image/audio/video), trashed files.
5. Shared-file rule (inside classifier input, not a separate stage): include if in student-owned folder OR sharer's email is `.edu`. Otherwise exclude.
6. Content extraction: on-demand, queued via `drive_content_queue`, not called on routine polls. Size-gated at 10MB placeholder (Cat B).

**Exit criterion:** Drive metadata polling produces classified `normalized_events`; content-extraction request from the pipeline produces a `source_type='drive_content'` record.

**Watch out for:** do not extract content on the metadata poll. Do not attempt Drive-side course association — deferred to edge inference (`google-drive.md` §6.1, `rumbo-lld.md` §3.3).

### Phase 6 — Manual course entry

**Goal:** students can add non-Canvas courses via file upload or class-website URL.

Read: `Rumbo-Design-Docs/External Sources/manual-course-entry.md`.

Steps:
1. Upload flow: PDF / DOCX / image (OCR) → Supabase Storage → `manual_uploads` row → extraction into `normalized_events` with `source_type='manual_*'`. Extraction happens in an Edge Function (Sonnet).
2. URL fetch flow: static HTML fetch only (Playwright deferred). Same normalization path.
3. Canvas-conflict prompt: if a manual course is later linked to a Canvas course, prompt to merge — do not auto-merge (`manual-course-entry.md` §9).
4. Archive-only, no delete.
5. UI lives inside `/settings` (Manual courses subpanel from Phase 3) and in the onboarding stage-4 flow.

**Exit criterion:** a student can add a course via each entry path; resulting assignments appear on the dashboard.

### Phase 7 — Brain: Stage 1 (entity extraction)

**Goal:** extraction pipeline running on a 6h Supabase Cron, producing `entity_candidates` from `normalized_events`.

Read: `Rumbo-Design-Docs/Graph Pipeline/entity-extraction.md`.

Steps:
1. New Edge Function `supabase/functions/pipeline-extract/`. LLM tool-use (Sonnet, not Haiku — this is reasoning work). Input = `normalized_text` + source metadata. Output = typed candidates (concept / assignment / deadline / topic / person / course_reference) + self-reported confidence + provenance (source `normalized_events.id`, `pipeline_version`).
2. Confidence handling: treat self-reported floats as ordinal buckets (high/med/low). Store both raw float and ordinal. Do not treat the raw as calibrated probability.
3. Embedding: every candidate gets embedded with `text-embedding-3-small` before Stage 2. Call OpenAI from the Edge Function.
4. Backfill: dedicated invocation with higher concurrency runs once at onboarding, hands off to the regular 6h Cron job. A 24h empty-graph experience is a bad first impression.
5. Batch size: 100 records per run initially. Instrument cost + latency; tune from there.

**Exit criterion:** `entity_candidates` rows appear for real student data with valid `pipeline_version`, valid provenance, and non-null embeddings.

### Phase 8 — Brain: Stage 2 (entity resolution)

**Goal:** entity candidates merge into existing `graph_nodes` or promote to new nodes.

Read: `Rumbo-Design-Docs/Graph Pipeline/entity-resolution.md`.

Steps:
1. Runs inline in the `pipeline-extract` Edge Function (same job — see `entity-resolution.md` §7 Q5).
2. Two-pass retrieval: pgvector cosine-similarity top-20 → LLM judge on the shortlist.
3. Three-zone thresholds: merge > 0.92, review 0.75–0.92, new < 0.75. **Placeholders — wire as constants for one-line tuning.**
4. Ambiguous zone → provisional node. Promotion: 3 corroborating mentions OR later high-confidence merge OR auto-demote after 60d.
5. Person-entity normalization *before* embedding: strip titles, normalize whitespace, canonicalize "F. Last" ↔ "First Last".
6. Resolution-judge prompt: §10.3 of this file.

**Exit criterion:** running the pipeline over Phase 7 output produces `graph_nodes` with correct `student_id` scoping; provisional nodes exist; promotion/demotion works on synthetic corroboration.

**Watch out for:** do not surface resolution ambiguity to the student. Silent resolution is a design decision, not a limitation.

### Phase 9 — Brain: Stage 3 (edge inference)

**Goal:** LLM proposes typed edges + confidence signals between candidate node pairs.

Read: `Rumbo-Design-Docs/Graph Pipeline/edge-inference.md`.

Steps:
1. New Edge Function `supabase/functions/pipeline-infer/` on Supabase Cron.
2. Candidate-pair generation: 10 pairs per node per run from proximity (embedding similarity) + co-occurrence (same source record).
3. LLM inference (Sonnet or Opus): pair → relationship type from V0 vocabulary + `sequential`. Returns type + three confidence signals (extraction, resolution, relevance).
4. Three-gate suppression: only pairs clearing all three gates become surfaced. Placeholders: extraction ≥ 0.7, resolution ≥ 0.8, relevance ≥ 0.75. Constants.
5. Reasoning storage: reasoning text stored *only* for edges that will be surfaced.
6. Append-only: no re-inference on updates. New evidence creates corroborating edges; existing edges updated by weighting (Phase 10).
7. System prompt: §10.4 of this file. Tool schema: `edge-inference.md` §4.

**Exit criterion:** `graph_edges` populated with correct `pipeline_version`; the four surfacing paths (drop / hold-provisional / stored-not-surfaced / surface) all exercised by real data.

### Phase 10 — Brain: Stage 4 (edge weighting + surfacing gate)

**Goal:** continuous edge weights; surfacing threshold controls what a V1 feature *would* see (nothing surfaces in V0).

Read: `Rumbo-Design-Docs/Graph Pipeline/edge-weighting.md`.

Steps:
1. Weighted-sum formula: `weight = (0.40·authority + 0.35·corroboration + 0.25·decay) × relevance`. Coefficients as constants.
2. Corroboration must respect independence (two mentions from the same lecture ≠ two independent sources). See `edge-weighting.md` §2.2.
3. Decay is per-feature, not global. `computeWeight(...)` takes `halfLifeDays`. Defaults: 90d for tutor/dashboard reads (V1), 365d for advising reads (V1).
4. Surfacing threshold: 0.60 placeholder. `is_surfaced` flag on `graph_edges`.
5. Daily Supabase Cron decay job: recomputes weights, flips `is_surfaced` if threshold crossed, logs the flip.
6. Reinforcement: `reinforceEdge(...)` per `edge-weighting.md` §6.

**Exit criterion:** full pipeline end-to-end on real student data produces a graph with plausible surfaced edges (spot-check manually — Cat B tuning happens here).

### Phase 11 — Pipeline versioning + shadow-rebuild plumbing

**Goal:** breaking pipeline changes roll out safely via per-student shadow rebuild + atomic swap.

Read: `Rumbo-Design-Docs/Graph Pipeline/pipeline-versioning.md`.

Steps:
1. Version registry: every pipeline stage has a semver row in `pipeline_versions`. Bumping writes a new row; `breaking_change=true` requires rebuild.
2. Shadow-rebuild orchestrator (Edge Function or admin script): given a student + changed stages, materializes new outputs into `_shadow` tables tagged with the new version.
3. Diff-of-surfaced-edges report tool: old vs. new surfaced set for a student. Human-reviewed before promotion.
4. Atomic swap: transaction replacing the student's live-table rows with shadow rows. Old rows get `superseded_at`, not deleted.
5. Canary: run new logic on 1–2 designated staging graphs, produce diff report, engineer signs off, then batch-rebuild real students sequentially. Consider a second Supabase project (`rumbo-staging`) as the canary target — decide when this phase is reached.

**Exit criterion:** a simulated breaking change (modified extraction prompt) rolls out to a test student via shadow-rebuild, produces a diff report, and completes a swap with no downtime.

---

## 6. Testing philosophy

- **Integration tests hit a real database** — a Supabase branch database or a local `supabase start` instance. Do not mock the DB. Mocked DB tests hide RLS bugs; RLS bugs leak one student's data to another, the exact failure we can't afford.
- **Frontend unit tests use Vitest** (`npm test` — already wired). Use liberally for pure functions (normalization, name normalization, weight formula, decay math).
- **Edge Function tests use `deno test`.** Same rule — DB-touching tests hit a real DB.
- **LLM calls in tests:** wrap in a small shim that either hits the real API in an integration-marked test or returns a canned response for unit tests. Do not write tests that pretend to call the LLM but never do — those give false confidence and rot fastest.
- **Every ingested-record test asserts on `pipeline_version` and `student_id`** — the two fields most likely to be silently omitted, both load-bearing.
- **RLS-leak test is required for every new student-scoped table.** Insert as student A, select as student B, expect zero rows. Add as a fixture, not a one-off.

---

## 7. Things Claude should ask about rather than guess

- **Any threshold or coefficient not written in a design doc.** Numbers matter and inventing them silently locks in bad calibration. If the doc says "placeholder 0.60" and you need to change it, ask.
- **Any decision that would surface graph output to a student in V0.** V0 is dashboard only, by design. Flag it.
- **Any code path that would send communication in the student's name.** Draft, don't send. Always.
- **Any schema change without a migration.** Never edit the DB by hand.
- **Any decision to skip pipeline versioning.** The temptation is real (extra fields, extra columns, extra bookkeeping). Skipping it makes shadow-rebuild incoherent.
- **Any move that would revive scheduler UI in V0** (re-registering `/add-task`, re-adding "Scheduled today" grouping, calling `schedule-generator` from a new code path). Preservation is deliberate; reviving is a V1 decision (`Legacy/scheduler.md`).

---

## 8. Things Claude should *not* ask about (already decided)

- Frontend framework (React + Vite + TS), server runtime (Deno on Supabase Edge Functions), DB (Supabase Postgres + pgvector), embedding model (`text-embedding-3-small`), vector index type (IVFFlat), Drive scope (`drive.readonly`), calendar scope (all calendars), Gmail scope (`gmail.compose`, not `gmail.send`), poll cadence (6h via Supabase Cron), calendar webhook renewal window (7d ahead of expiry), recurring-event handling (expand into occurrences), Drive change detection (Changes API), file storage (Supabase Storage), auth (Supabase Auth).

If in doubt whether a call has been made: `grep -r "RESOLVED" Rumbo-Design-Docs/` finds every closed OPEN with its reasoning.

---

## 9. Common development tasks

- **Start local Supabase:** `supabase start` (requires Supabase CLI).
- **Apply migrations:** `supabase db push` for dev; migrations in `supabase/migrations/`.
- **Frontend dev server:** `npm run dev` (Vite on port 5173).
- **Frontend build:** `npm run build`.
- **Frontend tests:** `npm test` (Vitest, single run) or `npm run test:watch`.
- **Serve an Edge Function locally:** `supabase functions serve <name>` (auto-reloads).
- **Deploy an Edge Function:** `supabase functions deploy <name>`.
- **Invoke a deployed Edge Function:** `curl -X POST '<supabase-url>/functions/v1/<name>' -H 'Authorization: Bearer <anon-key>'` — or via the SDK on the frontend.
- **Tail Edge Function logs:** `supabase functions logs <name>`.
- **Reset a student's graph (dev only):** hand-written script that deletes `graph_nodes` + `graph_edges` rows scoped by `student_id`. Never run against production.

Update this section as CLI shape stabilizes and new invocations are added.

---

## 10. Brain prototype spec (closes remaining V0 build gaps)

This section fills gaps that would otherwise stall a prototype build. Most things that *looked* like gaps turned out to already live in per-area docs — this section flags where, then adds the pieces that were genuinely missing.

### 10.1 Already documented — pointers so you don't re-search

- **Extraction system prompt + tool schema:** `Graph Pipeline/entity-extraction.md` §4. Six-type entity vocabulary (`concept | topic | assignment | deadline | person | course_reference`) and per-entity fields.
- **Relationship-type vocabulary:** `Graph Pipeline/edge-inference.md` §4 tool schema — seven types (`prerequisite`, `applies_to`, `part_of`, `assessed_by`, `related_concept`, `cross_course`, `sequential`) plus `none`.
- **Source-authority numeric mapping:** `Graph Pipeline/entity-extraction.md` §5 — full table from `canvas_syllabus` (1.0) down to `student-authored Drive note` (~0.55).
- **Corroboration independence test:** `Graph Pipeline/edge-weighting.md` §2.2 — group source records by `(course_id, source_type)`. Same course + same source type = same cluster; independent clusters get the corroboration boost.
- **Calendar academic/personal classifier prompt:** `External Sources/google-calendar.md` §5.
- **Edge-inference tool-use schema:** `edge-inference.md` §4 (structured output shape for `infer_relationship`).

### 10.2 Genuinely missing pieces — added below

Four things not concretely written anywhere that would block a prototype:

1. Resolution-judge LLM prompt (Stage 2)
2. Edge-inference framing prompt (Stage 3 — schema exists, no framing prompt)
3. Drive relevance-classifier prompt (Stage 0-adjacent)
4. Scheduled-job choice + `student_id` ↔ Supabase Auth mapping

### 10.3 Resolution-judge prompt (Stage 2)

Runs on the pgvector shortlist for each candidate that falls in the review band (similarity 0.75–0.92). Returns `same` / `distinct` / `ambiguous`.

```typescript
export const RESOLUTION_JUDGE_SYSTEM_PROMPT = `
You are an entity resolution judge for a student's academic knowledge graph.

You will be given a NEW ENTITY extracted from a source record, and a CANDIDATE existing
node in the student's graph that is similar to it. Decide whether they refer to the
same underlying academic entity, are distinct entities that just share vocabulary,
or the evidence is genuinely ambiguous.

Rules:
- "same"      — the two refer to the same underlying concept, assignment, person, etc.
                Different course contexts alone are not enough to force "distinct" —
                the same concept can appear across courses (that is exactly what the
                graph is for). Use "same" only when the meaning is the same.
- "distinct"  — the two share vocabulary but refer to different underlying things.
                Example: "eigenvalues" in Linear Algebra vs. "eigenvalues" mentioned
                in passing in a Quantum Mechanics reading list. If in doubt about
                pedagogical intent, prefer "distinct" — the edge-inference stage can
                still connect them via a cross_course edge.
- "ambiguous" — you cannot confidently pick either. This is not a failure state; it
                creates a provisional node that later evidence can resolve.

Bias: when uncertain, prefer "distinct" over "same". A wrong merge is a trust cost;
a wrong split is invisible and can be corrected downstream by edge inference.
Never invent context that is not in the input.
`;

export const RESOLUTION_JUDGE_TOOL = {
  name: "resolve_entity",
  description: "Judge whether the new entity and candidate node refer to the same thing.",
  input_schema: {
    type: "object",
    properties: {
      verdict:    { type: "string", enum: ["same", "distinct", "ambiguous"] },
      reasoning:  { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["verdict", "reasoning", "confidence"],
  },
};
```

User-message shape: JSON with `new_entity` (name, type, context, source_type, course_id) and `candidate_node` (name, type, existing contexts as a list, first_seen_at, source_types seen). Keep the payload small — the shortlist is for shortlisting; the judge doesn't need the whole graph.

### 10.4 Edge-inference system prompt (Stage 3)

Tool schema is already in `edge-inference.md` §4. The framing prompt that sits above it:

```typescript
export const EDGE_INFERENCE_SYSTEM_PROMPT = `
You are an academic-relationship reasoner for a student's knowledge graph. Given two
candidate nodes and the source records they appear in, decide whether there is a
meaningful academic relationship worth representing as an edge — and if so, what type.

Available relationship types (with strict meanings):
- prerequisite      — Node A must be understood before node B.
- applies_to        — Concept A is applied in context B (e.g. a technique used in an assignment).
- part_of           — A is a structural component of topic/course B.
- assessed_by       — Concept A is tested/evaluated by assignment B.
- related_concept   — A and B are related but neither is prerequisite; they inform each other.
- cross_course      — Same concept appears in different courses (usually paired with the
                      resolution decision that kept them as distinct nodes).
- sequential        — A precedes B in a course's ordering (lecture N then lecture N+1;
                      topic N then topic N+1). Not the same as prerequisite — sequential is
                      about ordering within a container, not conceptual dependency.
- none              — No meaningful academic relationship. Return this liberally.

Asymmetric-suppression rule (the core product principle):
- A wrong surfaced edge costs the student's trust. A missed edge costs a little value
  but is invisible. When uncertain, return "none".
- Do not invent relationships to fill a gap. Do not assert relationships from mere
  co-occurrence unless the source context supports the specific type you are claiming.

Relevance score: rate how relevant this connection is TO WHAT THE STUDENT IS DOING RIGHT
NOW, not how true it is in the abstract. A true-but-three-semesters-stale connection
should get a low relevance score.

Direction: prefer bidirectional only when the relationship is genuinely symmetric
(related_concept, cross_course). Prerequisite, applies_to, part_of, assessed_by, and
sequential are almost always directional.

Reasoning: one short sentence citing the specific source evidence that supports your call.
This reasoning is stored only for edges that end up surfaced — it is the debugging trail
if a wrong edge reaches a student.
`;
```

Wire this framing prompt above the `infer_relationship` tool schema from `edge-inference.md` §4. Do not redefine the schema in code.

### 10.5 Drive relevance-classifier prompt

Calendar's classifier prompt is in `google-calendar.md` §5. Drive's isn't concretely written. Use:

```typescript
export const DRIVE_RELEVANCE_CLASSIFIER_PROMPT = `
Classify this Google Drive file as academic, personal, or irrelevant to a student's
academic knowledge graph.

Consider:
- File name
- MIME type
- Parent folder name(s)
- Owner (student themselves vs. shared by someone else)
- Sharer's email domain if shared (an .edu-domain sharer is likely an instructor)

Rules:
- academic   — course materials, notes, readings, problem sets, syllabi, lecture slides,
               anything that would plausibly enter the student's academic knowledge graph.
- personal   — clearly non-academic personal files: photos, finance spreadsheets,
               non-course writing, personal projects.
- irrelevant — files that are neither academic nor personal in a way that matters:
               random downloads, unrelated collab docs, files the student happens to
               have access to but has no evident relationship with.

Return the classification, a confidence score, and one short sentence of reasoning.
When uncertain between academic and personal, prefer personal (lower cost than a
false-academic that pollutes the graph). When uncertain between anything and
irrelevant, prefer irrelevant (excluded from extraction, still stored).

If confidence is below the commit threshold, return "pending_classification" — this
holds the file for re-classification on a later pass when more context may exist.
`;
```

Confidence commit threshold is Cat B — wire as a constant, default to 0.7 as a placeholder, tune from real data.

### 10.6 Scheduled jobs + Supabase Auth wiring

**Scheduled jobs.** Use Supabase Cron (pg_cron under the hood) to invoke Edge Functions on schedule. Concrete cron entries for V0:

| Job | Cadence | Purpose |
|---|---|---|
| `canvas-ingest` | every 6h | Poll Canvas, write to `normalized_events`. |
| `drive-ingest` | every 6h | Drive `changes.list` incremental poll. |
| `calendar-webhook-renewal` | daily | Renew any watch channel within 7d of expiry. |
| `calendar-reclassify-pending` | weekly | Re-run classifier on `pending_classification` rows. |
| `pipeline-extract` | every 6h | Extraction + resolution (same job, per §7.2 of `entity-resolution.md`). |
| `pipeline-infer` | every 6h (offset from extract) | Edge inference on new candidate pairs. |
| `pipeline-decay` | daily | Recompute edge weights, flip `is_surfaced` on threshold crossings. |

APScheduler, Celery, and other in-process schedulers are explicitly not used — Supabase Cron is native, needs no extra host, and matches the Edge Functions runtime. Revisit only when a real scaling signal appears.

**`user_id` mapping.** `user_id` = `auth.users.id` from Supabase Auth (UUID). The **existing** `public.users` table is the student profile — do NOT create a separate `students` table. RLS policies on user-scoped tables check `auth.uid() = user_id`. Supabase Auth is the source of truth.

Onboarding flow:
1. Supabase Auth sign-up creates `auth.users` row. The `public.users` row is upserted by the frontend during onboarding (`ensureUserRow()` in `src/pages/Onboarding/Onboarding.tsx`) — no Postgres trigger needed since this is already wired.
2. Onboarding writes `canvas_credentials` (Canvas PAT + base URL, new table) and updates `calendar_connections` (existing table — expand its `scopes` column to track granted scopes). Both encrypted / restricted-grant per `Infrastructure/storage.md` §0.
3. Ingestion Edge Functions iterate `public.users`, load credentials, run per-user.

### 10.7 What to do when a prototype question arises that this section doesn't answer

If you hit a decision the design docs don't cover and this section doesn't cover, do not silently pick. The right sequence:
1. Grep the design repo for prior discussion: `grep -r "<keyword>" Rumbo-Design-Docs/`.
2. If nothing exists, flag the question and its options with the user before writing code that presumes an answer.
3. If the user resolves it, add a `RESOLVED` entry to the appropriate design-doc §8 (or per-doc equivalent) *before* landing the code change.

Same discipline as the design phase — no invented decisions, everything traceable.

---

*This doc mirrors the design repo. If you resolve a Cat B item (threshold or coefficient tuning), update the design doc's per-area file first, then reference it from code. Never encode a magic number in code that isn't traceable back to a doc entry.*
