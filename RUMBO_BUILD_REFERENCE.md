# RUMBO — Complete Build Reference
> Feed this file into your repo. Every architectural decision made before a line of code is written.
> Decisions are final unless marked PROVISIONAL. Check those before implementing.

---

## HOW TO USE THIS DOCUMENT

Work through phases in order. Before starting each phase:
1. Read the full phase section
2. Verify every decision still matches your intent
3. Note any PROVISIONAL decisions that need research before implementation
4. Do not skip ahead — later phases depend on earlier ones being built correctly

---

## GLOBAL DECISIONS

These apply across every phase and every surface.

| Decision | Choice |
|---|---|
| Web version | Full feature parity with desktop (except hotkey + tray) |
| Free tier | Real product — 5-task cap feels natural, not like a wall |
| Trust model | Simplicity — confident schedule, no inline algorithm explanations |
| Session model | Independent sessions per surface, data synced via Supabase Realtime |
| University field | Deferred — collect in future version when school integrations exist |

### The platform.ts Rule
UI components NEVER import from @tauri-apps directly.
All platform-specific calls go through `platform.ts` — one per surface.

```
apps/desktop/src/lib/platform.ts  ← calls Tauri APIs
apps/web/lib/platform.ts          ← calls browser equivalents
```

Functions platform.ts must export:
```typescript
createSupabaseClient()       // surface-specific storage adapter
closeWindow()
storeToken(key, value)
getToken(key)
openExternalUrl(url)
onWindowBlur(callback)
registerQuickAddShortcut(callback)
getFilePath(file)            // for PDF uploads
persistQueryCache(data)      // TanStack Query persistence
readQueryCache()
```

---

## REPO STRUCTURE

```
rumbo/
├── packages/
│   └── ui/                        ← shared React components
│       ├── package.json
│       ├── components/
│       │   ├── TaskCard.tsx
│       │   ├── WorkBlock.tsx
│       │   ├── ReflectionModal.tsx
│       │   ├── ClassifierBadge.tsx
│       │   └── ...
│       └── index.ts               ← barrel export
├── apps/
│   ├── desktop/                   ← Tauri 2 app
│   │   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   └── platform.ts    ← Tauri implementations
│   │   │   └── main.tsx
│   │   └── package.json
│   └── web/                       ← Next.js App Router
│       ├── app/
│       ├── lib/
│       │   └── platform.ts        ← browser implementations
│       └── package.json
└── pnpm-workspace.yaml
```

Tooling: pnpm workspaces only. No Turborepo until build times justify it.

---

## TECH STACK

### Infrastructure
| Layer | Choice |
|---|---|
| Desktop shell | Tauri 2 (Rust core) |
| Web framework | Next.js App Router |
| Monorepo | pnpm workspaces — no Turborepo yet |
| Deployment — web | Vercel |
| Deployment — desktop | GitHub releases |

### Frontend
| Layer | Choice |
|---|---|
| Framework | React 18 + TypeScript + Vite (desktop) / Next.js (web) |
| Component library | shadcn/ui |
| Styling | Tailwind CSS + CSS custom properties for design tokens |
| Platform abstraction | platform.ts per surface |

CSS tokens (extend shadcn/ui defaults in globals.css):
```css
:root {
  --rumbo-navy: #1a1a2e;
  --rumbo-purple: #6C63FF;
  --rumbo-block-deep: #6C63FF;
  --rumbo-block-shallow: #34D399;
  --rumbo-radius: 10px;
}
```

### State
| Layer | Choice |
|---|---|
| UI state | Zustand — modal open/closed, active block, onboarding step, classifier result |
| Server state | TanStack Query — tasks, blocks, profile, reflections |
| Local persistence | TanStack Query persistQueryClient → file via Tauri filesystem API |
| Local database | Dropped — SQLite removed |
| Realtime → UI | Supabase Realtime → queryClient.invalidateQueries() |

State boundary rule — enforce with comments in code:
```
zustand/uiStore.ts    → ONLY UI state. No Supabase data. No business logic.
tanstack/queries.ts   → ONLY Supabase data. No UI state. No ephemeral values.
```

### Backend
| Layer | Choice |
|---|---|
| Platform | Supabase all-in |
| Database | Supabase Postgres |
| Auth | Supabase Auth — email + password only at MVP |
| Backend logic | Supabase Edge Functions (Deno / TypeScript) |
| Realtime | Supabase Realtime |
| File storage | Supabase Storage |

### Hotkey
| Layer | Choice |
|---|---|
| Desktop plugin | tauri-plugin-global-shortcut |
| Modal window strategy | Pre-created at startup, hidden, toggled on hotkey |
| Web shortcut | Cmd+Shift+Space keydown listener at app root |
| Abstraction | platform.ts → registerQuickAddShortcut(callback) |
| macOS Accessibility | Required — no graceful fallback at MVP |

