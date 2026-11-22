# Desktop shell redesign: decisions

**Date:** 2026-11-22. **Branch:** `feat/mac-shell`, from `origin/main` at cc49c74 (0.6.0).
**Status:** direction approved by the owner on 2026-11-22 ("go with your recommendations").
MS-4 (platform) is an assumption that still needs the owner's answer.
**Scope:** `apps/tauri-desktop` only. No daemon, API, spool or schema change; none of the
five frozen surfaces is touched.

Decisions are numbered MS-1 to MS-12 and are local to this document. The backlog journal's
D numbers continue on an unmerged docs branch, so this document does not take one.

## Why

The goal of the desktop app is to understand the past and present activity of agents across
all projects. That reduces to three questions: who needs me, what is running where, and what
happened in a time range.

An audit of 0.6.0 on 2026-11-22 scored the shell 12/20 (9/20 on 2026-11-01). The token layer,
focus rings and keyboard activation are sound. What remains is structural:

- Three bars sit above every screen (attention strip, time bar, panel header), and a
  permanent "capture warning(s)" line is on all of them.
- Every control is an outlined box, with tabs in three styles.
- All text is monospace, although `PRODUCT.md` asks for system sans for prose.
- The sidebar lists levels (Fleet, Project, Worktree, Session), so a level can be empty.
- On a loaded Fleet, 268 of 329 controls are under 24px tall.

A walk through the real links showed what makes moving between screens jarring:

| Move | Observed |
|---|---|
| Launch | Lands on Project, then moves to Fleet by itself |
| Fleet row, then Esc | Fleet scroll position resets to the top |
| Fleet worktree glyph | The time bar disappears |
| Open a session | The range silently resets from 24h to Live; a detail pane opens unasked |
| Esc three times from a session | One Esc changes only the breadcrumb; Project is skipped; the range comes back as 7 d |
| "Needs you" strip | Opens Worktree with an empty breadcrumb |
| Sidebar "Session" | An empty screen with playback controls |
| Any move | Keyboard focus drops to `<body>` |

There is no back or forward history, only Esc.

## Decisions

### MS-1 Three axes, one control each

Every control answers where, when or what.

- **Where** is the sidebar.
- **When** is one range control in the toolbar.
- **What** is the content area, with an inspector for the selected thing.

A control that answers none of the three is demoted (MS-9) or removed.

### MS-2 The sidebar lists things, not levels

The sidebar is a source list:

| Item | Lands on | Implementation |
|---|---|---|
| Needs you | The needs-you queue | the existing `attention` alias |
| All projects | The fleet list | the `fleet` panel |
| One row per project | That project | `go("project", { project })` |
| Files | Files | unchanged |
| Doctor | Doctor, with a count of capture warnings | unchanged, plus a badge |

- "Fleet" is renamed **All projects** in visible copy. The code name `fleet` stays.
- **Worktree** and **Session** are no longer sidebar items. They are reached by opening a
  worktree or a session, so neither can be shown empty.
- **Settings** leaves the sidebar: it is the app menu item on ⌘, and a link in the sidebar
  footer.
- **Keys and symbols** moves to the Help menu and stays on `?`.
- The status bar is removed. Daemon state and version sit in the sidebar footer; the
  breadcrumb becomes the toolbar title.

Sidebar data adds no requests. Project names come from the `roots` store, and the per-project
"N needs you" and "N active" counts come from the attention poll that already runs every 3 s
(`AttentionSession.repo_id` and `state`). A state is always written as a word with its count;
a bare dot never carries state.

The sidebar is 200px wide. Under a 900px window it collapses behind a toolbar toggle
(⌃⌘S). Under 1100px the inspector overlays the content and does not push it.

### MS-3 Appearance follows the system

Light and dark, chosen by `prefers-color-scheme`. `PRODUCT.md` currently says dark only; it
is amended, and `DESIGN.md` is rewritten as each slice lands (the token tests require
`DESIGN.md` to list every `:root` token, so it cannot wait for the end).

- Neutrals stay tinted toward the brand hue (chroma 0.004 to 0.008, hue 60).
- The contrast tests in `tokens.test.ts` run on both themes.
- The four graph state colours pinned in `ui/graph/names.ts` and the per-session identity
  hue (`hsl(var(--hue) 55% 55%)`) are fixed today and would be too light on a light surface.
  The state colours become tokens with a value per theme, and the identity hue takes its
  saturation and lightness from tokens.
- The bundle minimum is macOS 13.1 (Safari 16.2), so `light-dark()` is not available.
  Themes are written with `@media (prefers-color-scheme: light)`.

### MS-4 macOS first (assumption, needs the owner's answer)

The release workflow builds a dmg only; CI also builds Windows and Linux bundles. This plan
assumes macOS is the product target and the other two only need to keep building.

