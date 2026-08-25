# Rumbo — Pitch Brief

Assembled 2026-08-13 from `Rumbo-vision.md`, `Rumbo-overview.md`, `PRODUCT.md`
(which live in `~/Rumbo-Design-Docs`, gitignored — see STATE-2026-08-13.md),
plus build status verified against the running deployment.

**One-liner:** Rumbo is your second brain for school — it knows your classes,
adapts to how you learn, and connects the dots across everything you're studying.

Tagline: *Your self-building academic brain.* · Catch line: *Grows with every class you take.*
Positioning: *The one AI that actually knows what you're studying — because it lives inside your coursework, not outside it.*

---

## The problem

College students carry an invisible second job: managing the logistics of academic
life across tools that don't talk to each other. Canvas has the assignments. The
calendar has the schedule. Drive has the readings. Lectures have the actual
content. None of them remember anything about the student.

That executive overhead competes directly with learning for the same finite
attention — and it falls hardest on the students with the least slack to absorb it.

Better-resourced students often have someone quietly doing this coordination for
them: a parent who's been through college, an advisor, a network. Rumbo exists
because most students don't have that, and an LMS, a calendar and a cloud drive
were never built to fill the gap.

**Acute wedge:** first-generation students and post-COVID cohorts in
quantitative-heavy majors at large public universities. They arrive tired,
skeptical of AI hype, and specifically wary of anything that risks an
academic-integrity problem.

---

## Why this founder

First-generation immigrant household. Direct work with underserved students
through the Learning Loss Recovery program at Barrio Logan College Institute
(11 students). Stanford CS + Math. Backed by the **Stanford Accelerator for
Learning**.

The throughline: the *ceiling* that low expectations and missing infrastructure
place on students who are just as capable as anyone else — and the belief that
the right infrastructure raises it.

---

## The insight

Every other AI education tool is generic — it answers the question. Rumbo answers
it *the way you learn best*, using *the framing your professor used*, connected to
*what you covered last month in a different class*.

The mechanism is a knowledge graph that builds itself from data the student
already generates, in tools they already use. **No new app to learn.** The graph
is invisible infrastructure — the student never "opens the graph."

> A system that knows a student's whole academic life well enough to tell them
> something true about it that they couldn't easily see themselves.

---

## What it does

- **Tutors** — explains from your material, citing the exact slide, adapted to how you learn
- **Drafts** — emails to professors, study-group messages, recruiter intros, in your voice
- **Schedules** — breaks work into deep/shallow blocks on your real calendar
- **Nudges** — proactive, not chatty; respects attention
- **Advises** — course selection, prereq chains, degree fit, without a three-week wait
- **Plans careers** — for a job market where AI is rewriting entry-level
- **Sets goals** — semester and longer-horizon targets broken into weekly actions

### The hard line

Rumbo never produces submittable academic work. No psets, no essays, no
take-homes. Ask it to solve your homework and it redirects to the professor's
method.

This isn't positioning — it's the same line that has already drawn institutional
backlash for a real competitor, and it is treated as a binding constraint on
every feature.

---

## The moat

**Accumulated history, not a feature.** A student four years in has a structural
map of how they actually learned and thought through college. No competitor
starting fresh can replicate it. The switching cost grows naturally, with no
artificial lock-in.

**Whole-student scope is the wedge.** Every competitor found in research does one
of two things: serves a single course (institution- or instructor-mediated), or
transforms content within a single upload (stateless, no memory across courses or
time). Rumbo is the only bet in the gap between — a graph spanning a student's
entire academic life, independent of whether any instructor opted in.

---

## Competition

| Who | What they actually are | The gap |
|---|---|---|
| **Docere** | Near-identical memory-graph architecture, deployed in K-12 middle schools | Different bet — a self-improving tutoring loop benchmarked against grades, not a cross-life graph |
| **FSchoolAI** | College-focused, 12,000+ self-reported students | Content/task automation on an LMS sync — AI-drafted assignments, GPA projection. Crosses the integrity line |

Stated honestly in the docs: the gap is real today but not guaranteed to stay
open. Memory-over-LMS is being independently arrived at by multiple teams now
that cheap embeddings and mature LMS APIs exist. **The scope and the intent are
the edge, not the existence of a graph.**

---

## Where the build actually is

Verified against the running system on 2026-08-13, not aspirational.

| Capability | State |
|---|---|
| Canvas + Drive + Calendar ingestion | live |
| Concept graph (Neo4j), class-scoped | live |
| Tutor grounded in course documents | live — verified end-to-end in EDUC 475 |
| Learner model — signal capture | live |
| Learner model — nightly aggregation | built + tested, not deployed |
| Adaptive explanation (learner model in the answer) | next |
| Scheduling, drafting, advising, career | designed, not built |

**Demo honestly, inside EDUC 475.** One course is fully extracted and grounded.
Other courses are still filename-only, and over those the tutor will answer
confidently from its own knowledge while citing course documents — a known,
verified failure mode.

---

## What the docs don't answer

Absent from the entire design corpus. A YC partner will ask all of these.

- **Market size** — no TAM, no segment sizing, no bottom-up count of the wedge
- **Business model** — no pricing, no willingness-to-pay evidence. Student-paid vs. institution-paid vs. freemium is open, and it changes the whole GTM
- **Traction** — waitlist mechanics are specified; actual numbers aren't recorded anywhere. Same for active users and retention
- **Distribution** — the docs deliberately build the graph *before* investing in acquisition. Defensible, but "how do students find Rumbo" is unanswered
- **Unit economics** — per-student cost of ingestion, parsing, embeddings and generation is untracked. A tutor turn is currently ~16s of model time
- **Team** — no composition or hiring plan in the corpus

Two proof points exist but aren't yet public, so reference them as in-flight
rather than citing them: UCSD math-advisor validation, and a potential faculty
collaboration on adaptive Canvas courses.

---

## The belief ladder

The order the docs say a skeptical listener must move through. Works directly as
pitch structure.

1. **AI in education is broken.** Generic AI doesn't know their coursework;
   over-reliance produces worse outcomes; existing tools don't close the gap.
2. **Rumbo fixes a three-way disconnect** — AI ↔ class context, teacher ↔ student
   context, student ↔ own trajectory — through one graph that captures the
   academic life once and serves it back where needed.
3. **Real students at real schools use it.** Stanford Accelerator backing; founder
   grounding that signals authentic domain understanding.
4. **I want early access.**

---

## Voice, if you're writing pitch copy

Warm, smart graduate student at a good school. Confident but not showy. Three
words: **grounded, sophisticated, warm.** Calm, not urgent.

Banned phrases: "AI-powered," "Next-generation," "Revolutionize your learning,"
"Unlock your potential," "Learn smarter not harder," "Your AI study companion,"
"Personalized learning," "Transform how you study."

If you show a knowledge graph, it uses real course concepts — `linear regression`,
`regulatory arbitrage`, `Double Reduction policy` — never "Concept A → Concept B."