### Calendar
| Layer | Choice |
|---|---|
| Calendars at MVP | Google Calendar + Microsoft Outlook |
| Desktop OAuth | Custom URI scheme — rumbo://oauth/callback |
| Web OAuth | Standard redirect — https://tryrumbo.com/auth/callback |
| Token encryption | Edge Function encrypts with secret key before writing to DB |
| Token refresh | Proactive — check expiry before every API call |
| Revoked permission | status = 'revoked' immediately + dashboard banner |
| Transient error | Retry once before marking revoked |

Register rumbo://oauth/callback in:
- tauri.conf.json (OS registration)
- Google Cloud Console (authorized redirect URI)
- Azure Portal (authorized redirect URI)

### AI
| Layer | Choice |
|---|---|
| Model | Claude Haiku 3.5 |
| PDF parsing | Once per PDF, cached by content hash |
| Description parsing | Once per description, cached by content hash |
| Cache invalidation | Re-runs when description_hash or pdf_hash changes |
| UI update on completion | Supabase Realtime → TanStack Query invalidation |
| Tier gate | Premium only |

AI expansion roadmap (post-MVP, in priority order):
1. Natural language task input → Haiku parse to structured fields
2. Smart rescheduling explanations → one sentence why a block moved
3. Weekly planning briefing → Monday morning schedule summary
4. Reflection pattern analysis → Sonnet, requires 30+ reflections
5. Deadline risk detection → daily check, conversational warning

### Billing
| Layer | Choice |
|---|---|
| Payment UI | Stripe Checkout — hosted page |
| Desktop open | platform.ts → openExternalUrl() |
| Webhook handler | Supabase Edge Function |
| Idempotency | Check stripe_event_id before processing |
| Tier source of truth | users.tier — never check Stripe in app code |
| Feature gating | RLS policies at DB level |

Webhook events to handle:
```
checkout.session.completed      → users.tier = 'premium'
customer.subscription.deleted   → users.tier = 'free'
invoice.payment_failed          → users.tier = 'free'
```

### Packaging
| Layer | Choice |
|---|---|
| Mac build | .dmg — signed + notarized (Apple Developer ID) |
| Windows build | .msi — unsigned for early access |
| Auto-update | tauri-plugin-updater + GitHub releases |
| Early access pipeline | Manual builds |
| Public launch pipeline | GitHub Actions + tauri-apps/tauri-action |

---

## DATABASE

### Complete Table List
```
users
tasks
work_blocks
deep_reflections
shallow_reflections
task_problems
task_subtasks
shallow_batches
learning_profile
calendar_connections
ai_schedules
```

### users
```sql
id                  uuid primary key (from auth.users)
email               text not null
name                text
tier                text default 'free' -- 'free' | 'premium'
stripe_customer_id  text
stripe_sub_id       text
onboarding_step     text default '1' -- '1'|'2'|'3'|'4'|'complete'
onboarding_q1       text  -- 'early_bird'|'morning'|'afternoon'|'night_owl'
onboarding_q2_before time
onboarding_q2_after  time
onboarding_q3       integer  -- 25|35|50|75
onboarding_q4       text  -- 'none'|'1-2'|'3-4'|'5+'
created_at          timestamptz default now()
```

### tasks
```sql
id                        uuid primary key
user_id                   uuid references auth.users
title                     text not null
due_date                  timestamptz not null
estimated_mins            integer not null check (estimated_mins > 0)
work_type                 text -- 'deep' | 'shallow'
classifier_confidence     float
shallow_score             float
deep_score                float
user_overrode_classifier  boolean default false
urgency_ratio             float
description               text
description_hash          text
pdf_url                   text
pdf_hash                  text
calendar_color            text
status                    text default 'pending' -- 'pending'|'in_progress'|'complete'
deleted_at                timestamptz  -- reserved for soft delete post-MVP
created_at                timestamptz default now()
```

### work_blocks
```sql
id                  uuid primary key
user_id             uuid references auth.users
task_id             uuid references tasks on delete cascade
start_time          timestamptz not null
end_time            timestamptz not null
duration_mins       integer not null
work_type           text -- 'deep' | 'shallow'
status              text default 'upcoming' -- 'upcoming'|'active'|'done'|'missed'
slot_score          float
scheduled_by        text -- 'algorithm' | 'manual'
calendar_event_id   text
shallow_batch_id    uuid references shallow_batches
created_at          timestamptz default now()
```

### deep_reflections
```sql
id               uuid primary key
user_id          uuid references auth.users
work_block_id    uuid references work_blocks on delete restrict
productivity     integer not null check (productivity between 1 and 5)
energy           integer not null check (energy between 1 and 5)
distraction      integer not null check (distraction between 1 and 5)
completion_rate  float not null check (completion_rate between 0 and 1)
notes            text
created_at       timestamptz default now()
```

### shallow_reflections
```sql
id                uuid primary key
user_id           uuid references auth.users
work_block_id     uuid references work_blocks on delete restrict
task_completions  jsonb not null -- Record<task_id, boolean>
created_at        timestamptz default now()
```

