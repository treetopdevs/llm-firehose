# Plan 005: Bootstrap clients from history into live SSE without gaps or duplicates

> **Executor instructions**: Execute only after Plan 004 is DONE. Run every
> verification gate, preserve existing `/events/stream` behavior when no replay
> parameter is supplied, and stop on any frozen-contract ambiguity. Update the
> index row when complete unless a reviewer owns it.
>
> **Drift check (run first)**:
> `git diff --stat 9801acf..HEAD -- internal/daemon/stream.go internal/daemon/stream_test.go internal/client/client.go internal/client/client_test.go cmd/firehose/main.go cmd/firehose/main_test.go apps/tauri-desktop/src/api.ts apps/tauri-desktop/src/api.test.ts apps/tauri-desktop/src/main.ts apps/tauri-desktop/src/state.ts apps/tauri-desktop/src/state.test.ts docs/contracts.md`
> Material drift is a STOP condition until reconciled.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/004-newline-safe-jsonl-follower.md`
- **Category**: bug / architecture
- **Planned at**: commit `9801acf`, 2026-07-19

## Why this matters

Desktop currently reads history and then subscribes, so events between those
operations are absent. The TUI subscribes and then reads history, so overlapping
events can appear twice. The server also flushes SSE headers before registering
the subscriber, leaving a smaller connection-time gap. An additive replay
option on the existing SSE endpoint can atomically subscribe, replay a bounded
snapshot, deduplicate overlap by event ID, and then continue live for both
clients.

## Current state

- `apps/tauri-desktop/src/main.ts:109-119` calls `recent(500)` before `stream`.
- `cmd/firehose/main.go:190-201` opens `Stream` before `Recent(500)` and returns
  both to `tui.Preload`, with no ID deduplication.
- `cmd/firehose/main.go:209-237` starts the direct spool tailer before reading
  local history, with neither a synchronous prime boundary nor ID deduplication.
- `internal/daemon/stream.go:156-162` flushes HTTP 200 before `hub.subscribe()`.
- `internal/daemon/stream.go:20-65` intentionally drops events for a subscriber
  whose bounded channel is full; this plan must not make capture block.
- `internal/client/client.go:84-121` exposes a plain live `Stream(ctx)`.
- The local API is frozen, but adding an optional query parameter while keeping
  the parameterless semantics unchanged is additive. Document it.
- TypeScript tests use Vitest and pure exported helpers; follow
  `apps/tauri-desktop/src/state.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Daemon/client tests | `go test ./internal/daemon ./internal/client ./cmd/firehose` | exit 0 |
| Go race tests | `go test -race ./internal/daemon ./internal/client ./cmd/firehose` | exit 0 |
| Frontend tests | `pnpm -C apps/tauri-desktop test` | all Vitest tests pass |
| Frontend build | `pnpm -C apps/tauri-desktop build` | TypeScript and Vite exit 0 |
| Format check | `gofmt -l .` | no output |
| Vet/full Go | `go vet ./... && go test ./...` | exit 0 |

## Scope

**In scope**:

- `internal/daemon/stream.go`
- `internal/daemon/stream_test.go`
- `internal/client/client.go`
- `internal/client/client_test.go`
- `cmd/firehose/main.go`
- `cmd/firehose/main_test.go` (create if absent)
- `apps/tauri-desktop/src/api.ts`
- `apps/tauri-desktop/src/api.test.ts` (create)
- `apps/tauri-desktop/src/main.ts`
- `apps/tauri-desktop/src/state.ts`
- `apps/tauri-desktop/src/state.test.ts`
- `docs/contracts.md`

**Out of scope**:

- Do not change `GET /events` ordering or response shape.
- Do not add durable cursors, pagination, WebSockets, reconnection policy, or
  authentication.
- Do not make hub broadcast block; slow-subscriber drop policy remains.
- Do not refactor `FeedState` filtering/coalescing, TUI rendering, or Orbit
  rendering/model files. A small bounded event-ID deduper in `state.ts` is in
  scope so browser EventSource reconnection cannot replay duplicates into both
  the feed and Orbit.
- Do not alter synthetic transition persistence; they remain stream-only.

## Git workflow

