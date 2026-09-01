# Tufte pass: typographic rows, session band, lane view

**Status:** Implemented on `feat/tufte-view` (TUI in `internal/tui`, desktop in
`apps/tauri-desktop/src/ui/sessions.ts` and `apps/tauri-desktop/src/ui/lanes/`).

## Why

Every surface except orbit was a one-dimensional scrolling list, and the list
spent its ink on chrome: bracketed badges, a full clock and working directory on
every row, and three colour channels (agent, category, session) fighting for the
eye so that warn and error did not pop. The multi-agent question the tool exists
to answer, *which session needs me and what is each one doing right now*, needed
the reader to scan and infer.

## What changed

### 1. Rows repeat only what changed

`10:04:12 │ claude   ▸ prompt: "fix the login bug"   …/dev/app`

- The clock is spelled out when the minute changes from the row above; inside a
  minute only `:SS` is printed. The working directory follows the same rule.
- Brackets are gone. The agent column is as wide as its widest visible label and
  no wider; the category is one glyph (`◆ ▸ ≡ ● ■ ? $ ! ·`, legend under `?`).
- Colour is reserved: yellow warn, red error, orange needs-you. The only other
  hue is the session bar, which is how a thread stays traceable.
- The footer is `? help`; the key list and glyph legend live behind it.

### 2. A small-multiples band above the feed

One line per live session, the same encoding every line so shapes compare:

`│ codex   ▂▂  ▄█       1m NEEDS YOU  approve Bash: rm -rf build`

session bar · agent · events per 30s over the last 5m (blank means zero: a gap
is the signal) · time since last event · engine state · reason or last summary.
Needs-you sessions lead, longest wait first; then most recent activity. The
band is capped so the feed always keeps room, with a `+N more` line.

The desktop sessions panel is the same band as HTML rows, replacing the badges;
the sparkline is computed from the live buffer the feed already holds.

### 3. Lanes: time as the axis

`l` in the TUI, a `lanes` panel on the desktop. Wall time across, now at the
right edge, one lane per live session. Events are density ticks per slot
(`▂▄▆█`), tool calls paired by `call_id` and `phase` are spans (`─`, or accent
fill on the desktop when still open), `!` marks an error, `?` a needs-you
transition. Axis labels sit on whole clock times and slide left as time passes.
`-` and `+` (or the desktop buttons) zoom between 1m, 5m, 15m, and 1h.

## Rules both viewers share (`internal/tui/derive.go`, `src/spark.ts`, `src/ui/lanes/model.ts`)

- Nothing re-folds the attention state machine. The viewer reads the engine's
  state and places it next to activity.
- An unfinished tool call runs to now only while the engine still says the
  session is working, and never past 30m; otherwise it ends at the session's
  last report.
- Engine state is trusted only while plausible. A real spool reported
  `needs_input` and `working` for sessions last heard from over a month ago;
  the viewers keep a needs-you state for 24h and a working state for 30m past
  the last report. The TUI header's NEEDS YOU count is unchanged and still
  counts them, which is the honest next thing to fix engine-side (expire stale
  attention in the projection) rather than in another viewer.
- Event-derived text is stripped of terminal control sequences before it is
  drawn (`stripControl`), as the header reason already was.

## Observed in real captures

Some tool calls have a `start` and no `end` in the capture (browser MCP calls
that failed mid-flight in a Claude Code session). Lanes render that honestly as
a span open to the 30m cap. Mapping the failure hook to `phase: end` in the
Claude Code adapter would close them at the right time.
