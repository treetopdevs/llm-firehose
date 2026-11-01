---
name: Agent Firehose
description: Local-first operations board for many AI coding agents across worktrees and time
colors:
  bg: "#110f0d"
  bg-panel: "#1a1614"
  bg-hover: "#25211e"
  border: "#6d6863"
  text: "#ebe7e4"
  text-dim: "#a9a39e"
  accent: "#fe7802"
  needs: "#f3b01d"
  selected: "#3adfd7"
  focus: "#5abdf2"
  stale: "#a0968f"
  fog: "#454e58"
  ok: "#3fc168"
  warn: "#daa932"
  err: "#f75d59"
  on-err: "#110c0b"
  on-fill: "#fcf9f7"
  map-zero: "#182125"
  map-heat: "#007b76"
  attention: "#f0b429"
  working: "#34d399"
  observed: "#7a5cf0"
  none: "#7d8aa0"
  series-1: "#5aa9e6"
  series-2: "#e6a15a"
  series-3: "#7fc97f"
  series-4: "#c58be0"
  series-5: "#d9d36a"
  replay-alt: "#b48be0"
  replay-alt-bg: "#231c2b"
  selected-wash: "#3adfd72e"
typography:
  body:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
  prose:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  heading:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  subtitle:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  section:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  meta:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
  axis:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: "0.04em"
rounded:
  tag: "3px"
  control: "4px"
  field: "6px"
  group: "8px"
  sheet: "10px"
  pill: "999px"
spacing:
  hair: "4px"
  tight: "8px"
  row: "0.35rem 0.8rem"
  gutter: "0.6rem"
  block: "0.8rem"
  sheet: "1.4rem"
components:
  button:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "{spacing.row}"
  button-hover:
    backgroundColor: "{colors.bg-hover}"
  button-primary:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.accent}"
    rounded: "{rounded.field}"
    padding: "{spacing.row}"
  button-pressed:
    textColor: "{colors.accent}"
  input:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "0.3rem 0.5rem"
  nav-item:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    padding: "{spacing.row}"
  nav-item-active:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.accent}"
  segment-group:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text-dim}"
    rounded: "{rounded.group}"
    padding: "7px 16px"
  segment-selected:
    backgroundColor: "{colors.selected-wash}"
    textColor: "{colors.text}"
  unit-row:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "4px 10px"
  badge:
    textColor: "{colors.text-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.35rem"
  badge-needs:
    backgroundColor: "{colors.needs}"
    textColor: "{colors.bg}"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.35rem"
  badge-error:
    backgroundColor: "{colors.err}"
    textColor: "{colors.on-err}"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.35rem"
  transport-control:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "3px 8px"
  transport-track:
    backgroundColor: "{colors.bg-panel}"
    rounded: "7px"
    height: "14px"
  onboarding-sheet:
    backgroundColor: "{colors.bg-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.sheet}"
    padding: "{spacing.sheet}"
---

# Design System: Agent Firehose

<!-- Documents the desktop shell after slice 13 (D116): one token layer on :root in
     apps/tauri-desktop/src/styles.css, enforced by src/tokens.test.ts. If this file and the
     test disagree, the test wins. Frontmatter colours are the sRGB hex fallbacks; the OKLCH
     canonicals are in the Token table. -->

## 1. Overview

**Creative North Star: "The Operations Board"**

Agent Firehose is read the way a flight-operations board or a well-kept lab notebook is read: between turns, at a glance, to answer four questions. Which agent needs me. What is each one doing. Where, meaning which checkout and branch. What did a finished session actually do. The interface is therefore dense, flat and dark, and colour is spent on state, not decoration. Every row carries evidence from captured events, and missing evidence is drawn as absence (dashed borders, "unknown"), never as a guess.

One token layer in `apps/tauri-desktop/src/styles.css` (`:root`) is the only place colour, type size and the sans face are defined. Neutrals are a near-black ink tinted toward the accent hue (60) at very low chroma, with hairline borders separating panels instead of shadows. Data (ids, paths, branches, timestamps, counts) is set in the platform monospace at 13px; prose (headings, notes, help text, onboarding) is set in the system sans. Hierarchy comes from dimming (`--text` against `--text-dim`) and from weight; the five-step type scale tops out at 16px. Colour is a vocabulary with fixed meanings: `--accent` for location, pressed state and the primary action, `--needs` for "needs you", `--selected` for selection in the graph and session tabs, `--focus` for the keyboard ring, and `--ok`, `--warn`, `--err` for landed, caution and fault. The workspace graph consumes the same tokens; it no longer has a palette of its own.