### learning_profile
```sql
id                    uuid primary key
user_id               uuid unique references auth.users
peak_hour_map         jsonb  -- HourScore[] — one per hour 0-23
target_block_mins     integer
deadline_strategy     text default 'even' -- 'front_load'|'even'|'ramp'|'unknown'
shallow_before_deep   boolean default true
unavailable_before    time
unavailable_after     time
day_fragmentation     text  -- 'low'|'medium'|'high'|'very_high'
peak_hour_confidence  float default 0.0
reflection_count      integer default 0
created_at            timestamptz default now()
updated_at            timestamptz default now()
```

### calendar_connections
```sql
id               uuid primary key
user_id          uuid references auth.users
provider         text not null -- 'google' | 'outlook'
access_token     text not null  -- encrypted in Edge Function
refresh_token    text not null  -- encrypted in Edge Function
expires_at       timestamptz
calendar_ids     text[]  -- which calendars the student selected
status           text default 'active' -- 'active' | 'revoked'
webhook_id       text
webhook_expiry   timestamptz
connected_at     timestamptz default now()
```

### task_problems (premium, AI-extracted from PDF)
```sql
id              uuid primary key
task_id         uuid references tasks on delete cascade
title           text not null
estimated_mins  integer
order_index     integer not null
created_at      timestamptz default now()
```

### task_subtasks (premium, AI-extracted from description)
```sql
id              uuid primary key
task_id         uuid references tasks on delete cascade
title           text not null
estimated_mins  integer
order_index     integer not null
completed       boolean default false
created_at      timestamptz default now()
```

### shallow_batches
```sql
id          uuid primary key
user_id     uuid references auth.users
date        date not null
created_at  timestamptz default now()
```

### ai_schedules
```sql
id            uuid primary key
user_id       uuid references auth.users
model         text not null
input_hash    text
output        jsonb
triggered_by  text -- 'task_create'|'reflection'|'nightly'|'manual'
created_at    timestamptz default now()
```

### DB-Level Constraints
```sql
-- Enforced at schema level, never violated by application code

learning_profile.user_id               UNIQUE
work_blocks.task_id                    FK → tasks ON DELETE CASCADE
deep_reflections.work_block_id         FK → work_blocks ON DELETE RESTRICT
shallow_reflections.work_block_id      FK → work_blocks ON DELETE RESTRICT
tasks.estimated_mins                   CHECK > 0
deep_reflections.productivity          CHECK 1–5
deep_reflections.energy                CHECK 1–5
deep_reflections.distraction           CHECK 1–5
deep_reflections.completion_rate       CHECK 0.0–1.0
```

### RLS Policies
RLS enabled on ALL tables.
Users can only read/write rows where user_id = auth.uid().

Free tier task cap — enforced via RLS policy, not application code:
```sql
-- Users on free tier cannot insert if they already have 5+ tasks
create policy "free tier task cap"
on tasks for insert
to authenticated
with check (
  (select tier from users where id = auth.uid()) = 'premium'
  or
  (select count(*) from tasks where user_id = auth.uid() and deleted_at is null) < 5
);
```

### DB Trigger — Create Profile on Signup
```sql
-- Fires on auth.users INSERT
-- Creates users row + learning_profile row immediately
-- Never leaves a user with auth but no profile
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into users (id, email, name) values (new.id, new.email, new.raw_user_meta_data->>'name');
  insert into learning_profile (user_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();
```

---

## AUTH IMPLEMENTATION

| Decision | Choice |
|---|---|
| Signup fields | Email + password + name |
| Email verification | None at MVP |
| Login | Email + password only |
| SSO | Post-MVP (Google + Apple) |
| Forgot password | Supabase default reset link |
| Session persistence | Always logged in, silent JWT refresh |
| Desktop token storage | Tauri secure store via custom storage adapter |
| Web token storage | @supabase/ssr cookie adapter |
| Route protection — web | Supabase SSR middleware |
| Route protection — desktop | Client-side ProtectedRoute component |
| Auth state | onAuthStateChange() → Zustand authStore |
| Logout | Clear session + queryClient.clear() + Zustand reset + redirect /login |
| Account collision | N/A until SSO added |

Next.js middleware matcher — prevent infinite redirect loop:
```typescript
export const config = {
  matcher: [
    '/((?!login|signup|forgot-password|_next/static|_next/image|favicon.ico).*)',
  ],
}
```

---

## PHASE 1 — AUTH + ONBOARDING

### Onboarding Gate
| Decision | Choice |
|---|---|
| Gate model | Hard gate — nothing accessible until complete |
| Mid-flow close | Resumes at exact step via onboarding_step in users table |
| Step persistence | Written to DB after each step transition |
| onboarding_step values | '1' \| '2' \| '3' \| '4' \| 'complete' |

