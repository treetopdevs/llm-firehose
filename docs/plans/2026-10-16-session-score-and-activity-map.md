# Session Score and Activity Map: decisions from the grilling session

**Status:** Decisions agreed 2026-10-16; nothing implemented. Source concepts
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