Product intent (register, users, tone) lives in [PRODUCT.md](PRODUCT.md).

This system explicitly rejects the SaaS analytics dashboard (hero metrics, KPI tiles, gradient accents, identical card grids), the observability "dark blue with neon" skin, glassmorphism and gradient text, chat-app friendliness (avatars, bubbles, emoji status), and any surface that identifies a thing by its hash when a human name exists.

**Key Characteristics:**
- Monospace for data, sans for prose; tabular numerals on clocks and ranges.
- Flat surfaces, 1px hairlines; shadows only on the two graph popovers (search results, overflow menu), the selected workspace pill and the onboarding scrim.
- Attention earns colour: accent-family tokens appear only on focus, selection, the primary action, needs-you and errors (tested by selector).
- Density first: five type steps, 11px to 16px, every `font-size` a `var(--fs-*)`.
- Rows and lanes, not cards: a unit of the fleet is a bordered row whose border style encodes its state.
- Keyboard parity is a requirement: every clickable row must have a keyboard path and a focus-visible treatment. The matrix cells, dwell rows, lane rows, fleet lane rows and score tracks now draw a `--focus` indicator (tested); feed rows and session items take focus but have no styled focus-visible yet and fall back to the browser ring.

## 2. Colors

A warm near-black ink, two surface steps for panels and hover, text in two strengths, one hot accent, and a small set of role and state hues. Dark only.

### Token table

Each token has a hex fallback in `:root` and, for neutrals, roles and fills, an `oklch()` override in a second `:root` block under `@supports (color: oklch(0 0 0))`. Hex is generated from the oklch value. The two agree within 6/255 per channel (tested). Contrast is WCAG against `--bg` and `--bg-panel` (hex values, tested in hex and oklch-resolved modes).

| Token | oklch | Hex | vs `--bg` | vs `--bg-panel` |
| --- | --- | --- | --- | --- |
| `--bg` | oklch(0.17 0.006 60) | #110f0d | 1.0 | 1.1 |
| `--bg-panel` | oklch(0.205 0.007 60) | #1a1614 | 1.1 | 1.0 |
| `--bg-hover` | oklch(0.25 0.008 60) | #25211e | 1.2 | 1.1 |
| `--border` | oklch(0.52 0.01 60) | #6d6863 | 3.5 | 3.3 |
| `--text` | oklch(0.93 0.006 60) | #ebe7e4 | 15.6 | 14.6 |
| `--text-dim` | oklch(0.72 0.01 60) | #a9a39e | 7.7 | 7.2 |
| `--accent` | oklch(0.72 0.19 50) | #fe7802 | 7.2 | 6.8 |
| `--needs` | oklch(0.8 0.16 80) | #f3b01d | 10.1 | 9.4 |
| `--selected` | oklch(0.82 0.13 190) | #3adfd7 | 11.6 | 10.9 |
| `--focus` | oklch(0.76 0.12 235) | #5abdf2 | 9.1 | 8.6 |
| `--stale` | oklch(0.68 0.015 60) | #a0968f | 6.6 | 6.2 |
| `--fog` | oklch(0.42 0.02 250) | #454e58 | 2.3 | 2.1 |
| `--ok` | oklch(0.72 0.17 150) | #3fc168 | 8.2 | 7.7 |
| `--warn` | oklch(0.76 0.14 85) | #daa932 | 8.8 | 8.3 |
| `--err` | oklch(0.68 0.19 25) | #f75d59 | 6.1 | 5.7 |
| `--on-err` | oklch(0.16 0.01 25) | #110c0b | 1.0 | 1.1 |
| `--on-fill` | oklch(0.985 0.004 60) | #fcf9f7 | 18.2 | 17.1 |
| `--map-zero` | oklch(0.24 0.015 235) | #182125 | 1.2 | 1.1 |
| `--map-heat` | oklch(0.52 0.1 190) | #007b76 | 3.7 | 3.5 |
| `--attention` | hex only | #f0b429 | 10.3 | 9.6 |
| `--working` | hex only | #34d399 | 9.9 | 9.3 |
| `--observed` | hex only | #7a5cf0 | 4.2 | 3.9 |
| `--none` | hex only | #7d8aa0 | 5.5 | 5.1 |
| `--series-1` | hex only | #5aa9e6 | 7.5 | 7.1 |
| `--series-2` | hex only | #e6a15a | 8.8 | 8.2 |
| `--series-3` | hex only | #7fc97f | 9.6 | 9.0 |
| `--series-4` | hex only | #c58be0 | 7.4 | 7.0 |
| `--series-5` | hex only | #d9d36a | 12.3 | 11.5 |
| `--replay-alt` | hex only | #b48be0 | 7.0 | 6.6 |
| `--replay-alt-bg` | hex only | #231c2b | 1.2 | 1.1 |

