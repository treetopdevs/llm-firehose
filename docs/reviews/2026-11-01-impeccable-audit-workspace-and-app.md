# Impeccable audit: the workspace visualization and the app as a whole

**Date:** 2026-11-01. **Tree audited:** `feat/fleet-altitude` at 4b0b078 (PR #63, the top
of the change-flow stack), plus the TUI. The main checkout is on the docs branch and still
has the pre-spine shell, so it was not the target.
**Method:** code read of `apps/tauri-desktop/src` and `internal/tui`, a technical sweep
(a11y, performance, theming, responsive, copy) with file:line evidence, and a real-data
render: isolated `firehosed` from the branch on a scratch HOME holding a copy of the last
three spool days (`full` privacy mode, port 4599, never 4517), vite on 1420, Playwright at
1440×900. Screenshots are in `docs/reviews/2026-11-01-impeccable-audit/`
(`landing`, `graph-firehose`, `graph-timeline`, `graph-map`, `attention`, `live`), and the
2026-10-31 Fleet/Project captures on PR #63 were reused.
**Register:** product. **Context:** `PRODUCT.md` present; `DESIGN.md` missing (see the
nudge at the end). No code was changed.

The brief: audit the workspace visualization in particular, and the app as a whole, for
ways to unify and clarify its point, which is to visualize and manage many agents across
repos across time, with HCI, UI and UX lenses and a game-HUD mentality for the semantics.

---

## 1. Audit health score

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 2 | Session cards and feed rows are focusable but click-only; five panels remove the focus outline with no replacement |
| 2 | Performance | 2 | Graph timeline model is unbounded and re-sorts on every live event; feed rebuilds up to 1000 rows per frame |
| 3 | Responsive design | 2 | Graph needs 820px, gets about 570px when the detail pane is open at 1100px; fixed 130/380/340px panes |
| 4 | Theming | 1 | Two unrelated palettes, 84 colour literals outside `:root`, "needs" hard-coded ten times, 13 ad hoc font sizes, mono for prose |
| 5 | Anti-patterns | 2 | Side-stripe borders, borrowed GitHub Primer palette, identical card stacks; no gradient text, no glass, no hero metrics |
| **Total** | | **9/20** | **Poor: major overhaul of the shell; the new altitudes themselves are sound** |

The score is low because of the shell and the legacy lenses, not because of the Fleet and
Project altitudes. Those two panels are the best-built surfaces in the app and should be the
template for everything else.

## 2. Anti-patterns verdict

**Does it look AI-made? Partly, and for a specific reason: it looks like three apps.**

- The shell, Fleet, Project, Sessions, Attention and Live are a GitHub-Primer-dark terminal
  skin: `--bg #0d1117`, `--bg-panel #161b22`, `--border #30363d`, `--text #e6edf3`,
  `--text-dim #8b949e`, `--ok #3fb950`, `--warn #d29922`, `--err #f85149` are Primer's values
  verbatim (`styles.css:1-14`), with one orange accent on top. Monospace everywhere.
- The workspace graph is a second product: its own token set (`--g-*`, `styles.css:401-418`),
  sans-serif, indigo/teal/purple, a radial vignette background, pill labels, a green
  selected tab. See `graph-firehose.png`.
- The graph's Map tab is a third: a treemap in full-saturation teal with its own time
  presets and brush. See `graph-map.png`.

Specific tells, each verified:

1. **Side-stripe borders.** `.band-row { border-left: 3px solid hsl(var(--hue) 55% 55%) }`
   (`styles.css:211`), `.dwell-row` (`:254-261`), `.capture-warning { border-left: 3px solid var(--warn) }` (`:394`). The session hue is meaningful, so the fix is not to drop it but to move it: the TUI already draws the same hue as a `│` glyph inside the row (`internal/tui/view.go`, help text "│ one hue per session"). Do that in the desktop too.
