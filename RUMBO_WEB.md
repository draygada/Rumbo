# Rumbo Web — build spec & scaffold guide

## What this is
The web companion to Rumbo desktop. Same core product — task input, scheduling algorithm,
calendar embedding, reflection loop — delivered as a browser app.

Built first. Desktop extends it later. The two live in separate repos right now.
When desktop becomes active again, components lift into a shared monorepo cleanly.

---

## What the web version is NOT
- Not a calendar. A workflow layer on top of the student's existing calendar.
- Not a replacement for the desktop app. Desktop adds the global hotkey, system tray,
  and always-on widget. Web is the full product without those OS-level features.
- No Cmd+K shortcut. Task input is a visible Add Task button. The hotkey is desktop-only.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React 18 + TypeScript |
| Routing | React Router v6 |
| Styling | CSS Modules |
| Components | shadcn/ui (accessible primitives only — date picker, combobox, select, modal) |
| State | Zustand (local) + TanStack Query (server state) |
| Auth | Supabase Auth |
| Database | Supabase Postgres + RLS |
| Server logic | Supabase Edge Functions (Deno / TypeScript) |
| File storage | Supabase Storage |
| AI | Anthropic Claude Haiku (Edge Functions only, premium) |
| Calendar | Google Calendar API v3 + Microsoft Graph API (Edge Functions only) |
| Billing | Stripe ($6.99/mo) |
| Deployment | Vercel |

---

## Environment variables

`.env.local` — never commit this file. Add to `.gitignore` immediately.

```
# Safe to expose — identified by VITE_ prefix, bundled into client
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key

# Never expose — no VITE_ prefix, Edge Functions only
SUPABASE_SERVICE_ROLE_KEY=never-in-frontend
ANTHROPIC_API_KEY=never-in-frontend
STRIPE_SECRET_KEY=never-in-frontend
GOOGLE_CLIENT_SECRET=never-in-frontend
MICROSOFT_CLIENT_SECRET=never-in-frontend
```

Mirror all variables in Vercel dashboard under Project → Settings → Environment Variables.

---

## Security rules (never break these)

1. RLS is enabled on every Supabase table. Users can only read/write `user_id = auth.uid()`.
2. The Supabase service role key never touches the frontend. Edge Functions only.
3. All AI calls happen inside Edge Functions. The Anthropic API key never reaches the browser.
4. All calendar OAuth secrets live in Edge Function environment variables.
5. Stripe secret key lives in Edge Functions only. Frontend only uses Stripe's public key.
6. `VITE_` prefix = visible to anyone. Only anon key and Supabase URL get this prefix.

---

## Repo structure

