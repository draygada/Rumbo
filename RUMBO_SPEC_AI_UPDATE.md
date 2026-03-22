# AI usage — updated (replaces previous section in RUMBO_SPEC.md)

## Full set of AI calls (both premium only, both cached)

### 1. Description / instruction parsing
- **Trigger:** task saved with a non-empty description field (premium only)
- **Model:** Claude Haiku
- **Input:** task title + pasted description or instructions
- **Output:** `DescriptionParseResult` — stored in `tasks` table, never re-run for same content
- **Extracts:**
  - Refined time estimate (overwrites student's manual estimate if more accurate)
  - Improved work_type confidence (supplements keyword classifier — AI reads full context)
  - Subtasks / sections as an ordered list (stored as `TaskSubtask[]` in `task_subtasks` table)
- **Free tier:** description field exists in UI but AI parsing is gated — raw text saved, no extraction
- **Caching:** hashed on (task_id + description content) — re-runs only if description changes

### 2. PDF parsing
- **Trigger:** PDF uploaded to task (premium only)
- **Model:** Claude Haiku
- **Input:** extracted PDF text
- **Output:** `TaskProblem[]` stored in `task_problems` table
- **Called:** once per PDF, cached forever
- **Note:** if BOTH description and PDF are provided, PDF parse takes precedence for problem list

---

## How description parsing interacts with the classifier

The hybrid classifier (keyword rules, client-side) always runs first — instant, no network call.
When a description is present and the user is premium, the AI parse result can:
1. Override `work_type` if AI confidence > keyword confidence
2. Override `estimated_mins` if AI estimate differs by more than 20%
3. Add `task_subtasks` rows that the scheduler uses like a lightweight problem list

For free tier users with a description, the keyword classifier is the only signal.
The description text is stored raw and available if they upgrade.

---

## Updated task creation flow

```
Student opens quick-add modal
  ↓
Fills in title → keyword classifier fires instantly (client-side)
  ↓
[Optional] pastes description or instructions
  ↓
Submits task
  ↓
Task written to DB immediately (don't wait for AI)
  ↓
[If premium + description present]
  → parse-description edge function called async
  → AI extracts: refined estimate + work_type signal + subtasks
  → DB updated with results
  → TanStack Query invalidates task → UI updates silently
  ↓
[If premium + PDF attached]
  → parse-pdf edge function called async after description parse
  → problem list written to task_problems
  ↓
schedule-generator runs (uses latest task data including AI refinements)
```

Key principle: task is saved and schedule starts generating immediately.
AI enrichment updates the task asynchronously — schedule re-runs if AI changes
estimated_mins or work_type materially.

---

## Cost impact

| Call | Avg tokens | Cost per call (Haiku) | Frequency |
|---|---|---|---|
| Description parse | ~600 input / 300 output | ~$0.003 | Once per task with description |
| PDF parse | ~4,000 input / 500 output | ~$0.02 | Once per PDF upload |

At 200 premium users each adding ~15 tasks/month with descriptions:
- Description parsing: 200 × 15 × $0.003 = ~$9/mo
- PDF parsing (est. 5 uploads/user/month): 200 × 5 × $0.02 = ~$20/mo
- Total AI cost: ~$29/mo — unchanged from previous estimate at this scale

