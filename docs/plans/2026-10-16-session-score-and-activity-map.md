# Session Score and Activity Map: decisions from the grilling session

**Status:** Decisions agreed 2026-10-16; Session Score v1 shipped the same day (see below); Activity Map not started. Source concepts
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

## Shared deferred work

**Error Signature** is the one concept three deferred pieces need: storm cells
on the map, motifs on the score, and Loop Observatory and Session Stratigraphy
from the brainstorm. Define it once, in the projection, before any view claims
two errors are the same or ties an error to a file.