```
rumbo-web/
├── public/
├── src/
│   ├── components/          # Shared UI components
│   │   ├── Sidebar/
│   │   │   ├── Sidebar.tsx
│   │   │   └── Sidebar.module.css
│   │   ├── TaskCard/
│   │   │   ├── TaskCard.tsx
│   │   │   └── TaskCard.module.css
│   │   └── ClassifierBadge/
│   │       ├── ClassifierBadge.tsx
│   │       └── ClassifierBadge.module.css
│   ├── pages/               # One folder per route
│   │   ├── SignIn/
│   │   │   ├── SignIn.tsx
│   │   │   └── SignIn.module.css
│   │   ├── SignUp/
│   │   │   ├── SignUp.tsx
│   │   │   └── SignUp.module.css
│   │   ├── Onboarding/
│   │   │   ├── Onboarding.tsx
│   │   │   └── Onboarding.module.css
│   │   ├── Dashboard/
│   │   │   ├── Dashboard.tsx
│   │   │   └── Dashboard.module.css
│   │   ├── Settings/
│   │   │   ├── Settings.tsx
│   │   │   └── Settings.module.css
│   │   ├── Account/
│   │   │   ├── Account.tsx
│   │   │   └── Account.module.css
│   │   └── AddTask/
│   │       ├── AddTask.tsx
│   │       └── AddTask.module.css
│   ├── lib/
│   │   ├── supabase.ts      # Supabase client (singleton)
│   │   ├── classifier.ts    # Hybrid keyword classifier (client-side, no API)
│   │   └── platform.ts      # Platform abstraction layer (web implementation)
│   ├── hooks/
│   │   ├── useAuth.ts       # Auth state, signin, signup, signout
│   │   └── useTasks.ts      # TanStack Query hooks for tasks
│   ├── types/
│   │   └── index.ts         # All TypeScript interfaces (from RUMBO_SPEC.md)
│   ├── router/
│   │   └── index.tsx        # React Router config + route guards
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css            # Global reset only — no component styles here
├── .env.local               # Never commit
├── .gitignore
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Routes

| Route | Access | Description |
|---|---|---|
| `/signin` | Public only | Returning users. No forgot password yet. |
| `/signup` | Public only | New users. Username, password, confirm password. |
| `/onboarding` | Auth + not onboarded | Forced after signup. 4 stages. |
| `/dashboard` | Auth + onboarded | Default view. Sidebar + task list. |
| `/settings` | Auth + onboarded | Scheduling preferences, calendar connect. |
| `/account` | Auth + onboarded | Tier, upgrade, sign out. |
| `/add-task` | Auth + onboarded | Full page. Sidebar hidden. Total focus. |

### Route guard logic (in `router/index.tsx`)
```
Signed out → redirect to /signin
Signed in + no onboarding completed → redirect to /onboarding
Signed in + onboarded → full app access
Public routes (signin, signup) → redirect to /dashboard if already signed in
```

---

## Pages

### `/signin`
- Email + password fields
- Submit → Supabase Auth signInWithPassword
- No forgot password (add later)
- Link to /signup

### `/signup`
- Username, password, confirm password
- Password confirm validated client-side before submit
- Submit → Supabase Auth signUp
- On success → redirect to /onboarding
- Link to /signin

### `/onboarding`
4 stages. Progress indicator at top. Cannot skip stages 1, 2, 4. Stage 3 (calendar) is skippable.
On completion → write onboarding_completed: true to users table → redirect to /dashboard.

**Stage 1 — Worker type**
Four options displayed as selectable cards. One must be chosen to proceed.

| Option | Peak hours seeded |
|---|---|
| Early Bird | 5am – 9am |
| Morning | 9am – 12pm |
| Afternoon | 12pm – 7pm |
| Night Owl | 7pm – 12am |

Writes to `learning_profile.peak_hour_map` as initial seed.
Rumbo learns actual patterns from calendar data and reflections over time.
This is a cold start only — it gets overwritten.

**Stage 2 — Unavailable hours**
Two time pickers: "I never work before __" and "I never work after __"
Writes to `learning_profile.unavailable_before` and `learning_profile.unavailable_after`.
Hard constraints — scheduler never places blocks outside this window.

**Stage 3 — Calendar connect (skippable)**
Two options: Google Calendar or Microsoft Outlook.
Show "Highly recommended" label clearly.
Skip link visible but not prominent.
OAuth handled via Supabase Edge Function.
If skipped, scheduling works on unavailable hours alone until connected.

**Stage 4 — What they study**
Searchable combobox (shadcn/ui Combobox component).
User types → filters dropdown options.
If no match → free text accepted as-is.
Stored in `users.field_of_study`.
Used for personalisation copy. Does not affect scheduling algorithm directly.

---

### `/dashboard`
Layout: sidebar left (200px fixed), main content right (flex: 1).

**Sidebar contains:**
- Rumbo logo + wordmark
- Nav links: Tasks (default), Settings, Account
- Active route highlighted
- User name + avatar at bottom

**Main content — Tasks view (default):**
- Page title + today's date
- Add Task button — prominent, top right
- Task list grouped: Scheduled today / Upcoming
- Each task card shows: name, deep/shallow badge, due date, estimated time
- Empty state if no tasks yet

**Main content switches** when sidebar nav is clicked:
- Tasks → task list
- Settings → settings page content
- Account → account page content

Sidebar always visible on dashboard, settings, account.
Sidebar hidden on `/add-task`.

---

### `/add-task`
Full page. No sidebar. Student's full attention.

Back link at top left → returns to /dashboard.

**Fields:**
1. Task name (required)
   - Classifier fires after 3 seconds of no keydown (debounce)
   - Shows Deep / Shallow badge on the input
   - Badge is clickable to toggle override
   - Classifier is client-side, no API call, instant

2. Due date (required)
   - Date picker (shadcn/ui DatePicker)

3. Estimated time (required)
   - Select dropdown: 15 min / 30 min / 45 min / 1 hour / 1.5 hours / 2 hours / 3+ hours

4. Description (premium only)
   - Textarea, disabled + locked on free tier
   - Premium label shown
   - AI extracts subtasks + refines time estimate asynchronously on submit

5. PDF upload (premium only)
   - File input, disabled + locked on free tier
   - Premium label shown
   - AI parses problem list once, cached forever

**On submit:**
- Task written to DB immediately (don't wait for AI)
- If premium + description → parse-description Edge Function called async
- If premium + PDF → parse-pdf Edge Function called async after description parse
- schedule-generator runs after task written
- Redirect to /dashboard

---

### `/settings`
Inside dashboard layout (sidebar visible).

Sections:
- Work hours — unavailable before / after (editable, updates learning_profile)
- Calendar — connection status, connect / disconnect
- Peak hours — current worker type setting (editable)

---

### `/account`
Inside dashboard layout (sidebar visible).

Sections:
- User info — name, email, avatar initials
- Tier — free (X of 5 tasks used) or premium
- Upgrade button → Stripe Checkout (premium only)
- Sign out

---

## Classifier (client-side, no API call)

Lives in `src/lib/classifier.ts`. Runs entirely in the browser.

```typescript
const SHALLOW_KEYWORDS = [
  'email','reply','respond','submit','upload','schedule','read','review',
  'canvas','lms','form','admin','message','notes','slides','plan','print',
  'confirm','check','watch'
]

