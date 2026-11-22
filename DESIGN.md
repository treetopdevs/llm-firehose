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
  selected: "#2c2825"
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
  selected-wash: "#2c2825"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, system-ui, Segoe UI, Roboto, sans-serif"
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
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.text}"
  toolbar:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    padding: "0.25rem 0.8rem"
    height: "44px"
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
    padding: "0 8px"
    height: "28px"
  transport-track:
    backgroundColor: "{colors.bg-panel}"
    rounded: "{rounded.field}"
    height: "24px"
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

Agent Firehose is read the way a flight-operations board or a well-kept lab notebook is read: between turns, at a glance, to answer four questions. Which agent needs me. What is each one doing. Where, meaning which checkout and branch. What did a finished session actually do. The interface is therefore dense and flat, in the light or dark appearance the system is set to, and colour is spent on state, not decoration. Every row carries evidence from captured events, and missing evidence is drawn as absence (dashed borders, "unknown"), never as a guess.

One token layer in `apps/tauri-desktop/src/styles.css` (`:root`) is the only place colour, type size and the sans face are defined. Neutrals are a near-black ink tinted toward the accent hue (60) at very low chroma, with hairline borders separating panels instead of shadows. Data (ids, paths, branches, timestamps, counts) is set in the platform monospace at 13px; prose (headings, notes, help text, onboarding) is set in the system sans. Hierarchy comes from dimming (`--text` against `--text-dim`) and from weight; the five-step type scale tops out at 16px. Colour is a vocabulary with fixed meanings: `--accent` for the primary action, `--needs` for "needs you", `--selected` as the neutral fill behind whatever is selected, `--focus` for the keyboard ring, and `--ok`, `--warn`, `--err` for landed, caution and fault. The workspace graph consumes the same tokens; it no longer has a palette of its own.

Product intent (register, users, tone) lives in [PRODUCT.md](PRODUCT.md).

This system explicitly rejects the SaaS analytics dashboard (hero metrics, KPI tiles, gradient accents, identical card grids), the observability "dark blue with neon" skin, glassmorphism and gradient text, chat-app friendliness (avatars, bubbles, emoji status), and any surface that identifies a thing by its hash when a human name exists.

**Key Characteristics:**
- System sans by default; monospace with tabular numerals for evidence (identifiers, clocks, durations, paths, payloads).
- Light and dark, following `prefers-color-scheme`; every colour token has a value per appearance.
- Flat surfaces, 1px hairlines; shadows only on the transient popovers (graph search results, graph overflow menu, actions menu), the selected workspace pill, the modal scrims, focus rings that cannot be outlines and the fleet change flash.
- Attention earns colour: accent-family tokens appear only on focus, selection, the primary action, needs-you and errors (tested by selector).
- Density first: five type steps, 11px to 16px, every `font-size` a `var(--fs-*)`.
- Rows and lanes, not cards: a unit of the fleet is a bordered row whose border style encodes its state.
- Keyboard parity is a requirement: every clickable row must have a keyboard path and a focus-visible treatment. One global `:focus-visible` rule in `styles.css` draws a 2px `--focus` indicator on every focusable surface, including feed rows, session items and Project beads. Session cards, feed rows and beads activate with Enter and Space. Keys are owned by `src/keys.ts`; element-local handlers share their descriptors with the registry. Glyph geometry and badge strings live in `src/glyphs.ts`. `?` opens the generated legend (`ui/legend.ts`), which mirrors `viewHelp` in `internal/tui/view.go`.

## 2. Colors

A warm near-black ink, two surface steps for panels and hover, text in two strengths, one hot accent, and a small set of role and state hues. The same roles exist in a light and a dark appearance; the table below is the dark one and "Light appearance" follows it.

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
| `--selected` | oklch(0.28 0.008 60) | #2c2825 | neutral fill | neutral fill |
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

- `--border` is 3:1 or better against both panel backgrounds (non-text UI contrast), so borders read brighter than a typical dark theme. Soft dividers (feed rows, lane baselines, the graph frame) use `color-mix()` of `--border`; selection is the `--selected` token used whole, never mixed. The frontmatter's `selected-wash` repeats it for the linter.
- `--bg-*` neutrals are surfaces, not text. `--fog` is a stroke colour (graph ground), not text.
- `--replay-alt` / `--replay-alt-bg` mark the hypothetical lane and fork anchor in Replay. Hex only.
- Some tokens are consumed only from TypeScript and have no rule in `styles.css`: `--fog`, `--replay-alt`, `--replay-alt-bg`, `--series-3`, `--series-4`, `--series-5`, `--observed` (Replay captured) and `--stale` (Ecosystem unknown, plus the quiet airspace band). Do not delete them as unused.