Fill pairs (text on a coloured fill):

- `--on-err` on `--err`: 6.2. Used by `.badge.err` and `.compat-banner`.
- `--bg` on `--needs`: the needs badge text.
- `--on-fill` on the Activity Map ramp, sampled from `--map-zero` (15.6) through `--map-heat` (4.9). The heat end is deliberately dark so one light `--on-fill` passes everywhere (`.map-tile > text`). The cost: heat is a duller teal than before, and `--map-heat` as text on `--bg` is 3.7, so `.map-hot-count` uses `--text-dim`.
- `--text-dim` on `--map-zero` is at least 4.5 (cold tile label).

Notes:

- `--border` is 3:1 or better against both panel backgrounds (non-text UI contrast), so borders read brighter than a typical dark theme. Soft dividers (feed rows, lane baselines, the graph frame) use `color-mix()` of `--border`; selection washes are `color-mix()` of `--selected` over `--bg-panel` or transparent at 16 to 20%. Neither is a token; the frontmatter's `selected-wash` (`#3adfd72e`, the 18% session-tab wash) is a derived value for the linter, not a `:root` property.
- `--bg-*` neutrals are surfaces, not text. `--fog` is a stroke colour (graph ground), not text.
- `--replay-alt` / `--replay-alt-bg` mark the hypothetical lane and fork anchor in Replay. Hex only.
- Some tokens are consumed only from TypeScript and have no rule in `styles.css`: `--fog`, `--replay-alt`, `--replay-alt-bg`, `--series-3`, `--series-4`, `--series-5`, `--observed` (Replay captured) and `--stale` (Ecosystem unknown, plus the quiet airspace band). Do not delete them as unused.

### Roles
- **Accent** (`--accent`): the active nav item, pressed toggles (lanes, score, attention filters, fleet encodings, transport presets and Live), the primary button's border and text, the current checkout's border on fleet rows and forks, the selected fleet row's outline, the current tick on the score. It means "you are here", "this is on" or "this is the action". It is no longer on the brand word or the onboarding heading, and no button is filled with it.
- **Needs** (`--needs`): the "needs you" badge (`--bg` text on `--needs`), bold state words and lane labels for sessions waiting on the operator, needs ticks on lanes and the score, the dwell bar of a needing row.
- **Selected** (`--selected`): selection inside the workspace graph (nodes, edges, labels, tabs, map presets, the event table row) and the session lens tabs' wash. Inside `.workspace-graph` it is also the focus ring.
- **Focus** (`--focus`): the 2px keyboard ring everywhere in the shell outside the graph.
- **Ok / Warn / Err** (`--ok`, `--warn`, `--err`): landed, copied and healthy; caution, paused and storm outlines; faults, failed worktrees, error ticks and error badges.
- **Stale / Fog**: muted states. `--stale` is a quiet text-capable grey, `--fog` a ground stroke.

### Neutrals
- **Bg** (`--bg`): the page, sidebar and graph background.
- **Bg Panel** (`--bg-panel`): buttons, inputs, fleet rows, attention rows, the onboarding sheet, the graph toolbar, the active nav item's background.
- **Bg Hover** (`--bg-hover`): hover and focus fill on rows, cells and lanes; graph controls at rest.
- **Border** (`--border`): every border, divider and axis line.
- **Text** (`--text`): primary text, lane labels, the brand word.
- **Text Dim** (`--text-dim`): secondary text, times, categories, `h3` section headings, idle badges, axis text, nav group headings, unresolved breadcrumb ids.

