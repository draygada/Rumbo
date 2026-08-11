# Rumbo — Frontend Design Spec

Reference implementation: `Rumbo Homepage v3.dc.html` (+ `rumbo-graph.js`).
This document is the source of truth for rebuilding the marketing frontend in a real codebase.

---

## 1. Product voice

Rumbo is an AI study companion that ingests a student's real course material (Canvas, Drive, Calendar, email, notes) and builds a personal knowledge graph — a "second brain" — then tutors from it. The site's job: make it feel like a serious research tool, not a chatbot wrapper.

Tone: plain, factual, lowercase-friendly. Never hype. Headline pattern is a claim + an italic twist ("Make learning, *easier than cheating.*"). Copy is short; the product demos carry the weight.

---

## 2. Logo

The mark is a **node graph** — one large center hub, five colored satellite hubs, and ten small gray nodes, drawn on a `-4 -4 108 108` viewBox. It reads as a constellation/second brain, and it is the same visual language as the product's knowledge graph.

### Geometry (exact — reuse these coordinates)

```js
// viewBox "-4 -4 108 108"
hubs = [[52,50],[48,22],[79,40],[70,71],[40,77],[24,45]];   // index 0 = center
sats = [[46,5],[96,24],[93,90],[30,95],[5,33],[9,63],[62,93],[97,57],[27,9],[15,20]];
links = [
  [0,1],[0,2],[0,3],[0,4],[0,5],           // primary spokes  (opacity .7)
  [1,6],[2,7],[3,8],[4,9],[5,10],[4,12],
  [2,13],[1,14],[5,11],[5,15],             // hub → satellite (opacity .4)
  [1,2],[4,5],[3,4]                        // hub → hub ring  (opacity .4)
];
```