2. **First-order category reflex.** "Developer observability tool, so GitHub dark plus mono." The palette was not chosen for this product; it was inherited from the category. Scene sentence that should drive the choice: *a developer with four dark terminals and an editor open on a 27-inch display in a daylit room glances at Firehose between agent turns to see who is blocked.* Dark holds (it sits beside dark terminals and must not flash on glance), but the neutrals should be the app's own, tinted toward its warm accent, with the graph brought onto the same tokens.
3. **Identical card stacks.** Sessions (`fleet-altitude-sessions.png`) and Attention inbox (`attention.png`): same-shaped bordered cards, 200+px tall each, three facts and two buttons per card, ten per screen. A dense table or band (as the TUI draws it) is the right affordance here; the card is the lazy one.
4. **Accent as decoration.** The live feed paints the source column in `--accent` on every row (`.cell.source`, `styles.css:103`), and the Attention inbox paints "Activity captured" orange on sessions that are simply working (`attention.png`). PRODUCT.md principle 4 says attention earns colour. On these screens the most common value owns it.
5. **Colour with no scale.** The Map treemap fills every cell with the same saturated teal for 8 file events; the heat encoding carries no information and there is no legend (`graph-map.png`).

No gradient text, no glassmorphism, no hero-metric tiles, no bounce easing. The Project
lanes view and the Fleet map are distinctive and would not be mistaken for a template.

## 3. Executive summary

- Audit health score: **9/20** (Poor), dragged down by theming and the shell. The new
  altitudes score well in isolation.
- Issues: **0 P0 · 9 P1 · 11 P2 · 3 P3.**
- Top five:
  1. **The named target is split in three.** "Workspace" is the old repo×agent matrix (`ui/workspace`, still alive through `CellScope`), the revision graph lens (`ui/graph`), and the TUI's top altitude (`viewWorkspace`). In the shell, `workspace` (graph) and `project` (lanes) are two Project-altitude pictures of the same repository with two repository pickers and no shared window. Unify them (section 5).
  2. **Time is not one axis.** Six independent time controls exist. The scope `window` is read by Project and Fleet, written (never read) by Score, and ignored by the graph, whose Timeline and Map tabs carry their own Live toggles and presets.
  3. **Keyboard operability gaps at Level A.** Session cards (`ui/sessions.ts:206-212`) and feed rows (`ui/feed.ts:57-64`) are focusable but open only on click; Space on a focused feed row pauses the feed instead (`feed.ts:97-107`). Five selectors set `outline: none` with no visible replacement.
  4. **Names are still ids on four surfaces.** Attention inbox headline is `agent · source · <full uuid>` (`ui/attention.ts:173`); session cards without a title read `claude · 2385e3bc` plus a full UUID line; Project's repository select shows the raw `repo_id` until Fleet has loaded (`ui/project/index.ts:194`); the footer breadcrumb shows the raw path (`graph-firehose.png` footer). PRODUCT.md principle 1 and the comment on `sessionName` in `format.ts:139-150` both say this must not happen.
  5. **Vocabulary collisions in the chrome.** worktree / fork / workspace / repository / project / root for overlapping things; "map" means Fleet encoding, graph tab and activity treemap; "live" means the feed lens and Project's last-7-days window; "matrix" means the Fleet table and the old repo×agent grid; "needs you" vs "needs attention" vs "NEEDS YOU".
- Recommended next steps: section 8. The order is clarify → harden → distill → extract/document → quieter → layout → typeset → polish.

## 4. Detailed findings by severity

### P1 Major

**[P1] Session list and feed rows are click-only**
- Location: `ui/sessions.ts:206-212`; `ui/feed.ts:57-64, 97-107`; `ui/project/index.ts:271-276` (bead rect); `ui/score/index.ts:531, 611, 648`.
- Category: Accessibility. Impact: a keyboard user can focus a session but cannot open it, and pressing Space on a feed row pauses the feed. The one direct keyboard route into Score from Project is missing because only lanes go through `onActivate`. WCAG 2.1.1 (A).
- Recommendation: route every activatable element through `onActivate` (`dom.ts`), give beads `tabindex`/`role=button`, and scope the Space-to-pause handler to the feed container rather than `document`.
- Command: `/impeccable harden`.

