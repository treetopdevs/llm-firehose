---
name: Agent Firehose
description: Local-first operations board for many AI coding agents across worktrees and time
colors:
  night-ink: "#0d1117"
  panel-slate: "#161b22"
  hover-slate: "#1f2630"
  hairline: "#30363d"
  row-hairline: "#1a2029"
  paper: "#e6edf3"
  paper-dim: "#8b949e"
  ember: "#ff6a00"
  ember-wash: "#ff6a0024"
  needs-you-amber: "#ff9f43"
  landed-green: "#3fb950"
  caution-gold: "#d29922"
  fault-red: "#f85149"
  graph-abyss: "#0b121b"
  graph-panel: "#0e1621"
  graph-raised: "#141d2b"
  graph-line: "#233245"
  graph-line-strong: "#34465c"
  graph-teal: "#2de2d0"
  graph-purple: "#7a5cf0"
  graph-amber: "#f0b429"
  graph-green: "#34d399"
  graph-gray: "#7d8aa0"
  graph-red: "#f4605f"
  graph-paper: "#d8e5ef"
  graph-paper-dim: "#8b9bb0"
  map-zero: "#172231"
typography:
  body:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
  title:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "1rem"
    fontWeight: 700
  subtitle:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "15px"
    fontWeight: 600
  section:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.9rem"
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
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.04em"
  graph-body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
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
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.field}"
    padding: "{spacing.row}"
  button-hover:
    backgroundColor: "{colors.hover-slate}"
  button-primary:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.ember}"
    rounded: "{rounded.field}"
    padding: "{spacing.row}"
  button-pressed:
    textColor: "{colors.ember}"
  input:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.field}"
    padding: "0.3rem 0.5rem"
  nav-item:
    backgroundColor: "{colors.night-ink}"
    textColor: "{colors.paper}"
    padding: "{spacing.row}"
  nav-item-active:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.ember}"
  segment-group:
    backgroundColor: "{colors.night-ink}"
    textColor: "{colors.paper-dim}"
    rounded: "{rounded.group}"
    padding: "7px 16px"
  segment-selected:
    backgroundColor: "{colors.ember-wash}"
    textColor: "{colors.paper}"
  unit-row:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.field}"
    padding: "4px 10px"
  badge:
    textColor: "{colors.paper-dim}"
    typography: "{typography.label}"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.35rem"
  badge-needs:
    backgroundColor: "{colors.needs-you-amber}"
    textColor: "#000000"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.35rem"
  badge-error:
    backgroundColor: "{colors.fault-red}"
    textColor: "#ffffff"
    rounded: "{rounded.tag}"
    padding: "0.1rem 0.35rem"
  transport-control:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "3px 8px"
  transport-track:
    backgroundColor: "{colors.panel-slate}"
    rounded: "7px"
    height: "14px"
  onboarding-sheet:
    backgroundColor: "{colors.panel-slate}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sheet}"
    padding: "{spacing.sheet}"
---

# Design System: Agent Firehose