### The 4 Onboarding Questions
| # | Question | Format | Seeds |
|---|---|---|---|
| Q1 | When do you usually work? | 4 buckets | peak_hour_map |
| Q2 | Unavailable hours | Two time pickers | unavailable_before / unavailable_after |
| Q3 | How long do you usually study at one time? | 4 options | target_block_mins |
| Q4 | How many classes or commitments most days? | 4 options | day_fragmentation |

Q1 — Peak hour seeds:
```
Early Bird  → hours 5–9   scored 0.8, all others 0.3
Morning     → hours 8–12  scored 0.8, all others 0.3
Afternoon   → hours 12–17 scored 0.8, all others 0.3
Night Owl   → hours 19–24 scored 0.8, all others 0.3
```
Note: Early Bird and Morning overlap at 8–9am intentionally. Profile corrects quickly.

Q3 — Session length mapping:
```
< 30 min  → target_block_mins = 25
30–45 min → target_block_mins = 35
45–60 min → target_block_mins = 50
60–90 min → target_block_mins = 75
```
Keep all 4 options including < 30 min. Students with significant attentional differences need it.

Q4 — Fragmentation mapping:
```
None → day_fragmentation = 'low'
1–2  → day_fragmentation = 'medium'
3–4  → day_fragmentation = 'high'
5+   → day_fragmentation = 'very_high'
```

### Calendar Connect (Step 4)
| Decision | Choice |
|---|---|
| Required | No — skippable, strongly encouraged |
| Degraded mode | Scheduler runs on Q1–Q4 seeds only |
| Degraded mode UI | Single persistent banner until connected |
| Banner behavior | Appears once, dismissed permanently on connect |
| Calendars | Google Calendar + Microsoft Outlook |

### First Task
| Decision | Choice |
|---|---|
| Location | Dashboard empty state after onboarding |
| Required | No |
| Empty state action | Single "Add your first task" CTA → opens quick-add modal |

### Cold Start Profile
| Field | Source | Default |
|---|---|---|
| peak_hour_map | Q1 | Bucket seed values |
| unavailable_before | Q2 | Student-set |
| unavailable_after | Q2 | Student-set |
| target_block_mins | Q3 | 25 / 35 / 50 / 75 |
| day_fragmentation | Q4 | low / medium / high / very_high |
| deadline_strategy | — | 'even' |
| shallow_before_deep | — | true |
| peak_hour_confidence | — | 0.0 |
| reflection_count | — | 0 |

Cold start behavior: seeded inputs treated as real. Single scheduler code path. Profile adapts through reflections. No cold start mode, no cold start UI indicator.

---

## PHASE 2 — TASK CAPTURE

### Quick-Add Modal
| Decision | Choice |
|---|---|
| Fields | Title + due date + time estimate + expandable description + PDF upload |
| Description section | Collapsible — hidden by default, expands on demand |
| PDF upload | Inside expandable section, premium only |
| Classifier display | Badge only — Deep / Shallow pill, live on keystroke |
| Override interaction | Click badge to toggle — stores user_overrode_classifier = true |
| Due date input | Date picker (calendar popover) |
| Time estimate | Free text number + unit selector (minutes / hours) |
| Cap message | Inline in modal before submit: "Upgrade to add more tasks" |

### Submit Sequence
This is the exact order of operations on submit. Do not deviate:
```
1. Validate required fields (title, due date) — show inline errors if missing
2. Run classifier one final time on submitted title
3. Write task to Supabase immediately
4. Close modal + clear all fields
5. Show task in dashboard optimistically via TanStack Query
6. [If premium + description present] → call parse-description Edge Function async
7. [If premium + PDF attached] → call parse-pdf Edge Function async after description parse
8. [Always] → trigger schedule-generator Edge Function
9. AI results arrive via Realtime → TanStack Query invalidates → UI updates silently
10. Work blocks appear in dashboard via Realtime as scheduler completes
```

Modal closes at step 4. Student NEVER waits for AI or scheduler.

### Hybrid Classifier (client-side, no API call)
Runs on every keystroke. Zero network calls.

Shallow keywords (+1.0 each):
```
email, reply, respond, submit, upload, schedule, read, review,
canvas, lms, form, admin, message, notes, slides, plan, print,
confirm, check, watch
```

Deep keywords (+1.0 each):
```
problem set, pset, essay, write, code, build, design, analyze,
study, exam, lab, report, project, research, derive, prove,
implement, debug, calculate, draft
```

Confidence formula:
```
confidence = max(shallow_score, deep_score) / (shallow_score + deep_score + 1)
```

Outcomes:
```
≥ 0.75 → auto-classify, show badge with override link
0.4–0.75 → ask student: "Deep or shallow work?"
< 0.4 → default to deep, student can override
```

Edge case: readings classified shallow BUT estimated_mins > 45 → promote to deep block treatment.

