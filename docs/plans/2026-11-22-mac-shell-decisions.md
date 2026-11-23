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
  Done in slice 2.
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
| `main.test.ts` "session activation by double click, Enter and Space…" (was "by click, Enter and Space…"), "Enter on a nested score button or id chip…" | A click on a session row opened it | A click selects, a double click, Enter or Space opens (MS-8); the nested-control rule moved into `select-open.ts` and `sessions.select.test.ts` |
| `main.test.ts` "the score view has no sidebar entry; shown with nothing in scope it starts empty" | Enabled replay sound from a button in the Score and checked audio closes on leaving | The Score has no sound control; replay sound is a Settings choice (MS-9). Audio closing on leaving is covered by `sonification.test.ts` |
| `ui/score/sonification.test.ts` "explicit sound control…" (now "the Score shows no sound control; the Settings choice decides, and playback starting is what opens audio"), "blocked audio and a cue failure…", "a tick observing a detached paused panel…", "stepping during playback…", "a dense window cues only its latest observation…"; "the sound disclosure keyboard action…" replaced by "turning the setting off in Settings closes audio at once" | Each clicked Enable replay sound in the Score and read the status text there | Each sets the shared setting (`ui/score/sound-setting.ts`) and plays; the audio state is read from the setting module, which Settings shows (MS-9) |
| `ui/attention.test.ts` "shows captured warnings and explains storage failures…", "unrecorded capture gaps are inspectable…" | Warnings and gaps were rows in the Needs you queue and counted in its strip | They are held for Doctor and counted on its badge, not in the queue (MS-9); inspected through `inspectWarning` and `inspectGap` |
| `ui/fleet/index.test.ts` "one row per repo in stable order…", "a snapshot with attention ahead of worktrees…", "every go patch carries…", the "%s open keeps the historical window…" fork case, "a hung worktrees request is aborted…", "glyphs are ordered needs you and working first…", "idle and needs show in the fork's accessible name…", "selecting an unknown worktree shows unknown and why…", the context-menu and `.` key tests on a fork (they share `rig`), "a /worktrees change while a menu is open…" | Worktrees were always drawn as chips under the row | A project row starts as one line; these open the rows and Show all first (`showEverything`) and a collapsed row draws no worktree (MS-10) |
| `ui/fleet/index.test.ts` "a row draws at most 12 glyphs…", "non-open forks are glyph-only…", "gone forks older than seven days are behind the overflow…", "the overflow chip does not navigate", "expanding a static +N row…", "the overflow control names what it hides, by status" | The "+N" chip, 12-glyph cap and glyph-only chips | The rest line, Show all, a state word on every worktree row (MS-10) |
| `main.test.ts` "Escape from Sessions reached by a Fleet fork…", "Fleet shares the one controller: its fork menu…" | A worktree chip was on screen at launch | Open the project rows first (`openFleetRows`) |
| `keys.test.ts` descriptor tables | Fleet registered two keydown handlers and `LOCAL` had no tree key | `rowTree` (← →) added; Fleet registers five keydown handlers (head, disclosure and worktree row read `LOCAL.rowTree`) |
| `content.test.ts` target list | `.fleet-more` was a 24px target | `.fleet-disclose` and `.fleet-showall` are (`.fleet-more` is gone) |

The test names above are the ones identified from `git diff cc49c74..HEAD -- '*.test.ts'` removed lines and from this pass. Many
tests on the branch also had their bodies adjusted without a new name for the slice rules (neutral selection fills, hairline rows,
hidden panel headings, 24px targets, two roots reads at launch, hosted switchers); those are in the slice commits, and the
diff is the list.

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
- **Slice 2, done** (the toolbar chevrons arrived with slice 3). In: the kept range (`scope.ts`), history with Back
  and Forward on ⌘[ and ⌘] (`history.ts`), scroll memory per place restored by row key, focus
  handed to the new view's heading, launch on All projects (the shell loads the resolver rows at
  boot and again on connect if that read failed, so nothing depends on Project being shown
  first), and no unasked detail pane (opening Score only marks the first event). Launch now issues two
  `/worktrees` requests (the shell's read for the resolver, and Fleet's own list) where it used
  to issue one.
- **Slice 3, done except the native menus.** In: the source-list sidebar (Needs you, All
  projects, a row per project with "N needs you" and "N active" from the attention poll, Files,
  Doctor with a capture-warning count, and Settings and Keys and symbols in the footer with the
  daemon state, version and event count); one toolbar (sidebar toggle on ⌃⌘S, Back and Forward
  chevrons wired to the history with disabled state, the place title and breadcrumb, the panel's
  view switcher hosted in the toolbar, and the range as one pop-up control); the scope strip and
  the status bar are removed; the sidebar collapses under 900px and the inspector overlays under
  1100px; chrome targets are 28px; ⌘, opens Settings. `DESIGN.md` Components and
  `.impeccable/design.json` describe the new chrome. The toolbar assumes a standard title bar.
  Not in: the native app menu and Help menu (Settings stays a footer link and Keys and symbols
  a footer button as well as `?`, until the Tauri menu exists), a toolbar search (the doc keeps
  none), and the Fleet More menu and merged list (slice 4). The attention module still builds its
  strip element for its own tests; the shell no longer mounts it.