### Light appearance

Chosen by `@media (prefers-color-scheme: light)`: a hex `:root` block, plus an `oklch()` block nested inside the same `@supports` rule as the dark overrides so the light values win in the cascade. `color-scheme` is `dark` or `light` to match, so native controls follow. Every token below meets the same contrast floors as the dark set (text 4.5:1 on `--bg`, `--bg-panel` and `--bg-hover`; `--border`, `--focus`, state and series marks 3:1), tested in four modes: hex and oklch, dark and light.

| Token | Light oklch | Light hex |
| --- | --- | --- |
| `--bg` | oklch(0.985 0.003 60) | #fcfaf8 |
| `--bg-panel` | oklch(0.955 0.004 60) | #f2efed |
| `--bg-hover` | oklch(0.925 0.005 60) | #e9e5e3 |
| `--border` | oklch(0.62 0.008 60) | #8a8581 |
| `--text` | oklch(0.23 0.006 60) | #1f1c1a |
| `--text-dim` | oklch(0.46 0.008 60) | #5c5754 |
| `--accent` | oklch(0.52 0.16 45) | #af4200 |
| `--needs` | oklch(0.5 0.12 65) | #915200 |
| `--selected` | oklch(0.9 0.006 60) | #e1ddda |
| `--focus` | oklch(0.55 0.15 250) | #0f74c5 |
| `--stale` | oklch(0.47 0.015 60) | #615953 |
| `--fog` | oklch(0.78 0.015 250) | #b0b8c1 |
| `--ok` | oklch(0.48 0.13 150) | #067132 |
| `--warn` | oklch(0.5 0.11 80) | #845b00 |
| `--err` | oklch(0.52 0.19 25) | #be222a |
| `--on-err` | oklch(0.985 0.004 25) | #fdf9f9 |
| `--on-fill` | oklch(0.2 0.006 60) | #181513 |
| `--map-zero` | oklch(0.93 0.01 235) | #e2e9ee |
| `--map-heat` | oklch(0.72 0.09 190) | #58b7b1 |

Hex only in light, as in dark: `--attention` #9a6400, `--working` #0f7a4d, `--observed` #5b3fd6, `--none` #5d6b82, `--series-1` #1f6fb2, `--series-2` #a85f12, `--series-3` #3b7d3b, `--series-4` #8546a8, `--series-5` #77700f, `--replay-alt` #7a4fb0, `--replay-alt-bg` #efe7f7. The Activity Map ramp inverts: the zero end is light and `--on-fill` is dark.

The per-session identity hue is data (`--hue`, set per row). Its saturation and lightness are theme tokens, `--hue-s` and `--hue-l` (55% and 55% dark, 60% and 40% light), so the stripe reads on both surfaces.

### Roles
- **Accent** (`--accent`): pressed toggles (lanes, score, attention filters), the primary button's border and text (the inspector's Open), the current checkout's border on fleet rows and forks, the current tick on the score. A selected row and the selected view segment are neutral fills, not accent. It means "you are here", "this is on" or "this is the action". It is no longer on the brand word or the onboarding heading, and no button is filled with it.
- **Needs** (`--needs`): the "needs you" badge (`--bg` text on `--needs`), bold state words and lane labels for sessions waiting on the operator, needs ticks on lanes and the score, the dwell bar of a needing row.
- **Selected** (`--selected`): a neutral fill, one step past `--bg-hover`, behind the selected row, the current sidebar item, the selected segment and pressed toggles. It is only ever a `background` or SVG `fill`; `--text`, `--text-dim`, `--needs`, `--err` and `--ok` all read on it at 4.5:1 in both appearances. Selected marks that cannot take a fill (graph edges, node and chip strokes) use `--text`.
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

Attention earns colour. `--accent`, `--needs` and `--focus` appear only on:

- focus (`:focus`, `:focus-visible`, `:focus-within`, `.focus`), which uses `--focus` everywhere, the graph included
- the Score playhead (`.score-tick.current`), the one place the accent marks a position
- the primary action (`.primary`)
- needs you (`.needs`, `.attention`, `.attention-kind` selectors and similar)
- errors (`.err`, `.error`, `.failed`)

The allowlist is by selector in `tokens.test.ts` (accent policy). Everything else, including the brand, the feed source column (`.cell.source`), captured/observed rows, notices, decorative bars and hover states, uses `--text`, `--text-dim`, `--border`, `--warn` or a neutral. `.attention-kind` itself uses `--text-dim`; it is not an accent user. Do not carry state by colour alone: keep the text label, and prefer a shape or dashed border for muted states.