### AI Enrichment (premium async)
```
parse-description:
  Input:  task title + description text
  Output: DescriptionParseResult
    - refined estimated_mins (overwrites if >20% different)
    - work_type signal (overrides classifier if AI confidence > keyword confidence)
    - TaskSubtask[] → written to task_subtasks table
  Cache:  hashed on (task_id + description content) — stored as description_hash
  Re-run: only if description_hash changes

parse-pdf:
  Input:  extracted PDF text
  Output: TaskProblem[] → written to task_problems table
  Cache:  hashed on PDF file contents — stored as pdf_hash
  Re-run: only if pdf_hash changes

If BOTH description and PDF provided → PDF parse takes precedence for problem list
```

---

## PHASE 3 — MAIN DASHBOARD

### Navigation
| Decision | Choice |
|---|---|
| Structure | Left sidebar |
| Nav items | Today / Tasks / Settings |
| Max items at MVP | 3 |

### Today View
| Decision | Choice |
|---|---|
| Layout | Ordered card list, chronological |
| Card contents | Task name, start time, duration, work type badge, status |
| Block statuses | Upcoming / Active / Done / Missed |
| Missed block | Status flips automatically, no reflection required |
| Realtime updates | Supabase Realtime → TanStack Query invalidation |
| Empty state | Single "Add your first task" CTA → opens quick-add modal |

### Active Block Experience
| Decision | Choice |
|---|---|
| UI | Timer embedded in block card, card expands when active |
| Timer behavior | Counts up from 0:00 |
| Dashboard behavior | Remains fully visible during active block |

### Reflection Prompts
| Decision | Choice |
|---|---|
| Trigger | When student stops timer or block time elapses |
| Presentation | Modal over dashboard |
| Dismissibility | Dismissible |
| Skip tracking | Count consecutive skips — nudge after 3 |
| Nudge | Inline below task list, appears once, dismissed permanently |
| Deep reflection fields | Productivity (1–5), Energy (1–5), Distraction (1–5), % done slider |
| Shallow reflection fields | Checkbox per task in batch |
| Target completion time | Deep: under 30 seconds (4 taps + slider). Shallow: under 10 seconds |

### Task List View
| Decision | Choice |
|---|---|
| Grouping | This Week / Later / No Date |
| Within-group sort | Due date ascending |
| At-risk indicator | Dashboard warning banner when any task is at risk |

### Persistent Banners (rules)
```
Calendar not connected:  show once, dismiss permanently on connect
At-risk tasks:           show when scheduler flags deadline risk
Reflection nudge:        show after 3 consecutive skips, dismiss permanently
Email verify:            not needed at MVP
```

---

## PHASE 4 — PLANNING ALGORITHM

### Objective
Quality-first with deadline floor (hybrid):
- Primary: place work in slots where student does their best work
- Floor: if a task cannot be completed on time with quality-first scheduling,
  switch that task to urgency mode

### Urgency vs Quality
Binary switch per task — not a continuous blend:
```
Quality mode:  default for all tasks
Urgency mode:  activated when deadline feasibility check fails for a specific task

Feasibility check:
  remaining_work_mins > available_slot_mins_before_deadline
  → task enters urgency mode
  → placed in next available slot regardless of quality score
```

### Block Sizing
PROVISIONAL — revisit ceiling after algorithm research.
```
Base:     target_block_mins from learning_profile
Ceiling:  120 minutes (provisional — research suggests 90 min optimal)
Floor:    target_block_mins (never shorter than student's usual session)
Adaptive: extends toward ceiling as urgency_ratio increases
```

urgency_ratio = estimated_mins_remaining / (mins_until_due / 60)

### Hard Constraints (never violated)
```
Max deep work block:          120 min (PROVISIONAL — may reduce to 90)
Max deep blocks per day:      4
Min break between blocks:     15 minutes
No same task consecutive days (spaced practice)
Unavailable before:           users.onboarding_q2_before (hard wall)
Unavailable after:            users.onboarding_q2_after (hard wall)
```

### Shallow Task Scheduling
```
Batch:     up to 3 shallow tasks per block
Cap:       25 minutes per batch
Order:     estimated_mins ASC within batch (quick wins first)
Placement: before first deep block of day ("clear the decks") by default
Overflow:  if batch > 25 min → split into second shallow block next day
Adaptation: if deep productivity scores higher on "shallow after deep" days
            → scheduler shifts shallow window to end of day
            (tracked via shallow_before_deep profile dimension)
```

### Algorithm Phases (inside schedule-generator Edge Function)
```
Phase 1 — Build free slot map
  1. Merge calendar busy slots + existing Rumbo blocks
  2. Strip unavailable_before / unavailable_after (hard constraint)
  3. Score remaining slots 0–1 based on peak_hour_map
  4. Apply stability bonus to slots matching existing block times

Phase 2 — Prioritize tasks
  1. Compute urgency_ratio per task
  2. Run deadline feasibility check per task
  3. Flag tasks that fail feasibility → urgency mode
  4. Determine adaptive block length per task
  5. Determine distribution shape from deadline_strategy:
     front_load | even | ramp

Phase 3 — Greedy placement
  1. Sort: urgency-mode tasks first, then quality-mode by urgency_ratio desc
  2. Place deep blocks before shallow within each day
  3. Fit each block into highest-scored available slot
  4. Enforce: 15 min break, no same-task consecutive days, max 4 deep per day
  5. Write work_blocks rows
  6. Trigger calendar-sync Edge Function
```