- **Slice 4, done except the items listed here.** In:
  - **All projects list.** The Map encoding became the merged list (id `map`, label List). A project
    row reads its worktrees by status in words ("1 needs you · 3 working · 20 idle · 59 unknown",
    zeros left out). A worktree is needs you, working, idle, unknown, landed, never diverged or gone;
    idle needs evidence (its own last activity within 7 days, or a live session reporting idle), so an open worktree with no readable time or none that recent is unknown with `◌` and a reason, never idle. The
    "+N" chip names what it hides. Needs you and working worktrees lead the strip. Waiting, Table and
    By state are retired from the switcher and still resolve by name.
  - **Select, open, back (MS-8).** `src/select-open.ts`: a click or an arrow selects and fills the
    inspector (`ui/inspector.ts`, in the shared pane), Enter, Space or a double click opens. Selecting
    writes no scope and adds no history entry. Escape clears the selection and the inspector first.
    The selected key is kept in the history entry, so Back returns with the row selected. Applies to
    project rows, worktree chips and needs-you chips in Fleet, and session and worktree rows in the
    Worktree panel. The session id left the row and is a copyable field in the inspector.
  - **Honest states in session rows.** A session the needs-you snapshot does not know is `◌ unknown`
    with a reason, an unreadable time reads unknown, a missing start time is left out, and the list
    still says "Showing N of M sessions".
  - **More menus (MS-9).** `ui/more-menu.ts`: Fleet (Strata, Patches) and Session (Loom, Replay,
    Handoffs, Court). Keyboard operable; Escape closes it and returns focus to its button.
  - **Targets (MS-11).** 24px minimum on every new control, 28px for the project row head, More,
    Open and Actions; `src/content.test.ts` reads them from the stylesheet. Fleet Lanes rows are 24px.
  - `DESIGN.md` Components and `.impeccable/design.json` describe all of this.
  - **Not in at the time (all since delivered, see Completion on 2026-11-22):** the project row's expansion is the existing "+N" chip, not the "one line with Show
    all" of MS-10; the per-row Actions button on Fleet rows stays beside the inspector's Actions
    button (the move to the context menu alone is not done); the session list is not filtered by the range, so it says "of N sessions", not
    "of N in range"; the Doctor-only move of install buttons and capture warnings is not done;
    the nearest-surviving-row fallback when a kept selection's row is gone is not built (the
    selection is simply dropped); Replay sound is still where it was; nothing was run in a real
    browser or WKWebView.
- **Slice 5, done in code, not checked in `tauri dev`.** In: `src-tauri/tauri.macos.conf.json`
  (merged on macOS only) sets `titleBarStyle: "Overlay"`, `hiddenTitle: true` and
  `trafficLightPosition` (x 18, y 22; the keys are in the Tauri window config schema, the exact
  position is a guess to tune by eye). Platform window arrays replace the base entry, so the file
  repeats the base window fields; a test keeps them equal. Linux and Windows keep the standard
  frame. `src/window.ts` turns the overlay behaviour on only inside the Tauri shell on macOS
  (`__TAURI_INTERNALS__` plus a Macintosh user agent); a browser, Linux and Windows get no inset and
  no drag regions. When on, the shell carries `data-titlebar="overlay"`: the sidebar gets 44px above
  its brand while visible, the toolbar gets an 80px left inset only while the sidebar is hidden
  (`data-sidebar-visible`), and the toolbar, its non-interactive containers and the sidebar brand
  carry `data-tauri-drag-region`. Buttons and the range pop-up never do. The capability adds
  `core:window:allow-start-dragging`; double-click maximise is covered by `core:window:default`
  inside `core:default`. Known caveat from Tauri: an unfocused overlay window cannot be dragged.
  Not verified: WKWebView rendering, real drag, traffic-light placement and the inset widths.

### Review follow-up on 2026-11-22

Fixed after review: the four global nav keys (⌘[, ⌘], ⌘, and ⌃⌘S) now stay quiet while a dialog is
open (legend, prune confirmation, onboarding); under 900px the open sidebar overlay has a scrim and
closes on a click outside it and on Escape; an open worktree classified unknown draws the unknown
mark and its chip is announced with the reason; a More view (Strata, Patches) leaves the last used
Fleet tab as the tab stop; the inspector's Close button hands focus back to the selected row.

