---
name: Rumbo
description: Calm study-workflow UI for college students who need fast, trustworthy task capture.
colors:
  page-canvas: "#f4f5f8"
  surface: "#ffffff"
  surface-muted: "#eef0f5"
  surface-selected: "#e8f2f3"
  text-primary: "#2c2c2e"
  text-secondary: "#5c5c66"
  text-muted: "#8a8a96"
  border-default: "#dde0e8"
  border-hover: "#b8bcc8"
  accent-plum: "#8a708a"
  accent-plum-hover: "#7a657a"
  accent-teal: "#5b969c"
  accent-slate: "#7791c2"
  semantic-error: "#b85450"
  badge-deep-bg: "#e8f2f3"
  badge-shallow-bg: "#ede8f2"
  shadow-tint: "rgba(138, 112, 138, 0.12)"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  section-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.06em"
  badge:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.03em"
rounded:
  sm: "4px"
  md: "8px"
  lg: "10px"
  xl: "12px"
spacing:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  page-desktop: "40px 48px"
  page-tablet: "32px"
  page-mobile: "24px 20px"
components:
  button-primary:
    backgroundColor: "{colors.accent-plum}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-plum-hover}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
  button-submit:
    backgroundColor: "{colors.accent-plum}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "40px"
  card-task:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  nav-link-active:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: Rumbo

## Overview

**Creative North Star: "The Quiet Capture"**

Rumbo's interface should feel like a calm desk in a library: enough structure to trust, never enough noise to compete with the task in front of you. The visual system serves quick capture first; chrome stays soft, familiar, and native (Things-like polish on a system font stack). Surfaces are light, airy, and grouped with tonal contrast rather than heavy shadows.

This system explicitly rejects busy SaaS dashboards, gamified productivity theater, and loud ADHD-app aesthetics. Density is moderate: readable at a glance, never widget-heavy.

**Key Characteristics:**

- Restrained palette: cool gray canvas, white surfaces, plum primary actions, teal for focus and deep-work signals
- System sans typography with a tight 1.125–1.2 scale ratio
- Flat-by-default elevation; borders and background tints carry hierarchy
- 8px corner radius on controls; 10–12px on cards and auth panels
- Responsive shell: fixed sidebar on desktop, compact top bar on tablet/mobile
- 150ms state transitions; no decorative motion

## Colors

A muted academic palette: slate blue, dusty plum, and soft teal on a cool gray ground. Color signals state and category, not decoration.

### Primary

- **Dusted Plum** (`#8a708a`): Primary buttons, links, active onboarding progress, shallow-work classifier badge text. Used sparingly on any screen; rarity keeps actions legible.

### Secondary

- **Soft Teal** (`#5b969c`): Focus rings on inputs, deep-work badge text, completed onboarding dots, avatar initials. Signals "deep work" and interactive focus without competing with plum CTAs.

### Tertiary

- **Muted Slate** (`#7791c2`): Brand gradient endpoint only (`--gradient-brand`). Do not use as a standalone UI accent on product screens.

### Neutral

- **Page Canvas** (`#f4f5f8`): Main content background behind task lists and settings.
- **Surface** (`#ffffff`): Sidebar, cards, inputs, modals-on-page panels.
- **Surface Muted** (`#eef0f5`): Hover states on nav links, dropdown hover rows, select chevron hover.
- **Surface Selected** (`#e8f2f3`): Selected dropdown items, avatar background, deep badge fill.
- **Ink Primary** (`#2c2c2e`): Headings and primary body text.
- **Ink Secondary** (`#5c5c66`): Nav default, subtitles, secondary labels.
- **Ink Muted** (`#8a8a96`): Dates, meta lines, section labels, hints.
- **Border Default** (`#dde0e8`): Card borders, dividers, input strokes.
- **Border Hover** (`#b8bcc8`): Card hover border shift.

### Named Rules

**The One Voice Rule.** Plum is the only saturated accent on primary actions. Teal appears for focus, deep-work semantics, and selection tints, never as a second CTA color on the same view.

**The Flat Ground Rule.** Page canvas and surface white carry most of the screen. Accent tints stay in badges, buttons, and focus states, not full-bleed panels.

## Typography

