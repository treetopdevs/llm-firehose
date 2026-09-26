# Altitudes follow-ups: honest state_since, a fresh NEEDS YOU count, error marks

**Status:** Implemented on `feat/altitudes-followups`. Targets the three
follow-ups recorded in
[2026-09-01-tufte-altitudes.md](2026-09-01-tufte-altitudes.md#follow-ups),
worktree `feat/altitudes-followups` off `main` (`d9166d8`, includes the shipped
Attention inbox).

## Why

The Tufte altitudes pass shipped with three follow-ups on record. Two are
honesty bugs in numbers the reader is meant to trust at a glance — the age of
an idle session, and how many sessions are waiting on the reader — and the
third is a legibility gap the original pass deliberately deferred. All three
are small, independently testable, and none touch the spool, export, or
envelope.

## 1. Engine: honest `state_since` for idle sessions, and a fresh NEEDS YOU count

### The bug

`TickIdle` (`internal/capture/internal/projection/attention.go:80`) stamps the
transition to idle with `now`, the instant the idle sweep happens to run —
not `lastActivity`, the session's own last real event:

```go
func TickIdle(prev Attention, lastActivity, now time.Time, toolOpen bool) (Attention, bool) {
	...
	next.Since = now   // wall clock, not the session's own evidence
	...
}
```

`AdvanceIdle` (`internal/capture/internal/projection/projection.go:261`) calls
this once per session on a 5s ticker (`internal/capture/reconcile.go:159`,
`idleInterval = 5 * time.Second`) once `Engine.Run` starts. On a cold rebuild
(`Build` replays the whole spool through `Apply`, which sets state from real
`ev.Time` values — that part is already honest) every session that was last
seen `working` and never got a clean end event is still `StateWorking` when
`Run` starts. The very first tick, 5s later, finds `now.Sub(lastActivity)`
comfortably past `IdleAfter` (90s) for essentially every historical session,
and stamps all of them idle **as of that first tick** — the "473 live
sessions" bug the first Altitudes pass papered over with a viewer-side
heuristic (`internal/tui/derive.go:126` `liveSessions`, `spark.ts`
`lastReported`).

The synthetic transition event's own `Time` field carries the same lie: `out
= append(out, newStateTransition(id, prev.State, next, now))` passes the tick
time as the event's `Time`, and the *live* client path
(`internal/tui/tui.go:433` `noteAttention`) reads `Since: ev.Time` straight
off that event — so a live client watching a restart is fooled the same way
a client that just called `GET /sessions` is.

This is not only cosmetic. `state_since` is a documented, additive `/sessions`
field (`docs/contracts.md` § Local API); a consumer that trusts it at face
value — a script that alerts on "idle for more than N minutes," a future
non-Firehose client — gets a materially wrong answer after every restart, not
just an ugly TUI count.

### The fix

Make `TickIdle` stamp `Since` from the evidence it already has —
`lastActivity` — instead of the wall clock it was handed to compare against:

```go
func TickIdle(prev Attention, lastActivity, now time.Time, toolOpen bool) (Attention, bool) {
	if prev.State != StateWorking || toolOpen {
		return prev, false
	}
	if now.Sub(lastActivity) < IdleAfter {
		return prev, false
	}
	next := prev
	next.State = StateIdle
	next.Since = lastActivity
	next.Reason = ""
	return next, true
}
```

This is a one-line, one-concept fix and it applies uniformly — there is no
special case for "just restarted" vs. "quiesced during a long-running
session." Whether the sweep discovers the idle transition 5s after a
restart or 91s after real-time activity stopped, `state_since` now always
answers "when did this session last show evidence of life," which is what
every caller already assumes it means.

`AdvanceIdle` must then stop passing `now` to the emitted transition event and
pass the honest `next.Since` instead, so the live SSE path (which the TUI's
`noteAttention` reads `Since` directly off of) inherits the same fix without
a second change:

```go
out = append(out, newStateTransition(id, prev.State, next, next.Since))
```

No change is needed to `Transition` (the non-idle path) — it already stamps
`Since` from `ev.Time`, the real event's own clock, which is already honest.

### Attention inbox: checked, not a bug

The plan asked to check `internal/capture/internal/projection/inbox.go` for
the same restamp problem. It does not have one: `InboxSession` has no ticked
idle state at all. Its `State` (`unknown` / `working` / `needs_input` /
`failed` / `done`) is set exclusively from real captured events inside
`applyInbox`, using `ev.Time` / `ev.SourceTime` / `ev.CaptureTime` — there is
no wall-clock sweep analogous to `AdvanceIdle` anywhere in this file, and
`docs/attention.md` already documents the inbox and the older `/sessions`
state machine as two independent semantics ("Older `/sessions` fields and
stream-only state transitions retain their existing semantics; `/attention`
provides the more conservative evidence-based view."). This item is a
verified no-op for the inbox; the implementation task adds one regression
test asserting a rebuild-then-idle-sweep sequence leaves inbox evidence
timestamps untouched, so a future change that *does* introduce ticking here
trips a test.

### TUI: the NEEDS YOU header count trusts stale states

Separately, `Model.needsYouCount()` (`internal/tui/tui.go:462`) and
`oldestNeedsYouReason()` (`tui.go:471`) loop over the raw `m.attention` map
and count every entry with `State == stateNeedsInput`, with no freshness
check at all:

```go
func (m Model) needsYouCount() int {
	n := 0
	for _, a := range m.attention {
		if a.State == stateNeedsInput {
			n++
		}
	}
	return n
}
```

`boundAttention` (`tui.go:441`) explicitly never evicts `needs_input`
entries ("Sessions that need you are never evicted"), so a session that
asked a question days ago and was then killed sits in `m.attention` and in
the header count forever. This is the exact freshness problem `liveSessions`
(`derive.go:90`) already solves for the band and workspace views: it
computes `ref` (last evidence of life — the session's last real event, or
`Since` when the engine still asserts `working`/`needs_input`) and calls
`stateFresh(state, ref, now)` before a session is allowed on screen. The
header must apply the identical rule instead of inventing a second one.

Fix: give `attention` a `Last time.Time` field (the session's last real
activity — mirroring `sessionInfo.Last`), thread it in from
`SessionAttention.Last` (`PreloadSessions`) and from the live event stream,
and change `needsYouCount`/`oldestNeedsYouReason` to compute the same `ref`
`liveSessions` computes and skip entries that fail `stateFresh`. Concretely:

- `tui.SessionAttention` (`tui.go:27`) gains `Last time.Time`.
- `cmd/firehose/main.go` `viewFeed`'s two construction sites
  (daemon path ~line 235, local-engine path ~line 251) populate it from
  `session.LastTime` (already present on both `client.Session` and
  `capture.Session`/`projection.Session`).
- `attention` struct (`tui.go:38`) gains `Last time.Time`; `PreloadSessions`
  copies it from `session.Last`.
- `noteAttention` (`tui.go:418`) does **not** get a reliable per-event last-
  activity signal (transition events are synthetic, not activity), so it
  carries the previous entry's `Last` forward unchanged, the same way it
  already carries forward `Source`/`Agent`/`Where` — real activity for a
  session already tracked continues to update `sessionInfo.Last` via
  `m.events`, and `liveSessions` already prefers the freshest of the two
  ancestries; `needsYouCount` should do the same by taking `max(a.Last,
  a.Since when state is needs_input)`, mirroring `liveSessions`'s `ref`
  computation line for line (`derive.go:126`-`131`).
- Extract that four-line `ref` + `stateFresh` computation out of
  `liveSessions`'s loop into a small helper (e.g. `attentionFresh(state
  string, last, since time.Time, now time.Time) bool`) in `derive.go`, so
  `liveSessions` and `needsYouCount`/`oldestNeedsYouReason` call the exact
  same function instead of two copies that can drift.

This does not change `viewHeader`'s scoping behavior: the count stays global
(not narrowed by `m.scope`), matching today's behavior — only staleness
changes.

### Contract assessment

**Not a frozen-surface change; no `schema_version` bump.**

- Nothing here touches the event envelope, privacy semantics, the NDJSON
  spool format, or the export format. `state.transition` frames are
  explicitly documented as stream-only and never persisted or exported
  (`docs/contracts.md` § Local API, closing paragraphs), so changing what
  timestamp they carry has no spool/export footprint at all.
- The Local API surface is unchanged in shape: `GET /sessions` keeps the same
  field, same type (`state_since` stays an RFC3339 timestamp), same
  cardinality. `docs/contracts.md` lists `state_since` as one of the
  additive attention fields but — deliberately, since it is "derived only —
  never written to the spool" — does not pin an exact derivation algorithm.
  Tightening that derivation from "wall clock when we happened to notice"
  to "the session's own last activity" is a correctness fix to the field's
  already-documented intent (when did this state begin), not a redefinition
  of what the field means or how a client should use it. A client reading
  `state_since` before and after this change parses it identically; it just
  gets a truthful value instead of a restart artifact.
  - Escalation note for reviewers: if the team wants `state_since`'s
    derivation pinned precisely (e.g. "idle `state_since` equals the last
    event's `Time`, not `Time + IdleAfter`"), that belongs as a clarifying
    addition to `docs/contracts.md`, not a version bump — no existing
    consumer can be relying on the old, buggy value, since the old value was
    never anything but a restart-time artifact.
- The TUI header fix is presentation-only; it has no API or spool footprint.

## 2. Adapters: `source_time` audit — no-op

The plan asked to audit every adapter under `internal/adapters/*` against its
*real* fixtures and add `source_time` wherever the source payload genuinely
carries its own clock and the adapter currently drops it. Audit result: no
adapter qualifies. This item is a documented no-op.

Evidence, adapter by adapter:

| Adapter | Native clock in real fixtures? | Current state |
| --- | --- | --- |
| `codex` (rollout tail) | Yes (Codex rollout `timestamp`) | Already sets `SourceTime` (`internal/adapters/codex/codex.go:207`) |
| `opencode` | Yes (`info.time.{created,completed}`, part `time`) | Already sets `SourceTime` in all four mapping sites (`opencode.go:207`, `209`, `251`, `352`, `354`) covering session, message, and part events |
| `generic` (`firehose ingest`) | Only when the caller's own envelope supplies `time`/`source_time` | Already passes it through (`generic.go:51`) |
| `claudeotel` (OTLP logs/metrics) | Yes (`sourceNano` on every log/metric record) | Already sets `SourceTime` for every event (`claudeotel.go:325`, the single `baseEvent` constructor every mapper uses) |
| `claude-code` (hook-forward) | **No.** Every real fixture under `internal/adapters/claudecode/testdata/*.json` (`pre_tool_use.json`, `post_tool_use*.json`, `stop*.json`, `session_start.json`, `session_end.json`, `notification.json`, `user_prompt_submit*.json`, `subagent_stop.json`) was grepped for any time/date/timestamp-shaped field; none exists. Confirmed by the adapter's own test (`claudecode_test.go:33`): "source_time = ..., want absent because Claude hooks supply no timestamp." | Correctly absent |
| `antigravity` (hook-forward) | **No.** Same audit against every fixture in `internal/adapters/antigravity/testdata/*.json`; no clock field. Confirmed by `antigravity_test.go:67`. | Correctly absent |
| `codexhook` (installable lifecycle/tool hooks, distinct from the rollout tail) | **No.** Fixtures carry a wall-time *duration* inside `tool_response` text ("Wall time: 0.006949 seconds") but no clock instant. Confirmed by `codexhook_test.go:33`. | Correctly absent |
| `procwatch` (process table poll) | **No.** `ps` gives no event clock; the observation *is* the capture. Confirmed by `procwatch_test.go:68`. | Correctly absent |

Nothing to implement. The "Observed in real captures" section of the
2026-09-01 plan already reflects the `codex`/`opencode` work having landed;
this audit closes the follow-up by confirming there is no remaining gap
rather than leaving it an open question.

## 3. Viewers: an error mark on the workspace matrix cell

### The gap

`matrixCell` (TUI, `internal/tui/derive.go:161`) and `MatrixCell` (desktop,
`apps/tauri-desktop/src/ui/workspace/model.ts:8`) fold every live session in
a workspace × agent cell into a summed sparkline, a single "worst state"
glyph, and a count — but neither folds `HasError`. A cell with a session
mid-error looks identical to one with no errors at all; the reader has to
descend into the session altitude to find out.

Both the TUI's `lanes` view (`renderLaneCells`/`laneGlyph`, `view.go:445`-
`451`) and the desktop's `dwell` panel (`ui/dwell/index.ts:61`,
`ui/dwell/model.ts:21`,`52`) already draw exactly this signal today, with the
same vocabulary: a compact `!` mark, in the shared error hue
(`errorStyle`/`--err`), shown only when `HasError`/`has_error` is true and
otherwise contributing nothing to the layout. That is the mark to mirror at
the workspace altitude — a fixed-width fourth slot in the cell (after the
state glyph, before the count), blank when there is no error, so every cell
in the table stays the same width whether or not it lights up. This keeps
"one glyph *for state*" true — the state glyph itself is untouched — while
adding one more small, consistent, and rare "there is something to see here"
signal, exactly as the count slot already does for session multiplicity.

### Design

**Data plumbing (`HasError` from engine to cell), TUI side:**

- `internal/client.Session` (`internal/client/client.go:45`) is missing
  `HasError bool \`json:"has_error,omitempty"\`` even though
  `docs/contracts.md` already documents `/sessions`' `has_error` field and
  the daemon already emits it (`projection.Session.HasError`,
  `json:"has_error,omitempty"`). This is a silent gap: the daemon-connected
  TUI path has never been able to see `has_error` at all, because
  `encoding/json.Unmarshal` drops the field on the floor. Fixing it is
  additive parsing of an already-frozen, already-documented field — no
  contract change.
- `tui.SessionAttention` (`tui.go:27`) gains `HasError bool`.
- `cmd/firehose/main.go` `viewFeed`'s two construction sites populate it from
  `session.HasError` (now present on both `client.Session` and
  `capture.Session`).
- `attention` struct (`tui.go:38`) gains `HasError bool`; `PreloadSessions`
  copies it from `session.HasError`.
- `noteAttention` (`tui.go:418`) reads `ev.Payload["has_error"]` (already
  emitted by every transition, `projection.go` `newStateTransition`
  payload key `has_error`) and sets it directly (not carried forward — the
  payload always states the current value, same as `state`/`reason`).
- `sessionInfo` (`derive.go:53`) gains `HasError bool`; `liveSessions`
  (`derive.go:90`) copies it from the merged `m.attention[id]` entry
  alongside `State`/`Since`/`Reason`.
- `matrixCell` (`derive.go:161`) gains `HasError bool`; `buildMatrix`
  (`derive.go:188`) folds it with OR across every session in the cell:
  `c.HasError = c.HasError || s.HasError`.

**Rendering, TUI side (`internal/tui/view.go`):**

`renderMatrixCell` (`view.go:385`) changes from

```go
spark + " " + style.Render(glyph) + " " + dimStyle.Render(count)
```

to reserve one more fixed-width slot for the error mark, rendered in
`errorStyle` when set and a single space otherwise, placed between the state
glyph and the count so it reads as an annotation on the state, not a second
state:

```go
errMark := " "
if c.HasError {
	errMark = errorStyle.Render("!")
}
spark + " " + style.Render(glyph) + errMark + " " + dimStyle.Render(count)
```

(selected-row rendering gets the same slot, unstyled like the rest of that
branch already is).

**Data plumbing + rendering, desktop side** (no DTO gap here —
`SessionSummary.has_error` already exists in `api.ts:60`):

- `MatrixCell` (`apps/tauri-desktop/src/ui/workspace/model.ts:8`) gains
  `hasError: boolean`.
- `buildMatrix` (`model.ts:32`) folds it with OR, same as the TUI:
  `c.hasError = c.hasError || !!s.has_error` inside the existing per-summary
  loop (only for summaries that already pass the `stateFresh` check — an
  error from a session that has otherwise aged out of the live view should
  not resurrect the cell).
- `ui/workspace/index.ts` (`draw()`, ~line 55) adds a sibling span next to
  the existing `glyph` span, mirroring the dwell panel's own markup
  (`ui/dwell/index.ts:61`) exactly:

  ```ts
  el("span", { class: "glyph" + (needs ? " needs" : "") }, stateGlyph(c.state)),
  el("span", { class: "err", title: c.hasError ? "an error was captured in this cell" : "" }, c.hasError ? "!" : ""),
  el("span", { class: "count" }, c.sessions > 1 ? String(c.sessions) : ""),
  ```

- `styles.css` gains one rule scoping the existing error color to this new
  element, mirroring `.dwell-row .err` and `.band-row .err`:

  ```css
  .matrix-cell .err { color: var(--err); font-weight: 700; }
  ```

### Test plan

- `internal/capture/internal/projection/attention_test.go`: update
  `TestTransitionIdleOnlyFromWorking` and add a case asserting
  `TickIdle(...).Since == lastActivity` (not `now`) when `lastActivity !=
  now`, both for a "just quiesced" gap (`now - lastActivity` just over
  `IdleAfter`) and a "long-dead, just rebuilt" gap (`now - lastActivity`
  measured in hours), proving both paths get the same honest answer.
- `internal/capture/internal/projection/projection_test.go`:
  - Update `TestAdvanceIdle` to assert the emitted transition's `Since` (via
    `Session("s1").StateSince`) equals the *event time already applied*
    (`base`), not the `AdvanceIdle` argument.
  - Add `TestAdvanceIdleAfterRebuildStampsOwnLastActivity`: build a
    Projection from spooled events whose last activity is hours before
    "now," call `AdvanceIdle(now)`, and assert `StateSince` equals that last
    activity time, not `now` — this is the literal restart-restamp
    regression.
  - Add `TestInboxUnaffectedByIdleSweep` (or extend an existing inbox test):
    apply a session's activity, call `AdvanceIdle` well past `IdleAfter`,
    and assert `Inbox()`'s evidence timestamps for that session are
    untouched by the sweep (documents item 1's "checked, not a bug"
    finding as a durable regression test, not just a design-doc claim).
- `internal/tui/tui_test.go` / `derive_test.go`: add a case seeding
  `PreloadSessions` with a `needs_input` session whose `Since`/`Last` are
  both far in the past (past `needsStaleAfter`), and assert
  `needsYouCount() == 0` and the header omits "NEEDS YOU"; keep the existing
  fresh-`needs_input` cases passing unchanged.
- `internal/tui/derive_test.go` / `view_test.go`: extend the workspace
  matrix tests with a cell containing one erroring and one clean session,
  asserting the rendered cell contains the error mark, and a cell with none
  erroring stays exactly as wide but unmarked (column alignment guard).
- `internal/client/client_test.go`: assert `Sessions()` parses `has_error`
  from a fixture JSON response.
- `apps/tauri-desktop/src/ui/workspace/model.test.ts`: extend `buildMatrix`
  tests with a fresh summary carrying `has_error: true` and one carrying
  `has_error: false` in the same cell, asserting `cell.hasError === true`;
  and a case where the only erroring summary is stale (fails `stateFresh`),
  asserting it does not resurrect `hasError` for the cell.
- `apps/tauri-desktop/src/ui/workspace/index.test.ts`: assert the rendered
  cell contains a `.err` element with `"!"` text when `hasError`, and an
  empty `.err` element otherwise (so the DOM shape — and column width in the
  table — never changes).

### Contract assessment

No frozen-surface impact. `has_error` is already a documented, additive
`/sessions` field (`docs/contracts.md`); this item only (a) fixes a client
that was silently failing to parse an already-frozen field, and (b) adds
presentation in two viewers. Nothing here touches the envelope, privacy,
spool, export, or the API's shape.

## Addendum (wave 2): Codex adversarial review findings

A Codex adversarial review of the branch after the above landed found three
real bugs in this same follow-up work, all fixed in follow-up commits on the
same branch (no design changes needed, no frozen-surface impact):

- **The `state_since` fix above was itself off by `IdleAfter`.** Stamping
  `Since` from `lastActivity` (this doc's original "the fix") is honest about
  *whether* a session is idle but not about *when* idle began — the session
  was still `working` for the 90s between `lastActivity` and the threshold
  crossing. A viewer computing dwell as `now - Since` therefore showed a
  fake ~90s of extra dwell the instant idle was first noticed, on every
  normal sweep, not just after a restart. Fixed by stamping `Since` from the
  threshold crossing itself (`lastActivity + IdleAfter`) in `TickIdle`
  (`internal/capture/internal/projection/attention.go`).
- **`lastActivity` was not monotonic.** `ApplyResult` assigned it from every
  applied event unconditionally, unlike `LastTime`'s existing max-tracking.
  Append order does not establish timestamp order, so a late-arriving event
  with an older source time could drag a session's evidence of life
  backwards, corrupting the idle sweep's crossing-time math. Fixed by
  tracking the max event time, mirroring `LastTime`
  (`internal/capture/internal/projection/projection.go`).
- **Reconciliation snapshots dropped fields the TUI needs.** The daemonless
  reconnect path (`internal/host/feed.go` `projectedSessionTransitions`)
  omitted `has_error` entirely (a stream overflow could silently clear an
  unresolved error mark), and neither reconnect path carried `last_time`, so
  a session whose activity had scrolled out of the bounded event-ring
  recovery window had no way to look fresh again after reconciling. Fixed by
  carrying both fields on both reconciliation payloads
  (`internal/host/feed.go`, `internal/client/client.go`) and consuming them
  in `noteAttention` (`internal/tui/tui.go`).

See the branch's commit history for the corresponding TDD commits and
regression tests.

## Addendum (wave 3): a second Codex adversarial review

A second Codex adversarial review, run against the branch after wave 2
landed, found three more real bugs, all in the same follow-up work and all
fixed on the same branch (no design changes, no frozen-surface impact — the
fixes only populate already-optional envelope fields and add new,
purely-additive keys to the stream-only, never-persisted `state.transition`
payload):

- **A transition's `event.Time` was overloaded to mean two different
  things: "when this was published" and "when the state began."** For an
  ordinary state change the two coincide, but `AdvanceIdle`'s idle sweep
  stamped `Time` with `next.Since` — the historical threshold crossing,
  which after a cold rebuild can be hours or days in the past — instead of
  the sweep's own tick. The TUI appends live frames to the timeline in
  arrival order and never sorts, so a batch of idle transitions published
  moments after a restart could render as the newest rows while carrying
  ancient timestamps. Fixed by publishing every transition's `Time` at its
  own instant and moving the honest state-begin time into a new payload key,
  `since` (`internal/capture/internal/projection/projection.go`).
- **The same conflation reset the viewer's dwell clock on an error that
  arrives mid-wait.** `Transition` (`attention.go`) already leaves `Since`
  untouched when only `HasError` flips, but both the TUI
  (`internal/tui/tui.go`) and the desktop dwell model
  (`apps/tauri-desktop/src/ui/dwell/model.ts`) assigned the transition
  event's own time to `Since`/`state_since` unconditionally, so a session
  that had needed input for ten minutes and then errored looked like it had
  just started waiting. Fixed by reading the new `since` payload key in both
  viewers, falling back to the event's own time when it is absent (older
  backends, or a transition genuinely published at its state-begin time).
- **Reconciliation snapshots carried no workspace identity.** Both
  reconciliation builders (`internal/host/feed.go`,
  `internal/client/client.go`) already carry `last_time` and `has_error`
  (wave 2) but set no `Agent`/`Repo`/`CWD` on the synthetic event and no
  session-source in its payload. A session recovered purely from a
  reconciliation snapshot — no prior attention entry to carry identity
  forward from, its own events already outside the bounded recovery ring —
  landed under an empty workspace/agent cell instead of its own. Fixed by
  stamping the session's `Agent`/`Repo`/`CWD` on the event (`Source` stays
  `"firehose"`, the synthetic-transition marker; the session's real
  originating adapter travels as payload `source` instead) and consuming
  both in `noteAttention` (`internal/tui/tui.go`).

See the branch's commit history for the corresponding TDD commits and
regression tests.
