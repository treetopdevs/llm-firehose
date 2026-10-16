# Session Score and Activity Map: decisions from the grilling session

**Status:** Decisions agreed 2026-10-16; Session Score v1 and Activity Map v1 shipped the same day (see each section's Shipped notes). Source concepts
are items 10 (Agent Score) and 2 (Repository Weather) in
`docs/brainstorms/2026-10-15-wild-visualizations/`. Canonical terms live in
`CONTEXT.md`: Session Score, Activity Map, Heat, Error Signature.

## Order

Session Score first. It needs no new API and reuses the Lanes span model, so it
teaches the track renderer and transport before the map's scrubber needs them.
Activity Map second.

## Session Score (was Agent Score)

- **Primary job:** replay one finished session. Live mode and sonification are
  additive later; sound stays opt-in and never touches capture.
- **Data:** `GET /sessions/{id}` only. No new endpoint.
- **Tracks:** one per envelope category present in the session. No Read/Edit
  split and no Test track in v1; those are future derived overlays and must be
  marked as inferred when they arrive.
- **Durations:** import the Lanes model (`src/ui/lanes/model.ts`). Paired
  `call_id` start/end is a span; an unmatched start is a visibly open span to
  the session's last report, capped at 30m; everything else is a tick.
- **Motifs:** none in v1. They depend on Error Signature.
- **Placement:** a separate session-scoped view opened from a session row.
  Lanes stays the multi-session live panel.
- **Transport:** the score is always fully drawn. The playhead is a cursor
  that advances at a chosen speed, highlights the event under it, and drives
  the existing detail renderer. Gaps are real time.
- **Long sessions:** the axis stays strictly linear. The transport has
  jump-to-next-event and horizontal zoom; an overview strip shows the whole
  session.
- **Minimal privacy mode:** categories, times, and call ids survive, so
  tracks render; summaries are digests, so labels are hashed.
- **Surface:** desktop, SVG, no new dependencies.

### Shipped 2026-10-16 (v1)

`apps/tauri-desktop/src/ui/score/`: `model.ts` (tracks, playhead, viewport,
labels), `index.ts` (SVG view, overview strip, transport), tests, and
`fixture.session.json`, a real 101-event claude-code session captured in
balanced mode on 2026-10-15 with personal paths rewritten. Opened from the
`score` button on a session row; also a `score` entry in the sidebar that
starts empty. Span pairing was lifted out of `buildLanes` into the exported
`collectCalls` helper in `lanes/model.ts`; Lanes behaviour and tests are
unchanged, and a parity test asserts the score's spans equal the lane's over
the fixture. The transport has play/pause (space), speed 1× to 60×, jump to
next and previous event (arrows), zoom in/out/fit around the playhead, and a
whole-session overview strip that follows the playhead. Playback runs on
`requestAnimationFrame`, moves only the cursor and the highlighted tick, and
calls the detail renderer only when the event under the cursor changes, with
the session's own events as the pairing siblings. Nothing in the TUI, daemon,
or Go code changed.

Observed real-capture quirks:

- One `mcp__ccd_turn__wrap_up` call in the fixture has its `end` captured
  56 ms before its `start` (19:32:52.490 vs 19:32:52.546). Lanes treats an end
  before its start as unmatched, so both views draw it as an open span to the
  session's last report rather than a negative one. Pinned by a test; not
  "fixed" in the shared helper because that would change Lanes.
- The plan assumed minimal mode digests summaries. `internal/privacy` only
  digests payload values (to `{sha256, len}`) and path identities (to 64 hex
  characters); `summary` stays readable in every mode. So tracks and tick
  labels read normally, and only the tool name in span titles prints as a
  short hash. The view handles both digest shapes and nothing else.
- `GET /sessions/{id}` includes `firehose` `state.transition` events. As in
  Lanes they are not activity: only `needs_input` draws, as a mark on the meta
  track; other transitions are neither drawn nor stepped to.
- The brief named a `stripControl` helper to reuse; none existed. A small one
  (C0, DEL, C1, and bidi controls) lives in `score/model.ts`.

## Activity Map (was Repository Weather)

- **Primary job:** orient after an overnight or long run over a historical
  window with a scrubber. Live is the window ending at now.
- **Unit:** one map per repository identity. Relative paths merge across
  worktrees; worktree is an optional filter.
  **Precondition:** in balanced mode the spool holds a readable absolute
  `file_path` but a digested `worktree_id`. The endpoint derives relative
  paths by matching each event's digested worktree id against the readable
  roots the workspace graph has registered or observed, digested the same way
  (`internal/workspacegraph/service.go` already does this). An event whose
  worktree root is unknown falls back to its raw path under its own bucket.
  This is the "join to the workspace graph" the brainstorm meant.
- **Positions:** deterministic treemap or circle pack from the path hierarchy,
  sorted by path. No persisted positions. The flat view is the primary view;
  contour art, if ever, is a skin over it.
- **Heat:** count of file-category Captured Events per path per time bucket,
  equal weight. No attribution of shell or tool activity to files in v1.
- **Storm cells:** dropped from v1. They return with Error Signature.
- **Data:** a new additive daemon endpoint returning per-path, per-bucket Heat
  for a repository identity and window. The client only renders. The spool's
  identity-day index locates the days to read. This is an additive change to
  the local API frozen surface: document it in `docs/contracts.md` and route
  it through the same origin restrictions as the workspace-graph routes.
- **Minimal privacy mode:** paths are digests on disk, so the view shows an
  explicit unavailable notice and no tiles.
- **Surface:** desktop-only tab sharing Graph/Timeline repository scope, SVG,
  no new dependencies. No TUI view in v1.

### Shipped 2026-10-16 (v1)

Built to `docs/plans/2026-10-16-activity-map-build-brief.md`.

- **Endpoint.** `GET /workspace-graph/activity` (`internal/daemon/workspace_graph.go`,
  behind `graphResponse`), backed by `Engine.Activity` in
  `internal/capture/activity.go`, which reads only the UTC days the window
  overlaps (a scale test pins two day files read out of forty and agreement with
  a full-spool reference). Bucket ladder, default bucket, UTC flooring, the
  2000-path cap and the minimal-mode gate (no spool read) are as briefed.
  Documented as "Activity heat (additive)" in `docs/contracts.md`; no
  `schema_version` bump, nothing existing changed.
- **Resolver.** Workspace roots come from the current snapshot through
  `EventScope` (raw and digest aliases; `jj:` stripped; rootless JJ workspaces
  skipped). One deviation from the brief's literal order: an absolute path
  resolves against the *innermost* known root that contains it, the event's own
  root included, rather than the own root first. Real repositories nest Claude
  Code worktrees under `<repo>/.claude/worktrees/`; own-root-first would file an
  edit made from the main checkout into a nested worktree as
  `.claude/worktrees/<name>/x.go` instead of merging it with `x.go`. Relative
  paths resolve against the event's own root; `..` escapes stay unresolved.
- **Desktop.** A third Workspaces tab, "Map" (`apps/tauri-desktop/src/ui/activity/`):
  order-preserving split treemap with single-child directory chains collapsed,
  2h/8h/24h/7d presets, Live (refetched on the graph's 15 s poll once 10 s
  stale; the map ignores attention arrivals), worktree filter, directory zoom
  with breadcrumb, a per-bucket strip with a keyboard and pointer brush,
  "Hottest in range", and the briefed notices. Unresolved groups are named by
  the snapshot workspace whose id they carry (the event's own worktree editing
  outside every root), else a short digest. `fixture.activity.json` is a real
  response from a temporary daemon over copied spool days of this repository.
- **Live check.** Temporary daemon on `127.0.0.1:4627` with a temp HOME and copies
  of real spool days, vite on 1420 with `VITE_DAEMON_URL`, headless Chromium
  (the built-in browser pane could not open localhost). Screenshots of an
  overnight brush over 24h, a Live 2h window, one worktree, and minimal mode were
  taken and not committed (they show personal paths). The drag brush lost its
  anchor after the first redraw; that was found in the live check, pinned by a
  test, and fixed.

#### Real-capture quirks

Seen in a copy of the real spool (223 days, about 96k file-category events):

1. **Codex Heat was nearly absent** (fixed 2026-10-16; see "Codex apply_patch
   paths" below). Only the rollout `patch_apply_end` event carries paths
   (absolute keys of `changes`), and it last appears on 2026-09-03. Current Codex
   rollout `custom_tool_call:apply_patch` and its `_output`, and the Codex hook's
   `PreToolUse`/`PostToolUse` for `apply_patch`, hold their paths only inside
   patch text (`*** Update File: …`, absolute or relative).
2. **Antigravity reads are Heat.** `PostToolUse:view_file` is file-category
   with an absolute `file_path`, so antigravity reading a file counts like an
   edit (1 per read), while Claude Code reads are not file-category.
3. **Claude Code is 2 Heat per edit** (`PreToolUse` and `PostToolUse`, both
   with an absolute `file_path`), as accepted for v1.
4. **opencode has no real captures** on this machine, so its shape is not
   pinned from real data. The adapter copies the tool's `file`/`filePath`
   verbatim; relative values are handled as root-relative by the resolver, and
   that branch is pinned with a constructed event.
5. **About 19k file events carry neither `repo_id` nor `worktree_id`** (an agent
   started outside any repository). They match no repository and appear on no
   map, not even as unreadable.
6. **Minimal-mode `changes` digests read as paths.** A Codex `changes` map
   recorded in minimal mode is a `{sha256,len}` object, and
   `projection.EventFilePaths` returns `len` and `sha256` as two paths. The
   Activity aggregate guards this and counts the event as unreadable; the
   projection's file artifacts (`/artifacts/files`) still have it. Fixing that
   changes an existing response, so it is left as a follow-up.
7. **Removed worktrees and outside edits are common.** Edits into a deleted
   sibling worktree (`llm-firehose-graph-mockup`) and into agent memory or
   `~/Library/...` files land under "Outside known worktrees" with raw paths.
8. **Some repositories never get a map.** The graph refuses to scan a repository
   whose git config defines commands (one large repository here), and a
   colocated JJ repository registered as `jj` matches only events captured with
   a JJ identity (2 of about 170 file events for one repository), the same as
   Timeline.
9. The desktop app has a single dark theme, so there was no light theme to
   check the colour ramp against.

#### Codex apply_patch paths (2026-10-16)

The Activity aggregate now reads the file headers of Codex `apply_patch` text
(`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`), from
the rollout call's `input` and the hook's `tool_input.command`, when an event
has no `file_path`/`path`/`file` and no `changes` map. Decisions:

- **(a) Where: the Activity aggregate only.** Parsing lives in `activityPaths`
  (`internal/capture/activity.go`). `projection.EventFilePaths` is untouched, so
  `/artifacts/files` (a frozen response) does not change. Teaching the projection
  the same headers would change that response and needs its own decision.
- **(b) Double counting: none removed. Heat still counts events.** Per patch,
  the rollout adds 2 (the call and its `_output`, see "Output summaries" below),
  the hook adds 2 (`PreToolUse` and `PostToolUse`), each the same as Claude
  Code's accepted 2 per edit; both together add 4, and a historical
  `patch_apply_end` adds 1 more.
  1,241 of about 21k call ids in the spool copy were seen by both rollout and
  hook. A path named twice in one patch adds 1. Deduplicating by `call_id`
  would change the CONTEXT.md definition of Heat ("count of … Captured Events").
  **Open question for the user:** keep counting events, or count each call once?
- **(c) Truncation: in the contract.** Balanced mode cuts text at 240 runes, so
  usually only the first header survives (14,745 headers read from 14,678 rollout
  calls). Only newline-terminated header lines count, so a cut header is never a
  path. `docs/contracts.md` ("Activity heat", Privacy) says that a multi-file
  patch heats its first file. The desktop notice for unreadable events is
  unchanged and still accurate.
- **Relative headers.** Codex resolves a relative patch path against its cwd;
  the Activity resolver roots it at the event's worktree root (the existing
  rule; in balanced mode cwd is a digest). A patch made from a subdirectory
  therefore lands on the wrong path. This change sends far more events through
  that rule (3,280 rollout calls had a relative header).

Measured on a copy of the real spool (223 days):

| Shape | Events | Now heat a path | Still unreadable |
|---|---|---|---|
| rollout `custom_tool_call:apply_patch` | 14,678 | 14,678 (3,280 with a relative header) | 0 |
| hook `PreToolUse` `apply_patch` | 8,439 | 8,399 | 40 (34 with only a cut header) |
| hook `PostToolUse` `apply_patch` | 8,046 | 8,012 | 34 |
| rollout `custom_tool_call_output:apply_patch` | 14,677 | 14,128 (see below) | 549 |

Pinned by `internal/capture/testdata/activity_apply_patch_shapes.ndjson`
(sanitized real records: a move, an untruncated two-file delete, a relative
header, a cut second header, a cut only header, and six `_output` records listed
below) and the updated `activity_real_shapes.ndjson` expectations.

**Output summaries.** The rollout `custom_tool_call_output:apply_patch` is now
read too, when its payload has no patch text: the `A`/`M`/`D` lines after
`Success. Updated the following files:`, newline-terminated only, as for
headers. A rollout-only Codex patch therefore adds 2 Heat, like a Claude Code
edit. Every `_output` in the spool copy has `status: completed`, failures
included, so status says nothing; anchoring on the success line is what keeps
failures at 0 Heat. Variants in the spool copy (all 14,677 are strings):

| `output` variant | Events | Read | Decision |
|---|---|---|---|
| plain `Exit code: …\nOutput:\nSuccess. Updated the following files:\n…` | 6,413 | 6,406 | read; 7 hold only a cut first path |
| JSON `{"output":"Success. Updated …","metadata":{…}}`, whole | 7,491 | 7,491 | read the inner `output` (2,176 list a relative path) |
| JSON wrapper cut by truncation | 231 | 231 | read up to the last complete `\n` escape when it begins `{"output":"` (all 231 do; 87 cut only in `metadata`, 144 inside `output`) |
| JSON `command timed out after … milliseconds` | 3 | 0 | no success line: unreadable |
| plain `apply_patch verification failed: …` | 532 | 0 | names a path, but no success line: unreadable |
| plain `patch rejected: …`, `execution error: …` | 7 | 0 | unreadable |

The read events list 15,270 paths, 3,401 of them relative (rooted at the
event's worktree root, as for headers). A move is listed as `M <destination>`
only, so the call heats source and destination and its output heats the
destination. Fixtures: plain with relative paths and a cut fourth line, whole
JSON, JSON cut in `metadata`, JSON cut inside `output`, a verification failure
naming a path, and a JSON timeout.

The hook `PostToolUse` carries the same plain `output` summary (8,046 events in
the spool copy). It is not read, because its patch text already is: headers name
a path in 8,012. Reading the output as a fallback for the other 34, whose only
header was cut, was measured and **decided against**: it reads 0 of them. The
output is cut at 240 runes too, and its preamble (`Exit code…`, `Wall time…`,
`Output:`, the success line) is longer than `*** Begin Patch\n*** Update File: `,
so a path long enough to cut the header also cuts the output's first line.

**Open question for the user:** in 7,900 `PostToolUse` events both headers and
output name paths, and in 771 of them the output names 786 paths the headers do
not (none is a relative/absolute twin of a header path). Reading the union of
both would add those; it would also make a hook event's paths depend on its
output, which no other event does.

## Shared deferred work

**Error Signature** is the one concept three deferred pieces need: storm cells
on the map, motifs on the score, and Loop Observatory and Session Stratigraphy
from the brainstorm. Define it once, in the projection, before any view claims
two errors are the same or ties an error to a file.