**[P1] Focus is invisible on the surfaces that matter most**
- Location: `styles.css:236` (`.matrix-cell:focus`), `:262` (`.dwell-row`), `:284` (`.lane-row`), `:752` (`.score-track:focus`), `:1015` (`.fleet-lane-row:focus`) all set `outline: none`; `.feed-row`, `.session-item`, `.fleet-row-head`, `.fleet-fork`, `.fleet-need`, `.fleet-dwell-row` have no focus rule at all. No global `:focus-visible`.
- Category: Accessibility. Impact: the 1-9 / n / N / Space keyboard model Fleet advertises is unusable because the pick is not visible. WCAG 2.4.7 (AA).
- Recommendation: one global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px }` and remove the five `outline: none` rules.
- Command: `/impeccable harden`.

**[P1] Two repository pickers, no shared window: the Project altitude is split across `project` and `workspace`**
- Location: `main.ts:142-160` (`panels` registers both); `ui/project/index.ts` (own select, own brush, `Live` button); `ui/graph/index.ts` + `toolbar.ts` (own repository select, Graph / Timeline / Map tabs, own `Live · pause` and `2h 8h 24h 7d Live` presets).
- Category: Anti-pattern / IA. Impact: the user picks the repository twice, sets time three times, and the two views cannot be compared because they do not share scope. The graph ignores `scope.window` entirely (`grep window ui/graph/index.ts` finds only `window.addEventListener`).
- Recommendation: section 5. Make lanes, graph and map encodings of one Project altitude with one picker and one window.
- Command: `/impeccable distill`.

**[P1] Six time controls for one time axis**
- Location: Project brush + `Live` (`ui/project/index.ts:109, 307`); Fleet window chip (`ui/fleet/index.ts:174`); graph Timeline `Live · pause` (`graph-timeline.png`); graph Map `2h 8h 24h 7d Live` + brush + `Whole window` (`graph-map.png`); live feed `pause` (`ui/feed.ts`); Score transport, which writes the window but never subscribes (`ui/score/index.ts:468-473`).
- Category: Anti-pattern / HCI (consistency). Impact: the plan's rule "time is one axis everywhere, the same window and the same scrubber on every altitude" (2026-10-31 assessment §4) is not yet true; descending from a brushed Project window into the graph loses the window.
- Recommendation: one transport in the shell footer or header, bound to `scope.window`; every panel reads it; Score's transport becomes that transport when a session is scoped.
- Command: `/impeccable distill`.

**[P1] Raw identifiers used as labels**
- Location: `ui/attention.ts:173` (h3 is `${agent} · ${source} · ${id}`, full UUID); `ui/sessions.ts` card fallback `claude · 2385e3bc` plus a full-UUID line (`fleet-altitude-sessions.png`); `ui/project/index.ts:194` (`projectLabel?.(id) ?? id`, so a single-repository user who never lands on Fleet sees the raw `repo_id` in the select; `project-altitude-preview.png` shows `/Users/nicholas/develop/llm-firehose/.git`); `breadcrumb.ts` footer shows the raw path; `ui/handoffs/map.ts:61`, `ui/lanes/model.ts:149`, `ui/replay/map.ts:14` slice ids into button text.
- Category: Copy / PRODUCT.md principle 1. Impact: the user "does not remember session UUIDs and never will"; every one of these costs a lookup.
- Recommendation: Attention and Sessions use `sessionName` + `sessionWhere` for the headline and demote the UUID to the existing copyable `.session-id` chip; Project resolves labels through the graph `labels()` resolver, not through Fleet; breadcrumb uses the same resolver.
- Command: `/impeccable clarify`.

**[P1] The sidebar is seventeen lowercase codenames**
- Location: `main.ts:175-179` (`NAV_GROUPS`), rendered verbatim as button text at `:230`.
- Category: HCI (recognition over recall) / Copy. Impact: `loops`, `strata`, `court`, `handoffs`, `loom`, `ecosystem`, `replay` are internal prototype names; the h2 inside says "Loop Observatory", "Session Stratigraphy", "Evidence Court", "Handoff Subway", "Causal Loom", "Patch Ecosystem", "Forked Replay Lab". Four panels (live, sessions, score, workspace) have no h2 at all. Casing is mixed (`doctor`, `settings` lowercase h2s). No `aria-current` on the active button (`main.ts:207`).
- Recommendation: sidebar shows altitudes (Fleet, Project, Worktree, Session) and housekeeping only; everything else becomes a tab inside an altitude (D105 slice 8 already does this for the six session lenses). Labels in sentence case, matching the panel heading, with `aria-current="page"`.
- Command: `/impeccable clarify`.

**[P1] Unbounded graph timeline model and per-event full render**
- Location: `ui/graph/model.ts:104-120` (`TimelineModel.events` Map never pruned; `rows()` re-sorts with `Date.parse` in the comparator); `ui/graph/index.ts:1391` → `render()` on every live event while the Timeline tab is up; `main.ts:280` forwards every event to the graph even when it is not the active panel.
- Category: Performance. Impact: a day is 29k events; memory and per-event cost grow for as long as the app is open.
- Recommendation: cap the model to the scope window (or the feed's 5000 ring), parse once on insert, and gate `onEvent` on `active === "workspace"` as is already done for Fleet (`main.ts:281`).
- Command: `/impeccable optimize`.

**[P1] Feed rebuilds up to 1000 rows per animation frame**
- Location: `ui/feed.ts:87-90` (`clear(rowsBox)` then rebuild `rows().slice(-1000)`), driven from `main.ts:285-290` on every event while live.
- Category: Performance. Impact: at the captured rate (several events per second from four agents) the feed is the most expensive panel in the app for the least signal; D95 already says 70% of these rows are meta.
- Recommendation: keyed reconciliation as Fleet does (`fleet/index.ts` `keyed`/`reconcile`), or prepend-only with a trim; apply D95 so meta rows are off by default.
- Command: `/impeccable optimize`.

**[P1] Two palettes and 84 colour literals**
- Location: `:root` (`styles.css:1-14`) vs `.workspace-graph` (`:401-418`, `--g-bg`, `--g-panel`, `--g-teal`, `--g-purple`, `--g-amber`, `--g-font`…); `#ff9f43` hard-coded ×10 as "needs" (`:200, 220, 239, 266, 272, 289, 296, 764, 1017`) while Fleet uses `--warn` for the same meaning (`:1054, 1076`); hexes in `ui/handoffs/map.ts:3`, `ui/ecosystem/map.ts:10-18`, `ui/replay/map.ts:12-14`, `ui/loom/map.ts:21`, `ui/airspace/map.ts:12`, `ui/graph/names.ts:16-19` (duplicates the `--g-*` values).
- Category: Theming. Impact: "needs you" has two colours, the graph and the shell disagree on every neutral, and no semantic tokens exist (selected, focus, disabled, needs, stale), so each panel invents its own.
- Recommendation: one token layer with semantic roles (`--needs`, `--selected`, `--focus`, `--stale`, `--fog`) on top of OKLCH neutrals tinted toward the accent; the graph consumes it; delete `--g-*`.
- Command: `/impeccable extract`, then `/impeccable document`.