### Accent rules

Attention earns colour. `--accent`, `--needs`, `--selected` and `--focus` appear only on:

- focus (`:focus`, `:focus-visible`, `:focus-within`, `.focus`), which uses `--focus` (`--selected` inside the graph)
- selection (`.selected`, `aria-pressed|selected|current`, `.active`, `.current`)
- the primary action (`.primary`)
- needs you (`.needs`, `.attention`, `.attention-kind` selectors and similar)
- errors (`.err`, `.error`, `.failed`)

The allowlist is by selector in `tokens.test.ts` (accent policy). Everything else, including the brand, the feed source column (`.cell.source`), captured/observed rows, notices, decorative bars and hover states, uses `--text`, `--text-dim`, `--border`, `--warn` or a neutral. `.attention-kind` itself uses `--text-dim`; it is not an accent user. Do not carry state by colour alone: keep the text label, and prefer a shape or dashed border for muted states.

Three focus rings still do not use `--focus`: the attention inbox and strip buttons and the Project altitude's lane hit use `--accent` (`ui/project/` belongs to slice 9), and the Loops lens uses `currentColor`. They pass the policy because they are focus selectors; move them to `--focus` when those surfaces are next edited.

### Named Rules
**The Accent Budget Rule.** `--accent` marks location, pressed state and the primary action, nothing else. If a screen shows accent on more than one thing the operator did not just choose, something is miscoloured. Selection in the graph and session tabs is `--selected`, and the keyboard ring is `--focus`, so the accent is never doing three jobs at once.

**The Word Beside the Dot Rule.** No hue carries state alone. `--needs`, `--ok`, `--warn` and `--err` always sit next to the word they mean ("needs you", "landed", "paused", "failed"), because the user may be colour-blind, the display may be dimmed, or the badge may be the only thing in view.

**The One Palette Rule.** New surfaces, the graph included, use the `:root` tokens. There is no second palette: `--g-*` and `--muted` are gone (tested), and no colour literal may appear outside `:root`.

## 3. Typography

**Display Font:** none; the product has no display tier.
**Data Font:** the `:root` monospace stack (ui-monospace, SFMono-Regular, Menlo, Consolas, monospace) for ids, paths, branches, timestamps, counts, rows and controls.
**Prose Font:** `--font-sans` (ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif) for headings, notes, help text, notices, onboarding and the whole workspace graph.

**Character:** A terminal that learned to align, with readable prose around it. Data shares one monospace rhythm so columns line up without a table; the words that explain the data are set in the system sans. Weight (400 against 600 and 700) and dimming do the work that size does elsewhere.

### Type scale

| Token | Size | Use |
| --- | --- | --- |
| `--fs-xs` | 11px | labels, headings in nav, dense metadata |
| `--fs-sm` | 12px | secondary text, table cells |
| `--fs-base` | 13px | body (`:root` font-size) |
| `--fs-md` | 14px | section headings |
| `--fs-lg` | 16px | panel titles |

`--font-sans` is for prose (headings, notes, help text, onboarding). The `:root` face is monospace and is for data: ids, paths, branches, timestamps, counts. Every `font-size` declaration in `styles.css` is a `var(--fs-*)` or `inherit`; no ad hoc sizes, at most five steps (tested). Text is dimmed with `--text-dim`, never with `opacity`.

### Hierarchy
- **Heading** (600, `--fs-lg`, sans): the graph inspector's `h3`, the largest declared size in the shell.
- **Subtitle** (600, `--fs-md`, sans, `--text-dim` inherited from the panel `h3`): the session heading in the Sessions list; the Project header and graph inspector `h4` also sit at `--fs-md`.
- **Title** (700 by browser default, `--fs-base`, sans): panel `h2` such as "Project"; the Session altitude title is the same size.
- **Section** (400, `--fs-sm`, sans, `--text-dim`): `h3` inside content panels; dimmed rather than enlarged.
- **Body** (400, `--fs-base`): rows, cells, controls, detail text. Prose blocks in attention rows run at 1.5 line height and are capped by the inbox's 1100px column; keep paragraphs under 75ch where layout allows.
- **Meta** (400, `--fs-sm`, usually `--text-dim`): session subtitles, detail crumbs, lane labels, the transport, notes and hints.
- **Axis** (400, `--fs-xs`): axis ticks, lane state words, the copyable session id, map tile labels.
- **Label** (700, `--fs-xs`, 0.04em, UPPERCASE): badges. Nav group headings use `--fs-xs`, 0.08em, uppercase in `--text-dim`.