const DEEP_KEYWORDS = [
  'problem set','pset','essay','write','code','build','design','analyze',
  'study','exam','lab','report','project','research','derive','prove',
  'implement','debug','calculate','draft'
]

// confidence = max(shallow, deep) / (shallow + deep + 1)
// >= 0.75 → auto-classify, show badge
// 0.4–0.75 → show badge, lower confidence
// < 0.4 → default deep, show badge

// Title only — does not use estimated time, due date, or other fields
```

Fires on title input (no debounce in current web build).
Result displayed as a small badge on the title field.
Student can click badge to toggle deep ↔ shallow (sets user_overrode_classifier = true).

---

## platform.ts (web implementation)

```typescript
// src/lib/platform.ts
// Web implementations only. Desktop swaps these out when Tauri is added.

export const storeToken = (key: string, value: string) =>
  localStorage.setItem(key, value)

export const getToken = (key: string) =>
  localStorage.getItem(key)

export const removeToken = (key: string) =>
  localStorage.removeItem(key)

export const openExternalUrl = (url: string) =>
  window.open(url, '_blank', 'noopener,noreferrer')

export const closeWindow = () =>
  window.close()

export const onWindowBlur = (callback: () => void) => {
  window.addEventListener('blur', callback)
  return () => window.removeEventListener('blur', callback)
}
```

Note: Supabase manages its own session in localStorage automatically.
You may not need storeToken / getToken directly — Supabase handles auth persistence.
The abstraction exists so desktop can swap to Tauri secure store without touching components.

---

## Supabase Edge Functions (unchanged from RUMBO_SPEC.md)

| Function | Trigger | What it does |
|---|---|---|
| `schedule-generator` | Task INSERT + nightly cron | Runs scheduling algorithm, writes work_blocks |
| `calendar-sync` | After schedule-generator | Pushes blocks to Google / Outlook |
| `parse-description` | Task INSERT with description (premium) | AI extracts subtasks + refined estimate |
| `parse-pdf` | PDF upload (premium) | AI parses problem list, writes task_problems |
| `profile-updater` | DB webhook after deep reflection | Weighted rolling average, updates learning_profile |
| `reschedule-remaining` | After profile-updater | Recalculates future blocks using % done |

---

## Build order

### Phase 1 — scaffold + auth (start here)
- [ ] Vite + React + TypeScript project init
- [ ] React Router v6 wired
- [ ] Supabase client in `src/lib/supabase.ts`
- [ ] `/signin` page — Supabase signInWithPassword
- [ ] `/signup` page — Supabase signUp
- [ ] Route guards in `router/index.tsx`
- [ ] `.env.local` with Supabase URL + anon key
- [ ] `.gitignore` includes `.env.local`

### Phase 2 — onboarding
- [ ] `/onboarding` — 4 stage flow
- [ ] Stage 1: worker type cards
- [ ] Stage 2: unavailable hours pickers
- [ ] Stage 3: calendar connect (Google + Outlook OAuth, skippable)
- [ ] Stage 4: field of study combobox
- [ ] On complete: write to users + learning_profile, redirect to /dashboard

### Phase 3 — dashboard + task list
- [ ] Dashboard layout — sidebar + main content
- [ ] Sidebar nav with active route highlighting
- [ ] Task list — today + upcoming groups
- [ ] Task card component
- [ ] Empty state
- [ ] Settings page (stub — editable later)
- [ ] Account page — tier, sign out

### Phase 4 — add task + classifier
- [ ] `/add-task` containing sidebar
- [ ] All form fields
- [ ] Classifier in `src/lib/classifier.ts`
- [ ] 0 second debounce on title input
- [ ] Badge display + toggle override
- [ ] Premium field lock UI (description + PDF)
- [ ] Submit → write task to Supabase

### Phase 5 — scheduling + calendar
- [ ] `schedule-generator` Edge Function
- [ ] `calendar-sync` Edge Function
- [ ] Google Calendar OAuth flow
- [ ] Blocks appear in task list after task creation
- [ ] Nightly refresh cron

### Phase 6 — reflection loop + profile
- [ ] Active block view + timer
- [ ] Deep reflection prompt
- [ ] Shallow reflection prompt
- [ ] `profile-updater` Edge Function
- [ ] `reschedule-remaining` Edge Function

### Phase 7 — premium + AI
- [ ] Stripe Checkout integration
- [ ] `parse-description` Edge Function
- [ ] `parse-pdf` Edge Function
- [ ] Upgrade flow UI

---

## Claude Code session template

Start every session with:
```
Continuing Rumbo Web — working on [specific page or feature].
Spec: [paste RUMBO_WEB.md]
Types: [paste src/types/index.ts]
Current file: [paste the file you're working on]
Task: [one specific thing]
```

One task per session.
Always verify RLS policies before moving on from any database work.
Never put secrets in frontend code — if you're not sure, it goes in an Edge Function.