### P2 Minor

**[P2] Graph lands on the wrong repository and truncates the only distinguishing part of labels**
- Location: `graph.png` (default repository is `memories`, the first option, not the scoped project or the most active); `graph-firehose.png` labels `llm-firehose-fleet-alti…`, `llm-firehose-project-al…`, `llm-firehose-desktop-sc…` (`names.ts` `truncateName`).
- Category: HCI. Impact: nine worktrees share a 13-character prefix; tail truncation hides the one part that differs. Recommendation: when `scope.project` is set, open it; strip the repository prefix from worktree labels and middle-elide. Command: `/impeccable clarify`.

**[P2] The graph's Timeline tab is a third feed**
- Location: `graph-timeline.png` vs `live.png` vs Sessions' event list: three list renderings of the same events with three filter bars (source, session, category, search, pause) and different column sets.
- Category: Anti-pattern (inconsistent component vocabulary). Recommendation: one event list component scoped by `scope` (project / worktree / session) replaces all three; "live" stops being a nav item and becomes that list at Fleet scope. Command: `/impeccable distill`.

**[P2] Fleet is a page, not a HUD; needs-you has no position outside Fleet**
- Location: `main.ts:195-200` swaps the whole content area; the attention strip (`attention.ts:227`) shows a count with no position.
- Category: HCI / game-HUD (section 6). Impact: in Project or Session you cannot see which other repository just started waiting without leaving. Recommendation: a one-line Fleet strip (repository glyphs plus needs-you units) in the header at every altitude; clicking a unit does what Fleet's queue does. Command: `/impeccable layout`.