The onboarding sheet's `h2` declares no size and keeps the browser's default `h2` size; it is the one heading larger than `--fs-lg`.

### Named Rules
**The No Display Rule.** Nothing declared in the shell is larger than `--fs-lg`. Emphasis is weight or a role colour, never size.

**The Tabular Clock Rule.** Any time, range, count or hash is set with `font-variant-numeric: tabular-nums` so columns do not shiver as values change.

## 4. Elevation

The system is flat. Depth is conveyed by hairlines and by two tonal steps (`--bg` page, `--bg-panel` controls and rows, `--bg-hover` on hover), never by shadow. Borders also encode state on fleet rows: solid for a known unit, dashed for fog (no recent evidence), dotted for a unit with no repository, `--accent` for the current checkout, `--err` for a failed one. The only shadows are the onboarding scrim (`color-mix(in srgb, var(--bg) 86%, transparent)`), the graph's search results and overflow menu (`0 12px 32px` of `--bg` at 75%), a soft `drop-shadow` of `--selected` on the selected workspace pill, and focus rings drawn as 2px box-shadows where an outline would box an SVG group.

### Shadow Vocabulary
- **Popover lift** (`box-shadow: 0 12px 32px color-mix(in srgb, var(--bg) 75%, transparent)`): only for a transient list floating over the graph (search results, the overflow menu).
- **Ring focus** (`box-shadow: inset 0 0 0 2px var(--selected)` on the graph canvas, `0 0 0 2px var(--selected)` on the map strip): focus where an outline cannot wrap the target. Outline is preferred everywhere an outline fits.
- **Change flash** (`0 0 0 2px var(--text-dim)` fading to transparent): the fleet row change animation.

### Named Rules
**The Hairline Rule.** Separate with a 1px `--border` line, a `color-mix()` of it, or a tonal step, never a shadow. If a new surface needs a shadow to be seen, its background step is wrong.

**The Border Speaks Rule.** On a unit row the border style is data (solid, dashed, dotted, accent, error). Do not reuse those styles decoratively.

## 5. Components

### Buttons
- **Shape:** softly squared (6px radius), 1px `--border`, `--bg-panel` fill, text inherits the body font at `--fs-base`.
- **Default:** `--bg-panel` background, `--text`, `0.35rem 0.8rem` padding, `0.15rem` outer margin.
- **Hover / Focus:** hover shifts the fill to `--bg-hover`; focus-visible draws a 2px `--focus` outline with 1px to 3px offset (per panel today; the shell should own it).
- **Primary:** same shape with an `--accent` border and `--accent` text; no filled accent buttons exist.
- **Pressed / toggled** (`aria-pressed="true"`, `.active`): `--accent` border and text in the shell; inside the graph, `--selected` text on a `--selected` wash.
- **Nav item:** borderless, backgroundless, left-aligned; active is `--accent` text on `--bg-panel`.

### Segmented groups (tabs, graph Fit/All, session lenses)
- **Style:** an 8px-radius `--border` frame with `overflow: hidden`; children are square buttons with `7px 16px` padding separated by 1px hairlines.
- **State:** the selected segment in the Session altitude is an 18% `--selected` wash with `--text`; in the graph it is `--selected` text on a 20% `--selected` wash over `--bg-panel`. Keyboard: Arrow, Home and End move selection; focus-visible is a 2px `--focus` outline inset by 2px.