- Suggested branch: `advisor/005-atomic-history-live-bootstrap`
- Use TDD commits for server replay, Go client migration, then desktop migration.
- Do not push or open a PR unless instructed.

## Target protocol

Add optional `replay=N` to `GET /events/stream`:

1. With no `replay`, behavior remains the existing live-only SSE feed.
2. With a positive bounded `replay`, the handler subscribes **before** taking
   the spool snapshot or sending headers.
3. It writes up to N historical spooled events, oldest first.
4. It then drains/continues the subscribed live feed, skipping any live event
   whose nonempty ID was already sent in the replay. Remove an ID from the
   overlap set after skipping its first live duplicate so this is a bootstrap
   deduper, not permanent stream-wide suppression.
5. Stream-only synthetic frames are never added to replay but continue live.
6. Invalid, zero/negative, or over-limit values return 400 before streaming.

Use a documented maximum such as 5000 and size the bootstrap subscriber buffer
to accommodate the requested replay plus the existing live allowance, while
retaining nonblocking hub broadcast. This removes the handoff race within the
daemon's documented bounded-subscriber semantics; it does not promise recovery
after a later network disconnect.

## Steps

### Step 1: Add failing daemon replay-contract tests

Seed a temporary spool before connecting and test that
`/events/stream?replay=2` emits the newest two events oldest-first, followed by
a newly broadcast/spooled live event. Add an overlap test using a directly
accessible same-package `Server`: broadcast an event with an ID already sent in
replay, then a distinct event, and assert the next delivered data frame is the
distinct event rather than a duplicate.

Also test live-only parameterless behavior, invalid/negative/over-limit values,
and subscription ordering. The ordering assertion must prove that once the HTTP
stream is established, a broadcast cannot fall into the current pre-subscribe
gap.

**Verify**: `go test ./internal/daemon -run 'TestStream.*Replay'` → tests fail
before implementation.

### Step 2: Implement bounded replay in the SSE handler

Parse and validate `replay` before writing headers. Subscribe before loading
history and before flushing headers. For replay requests, read the bounded
snapshot from the canonical spool, write each event as the existing `data:` SSE
frame, and record nonempty IDs. Continue receiving the subscriber channel and
skip only IDs already emitted during bootstrap. Do not globally deduplicate
later legitimate frames, and never deduplicate empty IDs.

Factor frame writing into a small helper so replay and live JSON/error behavior
cannot drift. If snapshot reading fails, return an HTTP error before headers;
always unsubscribe on every exit path after subscription.

Parameterless clients must still receive no history. Preserve nonblocking hub
broadcast and server-shutdown behavior.

**Verify**: `go test ./internal/daemon` → all stream, transition, shutdown, and
new replay tests pass.

### Step 3: Add a Go replay client and migrate the TUI feed

Keep `Client.Stream(ctx)` for compatibility and add
`StreamWithReplay(ctx, limit)` (or a private shared implementation) that requests
the encoded replay query. Migrate daemon-backed `viewFeed` to use replay 500 and
return an empty preload slice; remove its separate `Recent(500)` request.

Fix the direct/no-daemon handoff too, using Plan 004's exact boundary:

1. Construct the spool tailer and call `Prime()` synchronously.
2. Read the 500-event history snapshot.
3. Build a set of nonempty history IDs.
4. Start the already-primed tailer and the other live watchers.
5. In the forwarding goroutine, skip and delete the first live occurrence of a
   history ID; forward every other event normally.

This sequence permits safe overlap but no gap. Keep Codex redaction and process
watcher behavior unchanged. Do not try to replay pre-existing Codex/procwatch
events; they have no local spool-history contract.

Add client integration coverage that pre-seeded history arrives through the
stream followed by a live event exactly once. Add `cmd/firehose/main_test.go`
coverage using a real test daemon to prove daemon mode does not return duplicate
preload history. Add a direct-mode test that appends at the prime/history
boundary and proves the ID appears exactly once across preload plus live output.

**Verify**: `go test ./internal/client ./cmd/firehose` → replay and direct-mode
tests pass.

### Step 4: Migrate desktop to the same atomic stream