**[P2] Hotkeys are per panel, not per app**
- Location: `ui/fleet/index.ts:745-790` and `ui/project/index.ts:518-544` each own `1-9`, `Enter`, arrows; Fleet alone owns `n`, `N`, Space; the graph owns `/`, `+`, `-`, `0`; the feed owns Space.
- Category: HCI. Impact: the same key does different things on different panels and nothing lists them; the TUI has `?` help (`internal/tui/view.go:493`), the desktop has none. Recommendation: a shell-level key map (`1-9` worktrees as control groups, `n/N/Space` queue, `Esc` ascend, `?` legend), with panels registering conflicts explicitly. Command: `/impeccable harden`.

**[P2] No legend for the glyph vocabulary**
- Location: `?` `●` `·` `!` `±` `↑4 ↓139` hatched / dashed / solid lanes across Fleet and Project; the only explanation is a one-line hint paragraph (`fleet/index.ts:181`, `project/index.ts:113`).
- Category: HCI. Recommendation: a `?`-key legend panel, generated from the same glyph table the renderers use, mirroring the TUI help. Command: `/impeccable clarify`.

**[P2] State by colour alone in four places**
- Location: `ui/fleet/encodings.ts:94,100` (lane aria-label omits "needs input"); `ui/fleet/model.ts:152` (fork aria-label omits idle and needs counts that are drawn); `ui/sessions.ts:186` and `ui/project/index.ts:287` (bare `!`); `ui/graph/toolbar.ts:129`, `inspector.ts:302` (coloured agent dots with meaning only in `title`).
- Category: Accessibility (WCAG 1.4.1). Recommendation: put the state word in the aria-label and a visible word next to the dot where space allows. Command: `/impeccable harden`.

**[P2] Low-contrast text**
- Location: `.fleet-band.zero` (opacity .45, about 4.0:1), `.scope-crumb .unresolved` (about 3.6:1), `.graph-axis .axis-note.caption #5f7088` at 10px (about 3.7:1), `#fff` on `--err` in `.compat-banner` / `.badge.err` (about 3.35:1); `--border #30363d` on `--bg` is 1.55:1, below the 3:1 non-text minimum.
- Category: Accessibility (WCAG 1.4.3, 1.4.11). Recommendation: stop using opacity for dimming; add one more neutral step. Command: `/impeccable harden`.

**[P2] Monospace for prose contradicts PRODUCT.md**
- Location: `styles.css:12` sets `ui-monospace` on `:root`; hint paragraphs, Attention copy, Court and Score prose all inherit it; only the graph switches to sans (`--g-font`). PRODUCT.md principle 5: "monospace for identifiers and clocks, system sans for prose".
- Category: Theming / Typography. Recommendation: system sans at root, mono on `.mono`, ids, clocks, and the feed. Command: `/impeccable typeset`.

**[P2] Thirteen font sizes, px and rem mixed**
- Location: 12px ×46, 11px ×22, 15px ×4, 10px ×4, 14px ×3, 13px ×2, 9px, 20px, 1rem, .95rem, .9rem, 1.1rem in `styles.css`; SVG text 9/10/11; h2 is 1rem in `.content` but 15px in `.fleet-header`.
- Category: Theming. Recommendation: a five-step rem scale at ratio 1.2. Command: `/impeccable typeset`.

**[P2] Attention strip is permanent alarm chrome**
- Location: `ui/attention.ts:241`: `7 capture warning(s) · 0 capture gap(s) · Coverage depends on captured observations`, shown at every altitude, plus "Snapshot checked at 9:02:02 AM · source coverage is not guaranteed" inside the inbox.
- Category: Copy / HCI (alarm fatigue). Impact: a warning count that is always non-zero and a disclaimer that restates itself teach the user to stop reading the strip, which is the one place needs-you must land. Recommendation: hide the coverage sentence when nothing changed; show warnings as a dot on `doctor`; keep the strip for needs-you only. Command: `/impeccable clarify`.

**[P2] Graph overflows at 1100px with the detail pane open**
- Location: sidebar 130px (`styles.css:69`) + `.detail.open` 380px (`:138`) + `.graph-canvas-wrap` min 480px (`:505`) + `.graph-inspector` 340px (`:599`); `show()` (`main.ts:186-200`) closes the pane for seven panels but not for `workspace`.
- Category: Responsive. Recommendation: close or collapse the detail pane on `workspace` as on `project`/`fleet`; let the inspector collapse below 1200px. Command: `/impeccable adapt`.