### Chips and badges
- **Badge:** `--fs-xs`, 700, uppercase, 0.04em tracking, 3px radius, `--border`, `0.1rem 0.35rem` padding. Idle and dim variants are `--text-dim` on no fill.
- **Needs badge:** `--bg` text on `--needs`, border the same.
- **Error badge:** `--on-err` text on `--err`.
- **Lens chips** (session lens head): pill (999px), `--border`, `--fs-xs` text, `1px 10px` padding.
- **Copyable id** (`.session-id`): `--fs-xs` monospace, `--text-dim`, transparent border that becomes `--border` on hover, `cursor: copy`, turns `--ok` when copied. The id is a detail under the name, never the name.

### Unit rows (fleet, attention, sessions)
- **Corner style:** 6px radius.
- **Background:** `--bg-panel` on `--bg`; hover to `--bg-hover`.
- **Border:** 1px `--border`, with the state styles from Elevation; selected adds a 1px `--accent` outline offset 1px.
- **Internal padding:** `4px 10px` on fleet rows, `.8rem 1rem` on attention rows, `0.18rem 0.4rem` on feed rows.
- **Content:** label in `--text`, secondary facts in `--text-dim`, summary truncated with an ellipsis at a fixed character width (36ch on needs rows).
- **Identity stripe:** session band rows carry a 3px left border in the per-session identity hue, `hsl(var(--hue) 55% 55%)`. This is identity, not state.
- **Change flash:** a 1.6s ease-out fade from `--bg-hover` and a 2px `--text-dim` ring to transparent, disabled under `prefers-reduced-motion`.

### Inputs / Fields
- **Style:** `--bg-panel` fill, 1px `--border`, 6px radius, `0.3rem 0.5rem` padding, body font; selects match inputs.
- **Focus:** 2px `--focus` outline, 3px offset in the panels; graph fields use a `--selected` border on the search frame and a `--selected` outline.
- **Search:** a native `type="search"` that stretches to fill its bar.

### Navigation
- **Sidebar:** 130px wide, `--bg`, right `--border`, `0.8rem 0.5rem` padding, vertical stack with 0.3rem gaps. The brand word is `--text`, 700 weight, 0.08em tracking; it is not accent coloured.
- **Groups:** headings at `--fs-xs` uppercase, 0.08em tracking, `--text-dim`; current groups are Altitudes, Lenses and Housekeeping.
- **Items:** borderless buttons, left-aligned; active is `--accent` text on `--bg-panel`. Items should carry `aria-current` and sentence-case names (today they are lowercase codenames without `aria-current`).
- **Footer breadcrumb:** Fleet › Project › Worktree › Session in body text, unresolved ids in monospace `--text-dim`.

### Transport (signature component)
The shell-owned time control under the header, bound to the shared `scope.window`. A `--fs-sm` row with 8px gaps and a bottom hairline: four presets (2h, 8h, 24h, 7d), Live, Hold, a tabular-numeric range readout in `--text-dim`, and a 14px-high slider track with a 7px radius, `--bg-panel` fill and a `--border`. The thumb is `--text-dim` at 70% opacity and slides with a 120ms ease (disabled under reduced motion). Controls are 4px-radius `--bg-panel` buttons with `3px 8px` padding; pressed state is `--accent` border and text; focus-visible is a 2px `--focus` outline; disabled state is 45% opacity with a not-allowed cursor. The track is a `role="slider"` with Arrow and Home keys; Escape during a drag restores the window.

### Lanes (signature component)
SVG rows of time: an axis in `--fs-xs` `--text-dim` with 1-on-3 dashed `--border` gridlines, a soft `--border` baseline, closed spans in `--text-dim` at 45% opacity and open spans in `--text` at 85% (the open span is not accent coloured; tested), ticks in `--text` (`--err` for errors, `--needs` for needs), and a transparent hit rectangle that fills `--bg-hover` on hover or focus and takes a 2px `--focus` stroke on focus-visible. Lane labels are `--fs-sm` `--text`, state words `--fs-xs` `--text-dim`, and a lane that needs the operator goes bold `--needs`. Arrow keys and 1 to 9 pick a lane, Enter opens it.

### Graph

The workspace graph consumes the same tokens. `--g-*` and `--muted` no longer exist. It is scoped under `.workspace-graph`, set in `--font-sans` at `--fs-base` on `--bg`, with its toolbar on `--bg-panel` and controls on `--bg-hover`.