### Nightly Reschedule
```
Trigger:    2am UTC cron (Supabase cron)
Scope:      next 7 days for all active users
Approach:   full rebuild with stability constraint
Stability:  slots matching existing block times score higher in slot scoring
            → scheduler prefers keeping blocks in place unless reason to move
Additional triggers: task creation, block completion, reflection save
```

### Warnings
```
Condition:  scheduler cannot fit all tasks before their deadlines
UI:         dashboard warning banner
Banner:     "Some tasks may not be completed before their deadlines."
            Links to task list
No silent failures — always surface when schedule is infeasible
```

### Profile Inputs to Scheduler
```
peak_hour_map         → slot scoring (0–1 per hour)
target_block_mins     → base block size
deadline_strategy     → distribution shape (front_load | even | ramp)
shallow_before_deep   → shallow placement window
unavailable_before    → hard exclusion
unavailable_after     → hard exclusion
day_fragmentation     → used during cold start only, overridden by calendar data
```

---

## PHASE 5 — CALENDAR INTEGRATION

### Connect Flow
```
Desktop:  hotkey or Settings → OAuth opens in system browser via openExternalUrl()
          Redirect URI: rumbo://oauth/callback (custom URI scheme)
          OS captures redirect, passes auth code to Tauri

Web:      Settings → OAuth opens in same tab
          Redirect URI: https://tryrumbo.com/auth/callback

Both:     Student selects which calendars count as busy (checkbox list)
          Selection stored in calendar_connections.calendar_ids
          Token encrypted in Edge Function before writing to DB
```

### Calendar Event Format
```
Title:        [Task Name]  (task name only, no prefix)
Description:  Problem/subtask list if AI-parsed (premium), empty otherwise
Color:        Per-task, consistent across all blocks for same task
              Stored as tasks.calendar_color (assigned at task creation)
              Google: 11 event colors via API, set per-event
              Outlook: categories, mapped from same calendar_color value
Busy status:  Marked as busy
```

### Sync Behavior
```
Read frequency:   Webhook real-time sync
                  Google Calendar webhooks expire after 7 days
                  Daily cron checks and renews expiring webhooks
                  Webhook expiry stored in calendar_connections.webhook_expiry

Write:            Blocks pushed as events after schedule-generator runs
                  Events updated when blocks are rescheduled
                  Events deleted when blocks are removed

Manual moves:     Student drags Rumbo event in Google/Outlook
                  → Detected on sync by comparing calendar event times vs DB
                  → work_blocks row updated to match calendar
                  → Student's manual move is always respected
```

### Token Management
```
Encryption:     Edge Function encrypts access_token + refresh_token
                using secret key stored in Supabase Edge Function secrets

Refresh:        Proactive — check expires_at before every API call
                If expires within 5 minutes → refresh first
                Always make API call with fresh token

Revocation:     401 on refresh token = revoked
                Set calendar_connections.status = 'revoked'
                Show dashboard banner: "Your [Google/Outlook] Calendar
                needs to be reconnected"
                Transient errors: retry once before marking revoked
```

### Edge Functions for Calendar
```
calendar-sync:
  Trigger:    After schedule-generator writes work_blocks
  Does:       Pushes blocks as calendar events (create/update/delete)
              Stores calendar_event_id on each work_block
              Reads busy slots from selected calendars

webhook-renewer: (daily cron)
  Trigger:    Daily at 1am UTC (before nightly reschedule)
  Does:       Checks all active calendar_connections for webhook_expiry
              Re-registers any expiring within 24 hours
```

---

## PHASE 6 — REFLECTION + ADAPTATION LOOP

### Profile Update Trigger
```
Flow:
  Student completes reflection
  → reflection row inserted to deep_reflections or shallow_reflections
  → Supabase DB webhook fires
  → profile-updater Edge Function runs async
  → learning_profile updated
  → reschedule-remaining Edge Function triggered
  → future blocks recalculated

Guarantee: reflection is ALWAYS saved even if profile update fails
           The two operations are decoupled
```

### Update Formula (dynamic weighting)
```typescript
function getWeighting(reflectionCount: number): { recent: number; current: number } {
  if (reflectionCount < 10) return { recent: 0.5, current: 0.5 }   // learn fast
  if (reflectionCount < 30) return { recent: 0.4, current: 0.6 }   // stabilizing
  return { recent: 0.3, current: 0.7 }                              // established
}

// Applied to each profile dimension:
new_score = weighting.recent × latest_reflection_value
          + weighting.current × current_profile_score

// Increment after every deep reflection:
learning_profile.reflection_count += 1
```