Radii: center hub `r = 8.5` (1.42 × base), other hubs `r = 6`, satellites `r = 3.2`.
Link stroke: `--text3` (#8B857C), `stroke-width: 2.2`.

Hub fills cycle through `[--ochre, --sage, --teal, #1E66CC]` by index (`cols[i % 4]`), so the center hub is ochre. Satellites are `--text3`.

### Rules

- Minimum size 24px. Below that, drop the satellites and keep only the 6 hubs + 5 spokes.
- On dark backgrounds the mark stays as-is (the hub colors carry it); the wordmark switches to `--oninv`.
- Wordmark: "Rumbo" in Space Grotesk 600, `letter-spacing: -0.03em`. Nav pairs a 44px mark with 19px text, `gap: 10px`. Footer uses 28px mark / 17px text.
- Never re-color the mark to a single flat color. The multicolor hubs are the identity.

### Animation variants

The mark is built as a function, not a static file, because it animates in four ways:

| variant | behavior | where |
|---|---|---|
| `anim` | hubs pop in (`popIn`, 0.09s stagger), then satellites (0.04s stagger) | first paint / nav |
| `radiate` | links draw outward from center (`drawPulse`), nodes pop in on a delay proportional to distance from center | hero, section reveals |
| `pulse` | hubs breathe (`breathe 2.6s ease-in-out infinite`, scale 1 → 1.045) | **Rumbo listening indicator** — this replaces waveform bars everywhere |
| `learn` | three extra terracotta cross-links fade in between hubs | "it connects your courses" moments |

Build it in JS/TSX as a `<RumboMark size hubR satR lw variant />` component. Do not export a flat SVG file — half the site depends on the animated variants.

---

## 3. Color

```css
:root{
  /* surfaces */
  --base:   #F6F5F2;   /* page background — warm paper */
  --base2:  #EBEAE5;   /* alternating section background */
  --card:   #FFFFFF;
  --border: #E3E0D9;

  /* text */
  --text:   #1B1815;   /* near-black, warm */
  --text2:  #57514A;   /* body / secondary */
  --text3:  #8B857C;   /* meta, labels, graph links */

  /* inverted surfaces */
  --plum:   #1B1815;   /* dark chrome: nav, window title bars, user bubbles */
  --plum2:  #332E28;   /* its hover */
  --oninv:  #F6F5F2;   /* text on dark */

  /* accents — knowledge-graph palette */
  --terra:  #E86A4F;   /* single brand accent: eyebrows, Rumbo speech labels */
  --terra2: #D2543A;
  --sage:   #4FA06B;
  --ochre:  #E8A23E;
  --dblue:  #3E9AAC;
  --teal:   #8A6FD4;

  --shadow:    0 1px 0 rgba(27,24,21,.03), 0 1px 2px rgba(27,24,21,.06);
  --shadow-lg: 0 1px 0 rgba(27,24,21,.04), 0 18px 48px -16px rgba(27,24,21,.16);
}
```

### Usage rules

- **Warm neutrals do the work.** The page is paper (#F6F5F2) alternating with #EBEAE5. Only two background values across the whole page — do not introduce a third.
- **Terracotta `--terra` is the only accent used as UI accent.** Eyebrow labels, "RUMBO" speaker labels, active states, the primary link color in the graph particles.
- **Sage / ochre / dblue / teal are semantic, not decorative.** They mean "a course/class space." Once a color is assigned to a course in a demo (e.g. CS 107 = teal, ECON 105 = dblue, MKTG 220 = ochre, EDUC 475 = sage) it must stay that color in every demo, legend, calendar block, and graph node on the page.
- **Blue #1E66CC** appears in one place: the italic hero phrase and the 4th hub color. Treat it as a punctuation color, not a palette member.
- Buttons: primary = `--plum` fill with `--oninv` text, hover `--plum2`. Secondary = white card, 1px `--border`, hover `border-color: --text3`. Both `border-radius: 4px`, `padding: 15px 28px`, 15.5px/600.
- Demo window chrome uses macOS traffic lights `#FF5F57 / #FEBC2E / #28C840` on a `--plum` title bar.

---

## 4. Typography

Two families only.

- **Space Grotesk** — everything: headings, body, UI. Weights 500 / 600 / 700.
- **JetBrains Mono** — only inside the knowledge-graph canvas (concept and file labels). Not used in page chrome.

Note: `--mono` is aliased to Space Grotesk on purpose. "Mono-styled" labels (eyebrows, tags) are Space Grotesk 700 with `letter-spacing: .08–.12em` and `text-transform: uppercase`, not an actual mono face. Keep that.

| role | spec |
|---|---|
| h1 | `clamp(40px, 4.8vw, 64px)` / 600 / line-height 1.02 / `letter-spacing -.035em` / `text-wrap: balance` |
| h2 | `clamp(30px, 3.4vw, 44px)` / 500 / line-height 1.15 |
| section h2 (small) | `clamp(26px, 3vw, 36px)` / 500 |
| lede | `clamp(17px, 1.5vw, 20px)` / line-height 1.55 / `--text2` / `max-width: 52ch` |
| body | 16px / 1.65 / `--text2` |
| eyebrow | 12.5px / 600 / `.12em` tracking / uppercase / `--terra` |
| in-demo label | 9.5–13px / 700 / `.08–.1em` tracking / uppercase |
| nav | 14.5px / 500 |

Headings use weight 500–600, never 700. `text-wrap: balance` on headings, `text-wrap: pretty` on paragraphs.

---

## 5. Layout & spacing

- Content max-width **1200px** (hero, nav, scroll section), **1120px** for capabilities, **740px** for prose sections. Horizontal padding 32px.
- Section vertical rhythm: 130–150px padding. Hero is 210px top / 90px bottom (clears the fixed nav).
- Radii are **small and consistent**: 3–5px for cards, panels, and windows; 999px only for pills. Nothing is heavily rounded — this is the main thing that keeps it from looking like a generic SaaS page.
- Shadows are barely there (`--shadow`). The one exception is the hero demo window, which sits on `0 24px 50px -20px rgba(0,0,0,.22)`.
- Borders are 1px `--border`. Sections separate with a border-top, not a gradient.
- **Always lay out sibling groups with flex/grid + `gap`.** No margin-based spacing between siblings.

---

## 6. Page structure

1. **Nav** — fixed, dark (`--plum`) translucent chrome, logo left, two links (How it works / What it does), CTA right.
2. **Hero** — headline + lede + two CTAs, then a **bento grid** (3 cols × 272px rows): a large 2×2 demo window (chat / planner, cycling), a "Tutors" card, and a "Connects to you" card with real integration logos from `static/logos/*.png`.
3. **How Rumbo works** — the centerpiece. A `900vh` scroll track with a `position: sticky; top: 0; height: 100vh` stage. Three stages scrub off scroll progress:
   - **Connect** — cursor selects source apps, they check in one by one.
   - **Build** — the `<rumbo-graph>` knowledge graph grows tier by tier (courses → files → concepts), then cross-course links draw.
   - **Rumbo** — a full multi-turn voice tutoring conversation reveals message by message, with the pulsing logo as the listening indicator and grounded source chips under each answer.
4. **Proof strip** — logos / stats, on `--base2`.
5. **Capabilities** — stepper, seven things Rumbo does.
6. **What Rumbo is not** — collapsible list, 740px, the differentiator section.
7. **Final CTA / waitlist** + footer.

### Scroll-section mechanics (important to preserve)

- Progress = `(scrollY - trackTop) / (trackHeight - viewportHeight)`, clamped 0–1, then split into three stage ranges. Drive everything off that one number; do not use IntersectionObserver per element.
- The track is deliberately long (900vh) so animations read slowly. Do not shorten it.
- Unrevealed conversation turns must be **collapsed to zero height** (`max-height: 0; overflow: hidden`), not just faded — otherwise they reserve layout space and push the visible message off-screen.
- The message column auto-scrolls so the newest revealed message stays fully visible above the voice bar.
- Everything must be idempotent and reversible: scrolling back up must play the animation backwards cleanly. No one-shot `animation` on scroll-driven elements — use transforms/opacity derived from progress.

---

## 7. Motion

- Durations: 0.4–0.6s for element entrances, 0.7s for logo radiate, 2.6s for ambient breathing loops.
- Easing: `ease-out` for entrances; `cubic-bezier(.34, 1.5, .64, 1)` for node/badge pops (slight overshoot); `ease-in-out` for loops.
- Entrance pattern is always `fadeUp`: `opacity 0 → 1`, `translateY(14px) → 0`, staggered 0.06s per element.
- Respect `prefers-reduced-motion`: hold every scroll animation at its final state and disable ambient loops.

Key keyframes to port: `fadeUp`, `popIn`, `nodePulse`, `drawPulse`, `breathe`, `orbTalk`, `ripple`, `sheetUp`, `marqueeL/R`.

---

## 8. The knowledge graph (`rumbo-graph.js`)

A `<rumbo-graph>` custom element wrapping [force-graph](https://github.com/vasturiano/force-graph) 1.43.5 on canvas.

- Three node tiers: **course** (r 8.5, ringed, colored by course token, Space Grotesk 11px label), **file** (3.2px rounded square, JetBrains Mono 7.5px), **concept** (r 5 with a soft radial halo, JetBrains Mono 8.5px).
- Layout is **deterministic, not simulated**: four course clusters pinned to fixed quadrants (`±155, ±92/104`), children ringed around each at radius 46 (files) / 78 (concepts). After 1.7s every node is pinned (`fx`/`fy`) and all forces are removed, so the map never drifts and looks identical on every load.
- Peripheral fragment nodes are pinned far outside the fitted frame and excluded from `zoomToFit`, so the visible graph reads as a window into something larger.
- Reveal is time-based and scrubable via a `scrub` attribute (ms), so it can be driven by scroll progress: nodes appear tier by tier at 240ms intervals, each link 260ms after both endpoints.
- Zoom/pan interaction is disabled. Colors are read from CSS custom properties at runtime and re-read on `data-theme` change.

If rebuilding: keep the deterministic pinned layout. A live force simulation makes the graph look different every load and undermines the "this is *your* brain" claim.

---

## 9. Anti-patterns

Things this design deliberately avoids — please keep avoiding them:

- Gradient hero backgrounds, glassmorphism, glowing borders.
- Large border radii (12px+) and heavy drop shadows.
- Emoji, and icon sets that don't match the node/graph language.
- Inter, Roboto. (Space Grotesk carries the personality; swapping it flattens the whole thing.)
- More than two background colors per page.
- Waveform bars for the voice/listening state — always the pulsing logo.
- Decorative stats or fake metrics. Every number on the page should be real or clearly a demo.

---

## 10. Assets

- `static/logos/*-c.png` — integration marks: canvas, drive, calendar, classroom, outlook, onedrive, slack, github, linkedin, goodnotes, overleaf, zoom. Displayed at 38px in a white 5px-radius chip with 1px `--border`.
- `rumbo-graph.js` — ship as-is; it depends on `force-graph@1.43.5` from CDN.
- Fonts: Google Fonts — `Space Grotesk` (500,600,700) and `JetBrains Mono` (400,500,600).