- `--attention`, `--working`, `--observed`, `--none` are the four agent states and are pinned byte-for-byte to `AGENT_STATE_COLOR` in `src/ui/graph/names.ts` (tested by reading that file as text). They are hex only. Until the slice 9 follow-up moves `names.ts` onto the tokens, change a state colour in both places or the parity test fails.
- Selection is `--selected`, focus is `--selected` (outline) or `--text` (the pill, chip or node stroke, where an outline would box the SVG group), the ground stroke is `--fog`, conflicts use `--warn`/`--err`.
- Ecosystem leaves: attempt `--focus`, complete `--ok`, failed `--err`, unknown `--stale`. Handoff series use `--series-1..5`. Replay captured uses `--observed`; the hypothetical lane uses `--replay-alt` on `--replay-alt-bg`.
- TS renderers emit `var(--token)` strings or classes, not hex.

Names that TypeScript reads from CSS at runtime. Do not rename:

- `--border` (airspace map)
- `--map-heat` and `--map-zero` (Activity Map ramp, `ui/activity/model.ts`)

Identity-hue exception: the locally set property `--hue` (set per element in `sessions.ts`) and `hsl(var(--hue) 55% 55%)` in CSS, with `hsl(${sessionHue(id)} 55% 55%)` in `ui/fleet/encodings.ts`. This is identity, not state, and is the only non-token colour allowed in CSS or TS.

Literal allowlist: `OFFLIMITS_TS` in `tokens.test.ts` exempts only `ui/graph/names.ts`, which holds the four pinned graph state values the parity test compares against `:root`. Every other TypeScript file is covered by the literal guard and the accent policy.

### Onboarding sheet
The only modal: a fixed overlay of `--bg` at 86% over the app, with a centred `--bg-panel` sheet, 10px radius, `--border`, `1.4rem` padding, `min(520px, 90vw)` wide, and a `--text` sans `h2`.

## 6. Do's and Don'ts

### Do:
- **Do** build every new surface from the `:root` tokens and the `--fs-*` scale; add a token (see Adding a token) before reaching for a literal.
- **Do** spend `--accent` only on location, pressed state and the primary action (The Accent Budget Rule).
- **Do** put a word beside every state colour: "needs you", "landed", "paused", "failed", "unknown".
- **Do** set data in the monospace face and prose in `--font-sans`.
- **Do** name sessions and worktrees the way the user would (what was asked, where, by which agent, when) and show the hash only as a copyable detail in the `--fs-xs` id style.
- **Do** keep scope and selection when moving between Fleet, Project, Worktree and Session; Escape ascends one rung.
- **Do** give every clickable row a keyboard path and a visible focus state: a 2px `--focus` outline, or a `--focus` stroke on an SVG hit area.
- **Do** separate with hairlines and tonal steps; draw missing evidence as dashed or dotted borders and the word "unknown".
- **Do** respect `prefers-reduced-motion`; motion only conveys a state change and eases out.
- **Do** set clocks, counts and ranges in tabular numerals and truncate long summaries with an ellipsis at a fixed `ch` width.

### Don't:
- **Don't** build SaaS analytics dashboards: no hero metrics, no KPI tiles, no gradient accents, no identical card grids.
- **Don't** reach for the observability "dark blue with neon" skin, glassmorphism or gradient text.
- **Don't** add chat-app friendliness: no avatars, no rounded bubbles, no emoji status.
- **Don't** identify a thing by its hash when a human name exists; a UUID is never a label, a heading or a breadcrumb crumb.
- **Don't** add new `border-left` or `border-right` stripes wider than 1px on rows, bands or warnings; use a full border, a background tint or a leading badge. Existing 3px stripes (the identity hue on band rows, the five airspace band markers, the capture warning, the loops disclosure, and the court, airspace and loom notices) are recorded debt, not a precedent.
- **Don't** write `outline: none` on anything focusable without a replacement focus treatment for `:focus-visible`.
- **Don't** add a second time control, repository picker or event list to a view; the transport, the scope store and the shared lists already exist.
- **Don't** introduce colour literals (hex, `rgb()`, `hsl()`, `oklch()` and the rest) outside `:root`, in CSS or TypeScript; the test fails.
- **Don't** dim text with `opacity`; use `--text-dim`.
- **Don't** nest containers or wrap rows in cards; a unit row is already the container.
- **Don't** use pure `#000` or `#fff`; text on a coloured fill uses `--on-err`, `--on-fill` or `--bg`.
- **Don't** use em dashes in interface copy.