All focus rings use `--focus`, through the global `:focus-visible` rule or a per-surface override. Selection never uses the accent: `tokens.test.ts` (neutral selection) fails on any selected, pressed or current state painted with `--accent`, and on `--selected` used as anything but a fill.

### Named Rules
**The Accent Budget Rule.** `--accent` marks the one primary action on a screen and the Score playhead, nothing else. Selection is the neutral `--selected` fill, needs-you is `--needs`, and the keyboard ring is `--focus`, so colour on screen means something wants the operator.

**The Word Beside the Dot Rule.** No hue carries state alone. `--needs`, `--ok`, `--warn` and `--err` always sit next to the word they mean ("needs you", "landed", "paused", "failed"), because the user may be colour-blind, the display may be dimmed, or the badge may be the only thing in view.

**The One Palette Rule.** New surfaces, the graph included, use the `:root` tokens. There is no second palette: `--g-*` and `--muted` are gone (tested), and no colour literal may appear outside `:root`.

## 3. Typography

**Display Font:** none; the product has no display tier.
**Default Font:** `--font-sans` (-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif), the `:root` face, for names, labels, controls, headings and prose.
**Evidence Font:** `--font-mono` (ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace) with tabular numerals, for identifiers, hashes, paths, clocks, durations, sparklines and captured payloads.

**Character:** A native Mac tool that keeps its evidence exact. Names and controls are set in the system sans; anything copied from a captured event is monospace so it reads as evidence and lines up in columns. Weight (400 against 600 and 700) and dimming do the work that size does elsewhere.

### Type scale

| Token | Size | Use |
| --- | --- | --- |
| `--fs-xs` | 11px | labels, headings in nav, dense metadata |
| `--fs-sm` | 12px | secondary text, table cells |
| `--fs-base` | 13px | body (`:root` font-size) |
| `--fs-md` | 14px | section headings |
| `--fs-lg` | 16px | panel titles |

`--font-sans` is the `:root` face. `--font-mono` is opt-in, applied by one grouped rule in `styles.css` to the evidence selectors; every `font-family` outside `:root` is one of the two tokens or `inherit` (tested). Every `font-size` declaration in `styles.css` is a `var(--fs-*)` or `inherit`; no ad hoc sizes, at most five steps (tested). Text is dimmed with `--text-dim`, never with `opacity`.

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

The system is flat. Depth is conveyed by hairlines and by two tonal steps (`--bg` page, `--bg-panel` controls and rows, `--bg-hover` on hover), never by shadow. Borders also encode state on fleet rows: solid for a known unit, dashed for fog (no recent evidence), dotted for a unit with no repository, `--text` for the current checkout, `--err` for a failed one. The only shadows are the modal scrims (`color-mix(in srgb, var(--bg) N%, transparent)` at 86% for onboarding, 72% for the keys legend and 70% for the prune confirmation), the graph's search results and overflow menu (`0 12px 32px` of `--bg` at 75%), the actions menu (`0 12px 32px` of `--bg` at 85%), focus rings drawn as 2px box-shadows on the graph canvas and map strip, and the fleet row change flash.

### Shadow Vocabulary
- **Popover lift** (`box-shadow: 0 12px 32px color-mix(in srgb, var(--bg) 75%, transparent)`): only for a transient list floating over the graph (search results, the overflow menu). The actions menu over Fleet and Project uses the same offset at 85%.
- **Ring focus** (`box-shadow: inset 0 0 0 2px var(--focus)` on the graph canvas, `0 0 0 2px var(--focus)` on the map strip): focus where an outline cannot wrap the target. Outline is preferred everywhere an outline fits.
- **Change flash** (`0 0 0 2px var(--text-dim)` fading to transparent): the fleet row change animation.

### Named Rules
**The Hairline Rule.** Separate with a 1px `--border` line, a `color-mix()` of it, or a tonal step, never a shadow. If a new surface needs a shadow to be seen, its background step is wrong.

**The Border Speaks Rule.** On a unit row the border style is data (solid, dashed, dotted, accent, error). Do not reuse those styles decoratively.

### Motion

Two easing tokens live in `:root`; the built-in keywords are too weak to read as intentional.

- `--ease-out` (`cubic-bezier(0.23, 1, 0.32, 1)`): press feedback, and anything entering or leaving.
- `--ease-in-out` (`cubic-bezier(0.77, 0, 0.175, 1)`): things moving across the screen.