### Profile Dimensions Tracked
```
1. peak_hour_map
   Formula: composite score per hour = productivity + energy - distraction
   Updates: after every deep reflection
   Shape:   HourScore[] — one entry per hour 0–23

2. target_block_mins
   Formula: converges toward avg length of highest-scoring sessions
   Updates: after every deep reflection
   Bounds:  never exceeds 120 min ceiling (PROVISIONAL)

3. deadline_strategy
   Formula: inferred from completion_rate at different urgency_ratio values
   Values:  'front_load' | 'even' | 'ramp' | 'unknown'
   Updates: after every deep reflection with sufficient data

4. shallow_before_deep
   Formula: compare avg deep productivity on "shallow first" vs "shallow last" days
   Flips:   after 10+ data points if "shallow last" scores meaningfully higher
   Default: true (shallow before deep)
   Updates: checked after every deep reflection
```

### Student Never Reflects
```
Threshold:    3 consecutive completed blocks with no reflection
Action:       Show gentle inline nudge below task list
Message:      "Reflections help Rumbo learn what works for you
               — they take about 30 seconds."
Placement:    Inline note, not modal, not banner
Frequency:    Appears once, dismissed permanently
Degradation:  Profile stays at seeded defaults — app still works,
              just doesn't adapt
```

### Profile Insights
```
Location:   Dashboard — insights section
Activation: After 10+ deep reflections (stub/placeholder before threshold)
Source:     AI-generated (weekly briefing + reflection pattern analysis)
            See AI expansion roadmap for implementation
Examples:   "You do your best deep work Tuesday and Wednesday mornings."
            "Your Friday sessions consistently score lower — lighter work those days?"
Frequency:  Weekly refresh
MVP state:  Placeholder UI — "Rumbo is learning your patterns.
            Check back after a few sessions."
```

### Edge Functions for Reflection Loop
```
profile-updater:
  Trigger:    DB webhook on deep_reflections INSERT
  Does:       Applies dynamic weighting formula to all 4 profile dimensions
              Increments reflection_count
              Rewrites learning_profile row
              Triggers reschedule-remaining

reschedule-remaining:
  Trigger:    After profile-updater completes
  Does:       Recalculates future blocks using updated profile
              Applies stability constraint (prefer existing times)
              Calls calendar-sync to update pushed events
```

---

## EDGE FUNCTIONS — COMPLETE LIST

| Function | Trigger | Does |
|---|---|---|
| schedule-generator | Task INSERT + nightly cron + reflection completion | Runs scheduling algorithm, writes work_blocks |
| calendar-sync | After schedule-generator | Pushes/updates/deletes calendar events |
| parse-description | Task INSERT with description (premium) | AI extracts subtasks + refined estimate + work_type |
| parse-pdf | PDF upload (premium) | AI extracts problem list, writes task_problems |
| profile-updater | DB webhook on deep_reflections INSERT | Updates learning_profile with dynamic weighting |
| reschedule-remaining | After profile-updater | Recalculates future blocks with updated profile |
| stripe-webhook | Stripe POST | Updates users.tier on subscription events |
| webhook-renewer | Daily cron 1am UTC | Re-registers expiring calendar webhooks |

---

## BUILD ORDER

Build strictly in this order. Do not start a phase until the previous one is stable.

### Phase 1 — Auth + Onboarding
```
[ ] Supabase tables + RLS policies
[ ] DB trigger: create users + learning_profile on auth signup
[ ] Tauri scaffold + global hotkey (tauri-plugin-global-shortcut)
[ ] Two windows in tauri.conf.json (main + quickadd)
[ ] platform.ts — desktop implementations
[ ] Signup screen (email + password + name)
[ ] Login screen
[ ] Supabase auth client wired via platform.ts
[ ] JWT in Tauri secure store
[ ] Protected route guard + session persistence
[ ] Onboarding flow — 4 screens
[ ] Onboarding step written to DB after each transition
[ ] Cold start profile seeded from Q1–Q4 answers
[ ] Calendar connect screen (skippable)
[ ] Google OAuth — rumbo://oauth/callback
[ ] Outlook OAuth — rumbo://oauth/callback
[ ] Dashboard empty state

Checkpoint: app opens, hotkey fires, signup + login work,
            onboarding completes, learning_profile row exists
```

### Phase 2 — Task Capture
```
[ ] Quick-add modal UI
[ ] Hybrid classifier (src/lib/classifier.ts)
[ ] Classifier badge — updates live on keystroke
[ ] Badge click → toggle override
[ ] Date picker integration
[ ] Time estimate field (number + unit)
[ ] Expandable description section
[ ] PDF upload (UI only — AI wired in Phase 4)
[ ] Task written to Supabase on submit
[ ] Modal closes immediately on submit
[ ] Free tier 5-task cap — RLS + UI message
[ ] TanStack Query — tasks query + optimistic update

Checkpoint: modal opens via hotkey, classifier badge updates,
            task row in Supabase, modal closes instantly
```