Add an optional replay limit to the TypeScript `stream` API and construct the
URL with `URLSearchParams` or another encoded pure helper. In `main.ts`, remove
the `recent(500)` bootstrap and connect once with replay 500. Preserve health
compatibility checks, EventSource automatic reconnection behavior, status
callbacks, event counting, feed ingestion, and Orbit ingestion.

Because native EventSource reconnects by reopening the same replay URL, add a
small bounded ID-window helper in `state.ts` and apply it at the top of
`onEvent`, before both `FeedState.push` and `panels.orbit.ingest`. The window must
be bounded to the same order of magnitude as the 5000-event feed (for example,
10,000 IDs); empty IDs are always accepted. This is defensive client dedupe,
not durable reconnect recovery.

Add a Vitest file for the pure URL/query helper: no replay omits the parameter;
500 produces `replay=500`; invalid values are rejected before EventSource is
constructed. Extend `state.test.ts` for the bounded ID window: first occurrence
accepted, recent duplicate rejected, empty ID accepted, and an evicted old ID
accepted after the capacity is exceeded. Do not introduce jsdom or a browser
dependency merely for these tests.

**Verify**:

```sh
pnpm -C apps/tauri-desktop test
pnpm -C apps/tauri-desktop build
```

Expected: all tests pass and TypeScript/Vite build exits 0.

### Step 5: Document the additive API option and limits

Update the `/events/stream` row and prose in `docs/contracts.md` with the target
protocol above. State explicitly that parameterless behavior is unchanged,
replay contains spooled events only, synthetic transitions remain live-only,
and overlap is deduplicated by nonempty event ID. Do not bump schema version.

**Verify**: `rg -n "replay=N|live-only|deduplic" docs/contracts.md` → the
additive semantics are discoverable.

### Step 6: Run all gates

**Verify**:

```sh
gofmt -l .
go vet ./...
go test -race ./internal/daemon ./internal/client ./cmd/firehose
go test ./...
pnpm -C apps/tauri-desktop test
pnpm -C apps/tauri-desktop build
git status --short
```

Expected: formatting output is empty, all commands exit 0, and no files outside
scope are newly modified. Existing dirty Orbit files remain untouched.

## Test plan

- Daemon: bounded replay order, overlap dedupe, live continuation, invalid
  limits, parameterless compatibility, synthetic-live-only behavior, shutdown.
- Go client: history plus live over one stream, exactly once.
- TUI feed: daemon path has empty preload and receives replay through channel;
  direct mode primes before history and removes overlap exactly once.
- TypeScript: encoded stream URL for absent/valid/invalid replay limit, plus a
  bounded event-ID window that protects feed and Orbit from reconnect replay.
- Full frontend build catches stale `recent` imports/signatures.

## Done criteria

- [ ] Desktop and daemon-backed TUI use one replaying SSE subscription, not a
      separate history request.
- [ ] Direct/no-daemon mode uses prime → history → live with ID overlap removal.
- [ ] An event crossing the bootstrap boundary is delivered exactly once by ID.
- [ ] Browser reconnect replay is rejected before both FeedState and Orbit
      ingestion by a bounded ID window.
- [ ] Parameterless `/events/stream` remains live-only.
- [ ] Replay is bounded, oldest-first, spooled-only, and validated before 200.
- [ ] Synthetic transitions remain live-only and unpersisted.
- [ ] Hub broadcast remains nonblocking.
- [ ] Go format/vet/race/full tests and frontend test/build gates pass.
- [ ] The index status row is updated.

## STOP conditions

- Plan 004 is not DONE or its tailer tests are not green.
- An existing supported client already assigns a conflicting meaning to a
  `replay` query parameter.
- Correctness requires changing parameterless stream semantics, persisting
  synthetic frames, or bumping a frozen schema/API version.
- A deterministic overlap test cannot be written without adding production-only
  timing hooks; refactor a pure helper or report the blocker instead of adding
  sleeps.
- The implementation would make capture/broadcast wait on a slow client.

## Maintenance notes

Replay solves initial bootstrap only. EventSource reconnection currently has no
durable last-event cursor, and the Go client has no reconnect loop; those remain
separate audited work. If durable cursors are added later, preserve this
parameterless/live-only compatibility and keep synthetic frames explicitly
non-durable.