**[P2] Attention polls every 3 s and rebuilds the hidden inbox**
- Location: `ui/attention.ts:463` (ungated), `:219-220` (`clear(rows); clear(strip)`).
- Category: Performance. Recommendation: rebuild the strip only; rebuild the inbox on show or on change signature. Command: `/impeccable optimize`.

### P3 Polish

- **[P3] Hit targets:** `.fleet-fork` (`styles.css:1070`, about 16px tall), `.fleet-more` (`:1064`), `.session-id` (`:184`), Project beads (10 SVG units). Pointer users on a trackpad miss them. `/impeccable adapt`.
- **[P3] Detail pane animates `width`** (`styles.css:134`), a layout property, and it is outside the reduced-motion rule (`:1106`). Use `transform` or no transition. `/impeccable animate`.
- **[P3] Empty-state casing is mixed:** "no sessions captured yet" vs "No worktrees captured yet." `/impeccable clarify`.

## 5. Unification against the shipped spine

The 2026-10-31 assessment and D99–D107 put the right spine in place:

```
Fleet  ›  Project  ›  Worktree (sessions)  ›  Session  ›  Call
```

and D105 slice 8 already folds score, loops, loom, replay, handoffs and court into Session
tabs. This section covers what those decisions leave open.

**5.1 Vocabulary (the top clarity finding).** Pick one word per rung and use it in the nav,
the headings, the aria-labels, the API labels and the docs:

| rung | use | retire from the UI |
|---|---|---|
| repository | **project** (nav, heading, breadcrumb); "repository" only in the picker label | repo, root, repo id |
| checkout | **worktree** | fork (Fleet copy, `fleet/index.ts:387,432`), workspace (graph toolbar "Search worktrees…" is already right; the nav item is not), cell |
| the state word | **needs you** | needs attention, needs input, NEEDS YOU |
| real time | **live** means the live window only | the feed lens called "live" |
| the picture types | **lanes**, **graph**, **map**, **table** as encoding names | "matrix" (two meanings), "airspace", "dwell" as nav items |

The identifier `workspace` then survives only in `internal/workspacegraph` and the API,
where it is a graph-space term.

**5.2 The Project altitude is one view with three encodings.** Today `project` (lanes) and
`workspace` (graph with Graph / Timeline / Map tabs) are both the Project rung. Proposed
slice 9, in the shape of D104:

```
Project  [ Lanes | Graph | Map ]     repository picker ×1     window ×1 (shared transport)
```

- **Lanes** (existing `ui/project`): worktrees leaving and rejoining main through time. The default.
- **Graph** (existing `ui/graph/canvas`): the same worktrees on the revision DAG, depth not time. Keep `Fit`, `All`, ⌘K search, the inspector. Drop its repository select and its tokens; read `scope.project` and the shared window for the agent-activity halo.
- **Map** (existing `ui/activity` treemap): paths touched in the window, with a real heat scale and legend. Reads the shared window; its 2h/8h/24h/7d presets move to the shared transport.
- The graph's **Timeline** tab is retired; the one event list (5.4) at Project scope replaces it.

Selection is shared: pick a worktree in Lanes, switch to Graph, and it is the highlighted
tip; `Esc` ascends from any encoding. This is the "workspace visualization" unified.

**5.3 The time axis.** One transport, owned by the shell, bound to `scope.window`:
live / last 2h / 8h / 24h / 7d / custom brush, with a scrub handle when a window is set.
Project's brush, the Map presets, the graph Timeline toggle and the feed pause all become
this control. Score's transport is this control when `scope.session` is set; it already
writes the window (`score/index.ts:468-473`), it only needs to read it.

**5.4 Where the rest lands.**