- The overlay title bar (`titleBarStyle: "Overlay"`, hidden title, traffic-light inset, a
  drag region on the toolbar) goes in a macOS-only config file so other platforms keep
  their native frame.
- Known caveat from the Tauri documentation: with an overlay title bar the window cannot be
  dragged while it is unfocused.

If Windows or Linux is a real target, the toolbar needs a non-overlay variant and this
decision is revisited.

### MS-5 Type: system sans, mono for evidence

- The default face is the system sans stack (`-apple-system`, SF Pro).
- Monospace is kept for identifiers, hashes, paths, clocks, durations, counts in columns and
  captured payloads, always with tabular numerals.
- Five type steps stay as they are (`--fs-xs` to `--fs-lg`).
- One radius scale of three steps replaces the twelve values in use.

### MS-6 Colour means it needs you

- Selection, the current sidebar item and the selected segment are neutral fills.
- Warm colour is reserved for "needs you". Red stays for faults, green for landed and
  working, each beside its word.
- The ember accent remains for the app icon and the one primary action on a screen.
- Rows are separated by hairlines. No bordered box per row, no side stripes, no glass.

The accent policy test keeps its allow-list; `--selected` becomes a neutral token.

### MS-7 One range, kept everywhere

The range control in the toolbar replaces the time bar. It is a pop-up ("Live · 8h") with
the presets, Hold and the scrubber inside it.

- The range is kept on every screen and across every move.
- A session has its own zoom. Score opens on the whole session, as today. While a session
  is in scope, `scope.window` is that session's zoom (so Score and the filter lenses keep
  reading one value); the range in force before the session was entered is held by the
  scope store and put back when the session is left, by Esc, Back or any other route.
  Moving from one session to another keeps the held range.
- A session that lies outside the range still opens: opening is a statement about the
  session, not the range. The toolbar then shows "Session · whole" in place of the range.

This replaces the rule in `scope.ts` that left the window at live after a session. A window
named in the same change that leaves the session still wins, and a state installed whole
(`scope.set`) has nothing to restore.

### MS-8 Select, open, back

- **Select** (click, arrow keys) fills the inspector. Nothing navigates and the list does
  not move. The detail pane never opens unasked.
- **Open** (double-click, Enter, the inspector's primary button) drills in and pushes a
  history entry.
- **Back and forward** (⌘[ and ⌘], toolbar chevrons) return to the previous place.
- **Esc** clears the selection or closes the inspector first, then goes up one level in
  the structure (session to project, project to All projects). Esc moves in the structure;
  Back moves in time. Neither changes the range.

A history entry holds: panel, encoding or session tab, scope (project, worktree, session,
cell, range), the selected row's key, and a scroll anchor (the key of the first visible row
plus a pixel offset). Lists are live, so selection and scroll are restored by key, not by
index or pixel position. A key that no longer exists restores to the nearest surviving row.
History is in memory, capped at 50 entries, and is not kept across launches.

Also in this decision:

- Launch lands on All projects and never moves afterwards. The Project-then-Fleet jump is
  removed. **Not done yet, and not a one-line change:** the shell depends on Project being
  shown first. The names the Needs you inbox gives worktrees, and the Fleet worktree link
  to the session list, come from lifetime data that only the Project panel loads. A trial
  that landed on Fleet broke 51 shell tests, two of them for that reason. The resolver has
  to be loaded by the shell at boot (it already has a `refresh` that does not need the
  panel) before the landing can change, with the request-count tests updated to match.
- After every move, focus goes to the new view's heading or its restored row, never to
  `<body>`.

### MS-9 Keep, demote, move

| Surface | Decision |
|---|---|
| Fleet Map, Table, Waiting, By state | Merge into one list. Waiting becomes the Needs you queue |
| Fleet Lanes, Events | Keep |
| Fleet Strata, Patches | Demote to a More menu |
| Project Lanes, Graph, Map, Events | Keep, plus a Sessions view (the old Worktree rung) |
| Session Score, Loops | Keep |
| Session Loom, Replay, Handoffs, Court | Demote to More; they are notebooks, not views of activity |
| Replay sound | Move to Settings |
| Install buttons, capture warnings | Doctor only, with the sidebar badge |
| Prune and per-row Actions | Context menu and the inspector |

Nothing is deleted. Aliases (`live`, `attention`, `strata`, `ecosystem`, `workspace`) keep
resolving.

### MS-10 Lists are rows, with honest overflow

- Projects, worktrees and sessions are rows of one or two lines. The session id is a
  copyable field in the inspector, not a line on the row.
- **Unknown stays unknown.** A worktree or session with no recent evidence is drawn as
  unknown with the `◌` glyph and its reason, never as idle.
