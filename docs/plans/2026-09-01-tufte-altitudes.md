# Tufte pass, part two: dwell bars and three altitudes

**Status:** Implemented on `feat/tufte-altitudes`, stacked on `feat/tufte-view`
(see [2026-09-01-tufte-views.md](2026-09-01-tufte-views.md) for the rows, band,
and lanes it builds on). TUI in `internal/tui`, desktop in
`apps/tauri-desktop/src/ui/{dwell,workspace}` and `ui/detail.ts`.

## Why

Two gaps remained after the first pass. The orbit view spent depth, motion, and
a WebGL scene on one scalar, how long a session has been in its state, and the
terminal had no equivalent at all. And the viewer had only two reading
distances, the row and a JSON dump, so there was no way to see the whole
machine at a glance or to read one tool call as a designed thing.

## 1. Dwell bars

Time in the current state as a bar against a hairline at five minutes. A
session waiting past the line is the one you forgot.

- **TUI band.** The time-since-last-event column, which the sparkline already
  showed as a gap, becomes a fifteen-cell bar at half-minute resolution
  (`▌` marks a remainder past fifteen seconds) with the hairline (`│`) at cell
  ten and the number as the bar's own label:
  `│ codex   ▂▂  ▄█      ██        │      1m NEEDS YOU  approve Bash`.
  Narrow terminals keep the number and give the bar's cells to the text.
- **Desktop.** A `dwell` panel is the landing view: one row per live session,
  agent, workspace, state, the bar with the hairline, its number, an error
  mark, and the reason or last summary. Bars grow once a second; a live
  `state.transition` restarts one before the next fetch. Orbit moves to the
  end of the nav as the opt-in ambient display.

## 2. Three altitudes, one glyph grammar

```
workspace   one row per workspace, one column per agent; cell = sparkline · state glyph · count
   │ enter descends (esc ascends)
session     strip (band or lanes, `l`) over event rows, scoped to the cell; scope in the header
   │ enter descends (esc ascends)
call        one event as a table: request and response paired by call id
```

- **Workspace.** Rows are keyed on `repo`, else `cwd`, and ordered by latest
  activity; columns are agents, alphabetical. A cell folds every live session
  in the pair: the band's sparkline summed, the worst state as a glyph
  (`?` needs you, `●` working, `·` idle), and a count when there is more than
  one. Under the default balanced privacy mode `cwd` is a SHA-256 digest, so a
  workspace prints as its first eight hex digits; rows in the feed use the
  same label. On the desktop, clicking a cell scopes the sessions list to it,
  with a chip to clear.
- **Session.** The lanes view is no longer a screen of its own: `l` chooses
  the strip's encoding and the rows stay. Descending from a cell switches the
  strip to lanes, which is how one session reads at that distance. A session
  belongs to the scope through its engine attention or any one of its events,
  so transitions and events without a workspace stay with their session.
- **Call.** A breadcrumb (workspace · agent · session), the parent session's
  band line so context survives the zoom, the headline with tool name, then
  `started`/`ended` paired by session and call id with the duration, `captured`
  as capture time against the source's own clock when both are present, ids,
  and the start payload as **request** and the end payload as **response**.
  Keys the headline and timing already express (`tool_name`, `phase`) are not
  repeated; privacy digests `{sha256, len}` read as `#abcdef01 · len 512`.
  The desktop detail pane is the same table, with the full JSON behind a
  disclosure.

## Rules both viewers share

- **Freshness.** A state change counts as evidence of life only when the
  engine asserts `working` or `needs_input`; `idle` and `done` are judged on
  the last event alone. A daemon restart stamps every historical session idle
  with a fresh `state_since`, and the first live run of the dwell panel showed
  473 "live" sessions because of it.
- **Pairing.** The first `start` and the first `end` at or after it, in the
  same session; an unpaired start reads `still running · 10s` only while the
  engine says the session is working (TUI), otherwise `no end captured`.
- **Duration.** One resolution per magnitude: `42ms`, `2.59s`, `1m15s`,
  `1h02m`.
- Sort order (needs-you first, longest wait first, then latest activity), the
  state glyphs, and the digest label are the same in `internal/tui/derive.go`
  and `apps/tauri-desktop/src/{spark,format}.ts`.

## Observed in real captures

- Replayed Codex rollout lines carry a fresh capture time and their original
  source time, so the call view reads `captured +23h10m after source`, which
  honestly marks a replay rather than live activity.
- Claude Code hooks carry no `source_time`, so the latency row never appears
  for them.

## Follow-ups

- Engine-side: do not restamp `state_since` for idle sessions on restart, or
  mark reconciled states so viewers need no heuristic. The TUI header's
  NEEDS YOU count still counts stale engine states (unchanged from the first
  pass).
- Adapters: supply `source_time` where the source has a clock (Claude Code
  hook payloads carry none today).
- The workspace matrix could carry an error mark per cell; both viewers leave
  it out for now to keep one glyph per cell.