| today | lands in |
|---|---|
| `live` (feed) | the one event list, at whatever scope is set; at Fleet scope it is today's feed. Meta hidden by default (D95). |
| `attention` (inbox) | the needs-you queue is Fleet's; the inbox becomes a `Needs you` filter on the sessions list, and the strip stays as the HUD (5.5). |
| `workspace` (graph) | Project › Graph (5.2). |
| `strata`, `ecosystem` | Project › Map lenses (path over time; patch flow). |
| `files` | Project › Map at the Files tab, or Housekeeping if it stays an export/browse tool. |
| `loops`, `loom`, `replay`, `handoffs`, `court`, `score` | Session tabs (D105 slice 8, already decided). |
| `doctor`, `settings` | Housekeeping, unchanged. |
| `ui/workspace` matrix + `CellScope` | retire once Sessions can be scoped by graph-space worktree id, which `/worktrees` now allows; D100 kept `cell` as a documented escape hatch. |

Nav after this: **Fleet · Project · Worktree · Session** and **Doctor · Settings**. Eight
items become six; everything else is a tab or an encoding chip.

**5.5 Persistence of position.** Fleet already keeps row slots stable (`fleet/model.ts:183-191`,
`orderIds`), which is the right call. Two gaps: (a) nothing of Fleet is visible below Fleet,
so position is lost the moment you descend; (b) Project's lane order and the graph's layout
are not keyed to the same worktree order, so the same checkout sits in a different place in
each encoding. Fix (a) with the HUD strip (section 6, minimap) and (b) by sharing
`FleetOrder.forks[repo]` as the lane order in Project and the tip order in Graph.

## 6. Game-HUD grading of the fleet-altitude tree

Graded against the §5 table in the 2026-10-31 assessment. Present / partial / missing, with
where it lives. This is a grading of mechanics, not a proposal for a game skin.

| device | grade | evidence |
|---|---|---|
| Minimap, always visible | **partial** | Fleet is a full page (`main.ts:195`); the attention strip is the only persistent element and it is a count, not a map. A one-line Fleet strip in the header at every altitude closes this. |
| Units with state | **present** | Fork glyphs with open / idle / landed / gone / unknown (`fleet/model.ts:160-162`), session beads on lanes, dwell as a bar in the Dwell encoding. |
| Fog of war | **present** | Hatched `unknown` lanes, dashed stale needs units, "states pending" hint, fog rows for unmatched repositories, dashes instead of zeros (`Fleet post-review Codex pass`). The best-executed device in the app. |
| Tech tree / build order | **present** | Project lanes with ahead/behind badges and rejoin glyphs; revision graph for ancestry. Split across two panels (5.2). |
| Alerts with a position | **partial** | Needs-you units sit on their Fleet row and are clickable; outside Fleet the alert has no position. |
| Control groups | **partial** | `1-9` picks a row in Fleet and a lane in Project, per panel; `n/N/Space` only in Fleet; no global binding; Tab is correctly never intercepted (D104). |
| Replay / scrub | **partial** | Project brush and Score transport exist; not one control (5.3). |
| Idle worker alert | **present** | `IDLE_MARK` on open forks with no live session (`fleet/model.ts`, `project/index.ts:287`). Colour-only `!` (P2 above). |
| Legend / key | **missing** | TUI has `viewHelp`; the desktop has two hint sentences and no glyph or key legend. |
| Persistence of position | **partial** | Fleet rows stable; nothing persists across altitudes (5.5). |
| Change is motion, state is colour | **present** | Fleet animates transitions only (`.fleet .changed`, `styles.css:1102`), under `prefers-reduced-motion`. Extend the rule to the detail pane and to Project. |
| Actions from the map | **in progress** | D106 slice 6 (`feat/map-actions`): open in terminal / editor, copy diff command, copy resume command, register root, prune with dry-run confirmation. Put these behind one `Actions` affordance per unit with the same key on Fleet, Project and Worktree so the verb vocabulary is one list. |

## 7. Patterns, systemic issues, positives

**Systemic.**
- Panels were built as siblings with their own pickers, windows, filters and tokens; the
  scope store fixed the identity axis, not yet the time axis or the visual tokens.
- Raw-id fallbacks appear wherever a label resolver was out of reach; the resolver seam
  exists (`scope.ts` `labels()`), it is just not wired into Attention, Sessions, Project's
  picker or the breadcrumb.
- Accessibility was done well in the two newest panels (aria-labels, roving focus, status
  regions) and not retrofitted to the older ones.

