# Rumbo — 2 month roadmap
# 15 hrs/week · solo · website first

---

## MONTH 1 — foundation

### Week 1 — website live (15 hrs, website only)
Goal: tryrumbo.com collecting emails

Website (15 hrs):
- Day 1–2: v0.dev — generate + iterate landing page
- Day 3: pull into Next.js repo
- Day 4: waitlist table in Supabase + /api/waitlist route
- Day 5: deploy to tryrumbo.com, test end to end

App (0 hrs): read Tauri 2 docs, set up dev environment

Checkpoint:
- [ ] tryrumbo.com live with new design
- [ ] Email input submits and lands in Supabase waitlist table
- [ ] Looks good on mobile

---

### Week 2 — app skeleton (15 hrs)
Goal: app opens, hotkey fires, auth works

Website (2 hrs): mobile fixes + copy tweaks from feedback only
App (13 hrs):
- tauri init + React/TS + Vite
- Two windows in tauri.conf.json (main + quickadd)
- Global hotkey: Cmd+Shift+Space / Ctrl+Shift+Space
- Signup + login screens
- Supabase auth client wired
- JWT in Tauri secure store (tauri-plugin-store)
- Protected route guard + session persistence

Checkpoint:
- [ ] App launches
- [ ] Hotkey toggles modal
- [ ] Signup + login work
- [ ] Session persists on reopen

---

### Week 3 — task creation + classifier (15 hrs)
Goal: student can add a task, classifier works

Website (0 hrs): share build progress on social, link to waitlist
App (15 hrs):
- Quick-add modal UI (title, due date, estimated time)
- Hybrid classifier in src/lib/classifier.ts
  - Keyword scoring → ClassifierResult type
  - Confidence formula (see RUMBO_SPEC.md)
  - Work type badge updates on title change
  - Override toggle (deep ↔ shallow)
- Task written to Supabase on submit
- 5 task cap enforced on free tier

Checkpoint:
- [ ] Modal opens via hotkey
- [ ] Classifier badge updates as student types
- [ ] Override toggle works
- [ ] Task row in Supabase tasks table

---

### Week 4 — scheduling algorithm (15 hrs)
Goal: blocks appear after task creation

Website (0 hrs): no changes
App (15 hrs):
- Onboarding flow (3 questions → seeds learning_profile)
- schedule-generator Edge Function:
  - Phase 1: free-slot map from unavailable hours
  - Phase 2: urgency ratio + even distribution default
  - Phase 3: greedy placement, 15 min break enforcement
  - Triggers on tasks INSERT via DB webhook
- Basic dashboard — list today's blocks

⚠ Build 3 hardcoded test cases before writing the edge function:
  Task A: 3 hrs, due in 2 days
  Task B: 1 hr, due tomorrow
  Task C: 5 hrs, due in 5 days
Verify output manually before wiring to DB.

Checkpoint:
- [ ] Onboarding 3 questions complete
- [ ] learning_profile row seeded
- [ ] work_blocks rows appear after task creation
- [ ] Dashboard lists today's blocks

---

## MONTH 2 — intelligence + launch

### Week 5 — reflection loop (15 hrs)
Goal: full core loop working end to end

Website (0 hrs): no changes
App (15 hrs):
- Active block view — click to start, timer counts up
- Block status flips to 'active' in DB
- Deep reflection prompt:
  Productivity (1–5) · Energy (1–5) · Distraction (1–5) · % done slider
- Shallow reflection prompt:
  Checkbox per task in batch
- Reflections written to DB
- Supabase Realtime — dashboard updates without refresh

Checkpoint:
- [ ] Starting a block starts a timer
- [ ] Reflection prompt fires when block ends
- [ ] Scores in Supabase reflections table
- [ ] Dashboard updates in realtime

---

### Week 6 — profile scoring + Google Calendar (15 hrs)
Goal: schedule adapts + blocks appear in Google Calendar

Website (0 hrs): no changes
App (15 hrs):
- profile-updater Edge Function:
  - DB webhook on reflections INSERT
  - new_score = 0.3 × latest + 0.7 × current
  - Updates peak_hour_map + target_block_mins
- reschedule-remaining Edge Function:
  - Recalculates future blocks using % done
  - Deletes stale blocks, re-runs scheduler
- Scheduler updated to read profile (peak hours + block length)
- calendar-sync Edge Function:
  - Google Calendar API v3 OAuth
  - Blocks pushed as events
  - Busy slots pulled back into scheduler

Checkpoint:
- [ ] learning_profile updates after reflection
- [ ] Future blocks reschedule after low % done
- [ ] Google Calendar connect works
- [ ] Blocks appear in Google Calendar

---

### Week 7 — nightly refresh + Tauri build (15 hrs)
Goal: installable .dmg, schedule refreshes nightly

Website (3 hrs):
- Add Mac + Windows platform badges to hero
- "Coming soon" → "Early access" copy update
- Build anticipation — launch is one week away

App (12 hrs):
- Nightly refresh cron (Supabase cron at 2am UTC)
  Reschedules next 7 days for all active users
- Scheduler warning UI (deadline at risk toasts)
- Error states — network offline, failed writes
- Loading skeletons on dashboard
- Tauri build: npm run tauri build
- Test .dmg on Mac — install + verify all flows

Checkpoint:
- [ ] Nightly cron running
- [ ] Warning toasts show for tight deadlines
- [ ] .dmg installs and runs cleanly on Mac
- [ ] All week 1–6 features work in the built app

---

### Week 8 — polish + early access launch (15 hrs)
Goal: ship to waitlist

Website (6 hrs):
- Swap waitlist form → download button (links to .dmg)
- Add real app screenshots to hero
- Write + send waitlist email announcing early access

App (9 hrs):
- Windows .msi build tested (VM or second machine)
- Onboarding sample schedule animation
- Final bug fixes from build testing
- Code sign Mac build (requires Apple Developer account)

Checkpoint:
- [ ] Download button on tryrumbo.com works
- [ ] Waitlist email sent
- [ ] First external users have installed and used the app
- [ ] Mac + Windows both installable

---

## Month 3+ (post early access — in priority order)
1. Gather feedback from first users — fix what's broken
2. Stripe + premium tier ($6.99/mo)
3. AI description parsing (premium)
4. PDF upload + parsing (premium)
5. Outlook sync
6. Upgrade flow UI
7. User profile insights dashboard
8. Referral / sharing mechanism

---

## Weekly Claude Code session template
Start every session with:
```
Continuing Rumbo — week [N], working on [specific task].
Spec: [paste RUMBO_SPEC.md]
Types: [paste types.ts]
Current code: [paste relevant file]
Task: [one specific thing]
```

One task per session. Always verify scheduler/RLS/profile-updater
output against the spec before moving on.

---

## Buffer rules
- Scheduler runs long → push reflection loop from week 4 to week 5, 
  compress week 5 + 6 together
- Calendar sync too complex → make it optional, ship without it,
  add in month 3
- Windows build breaks → ship Mac only for early access,
  fix Windows post-launch
- Never compromise on RLS — get it right even if it costs 2 extra days