The shell is a tool people keep open all day, so motion is rare (the graph's pointer-initiated camera pan is the one movement, see Graph): anything triggered tens of times a day (rows streaming in, nav switches, opening the detail pane) changes in one frame, and keyboard-initiated changes never animate. New motion animates only `transform`, `scale` and `opacity`; the transport thumb (`left`/`width`) and the fleet change flash predate this rule. Reduced motion keeps opacity and drops movement (tested in `motion.test.ts`).

## 5. Components

### Buttons
- **Shape:** softly squared (6px radius), 1px `--border`, `--bg-panel` fill, text inherits the body font at `--fs-base`.
- **Default:** `--bg-panel` background, `--text`, `0.35rem 0.8rem` padding, `0.15rem` outer margin.
- **Press:** `scale: 0.97` (the individual property, so it composes with positioning transforms) over 120ms `--ease-out` on `:active`, off under reduced motion. Nav buttons and session lens tabs stay still: they are switched constantly.
- **Hover / Focus:** hover shifts the fill to `--bg-hover`; focus-visible draws a 2px `--focus` outline with 1px to 3px offset (per panel today; the shell should own it).
- **Primary:** same shape with an `--accent` border and `--accent` text; no filled accent buttons exist.
- **Pressed / toggled** (`aria-pressed="true"`, `.active`): `--selected` fill, `--text`, a `--text-dim` border.
- **Nav item:** borderless, backgroundless, left-aligned, at least 28px tall; the current item is a neutral `--bg-hover` fill (see Chrome).

### Segmented groups (tabs, graph Fit/All, session lenses)
- **Style:** an 8px-radius `--border` frame with `overflow: hidden`; children are square buttons with `7px 16px` padding separated by 1px hairlines.
- **State:** the selected segment is the `--selected` fill with `--text` at weight 600, in the shell and in the graph alike. Keyboard: Arrow, Home and End move selection; focus-visible is a 2px `--focus` outline inset by 2px.

### Chips and badges
- **Badge:** `--fs-xs`, 700, uppercase, 0.04em tracking, 3px radius, `--border`, `0.1rem 0.35rem` padding. Idle and dim variants are `--text-dim` on no fill.
- **Needs badge:** `--bg` text on `--needs`, border the same.
- **Error badge:** `--on-err` text on `--err`.
- **Lens chips** (session lens head): pill (999px), `--border`, `--fs-xs` text, `1px 10px` padding.
- **Copyable id** (`.session-id`): `--fs-xs` monospace, `--text-dim`, transparent border that becomes `--border` on hover, `cursor: copy`, turns `--ok` when copied. The id is a detail under the name, never the name. It is on the session heading and in the inspector; a session row in a list no longer draws it (MS-10).

### Unit rows (fleet, attention, sessions)
- **Corner style:** 6px radius.
- **Background:** `--bg-panel` on `--bg`; hover to `--bg-hover`.
- **Border:** 1px `--border`, with the state styles from Elevation. A selected row (`.selected`, or `.picked` in the Worktree lists) is a neutral `--bg-hover` fill with a 1px `--border` outline, never the accent (MS-6); the fill is the whole signal, so it is also set for the current item of a keyboard walk.
- **Internal padding:** `4px 10px` on fleet rows, `.8rem 1rem` on attention rows, `0.5rem` on session and worktree rows, `0.18rem 0.4rem` on feed rows.
- **Targets (MS-11):** the head of a project row is 28px tall, its disclosure button, a worktree row, a need chip and the Show all button are 24px, a session or worktree row is at least 40px, and the Score and Loops buttons on a session row are 24px. `src/content.test.ts` reads these from the stylesheet.
- **Content:** label in `--text`, secondary facts in `--text-dim`, summary truncated with an ellipsis at a fixed character width (36ch on needs rows).
- **Identity stripe:** session band rows carry a 3px left border in the per-session identity hue, `hsl(var(--hue) 55% 55%)`. This is identity, not state.
- **Change flash:** a 1.6s ease-out fade from `--bg-hover` and a 2px `--text-dim` ring to transparent, disabled under `prefers-reduced-motion`.

### All projects list (`ui/fleet`, the `map` encoding)
One row per project, newest activity first within a stable order. A project row is **one line** (MS-10): a 24px disclosure button, the project name, a needs-you count in `--warn`, the longest wait, the worktrees by status in words ("1 needs you · 3 working · 20 idle · 59 unknown", zeros left out; `summarize()` in `ui/fleet/model.ts`), the activity spark and the last activity (`.fleet-last`, tabular numerals). The needs-you queue of sessions sits under it as before.
- **Disclosure:** a real `button` beside the head, never inside it (the head is a `role="button"`): `aria-expanded`, `aria-controls` the child list, named "Expand alpha" or "Collapse alpha". A project with a needs-you worktree starts expanded; the rest start collapsed. That start is fixed the first time the row is drawn with the attention snapshot, so a refresh never opens or closes a row under the pointer; the user's choice, kept per project across refreshes, always wins. A project with no worktree has no control (it stays in the layout, hidden).
- **Children:** expanded, the row shows its needs-you and working worktrees as rows, needs first, in the row's stable order. Each is one line: the state mark and the state word (needs you, working, idle, unknown, landed, never diverged, gone), the worktree name (the last path segment), what it is doing or waiting on if known (the request it asks, "N sessions working", or why it is unknown), and its age. Selecting and opening are as for any row; the keys stay `fork:` so history restores them.
- **Rest line:** one line under the children counts the remainder by status: "79 more worktrees: 20 idle · 59 unknown (no recent evidence)", with a **Show all** button (`aria-expanded`, 24px) that lists the rest as rows and then reads "Show fewer". "(no recent evidence)" is said only when every unknown one is an open worktree with no activity in 7 days; a state the daemon could not determine says just "unknown". With nothing left over there is no line.
- **Status of a worktree:** needs you, working, idle, unknown, landed, never diverged, gone, claimed in that order. Needs you and working come from the attention poll by `worktree_id`. Idle needs positive evidence: an open worktree whose own last activity is within 7 days, or one a live session reports idle. **Unknown stays unknown:** an open worktree with no readable activity time or none in the last 7 days, and a worktree whose state the daemon could not determine, are unknown with the `◌` mark, in italic `--text-dim`, with a reason, never idle. A project seen only by the needs-you snapshot says "no worktree data", not 0.
- **Steadiness:** a press holds the drawn rows still for 600 ms against data changes, so the second click of a double click lands on what the first did. A selection or a toggle is drawn at once.
- **Switcher:** List and Lanes are tabs, Events too when its host is mounted. Strata and Patches sit behind **More views**. Waiting, Table and By state are retired from the switcher (MS-9); the List carries what they showed. Dwell, Matrix and Airspace are not in the UI either; all of these still resolve by name (`panel.encoding = "dwell"`) and each has a test that renders it.
- **Keys:** arrows select the next or previous row, Enter or Space opens, Escape clears the selection and the inspector, 1 to 9 pick a row, n and N walk the needs-you queue. Right expands a collapsed row; Right again moves to its first worktree; Left on a worktree climbs to the row; Left on an expanded row collapses it (a selection inside it moves to the row).

### Project views
Lanes, Graph, Map, Events and **Sessions** (the old Worktree rung, MS-9). The Sessions chip hosts the same panel the Worktree level uses, so it is the project's worktree list (or its sessions list once a worktree is opened), with the same select, open and Escape rules. It is a view of the Project place: switching to it is a history stop, and Back and Forward restore it with its selected row.

### Select, open, back
Selecting and opening are different moves (MS-8). A single click or an arrow key **selects**: the row takes the neutral fill and the shared pane fills with the inspector. Nothing navigates, the scope is not written, no history entry is added, and focus stays on the row so the arrows keep walking. Enter, Space or a double click **opens**: it narrows the scope and pushes a history entry. The pane never opens unasked. Escape clears the selection and closes the inspector before it goes up a level. The selected row's key is stored in the current history entry, so Back returns to the place with the same row selected and focus on it. A row that is gone falls to the row now at its old place in the list (the last row clamps), and a worktree that is hidden behind a collapsed project or Show all is revealed to be selected. The rule lives in `src/select-open.ts` and is audited in `focusable-audit.test.ts` like `onActivate`.

### Inspector (`ui/inspector.ts`)
The shared right-hand pane, filled by a selection: the kind (Project, Worktree, Session) in `--fs-xs` `--text-dim`, the name as an `h2`, the status as a mark and a word (`--needs` for needs you, `--text-dim` for unknown, with its reason underneath), a facts list (`--fs-sm`, labels `--text-dim`; a fact that was never captured reads "unknown" in italic `--text-dim`, it is not left out and not invented), the native id as a monospace copyable field with a "Copy" button (24px), then one **Open** button (28px, the primary action) and, when the row has some, an **Actions** menu button that opens the row's actions. It does not take focus. A redraw while focus is on one of its controls keeps focus there. At 1100px and under it overlays the content.

### More menu (`ui/more-menu.ts`)
Where a demoted view lives (MS-9). One 28px button reading "More" (or the name of the demoted view that is showing, with the `--bg-hover` fill and 600 weight, so Back to a hidden view is never a mystery) and a `▾`; `aria-haspopup="menu"` and `aria-expanded`. The pop-up is a `--bg-panel` surface (6px radius, `--border`, `--shadow`) of full-width 28px `menuitemradio` items, the current one marked with `aria-checked` and a `--bg-hover` fill. ArrowUp and ArrowDown open it from the button and move through it (wrapping), Home and End jump, choosing an item closes it and returns focus to the button, Tab closes it, and **Escape closes it, returns focus to the button, and is claimed** so the shell does not also go up a level. A press outside closes it. Used by Fleet (Strata, Patches) and Session (Loom, Replay, Handoffs, Court); Score and Loops stay tabs. The demoted tabs keep their `session-tab-*` ids as the menu items, so each tabpanel is still labelled.

### Doctor and capture warnings
Capture warnings and gaps are Doctor's (MS-9). Under the checks, a "capture warnings" heading lists each as a hairline row (`.capture-warning`: the source and summary, when it was recorded, an Inspect button that fills the shared pane), or says "No capture warnings." They are not in the Needs you queue or its count. The Doctor item in the sidebar carries their count (warnings plus gaps). Install buttons live here, and only here: the first-run setup says so and sends the user to Doctor when it ends.

### Settings: replay sound
Replay sound is a Settings choice (MS-9): a checkbox row "replay sound", off by default, kept on this device, with a status line ("Off. A replay is silent.", "Tones play while a session replays.", or that audio is unavailable on this device and will be tried again at the next play) and the tone list as dim text. The Score carries no control. It reads the choice when playback starts (a user action, which is what lets audio open) and still switches sound off when the page hides, the Score is left or another session loads.

### Inputs / Fields
- **Style:** `--bg-panel` fill, 1px `--border`, 6px radius, `0.3rem 0.5rem` padding, body font; selects match inputs.
- **Focus:** 2px `--focus` outline, 3px offset in the panels; graph fields use a `--focus` border on the search frame and a `--focus` outline.
- **Search:** a native `type="search"` that stretches to fill its bar.

### Chrome: sidebar and toolbar
The window is a source list beside a stage. The sidebar answers "where", the toolbar carries history, the title, the view and "when", and the content below is "what" (MS-1). Nothing sits above the toolbar except the compatibility banner when the daemon is too old or new, and there is no status bar and no attention strip. Both parts work under a standard OS title bar: neither assumes the overlay title bar or reserves traffic-light room. Linux and Windows keep their native frame.

**Sidebar** (`src/chrome.ts`, `createSidebar`)
- **Frame:** 200px wide, `--bg-panel`, right `--border`, `0.8rem 0.5rem` padding, a 2px gap between items, scrolls on its own. The brand is the words "Agent Firehose" in `--text` at 700 weight, not accent coloured.
- **Items, in order:** Needs you, All projects, a Projects heading with one row per registered project (alphabetical, so rows never jump as state changes), then a Capture heading with Files and Doctor. All projects shows the project count. Worktree and Session are levels, not things, and have no entry: they are reached by opening one. Fleet is named All projects in visible copy; the code name stays `fleet`.
- **Item:** a borderless, backgroundless, left-aligned button, at least 28px tall, `0.35rem 0.8rem` padding, 6px radius. Hover is `--bg-hover`.
- **Selected:** the current item carries `aria-current="page"` and is drawn with a `--bg-hover` fill, `--text` and 600 weight. Selection is neutral; it is never accent coloured (MS-6), so the fill and the weight carry it, not hue alone.
- **Counts are words:** the Needs you item has a count badge (`--needs`, tabular numerals, an `aria-label` such as "Needs you, 2 sessions"); the Doctor item has a count of capture warnings in `--text-dim`. A project row has a second line of `--fs-xs` text, "1 needs you · 3 active", where "needs you" is `--needs` and "active" is `--text-dim`. A bare dot never carries state. Counts come from the attention poll that already runs every 3 s and add no request.
- **Footer:** the daemon dot and its status line (state, version, schema), the event count in monospace `--text-dim`, then Settings and Keys and symbols as two borderless 28px buttons. Settings also opens on ⌘, and Keys and symbols on `?`.
- **Collapse:** at 900px and under the sidebar leaves the layout and the toolbar toggle (⌃⌘S, `aria-expanded`, `aria-controls="sidebar"`) overlays it on the content with a `--shadow`. Above 900px the toggle hides it for good.

**Toolbar** (`createToolbar`)
- **Frame:** one row, `44px` minimum, `0.25rem 0.8rem` padding, bottom `--border`, wrapping when narrow. Controls are 28px tall.
- **Order:** sidebar toggle, Back and Forward chevrons, the title, the view switcher, then the range at the far edge. A toolbar search (the mock shows one) is not built: the decisions doc gives it no scope.
- **History:** two borderless 28px chevron buttons named "Back" and "Forward", `aria-disabled` and 45% opacity when the history has nowhere to go (not `disabled`, so a button that holds focus keeps it). They are the same moves as ⌘[ and ⌘].
- **Title:** the place name in 600 weight `--fs-md` (All projects, Needs you, Files, Doctor, Settings; Project, Worktree and Session for opened levels), then the breadcrumb (project › worktree › session) in `--text-dim`, unresolved ids in monospace.
- **View switcher:** the shown panel's own switcher (`.fleet-views`, `.project-chips`, `.session-views`: the segmented group plus its More menu) is hosted in the toolbar and handed back to its panel when another panel is shown, so there is one control for "what" and it keeps its keys and roles.
- **Range:** the one time control, see below.
- **Inspector:** at 1100px and under it overlays the content instead of pushing it.

### History
Every move is a place: a panel, its view and what is in scope. ⌘[ goes back and ⌘] forward, and so do the toolbar chevrons (`src/history.ts`, wired in `main.ts`). The time range is not part of a place: Back never changes it, and the range set before a session is opened comes back when the session is left. Each place remembers its scroll position by the key of its first visible row, and a move that removes the focused element hands focus to the new view's heading, never `<body>`.

### Range (signature component, `transport.ts`)
The shell-owned time control, bound to the shared `scope.window`, mounted once in the toolbar. At rest it is one 28px button reading the range ("Live · last 8h", a tabular-numeric readout) with a caret, `aria-expanded` and `aria-haspopup`. Opening it shows a `--bg-panel` pop-up (10px radius, `--border`, `--shadow`, 340px wide) holding four presets (2h, 8h, 24h, 7d), Live, Hold or Return to live, a hint, and a 24px-high slider track with a 6px radius and a `--text-dim` thumb at 70% opacity that slides with a 120ms ease (disabled under reduced motion). Buttons in the pop-up are 28px, 4px radius; a pressed preset is a `--bg-hover` fill with 600 weight, not an accent. Focus moves into the pop-up on open; Escape, or a click outside, closes it and returns focus to the trigger without leaving the place; focus-visible is a 2px `--focus` outline. At the Session altitude presets, Hold and the track are inert (45% opacity, not-allowed cursor). The control is always present (MS-7): on panels that do not read the range it is inert (`aria-disabled`, 45% opacity, a title saying so) and the range is untouched. The track is a `role="slider"` with Arrow and Home keys; Escape during a drag restores the window.

### Lanes (signature component)
SVG rows of time: an axis in `--fs-xs` `--text-dim` with 1-on-3 dashed `--border` gridlines, a soft `--border` baseline, closed spans in `--text-dim` at 45% opacity and open spans in `--text` at 85% (the open span is not accent coloured; tested), ticks in `--text` (`--err` for errors, `--needs` for needs), and a transparent hit rectangle that fills `--bg-hover` on hover or keyboard focus (`:focus-visible`, so a click leaves no hover-like fill behind) and takes a 2px `--focus` stroke on focus-visible. Lane labels are `--fs-sm` `--text`, state words `--fs-xs` `--text-dim`, and a lane that needs the operator goes bold `--needs`. Arrow keys and 1 to 9 pick a lane, Enter opens it.

### Graph

The workspace graph consumes the same tokens. `--g-*` and `--muted` no longer exist. It is scoped under `.workspace-graph`, set in `--font-sans` at `--fs-base` on `--bg`, with its toolbar on `--bg-panel` and controls on `--bg-hover`.

- `--attention`, `--working`, `--observed`, `--none` are the four agent states and are pinned byte-for-byte to `AGENT_STATE_COLOR` in `src/ui/graph/names.ts` (tested by reading that file as text). They are hex only. Until the slice 9 follow-up moves `names.ts` onto the tokens, change a state colour in both places or the parity test fails.
- Selection is a `--selected` fill on the pill with `--text` strokes on pills, chips, nodes and edges; focus is `--focus` (outline, or the pill, chip or node stroke where an outline would box the SVG group), the ground stroke is `--fog`, conflicts use `--warn`/`--err`.
- Ecosystem leaves: attempt `--focus`, complete `--ok`, failed `--err`, unknown `--stale`. Handoff series use `--series-1..5`. Replay captured uses `--observed`; the hypothetical lane uses `--replay-alt` on `--replay-alt-bg`.
- TS renderers emit `var(--token)` strings or classes, not hex.
- Camera: a camera jump the mouse starts (clicking a search result or an inspector parent link) pans over 240ms with the `--ease-in-out` curve (computed in TS as the quartic ease-in-out, `canvas.ts`). Jumps the keyboard starts (Enter in search, Space or Enter on a parent link), jumps that also switch tabs, and every jump under reduced motion land in one frame. Wheel, drag, any arrow key (on the canvas or a focused node), fit and the edge hints stop a running pan where it is.

Names that TypeScript reads from CSS at runtime. Do not rename:

- `--border` (airspace map)
- `--map-heat` and `--map-zero` (Activity Map ramp, `ui/activity/model.ts`)

Identity-hue exception: the locally set property `--hue` (set per element in `sessions.ts`) and `hsl(var(--hue) 55% 55%)` in CSS, with `hsl(${sessionHue(id)} 55% 55%)` in `ui/fleet/encodings.ts`. This is identity, not state, and is the only non-token colour allowed in CSS or TS.

Literal allowlist: `OFFLIMITS_TS` in `tokens.test.ts` exempts only `ui/graph/names.ts`, which holds the four pinned graph state values the parity test compares against `:root`. Every other TypeScript file is covered by the literal guard and the accent policy.

### Onboarding sheet
One of three modals, with the keys legend (`--bg` at 72%) and the prune confirmation (`--bg` at 70%): a fixed overlay of `--bg` at 86% over the app, with a centred `--bg-panel` sheet, 10px radius, `--border`, `1.4rem` padding, `min(520px, 90vw)` wide, and a `--text` sans `h2`.

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
- **Don't** add a second time control, repository picker or event list to a view; the range control in the toolbar, the scope store and the shared lists already exist.
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
- Type: `--fs-xs`, `--fs-sm`, `--fs-base`, `--fs-md`, `--fs-lg`, `--font-sans`, `--font-mono`.
- Radius: `--radius-sm` (4px: tags, small controls), `--radius-md` (6px: fields, rows, groups), `--radius-lg` (10px: sheets). Every `border-radius` is one of these, `999px`, `50%` or `0` (tested).
- Identity hue: `--hue-s`, `--hue-l`.
- Depth: `--shadow` (popover shadow) and `--scrim` (modal backdrop), each a dark ink with alpha in both appearances (`#080605c0` and `#110f0ddb` dark, `#1f1c1a38` and `#1f1c1a66` light). Never mix a shadow or scrim from `--bg`: it turns into a white haze in light (tested).
- Locally set: `--hue` only, per band row from `ui/sessions.ts`.

Deleted: the `--g-*` graph palette (`--g-bg` through `--g-font`), `--muted`, and every colour literal that was outside `:root`.

No colour literals remain outside `:root` in `styles.css` or application TypeScript, except two allowlisted cases: the identity hue `hsl(var(--hue) var(--hue-s) var(--hue-l))` (with its TS twin in `ui/fleet/encodings.ts`), and the four pinned state values in `ui/graph/names.ts` (`#f0b429`, `#34d399`, `#7a5cf0`, `#7d8aa0`), which `--attention`, `--working`, `--observed` and `--none` must equal. `tokens.test.ts` enforces this.

No literal font stacks or radii remain: faces are `--font-sans` and `--font-mono`, radii are the three-step scale.

</details>

## 7. Adding a token

1. Add the hex fallback to the first `:root` block, in the right group.
2. For a neutral, role or fill, add the `oklch()` override in the `@supports` block and generate the hex from it with `oklchToHex` in `src/tokens-helpers.ts`. Status and series colours stay hex only. Add the light value to both light blocks as well.
3. Use it as `var(--name)` in CSS and TS. No colour literals outside `:root`, and no custom properties set outside `:root` except `--hue`.
4. Check contrast against `--bg` and `--bg-panel` with `contrast()`; text must meet 4.5, non-text UI 3.
5. If it is an accent-family colour, confirm every selector that uses it is on the allowlist in Accent rules.
6. Add the token to the Token table in this file and to the frontmatter `colors` (the DESIGN.md test fails if a `:root` token is missing from the body), update `.impeccable/design.json`, then run `pnpm -C apps/tauri-desktop test`.

## 8. Browser baseline

The shell runs in the system WKWebView. The bundle sets `minimumSystemVersion` 13.1 in `tauri.conf.json`, the first macOS with Safari 16.2.

- `oklch()`: Safari 15.4+. The hex fallback covers oklch only: an engine without `oklch()` ignores the `@supports` block and renders the hex values.
- `color-mix()`: Safari 16.2+ (macOS 13.1+). There is no CSS fallback for `color-mix()`; soft dividers, selection washes, the scrim and the popover shadows rely on it, so the 13.1 minimum is what guarantees support.
- Light and dark follow `prefers-color-scheme`. `light-dark()` needs Safari 17.5, above the 13.1 minimum, so the two appearances are written as `@media` blocks.

## 9. PRODUCT.md link

Register, users, personality and accessibility commitments are in [PRODUCT.md](PRODUCT.md), which links back here. Design decisions that change either should update both.
