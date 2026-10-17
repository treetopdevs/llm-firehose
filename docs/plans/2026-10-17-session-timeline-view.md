# Session timeline view: build brief

**Status:** Brief agreed 2026-10-17. Source: fix C and the "Not done here" line of
[2026-10-16-session-endpoint-perf.md](2026-10-16-session-endpoint-perf.md).
Consumer: the Session Score (`apps/tauri-desktop/src/ui/score/`), which replays
one session over `GET /sessions/{id}`.

## Why this slice, and not storm cells

The decisions doc deferred Activity Map storm cells "until Error Signature".
Error Signature v1 shipped 2026-10-16 with a deliberate v1 limit: a signature
ties only to paths the qualifying event itself carries. On this machine's live
daemon (0.2.1, 2026-10-17) `GET /errors` returned 5,382 signatures and **none
carries a path**: 5,377 are `codex|shell|PostToolUse` failures, 4 are
claude-code `StopFailure`, 1 is codex `turn_aborted`. A path-placed storm layer
would draw nothing, and anything smarter would attribute shell errors to files,
which the Activity Map decision forbids. Storm cells stay deferred until a
source carries file-tied errors; pick something else before re-picking them.

Fix A (prefiltered day scans) landed on 2026-10-16 and cut the server time for
the 123,273-event Codex session from 12 to 16 s to the cost of decoding the
session's own records. The body is still 132 MB and the webview heap 440 MB,
because every event ships the full envelope and payload while the Score reads a
dozen fields. The perf doc names the lighter envelope the next step for both
the server's encode and the webview's memory, and requires the contract wording
before any prototype. This slice is that step, plus the one engine read the
same doc lists as not done (`Engine.Event(id)` still full-decodes a day file),
because the Score starts depending on it.

## Scope

In:

1. `GET /sessions/{id}?view=timeline`: an additive query parameter on the
   existing route (`internal/daemon/endpoints.go`).
2. `capture.TimelineView(ev event.Event) event.Event`: the pure projection the
   handler applies, in `internal/capture/history.go`.
3. `Engine.Event(id)` reads its day through the prefiltered day scanner.
4. `docs/contracts.md`: the row for the parameter (done in this brief's commit,
   before the daemon code).
5. Desktop: the Score fetches the timeline view and lazily fetches full
   envelopes for the detail pane.

Out: `GET /traces/{id}?view=` (follow-up; same helper, trivially), a `fields=`
free-form selector, any change to the default response, the TUI, the Go
client (`internal/client` has no session-by-id method), streaming the array,
any new persisted state.

## Decisions

### Route

`GET /sessions/{id}?view=timeline`. With no `view`, or `view=full`, the response
is byte-for-byte what it is today. Any other value is `400 Bad Request` with a
plain-text body naming the accepted values. 404 for an unknown session is
unchanged and takes precedence over nothing: validate `view` first, so a typo
never triggers a spool scan.

### The projection

The same events, in the same order, after the same stable-id dedupe as the full
response. Each event is the envelope with every field outside the allowlist
zeroed, so `omitempty` drops it, and `payload` reduced to the allowlisted keys.
The JSON tags are the envelope's own: a timeline event is a strict subset of a
full envelope, decodes into `event.Event` and `FirehoseEvent` unchanged, and
carries nothing the full response does not. It is not a substitute envelope:
re-emitting or exporting it is not a supported path, and the response is never
written to the spool.

Envelope fields kept, verbatim:

```
schema_version id time source agent session_id turn_id call_id
category name severity summary
```

Payload keys kept when present, values copied as-is (whatever shape they
have, string or privacy digest):

```
phase state tool_name error_class duration_ms status item_type
```

Everything else is dropped, including `transport`, `capture_time`,
`source_time`, `cwd`, `repo`, `repo_id`, `worktree_id`, `jj_*`, `trace_id`,
`sequence`, `raw`, and payload keys such as `usage`, `rate_limits`, `output`,
`input`, `arguments`, `file_path`, `command`.