<details>
<summary>Token inventory (after slice 13)</summary>

All custom properties live on `:root` in `apps/tauri-desktop/src/styles.css`. The first block holds the hex fallbacks; a second `:root` block under `@supports (color: oklch(0 0 0))` overrides the neutrals, roles, fills and map ramp with `oklch()`.

- Neutrals: `--bg`, `--bg-panel`, `--bg-hover`, `--border`, `--text`, `--text-dim` (hex + oklch).
- Roles: `--accent`, `--needs`, `--selected`, `--focus`, `--stale`, `--fog`, `--ok`, `--warn`, `--err` (hex + oklch).
- Fills: `--on-err`, `--on-fill` (hex + oklch).
- Activity Map ramp: `--map-zero`, `--map-heat` (hex + oklch).
- Graph agent states: `--attention`, `--working`, `--observed`, `--none` (hex only, pinned to `ui/graph/names.ts`).
- Categorical series: `--series-1`, `--series-2`, `--series-3`, `--series-4`, `--series-5` (hex only).
- Replay: `--replay-alt`, `--replay-alt-bg` (hex only).
- Type: `--fs-xs`, `--fs-sm`, `--fs-base`, `--fs-md`, `--fs-lg`, `--font-sans`. The monospace stack is the `:root` `font-family`, not a token.
- Locally set: `--hue` only, per band row from `ui/sessions.ts`.

Deleted: the `--g-*` graph palette (`--g-bg` through `--g-font`), `--muted`, and every colour literal that was outside `:root`.

No colour literals remain outside `:root` in `styles.css` or application TypeScript, except two allowlisted cases: the identity hue `hsl(var(--hue) 55% 55%)` (with its TS twin in `ui/fleet/encodings.ts`), and the four pinned state values in `ui/graph/names.ts` (`#f0b429`, `#34d399`, `#7a5cf0`, `#7d8aa0`), which `--attention`, `--working`, `--observed` and `--none` must equal. `tokens.test.ts` enforces this.

Remaining literal font stacks (faces, not colours): `ui-monospace, SFMono-Regular, Menlo, monospace` on `.session-id`, `.agent-id`, `.graph-inspector code` and `.parent-link`, and bare `monospace` on `.scope-crumb .unresolved`. Radii are literals by design: 6px for fields and rows, 8px for groups and popovers, 4px for transport controls, 3px for tags, 999px for pills, 10px for the sheet.

</details>

## 7. Adding a token

1. Add the hex fallback to the first `:root` block, in the right group.
2. For a neutral, role or fill, add the `oklch()` override in the `@supports` block and generate the hex from it with `oklchToHex` in `src/tokens-helpers.ts`. Status and series colours stay hex only.
3. Use it as `var(--name)` in CSS and TS. No colour literals outside `:root`, and no custom properties set outside `:root` except `--hue`.
4. Check contrast against `--bg` and `--bg-panel` with `contrast()`; text must meet 4.5, non-text UI 3.
5. If it is an accent-family colour, confirm every selector that uses it is on the allowlist in Accent rules.
6. Add the token to the Token table in this file and to the frontmatter `colors` (the DESIGN.md test fails if a `:root` token is missing from the body), update `.impeccable/design.json`, then run `pnpm -C apps/tauri-desktop test`.

## 8. Browser baseline

The shell runs in the system WKWebView. The bundle sets `minimumSystemVersion` 13.1 in `tauri.conf.json`, the first macOS with Safari 16.2.

- `oklch()`: Safari 15.4+. The hex fallback covers oklch only: an engine without `oklch()` ignores the `@supports` block and renders the hex values.
- `color-mix()`: Safari 16.2+ (macOS 13.1+). There is no CSS fallback for `color-mix()`; soft dividers, selection washes, the scrim and the popover shadows rely on it, so the 13.1 minimum is what guarantees support.
- Dark only. There is no light theme and no `prefers-color-scheme` switch.

## 9. PRODUCT.md link

Register, users, personality and accessibility commitments are in [PRODUCT.md](PRODUCT.md), which links back here. Design decisions that change either should update both.