**Display Font:** System UI stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif`)

**Body Font:** Same system stack (single-family product UI)

**Character:** Native, quiet, and scannable. No display fonts in labels or data. Hierarchy comes from weight and size, not novelty.

### Hierarchy

- **Headline** (700, 24px, 1.2): Dashboard page titles ("Tasks"), Add Task title.
- **Title** (700, 22px, 1.2): Onboarding stage headings.
- **Body** (400, 14px, 1.5): Form copy, task titles, list content. Cap prose blocks at 65–75ch where used.
- **Label** (500, 13px): Form field labels, nav links, usernames.
- **Section label** (600, 12px, uppercase, 0.06em tracking): "Scheduled today", "Upcoming" group headers.
- **Badge** (600, 11px, uppercase, 0.03em tracking): Deep / Shallow classifier chips.

### Named Rules

**The System Stack Rule.** Do not introduce a second webfont for product screens unless accessibility requires it. Familiarity beats novelty.

## Elevation

Flat-by-default. Depth is conveyed with surface color steps (`page-canvas` → `surface` → `surface-muted`) and 1px borders, not stacked shadows. The only structural shadow is on dropdown menus (`0 4px 12px` plum-tinted rgba) to separate floating lists from the page.

### Shadow Vocabulary

- **Dropdown lift** (`box-shadow: 0 4px 12px rgba(138, 112, 138, 0.12)`): Combobox and time-picker menus only.

### Named Rules

**The Border-Not-Glow Rule.** Inputs gain focus through a teal border shift (`--color-focus`), not outer glows or ring stacks.

## Components

### Buttons

- **Shape:** Gently rounded (8px).
- **Primary:** Plum fill, white text, 36px height on dashboard ("+ Add Task"), 44px on forms. Padding 0 16px; 15ms background transition.
- **Hover / Focus:** Darker plum (`#7a657a`); disabled at 40–50% opacity.
- **Secondary:** Text links use plum with underline on hover; no ghost button variant yet.

### Chips

- **Deep:** `#e8f2f3` background, teal text, 4px radius, uppercase 11px.
- **Shallow:** `#ede8f2` background, plum text. Clickable badges fade to 75% opacity on hover.

### Cards / Containers

- **Task cards:** White surface, 1px border, 10px radius, 14×16px padding. Hover darkens border only.
- **Auth / onboarding panels:** White surface, 12px radius, 40px padding (28×24px on mobile).
- **No nested cards.** Lists are flat stacks with 8px gap.

### Inputs / Fields

- **Style:** 40–42px height, 8px radius, 1px border, white fill.
- **Focus:** Border shifts to teal (`--color-focus`).
- **Error:** `#b85450` text below field, 13px.
- **Premium locked:** 50% opacity, `pointer-events: none`.

### Navigation

- **Sidebar (desktop):** 200px fixed column, white surface, right border. Nav links 14px medium, 8×12px padding, 8px radius. Active/hover: muted gray background.
- **Mobile (≤768px):** Sidebar becomes horizontal top bar; username hidden; nav links in a row.
- **Shell:** Only `mainInner` scrolls; sidebar stays fixed.

### Classifier row (signature)

Inline deep/shallow badge beside task name input on Add Task. Debounced, client-side, toggleable. Teaches task type without a separate modal.

## Do's and Don'ts

### Do:

- **Do** keep one primary plum CTA per view; secondary actions as text links or muted controls.
- **Do** use uppercase 12px section labels with letter-spacing for task groups, not heavy dividers.
- **Do** respect `prefers-reduced-motion` when adding transitions (150ms max, ease-out only).
- **Do** collapse the sidebar to a compact top bar at 768px and tighten page padding at 1024px / 768px / 480px.
- **Do** use teal focus borders and plum primary buttons so state and action colors stay distinct.

### Don't:

- **Don't** build busy SaaS dashboards: dense widgets, hero metrics, gradient accents, identical feature-card grids.
- **Don't** use gamified productivity patterns: streaks, badges, confetti, guilt copy.
- **Don't** use clinical institutional styling or childish ADHD-app mascots and loud primaries.
- **Don't** add colored left-border stripes on cards or list items.
- **Don't** use gradient text, glassmorphism cards, or decorative motion that does not convey state.
- **Don't** open modals when inline or full-page flows suffice (Add Task is already full-page by design).