Why these: the Score and Lanes models read `time category name severity summary
source agent session_id call_id payload.phase payload.state`
(`needs_input` marks) and `payload.error_class` (the local motif key mirror,
which must see the minimal-mode `{sha256,len}` shape to stay in step with the
daemon's keys); the detail pane's compact line reads `payload.tool_name`;
`turn_id`, `duration_ms`, `status`, `item_type` are the perf doc's measured
"timeline fields" set and cost nothing. `schema_version` stays so a consumer
can tell which contract it is reading.

An empty payload after filtering is omitted, not `{}`.

Privacy: a projection of already-admitted events can only remove fields, so no
privacy mode changes meaning. Minimal-mode digests that survive the allowlist
(`error_class`, `tool_name`) are passed through untouched.

### `Engine.Event(id)`

Replace `spool.ReadDays(e.spoolDir, []string{day})` with one `e.scanDay` pass
over the same day, prefiltered on `spool.IdentityNeedles([]string{id})`
exactly as `history()` does; a nil prefilter (non-ASCII or escapable id) scans
without one. First record whose `ID` matches wins, as today. Not-found stays
`ErrNotFound`. This read now backs every detail-pane highlight in the Score,
so it must not decode the whole day.

### Desktop

- `api.ts`: `sessionEvents(id, view?: "timeline")` appends `?view=timeline`
  when given; `capturedEvent(id, signal?)` gains an optional `AbortSignal`.
- The Score opens a session with `view: "timeline"`. The track model, motif
  keys, coalescing and transport are unchanged: everything they read is in the
  allowlist, and a test pins that `buildScore` over the projected fixture
  equals `buildScore` over the full fixture (tracks, ticks, spans, motifs).
- **Detail pane.** On highlight the Score calls the detail renderer at once
  with the projected event and its projected call siblings (so the pane is
  never empty), then lazily fetches the full envelope of the current event and
  of its call siblings via `capturedEvent` (`GET /attention/event?id=`), caches
  them by id for the open session, and calls the renderer again with the full
  events if the highlighted event is still the same one (the existing
  `v !== version` and `currentId` guards). Fetch failures are swallowed: the
  projected rendering stands.
- **Playback guard.** Full-detail fetches happen only when the transport is
  paused, on an explicit step (arrows, click, jump) or when playback stops on
  the event under the cursor. During play, the pane renders projected fields
  only. At most one detail fetch group is in flight; starting another aborts
  the previous one. The cache is cleared on `open()`.
- **Old daemon.** A daemon that predates the parameter ignores `view=` and
  returns full envelopes. The client must behave identically (the full
  envelope is a superset; the lazy fetch is then redundant but harmless). Pin
  it with a test that feeds the full fixture through the timeline code path.

## Tests

Go (`internal/capture/history_test.go`, `internal/daemon/endpoints_test.go`):

- `TestTimelineViewKeepsExactlyTheAllowlist`: over
  `apps/tauri-desktop/src/ui/score/fixture.session.json` (real, 101 events,
  balanced) and `fixture.errsig.json` (real minimal-mode digest shapes), the
  encoded JSON of every projected event has keys that are a subset of the
  envelope allowlist, `payload` keys a subset of the payload allowlist, the
  kept values byte-equal to the originals, and the fixture's `error_class`
  digests survive intact. Read the fixtures from their desktop path via a
  relative testdata symlink or a copy under `internal/capture/testdata/`;
  do not invent events.
- `TestTimelineViewDropsEmptyPayload`.
- `TestSessionByIDTimelineView`: same ids, same order, same length as the full
  response; no `transport`/`cwd`/`repo_id` in the body; `view=bogus` → 400;
  `view=full` and no `view` are identical bodies.
- `TestEventByIDUsesPrefilteredScan`: with the seam counter the history tests
  use, `Event(id)` decodes only the matching record of a day that holds
  several; a quoting-in-another-field record is scanned but rejected; a
  non-ASCII id falls back to a full scan and still resolves.

Desktop (`apps/tauri-desktop/src/ui/score/*.test.ts`, `api.test.ts` if one
exists, else beside the score tests):

- `sessionEvents` builds `/sessions/{id}?view=timeline` and the plain path.
- Score parity: `buildScore(projected) == buildScore(full)` over the fixture,
  motifs included.
- Highlight renders at once from projected fields, then re-renders with the
  fetched full event and siblings; a highlight change before the fetch lands
  discards the stale result; during play no `capturedEvent` request is made;
  a failed fetch leaves the projected rendering.
- The full-envelope (old daemon) response through the same path renders the
  same score.

## Validation

```sh
gofmt -l .            # must print nothing
go vet ./...
go test ./...
pnpm -C apps/tauri-desktop test
pnpm -C apps/tauri-desktop build
```

Before/after numbers, if taken, come from a temporary daemon over copied spool
days (as the Activity Map live check did), never the live 0.2.1 daemon on
4517, which cannot serve the view. Append a "Shipped" section here and update
fix C and the "Not done here" line in the perf doc.

## Shipped 2026-10-17

As specified, with these notes:

- **Go.** `capture.TimelineView` and `GET /sessions/{id}?view=timeline` in
  `internal/capture/history.go` and `internal/daemon/endpoints.go`; an unknown
  `view` is 400 before any spool scan. `Engine.Event` gained a `ctx` parameter
  (a review finding: aborting the client fetch did not stop the server's day
  scan, since `Event` scanned under `context.Background()`), and
  `/attention/event` passes the request context and stays silent when the
  client has gone. The Score fixtures are copied into
  `internal/capture/testdata/` (noted in its README) so the Go tests read the
  same real captures.
- **Fixture correction.** The brief said `fixture.errsig.json` holds
  minimal-mode digest shapes. It is a balanced-mode capture with plain
  `error_class` strings. Digest pass-through is pinned instead by running the
  same real events through `privacy.Redact(ModeMinimal)` in
  `TestTimelineViewPassesMinimalModeDigestsThrough`.
- **Desktop.** `timelineProjection` in `score/model.ts` mirrors the allowlist
  so tests derive the projected fixture from the real one. The Score opens with
  the timeline view and lazily fetches full envelopes (event plus call
  siblings) for the detail pane. Guards beyond the brief, each pinned by a
  test: starting playback aborts any in-flight detail fetch, so a restart from
  the end (which rewinds first) never fetches mid-play; a detached Score that
  pauses itself fetches nothing and never writes the shared detail pane; and
  `open()` drops the previous session's detail state before pausing, so the old
  session's current event is never fetched into the new cache.
- **Not measured.** No before/after bytes were taken: the live daemon is 0.2.1
  and a temporary daemon over copied spool days was not run this time. The
  perf doc's measured projection of the same field set (132 MB to roughly 42 MB
  for the 123k-event session) is the expectation.
- **Desktop test suite under load.** The wall-clock budget tests
  (`score/model.test.ts` 100k coalesce, `score/index.test.ts` 100k open,
  `graph/index.requests.test.ts` bursts) failed in parallel runs on this
  machine at a load average above 700 and passed with
  `--no-file-parallelism`. They are untouched by this change.
- **Codex review fixes.** A Codex Sol 6.1 xhigh adversarial review found two
  desktop races and nothing in the backend, privacy, contracts or allowlist
  ([review](../reviews/2026-10-17-session-timeline-view-codex.md)). A late
  full-detail result could overwrite another view's selection or reopen a
  closed pane: results now render only under the pane-selection token they
  started with, and only while the Score is attached. A new selection, the
  pane's close button (a `dismiss` callback main.ts wires in), `open()` and the
  view being shown again (`refresh()`) each bump the token and abort the fetch.
  Explicit steps during playback fetched full detail and cached envelopes
  rendered through `fuller()`: playback now renders projected fields only, and
  pausing renders cached envelopes at once and fetches the rest.