- A project row summarises its worktrees by state ("1 needs you · 3 working · 20 idle ·
  59 unknown"). Expanding shows needs-you and working worktrees first, then one line that
  counts the rest with "Show all".
- Session lists state how many are shown of how many are in range.

### MS-11 Targets and density

Interactive controls are at least 24px tall, 28px for toolbar controls. Density comes from
row height and type, not from shrinking targets.

### MS-12 What does not change

- The scope store remains the single source of selection; panels still read it.
- Panel internals (lanes, graph canvas, score) are restyled through tokens, not rewritten.
- Privacy remapping, the actions controller and the escape-claim protocol are unchanged.
- No new dependency.

## Tests this supersedes

Each is rewritten to the new rule, not deleted.

| Test (file, name) | Old rule | New rule |
|---|---|---|
| `main.test.ts` "Project is the landing view…", and the six "landing:" tests | Land on Project, move to Fleet when there are two repositories | Land on All projects and never move (MS-8) |
| `main.test.ts` "nav is the ladder", "sidebar groups altitudes, lenses and housekeeping" | Sidebar is Fleet, Project, Worktree, Session, Files, Doctor, Settings | Sidebar is the source list in MS-2 |
| `main.test.ts` "the score view is reachable from the sidebar and starts empty", the loops twin, "empty scope: every tab opens… no session in scope" | Session can be shown with nothing in scope | Session is reached only by opening one (MS-2) |
| `main.test.ts` "every panel opens with a visible h2 equal to its nav label", "Worktree is the h2 even when scoped" | The h2 repeats the nav label | The toolbar title names the place; one heading per view |
| `main.test.ts` "footer crumb sits between the status text and the event count", "the footer Keys and symbols button…" | Crumb and legend button live in the status bar | Crumb is the toolbar title; the legend opens from Help and `?` (MS-2) |
| `main.test.ts` "strip click opens Needs you on the Worktree rung…" | A strip above the window | The Needs you sidebar item, same landing, scope untouched |
| `main.test.ts` "transport: mounted once between strip and layout…", "visible only where consumed…", "transport follows (panel, encoding)…" | A bar that shows and hides | One toolbar control, always present (MS-7) |
| `scope.test.ts` window tests | Leaving a session leaves the window at live | The range held from before the session is restored (MS-7). The existing tests still pass because they enter the session from live; new tests cover the held range |
| `main.test.ts` Escape ascent tests | Esc walks session, worktree, project, fleet | Esc clears selection, then goes up one structural level (MS-8) |
| `vocabulary.test.ts` "Fleet encoding labels use Table, Waiting and By state" | Eight Fleet encodings | The merged list and its More menu (MS-9); "All projects" added to the vocabulary |
| `tokens.test.ts` contrast, token contract, identity hue | One dark theme | Both themes; state and identity colours per theme (MS-3) |

Checked against the test bodies, these stay as they are: "scope.window drives Score and the
filter lenses", "a disjoint window is left unchanged by Score…", "Fleet descents carry the
window…" and "Escape round trip: Session -> Sessions…". MS-7 was reworded to fit them.

## Slices

Each slice starts with failing tests, ends with `pnpm -C apps/tauri-desktop test` and
`build` green, and stands on its own.

1. **Appearance.** Light and dark tokens, system sans with mono for evidence, the radius
   scale, state and identity colours per theme. `DESIGN.md` and `PRODUCT.md` updated.
2. **Flow.** History with keyed restore, the kept range, no boot move, focus hand-off,
   no unasked detail pane. This does not need the new sidebar.
3. **Chrome.** The source-list sidebar and the single toolbar over the existing panels and
   `go()`; strip and status bar folded in; collapse rules.
4. **Content.** The merged All projects list, session rows with the inspector, the More
   menus, 24px targets.
5. **Window.** The macOS overlay title bar and drag region, checked in `tauri dev`
   (headless Chromium is not WKWebView).

Acceptance for slice 2 is the walk table above, rerun: nothing lost on any move.

### Status on 2026-11-22

- **Slice 1, done.** Light and dark tokens with contrast tested in four modes, system sans
  with `--font-mono` for evidence, the radius scale, themed state and identity colours,
  `--shadow` and `--scrim` (popovers and modal backdrops were mixed from the background and
  would have been a white haze in light). `DESIGN.md` and `PRODUCT.md` updated for these;
  the Components section of `DESIGN.md` and `.impeccable/design.json` still describe the old
  chrome and are rewritten with slice 3.
- **Slice 2, partly done.** In: the kept range (`scope.ts`), history with Back and Forward
  on ⌘[ and ⌘] (`history.ts`), scroll memory per place restored by row key, focus handed to
  the new view's heading. Not in: the launch landing (see MS-8), toolbar chevrons for Back
  and Forward (they arrive with the toolbar in slice 3), and the detail pane that opens
  with Score.
- Slices 3 to 5 not started.

## Open

- MS-4: is macOS the only product target?
- A view switch (Lanes to Graph, Score to Loops) is recorded as a place, so Back steps
  through views as well as screens. If that feels like too many stops, views can update
  the current entry instead.
