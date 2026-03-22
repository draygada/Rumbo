# Rumbo — full product specification

## What Rumbo is
A desktop-only productivity app for college students with attentional learning differences.
It breaks tasks into adaptive work blocks (shallow and deep) and embeds them directly into
the student's existing calendar. It is NOT a calendar — it is a workflow layer on top of
the calendars students already use.

---

## Core interaction model
- A floating desktop widget (Mac + Windows) hidden until a global hotkey is pressed
- Hotkey opens a quick-add modal for task input
- A separate main dashboard window for managing tasks, viewing blocks, and reviewing reflections
- Both windows are managed by Tauri 2 — the quick-add modal is always-on-top, dismisses on Esc or outside click

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (Rust core) |
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS + shadcn/ui |
| Local state | Zustand |
| Server state | TanStack Query |
| Local cache | SQLite via Tauri |
| Database | Supabase Postgres |
| Auth | Supabase Auth (email + password) |
| Realtime | Supabase Realtime |
| File storage | Supabase Storage |
| Backend logic | Supabase Edge Functions (Deno / TypeScript) |
| AI | Anthropic Claude Haiku — premium PDF parsing only |
| Calendar | Google Calendar API v3 + Microsoft Graph API |
| Billing | Stripe ($6.99/mo premium tier) |

---

## Two tiers

### Free tier
- Up to 5 tasks
- Basic block scheduling (algorithm only, no PDF)
- Reflection logging (productivity, energy, distraction, % done)
- No AI calls

### Premium tier ($6.99/month)
- Unlimited tasks
- PDF / instruction upload → AI parses problems once, cached forever
- Per-session problem slice recommendations
- Microsoft Outlook calendar sync (Google available on both tiers)
- All free features

---

## Database tables

| Table | Purpose |
|---|---|
| `users` | Auth identity, tier, calendar provider, Stripe IDs |
| `tasks` | All student tasks with classification metadata |
| `work_blocks` | Scheduled blocks with slot scores and calendar event IDs |
| `task_problems` | AI-extracted problem list from PDFs (premium, cached) |
| `shallow_batches` | Groups of shallow tasks assigned to one block |
| `learning_profile` | Adaptive user profile built from reflections |
| `reflections` (deep) | Post-block scores: productivity, energy, distraction, % done |
| `reflections` (shallow) | Per-task completion: yes/no per task in batch |
| `ai_schedules` | Log of AI-generated schedules with model version |

RLS is enabled on ALL tables. Users can only read/write rows where `user_id = auth.uid()`.
OAuth tokens stored encrypted via pgsodium.

---

## TypeScript types
All interfaces are defined in `types.ts`. Key types:
- `User` — tier, calendar_provider, stripe IDs
- `Task` — work_type, classifier_confidence, urgency_ratio, user_overrode_classifier
- `WorkBlock` — slot_score, scheduled_by, assigned_problem_ids, calendar_event_id
- `LearningProfile` — peak_hour_map (HourScore[]), target_block_mins, deadline_strategy, shallow_before_deep
- `DeepReflection` — productivity, energy, distraction (1–5), completion_rate, task_progress_delta
- `ShallowReflection` — task_completions: Record<task_id, boolean>
- `SchedulerInput` / `SchedulerOutput` / `SchedulerWarning`
- `ClassifierResult` — work_type, confidence, shallow_score, deep_score, matched_keywords
- `ProfileUpdateInput` — passed to profile-updater edge function after every deep reflection
- `StripeWebhookPayload` — updates users.tier on checkout / cancellation

---

## Supabase Edge Functions

| Function | Trigger | What it does |
|---|---|---|
| `schedule-generator` | On task creation + nightly cron | Runs scheduling algorithm, writes work_blocks |
| `calendar-sync` | After schedule-generator | Pushes blocks to Google / Outlook, stores calendar_event_id |
| `parse-pdf` | On PDF upload (premium only) | Calls Haiku once, writes task_problems, never called again for same task |
| `profile-updater` | DB webhook after deep reflection saved | Weighted rolling average, rewrites learning_profile |
| `reschedule-remaining` | After profile-updater | Recalculates future blocks using % done from reflection |

---

## Scheduling algorithm (runs inside schedule-generator)

### Three phases:

**Phase 1 — build free-slot map**
1. Merge calendar busy slots + existing Rumbo blocks
2. Strip student's unavailable hours (hard constraint from onboarding)
3. Score remaining slots 0–1 based on peak_hour_map match in learning_profile

**Phase 2 — prioritize tasks**
1. Compute urgency_ratio = estimated_mins_remaining / (mins_until_due / 60)
2. Determine distribution shape from profile: front_load | even | ramp
3. Apply deadline proximity modifier to target block length

**Phase 3 — greedy placement**
1. Sort tasks by urgency_ratio descending
2. Deep work blocks placed before shallow within each day
3. Fit each task's block into highest-scored available slot
4. Enforce: 15 min minimum break, no same-task on back-to-back days

### Research constraints (hard bounds, never violated):
- Max deep work block: 90 minutes
- Max deep blocks per day: 4
- Min break between blocks: 15 minutes
- No same task scheduled on consecutive days (spaced practice)

### Profile inputs to scheduler:
- `peak_hour_map` → slot scoring
- `target_block_mins` → block sizing
- `deadline_strategy` → distribution shape
- `shallow_before_deep` → shallow placement window
- `unavailable_before` / `unavailable_after` → hard exclusion