<!-- Current-state baseline, documented 2026-11-01 from the desktop shell at the slice 10 tip
     (feat/shell-transport, 9f43b06, PRs #57 through #67). Slice 13 (D116) replaces the token
     layer; it should rewrite this file rather than add a second one. -->

## 1. Overview

**Creative North Star: "The Operations Board"**

Agent Firehose is read the way a flight-operations board or a well-kept lab notebook is read: between turns, at a glance, to answer four questions. Which agent needs me. What is each one doing. Where, meaning which checkout and branch. What did a finished session actually do. The interface is therefore dense, monospaced, flat and dark, with one warm ember accent that is spent only on what the operator must act on or has selected. Nothing is decorated. Every row carries evidence from captured events, and missing evidence is drawn as absence (dashed borders, "unknown"), never as a guess.

The shell is a single monospace system, 13px on near-black, with hairline borders separating panels instead of shadows or tonal steps. Hierarchy comes from dimming (paper versus paper-dim) and from weight, not from size: the largest text in the product is a 1rem title. Colour is a vocabulary with fixed meanings. Ember is the accent, attention and selection. Amber means "needs you". Green means landed or copied. Gold is caution. Red is a fault. The one deliberate exception is the workspace graph, which carries its own cooler, sans-serif palette (teal, purple, amber, green on an abyss blue) scoped under its own root; this file records that palette as it is today, and slice 13 is expected to fold it onto the shell tokens.

This system explicitly rejects the SaaS analytics dashboard (hero metrics, KPI tiles, gradient accents, identical card grids), the observability "dark blue with neon" skin, glassmorphism and gradient text, chat-app friendliness (avatars, bubbles, emoji status), and any surface that identifies a thing by its hash when a human name exists.

**Key Characteristics:**
- Monospace throughout the shell; tabular numerals on clocks and ranges.
- Flat surfaces, 1px hairlines, no shadows except the onboarding sheet and graph overlays.
- One accent (ember) at well under 10% of any screen; state hues each carry one meaning and always sit next to a word.
- Density first: 12px and 11px are the working sizes, 13px is body, 1rem is a title.
- Rows and lanes, not cards: a unit of the fleet is a bordered row whose border style encodes its state.
- Keyboard parity is a requirement, not a feature: every clickable row must have a keyboard path and a focus-visible treatment (today five SVG rows and the session and feed openers still fall short; see the inventory).

## 2. Colors

A near-black ink with a cool grey cast, two steps of slate for panels and hover, paper-white text in two strengths, and a single hot ember accent; four state hues complete the vocabulary.

### Primary
- **Ember** (`#ff6a00`): the brand mark in the sidebar, the active nav item, pressed presets and Live on the transport, the selected fleet row's outline, the open span on a lane, the current repository's border, and the shell's focus rings (the graph rings in teal and Loops in `currentColor`, both debt). It is the only colour that means "you are here" or "this is active". Used as a 14% wash (`#ff6a0024`) behind the selected session tab.

### Secondary
- **Needs-you Amber** (`#ff9f43`): the "needs you" badge (black text on amber), bold lane labels and ticks for sessions waiting on the operator, the strip count. Warmer and lighter than Ember so the two read as kin: Ember is where you are, Amber is where you should go. Today it is a bare literal in eleven places; it should become a token.

### Tertiary
- **Landed Green** (`#3fb950`): ok state, a copied id, healthy doctor rows.
- **Caution Gold** (`#d29922`): warn state, a paused feed, the session "reason" line, the needs count in Fleet.
- **Fault Red** (`#f85149`): error state, failed worktrees, error badges (white text on red), error ticks on lanes.

### Neutral
- **Night Ink** (`#0d1117`): the page and sidebar background.
- **Panel Slate** (`#161b22`): buttons, inputs, fleet rows, attention rows, the onboarding sheet, the active nav item's background.
- **Hover Slate** (`#1f2630`): hover and focus fill on rows, cells and lanes.
- **Hairline** (`#30363d`): every border, divider and axis line.
- **Row Hairline** (`#1a2029`): the quieter divider between feed rows and under lane baselines.
- **Paper** (`#e6edf3`): primary text and lane labels.
- **Paper Dim** (`#8b949e`): secondary text, times, categories, headings at h3 level, idle badges, axis text.

### Workspace graph palette (scoped, legacy)
Defined on `.workspace-graph` only and not visible elsewhere. **Graph Abyss** (`#0b121b`) background, **Graph Panel** (`#0e1621`) and **Graph Raised** (`#141d2b`) surfaces, **Graph Line** (`#233245`) and **Graph Line Strong** (`#34465c`) strokes, **Graph Paper** (`#d8e5ef`) and **Graph Paper Dim** (`#8b9bb0`) text. Semantic hues: **Graph Teal** (`#2de2d0`) is the graph's accent, focus ring and the Activity Map's single sequential heat hue over **Map Zero** (`#172231`); **Graph Purple** (`#7a5cf0`), **Graph Amber** (`#f0b429`), **Graph Green** (`#34d399`), **Graph Gray** (`#7d8aa0`) and **Graph Red** (`#f4605f`) encode revision kinds in `ui/graph/names.ts`. Smaller categorical sets live in `ui/ecosystem/map.ts`, `ui/handoffs/map.ts`, `ui/replay/map.ts`, `ui/loom/map.ts` and `ui/airspace/map.ts` as literals.

### Named Rules
**The Ember Budget Rule.** Ember marks location and selection, nothing else. If a screen shows ember on more than one thing the operator did not just choose, something is miscoloured.

**The Word Beside the Dot Rule.** No hue carries state alone. Amber, green, gold and red always sit next to the word they mean ("needs you", "landed", "paused", "failed"), because the user may be colour-blind, the display may be dimmed, or the badge may be the only thing in view.

**The One Palette Rule.** New surfaces use the shell tokens (`--bg`, `--bg-panel`, `--bg-hover`, `--border`, `--text`, `--text-dim`, `--accent`, `--ok`, `--warn`, `--err`). The graph's `--g-*` set and the remaining literals are debt recorded in the token inventory below, not a second system to extend.

## 3. Typography

**Display Font:** none; the product has no display tier.
**Body Font:** ui-monospace (SFMono-Regular, Menlo, Consolas, monospace fallbacks)
**Label/Mono Font:** the same monospace stack; the workspace graph alone uses ui-sans-serif / system-ui.

**Character:** A terminal that learned to align. Everything is set in the platform's monospace at 13px, so identifiers, paths, clocks and prose share one rhythm and columns line up without a table. Weight (400 against 600 and 700) and dimming do the work that size does elsewhere.

### Hierarchy
- **Title** (700 by browser default, 1rem): panel headings (`h2`) such as "Project"; the Session altitude title is the same size at 600. The largest text in the shell apart from the onboarding sheet's 20px heading.
- **Subtitle** (600, 15px): the session heading inside the Sessions list.
- **Section** (400, 0.9rem, paper-dim): `h3` inside content panels; dimmed rather than enlarged.
- **Body** (400, 13px): rows, cells, controls, detail text. Prose blocks in attention rows run at 1.5 line height and are capped by the inbox's 1100px column; keep paragraphs under 75ch where layout allows.
- **Meta** (400, 12px, usually paper-dim): session subtitles, detail crumbs, lane labels, transport readout, times. The most common size in the stylesheet.
- **Axis** (400, 11px): axis ticks, lane state words, the copyable session id, hints.
- **Label** (700, 10px, 0.04em, UPPERCASE): badges. Nav group headings use 10px, 0.08em, uppercase at 55% opacity.

### Named Rules
**The No Display Rule.** Nothing in the shell is larger than 1rem except the onboarding sheet. Emphasis is weight or ember, never size.

**The Tabular Clock Rule.** Any time, range, count or hash is set with `font-variant-numeric: tabular-nums` so columns do not shiver as values change.

## 4. Elevation

The system is flat. Depth is conveyed by hairlines and by two tonal steps (Night Ink page, Panel Slate controls and rows, Hover Slate on hover), never by shadow. Borders also encode state on fleet rows: solid for a known unit, dashed for fog (no recent evidence), dotted for a unit with no repository, ember for the current checkout, red for a failed one. The only shadows in the product are the onboarding overlay's dimmed backdrop (`rgba(4, 6, 10, 0.86)`), the graph's floating inspector and legend (`0 12px 32px rgba(0, 0, 0, 0.55)`), and focus rings drawn as 2px box-shadows inside the graph where an outline would box an SVG group.

### Shadow Vocabulary
- **Sheet lift** (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55)`): only for a transient panel floating over the graph canvas.
- **Ring focus** (`box-shadow: 0 0 0 2px var(--accent)` or `inset 0 0 0 2px var(--g-teal)`): focus on the graph canvas, map strip and the fleet change flash; outline is preferred everywhere an outline fits.

### Named Rules
**The Hairline Rule.** Separate with a 1px `--border` line or a tonal step, never a shadow. If a new surface needs a shadow to be seen, its background step is wrong.

**The Border Speaks Rule.** On a unit row the border style is data (solid, dashed, dotted, ember, red). Do not reuse those styles decoratively.

## 5. Components

### Buttons
- **Shape:** softly squared (6px radius), 1px hairline border, Panel Slate fill, text inherits the body font at 13px.
- **Default:** Panel Slate background, Paper text, `0.35rem 0.8rem` padding, `0.15rem` outer margin.
- **Hover / Focus:** hover shifts the fill to Hover Slate; focus-visible draws a 2px ember outline with 2px to 3px offset (per panel today; the shell should own it).
- **Primary:** same shape with an ember border and ember text; no filled accent buttons exist.
- **Pressed / toggled** (`aria-pressed="true"`, `.active`): ember border and ember text. The feed's paused toggle uses Caution Gold instead.
- **Nav item:** borderless, backgroundless, left-aligned; active is ember text on Panel Slate.

### Segmented groups (tabs, graph Fit/All, session lenses)
- **Style:** an 8px-radius hairline frame with `overflow: hidden`; children are square buttons with `7px 16px` padding separated by 1px hairlines.
- **State:** the selected segment in the Session altitude is a 14% ember wash with Paper text; in the graph it is teal text on a deep teal fill. Keyboard: Arrow, Home and End move selection; focus-visible is a 2px ember outline inset by 2px.

### Chips and badges
- **Badge:** 10px, 700, uppercase, 0.04em tracking, 3px radius, hairline border, `0.1rem 0.35rem` padding. Idle and dim variants are Paper Dim text on no fill.
- **Needs badge:** black text on Needs-you Amber, border the same amber.
- **Error badge:** white text on Fault Red.
- **Lens chips** (session lens head): pill (999px), hairline border, 0.75rem text, `1px 10px` padding.
- **Copyable id** (`.session-id`): 11px monospace, Paper Dim, transparent border that becomes a hairline on hover, `cursor: copy`, turns Landed Green when copied. The id is a detail under the name, never the name.

### Unit rows (fleet, attention, sessions)
- **Corner style:** 6px radius.
- **Background:** Panel Slate on Night Ink; hover to Hover Slate.
- **Border:** 1px hairline, with the state styles from Elevation; selected adds a 1px ember outline offset 1px.
- **Internal padding:** `4px 10px` on fleet rows, `.8rem 1rem` on attention rows, `0.18rem 0.4rem` on feed rows.
- **Content:** label in Paper, secondary facts in Paper Dim, summary truncated with an ellipsis at a fixed character width (36ch on needs rows).
- **Change flash:** a 1.6s ease-out fade from Hover Slate and a 2px ember ring to transparent, disabled under `prefers-reduced-motion`.

### Inputs / Fields
- **Style:** Panel Slate fill, 1px hairline, 6px radius, `0.3rem 0.5rem` padding, body font; selects match inputs.
- **Focus:** 2px ember outline, 3px offset (graph fields use a teal border shift instead).
- **Search:** a native `type="search"` that stretches to fill its bar.

### Navigation
- **Sidebar:** 130px wide, Night Ink, right hairline, `0.8rem 0.5rem` padding, vertical stack with 0.3rem gaps. The brand word is ember, 700 weight, 0.08em tracking.
- **Groups:** headings at 10px uppercase, 0.08em tracking, 55% opacity; current groups are Altitudes, Lenses and Housekeeping.
- **Items:** borderless buttons, left-aligned; active is ember text on Panel Slate. Items should carry `aria-current` and sentence-case names (today they are lowercase codenames).
- **Footer breadcrumb:** Fleet › Project › Worktree › Session in body text, unresolved ids in monospace at 70% opacity.

### Transport (signature component)
The shell-owned time control under the header, bound to the shared `scope.window`. A 12px row with 8px gaps and a bottom hairline: four presets (2h, 8h, 24h, 7d), Live, Hold, a tabular-numeric range readout in Paper Dim, and a 14px-high slider track with a 7px radius, Panel Slate fill and a hairline border. The thumb is ember at 70% opacity and slides with a 120ms ease (disabled under reduced motion). Controls are 4px-radius Panel Slate buttons with `3px 8px` padding; pressed state is ember border and text; disabled state is 45% opacity with a not-allowed cursor. The track is a `role="slider"` with Arrow and Home keys; Escape during a drag restores the window.

### Lanes (signature component)
SVG rows of time: an axis in 11px Paper Dim with 1-on-3 dashed hairline gridlines, a Row Hairline baseline, spans in Paper Dim at 45% opacity (ember at 50% while open), ticks in Paper (red for errors, amber for needs), and a transparent hit rectangle that fills Hover Slate on hover or focus. Lane labels are 12px Paper, state words 11px Paper Dim, and a lane that needs the operator goes bold amber. Arrow keys and 1 to 9 pick a lane, Enter opens it.

### Onboarding sheet
The only modal: a fixed overlay at `rgba(4, 6, 10, 0.86)` with a centred Panel Slate sheet, 10px radius, hairline border, `1.4rem` padding, `min(520px, 90vw)` wide, ember `h2`.

## 6. Do's and Don'ts

### Do:
- **Do** build every new surface from the ten shell tokens on `:root` and the type sizes above; add a token before adding a literal.
- **Do** spend ember only on location and selection (The Ember Budget Rule) and keep it under 10% of any screen.
- **Do** put a word beside every state colour: "needs you", "landed", "paused", "failed", "unknown".
- **Do** name sessions and worktrees the way the user would (what was asked, where, by which agent, when) and show the hash only as a copyable detail in the 11px id style.
- **Do** keep scope and selection when moving between Fleet, Project, Worktree and Session; Escape ascends one rung.
- **Do** give every clickable row a keyboard path and a visible focus state: 2px ember outline, or a Hover Slate fill on an SVG hit area.
- **Do** separate with hairlines and tonal steps; draw missing evidence as dashed or dotted borders and the word "unknown".
- **Do** respect `prefers-reduced-motion`; motion only conveys a state change and eases out.
- **Do** set clocks, counts and ranges in tabular numerals and truncate long summaries with an ellipsis at a fixed `ch` width.

### Don't:
- **Don't** build SaaS analytics dashboards: no hero metrics, no KPI tiles, no gradient accents, no identical card grids.
- **Don't** reach for the observability "dark blue with neon" skin, glassmorphism or gradient text; the graph's teal-on-abyss palette is recorded debt, not a precedent.
- **Don't** add chat-app friendliness: no avatars, no rounded bubbles, no emoji status.
- **Don't** identify a thing by its hash when a human name exists; a UUID is never a label, a heading or a breadcrumb crumb.
- **Don't** use `border-left` or `border-right` wider than 1px as a coloured stripe on rows, bands or warnings; use a full border, a background tint or a leading badge.
- **Don't** write `outline: none` on anything focusable without a replacement focus treatment in the same rule.
- **Don't** add a second time control, repository picker or event list to a view; the transport, the scope store and the shared lists already exist.
- **Don't** introduce new hex or rgba literals in `styles.css` or `ui/*/map.ts`; `#ff9f43` appearing eleven times is the cautionary tale.
- **Don't** nest containers or wrap rows in cards; a unit row is already the container.
- **Don't** use pure `#000` or `#fff` for new text or fills; the two existing uses (needs and error badge text) should move to tinted neutrals when the token layer lands.
- **Don't** use em dashes in interface copy.

<details>
<summary>Token inventory (current state, for the slice 13 migration)</summary>

Custom properties, all in `apps/tauri-desktop/src/styles.css`:

| Line | Property | Value |
|---|---|---|
| 2 | `--bg` | `#0d1117` |
| 3 | `--bg-panel` | `#161b22` |
| 4 | `--bg-hover` | `#1f2630` |
| 5 | `--border` | `#30363d` |
| 6 | `--text` | `#e6edf3` |
| 7 | `--text-dim` | `#8b949e` |
| 8 | `--accent` | `#ff6a00` |
| 9 | `--ok` | `#3fb950` |
| 10 | `--warn` | `#d29922` |
| 11 | `--err` | `#f85149` |
| 401 to 413 | `--g-bg` `--g-panel` `--g-raised` `--g-line` `--g-line-strong` `--g-teal` `--g-purple` `--g-amber` `--g-green` `--g-gray` `--g-red` `--g-text` `--g-dim` | scoped on `.workspace-graph`, values in the Colors section |
| 414 | `--g-font` | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| 416, 417 | `--map-heat`, `--map-zero` | `#2de2d0`, `#172231` |

Colour literals outside custom properties (file: line=value):

- `styles.css`: 115=#1a2029 · 200=#000, #ff9f43 ×2 · 201=#fff · 220, 239, 266, 272, 289, 296, 764, 1008=#ff9f43 · 291=#1a2029 · 347=#fff · 357=rgba(4,6,10,.86) · 443, 476, 489=#17263a · 474, 487=rgba(0,0,0,.55) · 485, 693=#10413f · 498, 699=#5a4a1c, #e7bd68, rgba(40,32,12,.92) · 505=#0f1c29 · 517=rgba(0,0,0,0) · 520=#eafffb · 526=#c2cbe0 · 539=#55708f · 540=#0e3a3d, rgba(45,226,208,.7) · 545, 546=#ffffff · 552=#4f6684 · 554=#26251d · 556=#271b23 · 558=rgba(125,138,160,.06) · 574=#0b121b · 578=#5f7088 · 581=rgba(14,22,33,.92) · 627=#b6c6da · 632, 634=#6ea8ff · 654=rgba(14,22,33,0) · 658=#0e3a3d · 678=#17212d, #a9bad0 · 679=#263748 · 681=#263a3c, #42daca · 682=#1c2937 · 700=#5c2a2a · 716=#062421 · 756=#1a2029 · 780=rgba(128,128,128,.06) · 781=#ed927c · 853, 862=#e7bc65 · 863=#df8d91 · 864=#78bdd4 · 865=#929aa8 · 866=#91bca5 · 1106=rgba(255,106,0,.14)
- `ui/graph/names.ts`: 16=#f0b429 · 17=#34d399 · 18=#7a5cf0 · 19=#7d8aa0 · 58=#abcd1234 (a fixture-like string, verify before migrating)
- `ui/ecosystem/map.ts`: 10=#81b9ec, #8ab897, #a0a6b3, #e27d77 · 14=#151d21, #34404e · 17=#485e4f · 18=#75818d, #d7ab63
- `ui/handoffs/map.ts`: 3=#73b7ff, #76d7ba, #b59aff, #ee91b0, #f2ba72
- `ui/replay/map.ts`: 12=#211d29, #7aa6c8, #bb9ad3 · 14=#bb9ad3
- `ui/loom/map.ts`: 21=#f0a970
- `ui/airspace/map.ts`: 12=#34404e

Type sizes in `styles.css` by frequency: 12px ×45, 11px ×22, 15px ×4, 10px ×4, 14px ×3, 13px ×2, 1rem ×3, 20px, 1.1rem, 0.95rem, 0.9rem, 0.8rem, 0.75rem, 9px. Radii: 6px ×16, 8px ×8, 4px ×7, 999px ×5, 3px ×4, 5px ×3, 0 ×3, 50% ×2, 2px ×2, 7px, 10px. Font stacks: the `:root` monospace stack (line 12), `ui-monospace, SFMono-Regular, Menlo, monospace` (184, 620, 627, 630), bare `monospace` (906), `var(--g-font)` (425, 432, 509, 710).

Focus debt (`outline: none` without a same-rule replacement): `styles.css` 236, 262, 284, 752, 1006. Line 544 is exempt (the pill stroke is the indicator, lines 545 and 546).

</details>
