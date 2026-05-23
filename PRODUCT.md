# Product

## Register

product

## Users

College students with attentional learning differences (ADHD and related profiles). They juggle classes, deadlines, and shifting energy across the day, often between lectures, the library, and home. They need to offload tasks quickly without rebuilding a mental plan every time they open the app.

## Product Purpose

Rumbo is a workflow layer on top of the student's existing calendar, not a calendar replacement. It captures tasks, classifies them, and places study blocks using a deterministic scheduler the student can trust. Success looks like: dump a task in seconds, leave, and believe it will land in a realistic slot that respects their hours, calendar conflicts, and energy patterns.

## Brand Personality

Calm, grounding, and unobtrusive. The interface should feel like a polished native tool (Things-like): quiet confidence, no hype, no pressure. Copy is direct and respectful, never patronizing. Small moments of warmth are fine; spectacle is not.

## Anti-references

- Busy SaaS dashboards: dense widgets, hero metrics, gradient accents, identical feature-card grids
- Gamified productivity: streaks, badges, confetti, guilt-driven nudges
- Clinical or institutional UIs: sterile warning-heavy layouts that feel like a medical portal
- Childish "ADHD apps": cartoon mascots, loud primaries, condescending tone

## Design Principles

1. **Capture first, chrome second.** Every screen justifies itself by helping the student add or trust a task. Navigation and settings stay available but never compete with the primary action.
2. **Calm over clever.** Visual hierarchy is clear; decoration does not fight for attention. One primary action per view when possible.
3. **Trust through clarity.** Show what Rumbo scheduled and the constraints that shaped it, without dumping algorithmic detail. Predictability beats surprise.
4. **Earned familiarity.** Use patterns students already know from best-in-class tools (sidebar + list, clear primary button, familiar form controls). Do not reinvent standard affordances for flavor.
5. **Cognitive kindness.** Low cognitive load by default: generous whitespace, consistent component vocabulary, scannable groupings, and respect for `prefers-reduced-motion`. Avoid notification pressure and metric theater.

## Accessibility & Inclusion

- **WCAG 2.1 AA** as baseline: color contrast, visible focus states, keyboard operability, semantic structure.
- **ADHD-first accommodations:** reduce visual noise, limit simultaneous choices, maintain stable layout (no layout-shift surprises), honor reduced motion, keep copy short and actionable.
- Avoid patterns that punish inconsistency (streaks, shame copy). Empty and error states should teach the next step, not blame the user.