---

## Hybrid task classifier (runs client-side, no API call)

### Shallow work keywords (+1.0 each):
email, reply, respond, submit, upload, schedule, read, review,
canvas, lms, form, admin, message, notes, slides, plan, print,
confirm, check, watch

### Deep work keywords (+1.0 each):
problem set, pset, essay, write, code, build, design, analyze,
study, exam, lab, report, project, research, derive, prove,
implement, debug, calculate, draft

### Confidence formula:
```
confidence = max(shallow_score, deep_score) / (shallow_score + deep_score + 1)
```

### Outcomes:
- ≥ 0.75 → auto-classify, show badge with override link
- 0.4–0.75 → ask student: "Deep or shallow work?"
- < 0.4 → default to deep, student can override

### Edge case:
Readings classified shallow BUT if estimated_mins > 45 → promote to deep block treatment

---

## Shallow block scheduling rules
- Default: schedule shallow blocks in 30–60 min window BEFORE first deep block of day ("clear the decks")
- Batch multiple shallow tasks into one 25-minute block (max 3 tasks per block)
- Sort tasks within batch by estimated_mins ASC (quick wins first)
- Overflow rule: if batched tasks exceed 25 min → split into second shallow block next day
- Profile adaptation: if deep block productivity scores are higher on days shallow was done AFTER deep → scheduler shifts shallow window to end of day

---

## Profile scoring system

### Dimensions tracked per deep block (1–5 scale):
- `productivity` — focus quality
- `energy` — mental freshness
- `distraction` — inverse scored (5 = not distracted = good)
- `completion_rate` — 0–1, % of planned work done

### Update formula (weighted rolling average):
```
new_score = 0.3 × latest_reflection + 0.7 × current_profile_score
```

### Three derived profile dimensions updated after each reflection:
1. `peak_hour_map` — composite score per hour-of-day (productivity + energy - distraction)
2. `target_block_mins` — converges toward avg length of highest-scoring sessions
3. `deadline_strategy` — inferred from completion rates at different distances from deadlines

### Cold start (no reflections yet):
- peak_hour_map seeded from onboarding Q1 (morning / afternoon / night)
- target_block_mins seeded from onboarding Q3 answer
- unavailable_before / unavailable_after set from onboarding Q2
- deadline_strategy = 'unknown' → defaults to 'even' distribution

---

## Onboarding flow (4 steps, target < 4 minutes)

**Step 1 — create account**
Email + password + optional name/university → Supabase Auth → profile seeded with research defaults

**Step 2 — see Rumbo in action (no input)**
Animated sample schedule showing shallow + deep blocks in a real calendar
Callouts explain: "deep work in peak hours", "shallow tasks cleared before focus time"
Single CTA: "Build my schedule"

**Step 3 — 3 questions only**
- Q1: When do you usually work? (Morning / Afternoon / Night owl) → seeds peak_hour_map
- Q2: Unavailable hours picker ("never before __ / never after __") → hard constraint
- Q3: "How long do you usually study for at one time?" (< 30 min / 30–45 / 45–60 / 60–90) → seeds target_block_mins

**Step 4 — connect calendar + add first tasks**
- Google or Outlook OAuth (skippable, can do later)
- Quick-add modal opens → student adds up to 5 tasks
- schedule-generator runs immediately
- Student sees their first real schedule

---

## AI usage — exactly one call per PDF upload

The ONLY place Rumbo calls an AI API is parse-pdf (premium tier).
Everything else — classification, scheduling, profile updates, rescheduling — is deterministic TypeScript.

AI call details:
- Model: Claude Haiku (cheapest, sufficient for structured extraction)
- Input: PDF text + prompt to extract ordered problem list with time estimates
- Output: TaskProblem[] stored in task_problems table
- Called: once per PDF, result cached forever
- Never called again for the same task

---

## Billing (Stripe)

- $6.99/month subscription
- Stripe Checkout handles payment UI (no custom payment form needed)
- Webhook events handled in a Supabase Edge Function:
  - `checkout.session.completed` → set users.tier = 'premium'
  - `customer.subscription.deleted` → set users.tier = 'free'
  - `invoice.payment_failed` → set users.tier = 'free'
- RLS policies gate premium features at the database level
- users.tier is the single source of truth — never check subscription status in app code

---

## Cost model (500 free + 200 premium users)

| Cost | Amount |
|---|---|
| AI (PDF parsing only, ~10 uploads/user/month) | ~$28/mo |
| Supabase Pro | $25/mo |
| Total infra | ~$53/mo |
| Revenue (200 × $6.99) | $1,398/mo |
| Gross margin | ~96% |

---

## Build order (phased)

1. **Phase 1 (wk 1–2):** Supabase tables + RLS, Tauri scaffold + hotkey, auth flow
2. **Phase 2 (wk 3–5):** Task creation + classifier, scheduling algorithm (hardcoded defaults first), dashboard + reflection
3. **Phase 3 (wk 6–8):** Profile scoring, Google Calendar sync, nightly refresh cron
4. **Phase 4 (wk 9–11):** Stripe billing, PDF parsing + problem slicing, Outlook sync
5. **Phase 5 (wk 12):** Onboarding flow, error states, Tauri packaging + code signing