**Positives to keep and copy.**
- The scope store and its resolver composition (`scope.ts`) are a clean, tested spine.
- Fleet's keyed reconciliation, stable ordering, transition-only motion and honest
  unknowns are the standard the rest of the app should meet.
- `format.ts` already encodes the naming rules (`sessionName`, `sessionWhere`, `idLabel`,
  `disambiguateSessionLabel`); the fix for P1 "raw identifiers" is to use them.
- Tab is never trapped; Escape ascends through a claim registry that respects inputs,
  dialogs and menus (`escape.ts`).
- The real-data validation habit (scratch HOME, isolated daemon, Playwright evidence in
  `docs/reviews`) caught the wall-of-paths Fleet and the `/Users/n` label bug before merge.
- The Project lanes view is the clearest answer in the app to "flow of changes across
  worktrees through time".

## 8. Recommended actions

1. **[P1] `/impeccable clarify`**: one vocabulary (5.1), sentence-case nav matching headings, names not ids on Attention / Sessions / Project picker / breadcrumb, legend text, attention-strip copy.
2. **[P1] `/impeccable harden`**: `onActivate` everywhere, global `:focus-visible`, remove the five `outline: none`, state words in aria-labels, shell-level key map, contrast fixes.
3. **[P1] `/impeccable distill`**: Project = Lanes | Graph | Map with one picker and one window (5.2); one transport (5.3); one event list (5.4); retire the graph Timeline tab and the `ui/workspace` matrix.
4. **[P1] `/impeccable extract`** then **`/impeccable document`**: one token layer with semantic roles, OKLCH neutrals tinted toward the accent, the graph on the same tokens; write `DESIGN.md` from the result.
5. **[P1] `/impeccable optimize`**: bound the graph timeline model, gate graph `onEvent` on active panel, keyed feed rows with meta off by default, attention strip-only polling.
6. **[P2] `/impeccable quieter`**: accent off the feed source column and off "Activity captured"; colour reserved for needs-you, selection and errors.
7. **[P2] `/impeccable layout`**: Sessions and Attention from card stacks to dense bands; the persistent Fleet strip in the header.
8. **[P2] `/impeccable typeset`**: system sans at root, mono for ids/clocks/feed, a five-step rem scale.
9. **[P2] `/impeccable adapt`**: close the detail pane on `workspace`, collapsible inspector, larger fork / bead / chip targets.
10. **`/impeccable polish`** as the final pass.

`DESIGN.md` is missing: run `/impeccable document` after step 4 for more on-brand output;
the token and font-size inventory in this report is its raw material.

> You can ask me to run these one at a time, all at once, or in any order you prefer.
>
> Re-run `/impeccable audit` after fixes to see your score improve.

---

## Appendix: ready-to-paste journal entry

For `docs/plans/2026-10-18-backlog-coordination.html`, numbering continues from D107:

> **D108 — Impeccable audit of the workspace visualization and the shell (2026-11-01).**
> Report: `docs/reviews/2026-11-01-impeccable-audit-workspace-and-app.md`, screenshots in
> `docs/reviews/2026-11-01-impeccable-audit/`. Health 9/20 (Poor), driven by the shell and
> legacy lenses, not by Fleet/Project. Findings taken as candidate slices after 6–8:
> **slice 9**, Project altitude unifies `project` lanes, the `workspace` graph and the
> activity map as encodings with one repository picker and one shared window (the graph's
> Timeline tab retires in favour of one scoped event list); **slice 10**, one shell-owned
> transport bound to `scope.window` that Project, Fleet, Graph, Map and Score all read;
> **slice 11**, vocabulary and naming pass (project / worktree / needs you / live; names
> through the scope resolver on Attention, Sessions, Project picker and breadcrumb; sentence
> case nav with `aria-current`); **slice 12**, keyboard and focus hardening plus a `?`
> legend generated from the glyph table; **slice 13**, one token layer (semantic roles,
> OKLCH neutrals tinted toward the accent, graph on the same tokens) and `DESIGN.md`.
> Constraint carried into slice 6 (map actions): one `Actions` affordance and one verb list
> shared by Fleet, Project and Worktree units. Constraint carried into slice 8 (session
> tabs): the Session altitude reads the shared transport rather than keeping Score's own.