### Phase 3 — Dashboard + Scheduler (core loop)
```
[ ] schedule-generator Edge Function
    [ ] Phase 1: free slot map from unavailable hours + day_fragmentation
    [ ] Phase 2: urgency_ratio + feasibility check + adaptive block sizing
    [ ] Phase 3: greedy placement, constraint enforcement
    [ ] Writes work_blocks rows
    [ ] Test with 3 hardcoded cases before wiring to DB:
        Task A: 3hrs, due in 2 days
        Task B: 1hr, due tomorrow
        Task C: 5hrs, due in 5 days
[ ] Dashboard — left sidebar navigation
[ ] Today view — ordered block cards
[ ] Block card — task name, time, duration, badge, status
[ ] Start block → timer in card
[ ] Supabase Realtime → TanStack Query invalidation → live updates
[ ] Deep reflection modal (4 fields)
[ ] Shallow reflection modal (checkboxes)
[ ] Reflection written to DB
[ ] Task list view — grouped by This Week / Later / No Date
[ ] At-risk warning banner

Checkpoint: full core loop working — add task → block appears →
            start block → timer runs → reflection captured
```

### Phase 4 — Profile + Calendar
```
[ ] profile-updater Edge Function
    [ ] Dynamic weighting based on reflection_count
    [ ] Updates all 4 profile dimensions
    [ ] Increments reflection_count
[ ] reschedule-remaining Edge Function
[ ] Scheduler updated to read full profile (peak hours + block length)
[ ] Google Calendar API v3 OAuth
[ ] Calendar selection UI (checkbox list during connect)
[ ] calendar-sync Edge Function
    [ ] Push blocks as events with task name + color
    [ ] Update events on reschedule
    [ ] Delete events on removal
[ ] Busy slots pulled into scheduler
[ ] Webhook registration for real-time calendar reads
[ ] webhook-renewer daily cron
[ ] Manual move detection — sync calendar → update work_blocks

Checkpoint: learning_profile updates after reflection,
            future blocks reschedule, blocks appear in Google Calendar
```

### Phase 5 — Premium + AI
```
[ ] Stripe Checkout integration
[ ] stripe-webhook Edge Function (3 events)
[ ] RLS policies for premium features
[ ] Upgrade prompt UI (calm, non-aggressive)
[ ] parse-description Edge Function (AI)
[ ] parse-pdf Edge Function (AI)
[ ] Premium UI gates (description AI, PDF upload)
[ ] Outlook calendar sync (Microsoft Graph API)
[ ] calendar_color assignment at task creation
[ ] Subtask list in calendar event descriptions (premium)

Checkpoint: Stripe checkout works, users.tier updates,
            AI parses description and PDF, Outlook sync works
```

### Phase 6 — Polish + Launch
```
[ ] Nightly reschedule cron (2am UTC)
[ ] Scheduler warning banner wired
[ ] Reflection nudge (3 consecutive skips)
[ ] Profile insights placeholder in dashboard
[ ] Error states — network offline, failed writes
[ ] Loading skeletons on dashboard
[ ] Tauri build: npm run tauri build
[ ] Test .dmg on Mac — all flows work
[ ] Code sign Mac build (Apple Developer account)
[ ] Auto-update: tauri-plugin-updater configured
[ ] GitHub releases — update server JSON
[ ] Windows .msi build tested
[ ] tryrumbo.com — swap waitlist form for download button
[ ] Waitlist email sent

Checkpoint: .dmg installs and runs cleanly on Mac,
            first external users installed and used the app
```

---

## DECISIONS STILL OPEN (research required)

| Decision | Status | Notes |
|---|---|---|
| Deep work block ceiling | PROVISIONAL — currently 120 min | Research suggests 90 min optimal. Decide before writing scheduler. |
| Adaptive block sizing formula | Needs design | How exactly does urgency_ratio map to block length increase? Define the curve. |
| Insights activation threshold | Set at 10 deep reflections | Adjust based on early user data |
| shallow_before_deep flip threshold | "Meaningfully higher" undefined | Define the delta (e.g. > 0.5 point difference) before implementing |
| Stripe price | $6.99/month | Validate with early users before locking |

---

## NEVER DO THESE

```
[ ] Import from @tauri-apps inside packages/ui or any shared component
[ ] Check Stripe subscription status in app code — use users.tier only
[ ] Store OAuth tokens unencrypted
[ ] Call AI APIs from the client — always goes through Edge Functions
[ ] Skip RLS on any table for any reason
[ ] Make the OAuth flow a hard requirement in onboarding
[ ] Permanently delete reflection data
[ ] Show the student the raw profile scores or weighting formulas
[ ] Schedule blocks during unavailable_before / unavailable_after windows
[ ] Silently fail when the scheduler can't fit everything
[ ] Wait for AI or scheduler before closing the quick-add modal
[ ] Run the scheduler without testing the 3 hardcoded cases first
```

---

*Generated from complete architecture review — all decisions made before implementation.*
*Feed into repo as RUMBO_BUILD_REFERENCE.md*
*Last updated: Phase planning complete, tech stack locked.*