### Completion on 2026-11-22 (second pass)

The deferred items above are delivered, each with tests that were run:

- **MS-6, neutral selection token.** Landed in `c424abc`: `--selected` is a neutral fill in both themes and may only be a
  background or fill; no selected, pressed or current state reads `--accent` (`tokens.test.ts`).
- **MS-7, "Session · whole".** While a session is in scope and the held range does not cover it, the range control reads
  "Session · whole". The held range is a new read-only `scope.held()`; the session's extent comes from the session directory
  (`first_time`, and `last_time` when known). With no known extent, or a state installed whole, it keeps "Live · whole session".
- **MS-8, range on travel.** Back, Forward, Back through a session leaves the project's 24h range at 24h (a guard test; no
  change was needed). Entering a session by history still starts on the whole session, as before; a session's zoom is not part of
  a place.
- **MS-8, restore by key.** Session and worktree rows carry `data-key` equal to their selection key. A history entry keeps the
  selected key and its place in the list; Back restores the key once this visit's load has settled, a key that is gone falls to the
  row now at that place (the last row clamps), and focus goes to the restored row, else the view's heading. A worktree hidden
  behind a collapsed project or Show all is revealed to be selected.
- **Review leftovers.** A pending scroll restore ignores the clamp event the clearing queues, and panels close an open More menu
  when they are left.
- **MS-9.** Replay sound is a Settings checkbox (off by default, kept on this device); the Score keeps playing it, opens audio when
  playback starts, and shows no control. Capture warnings and gaps are listed in Doctor and counted on its badge, and are out of the
  Needs you queue and its count; the first-run setup no longer has install buttons. Project has a Sessions view (the Worktree list,
  hosted) that is a view of the Project place in history. Dwell, Matrix and Airspace stay reachable by name, one test each.
- **MS-10.** A project row is one line with a disclosure button; expanded it shows its needs-you and working worktrees as one-line
  rows, then one rest line with Show all. A needs-you project starts expanded and the start is fixed when the row is first drawn.
  Keys: Right expands, Right again enters the worktrees, Left climbs and collapses.

Four review findings that had not been confirmed were traced: two were real and fixed (Back into a session's history in the
Worktree panel came back empty; a session's zoom stayed drawn over All projects after the sidebar), one was real and fixed
(history entries kept old project ids after a privacy-mode change), and one was real in a narrow form and mitigated (rows could
move between the clicks of a double click; Fleet now holds drawn rows still for 600 ms after a press). The fifth, "Back loses the
session's saved zoom", is the rule, not a defect: MS-7 gives a session its own zoom that opens whole, and a zoom is not a place.

Still not done or not verified:

- Nothing was run in a real browser or WKWebView; every result above is a happy-dom test. The new row layout (the hairline
  flex, the 40px indent of worktree rows, the hidden disclosure that keeps its space) has not been looked at.
- Capture gaps are counted with warnings on the Doctor badge; they were a separate line in the old strip. If the badge should count
  only warnings, `attention.warnings()` is the one place.
- The attention module still builds its strip element (its own tests read it); the shell does not mount it.
- The Sessions view keeps the panel's own `h2` ("Worktree"), visually hidden, so Project shows two hidden headings.
- The native app menu and the toolbar search remain out of scope (see slice 3).
- Escape while a restore is pending and the user's own click or selection end the restore; Tab alone does not.

### Honest list on 2026-11-23

The owner's first look at the real app found counts and lists that disagreed. These rules replace earlier ones:

| Earlier rule | New rule |
|---|---|
| A stale pending request is counted and flagged, never dropped (fleet-altitude item 6) | One 24-hour rule for every count. An older episode stays in the Needs you queue, labelled and uncounted |
| A window change redraws nothing in the All projects list | The List shows projects active in the range and says how many; anything needing you stays listed |
| Every repository seen in history is a row | Registered, live and needing-you projects are listed. The rest wait behind one "older history" line |
| Two projects may share a name | An unregistered project sharing a registered name shows its parent folder |
| A gone worktree is drawn in the fault colour | Gone is muted; red is for faults (MS-6) |
| A landed worktree's whole row is green | The row is quiet and only its mark stays green (MS-6) |
| The list and the sidebar poll needs-you separately | Both read one shared snapshot |

## Answered on 2026-11-22

- MS-4: macOS is the only target today; Linux and Windows are on the roadmap. The overlay
  title bar therefore lives in a macOS-only Tauri config, and the toolbar must work
  unchanged under a standard title bar.
- A view switch (Lanes to Graph, Score to Loops) stays a history stop for now.
- Commits on `feat/mac-shell` are approved, one or more per slice. No push without asking.
