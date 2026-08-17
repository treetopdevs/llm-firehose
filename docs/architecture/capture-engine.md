# Deepening the Capture Engine

**Status:** Approved design

**Date:** 2026-08-17
**Scope:** Internal architecture; no frozen contract change

## Decision

Deepen the Capture Engine into the sole module responsible for turning normalized
Observations into durable Captured Events and projecting them into local views.
The daemon and daemonless TUI become adapters over the same engine interface.

The Capture Engine owns:

- Admission ordering;
- workspace enrichment;
- Capture Policy application;
- canonical spool persistence and reconciliation;
- disposable session, trace, and file Projections;
- live subscriptions and backpressure;
- Source Adapter lifecycle;
- history queries and export.

Source Adapters continue to own native parsing, source-specific filtering, safe
payload selection, and source-schema drift detection. They submit normalized
`event.Event` values as Observations.

## Why deepen this module

The same capture invariants are currently reconstructed in several places:

- `internal/cli/cli.go` parses pushed payloads, enriches, redacts, and appends;
- `internal/daemon/otel.go` independently enriches, redacts, and appends batches;
- `internal/daemon/stream.go` runs watchers, persists some observations, applies
  the index, and publishes events;
- `cmd/firehose/main.go` builds a separate daemonless tail/watch/redact path;
- daemon handlers read the spool and index directly.

These modules are shallow at the capture seam: callers must know privacy order,
durability order, retry meaning, indexing order, and live-delivery behavior.
Deleting any one orchestration path merely moves those facts into another caller.

The deepened module provides leverage across every Source Adapter and locality for
the highest-risk rules. Its interface becomes the test surface for the frozen
privacy and spool semantics.

## Goals

1. Make daemon and daemonless capture behavior identical.
2. Guarantee that a Captured Event is durable before it reaches derived state or a
   Live Subscription.
3. Keep capture non-blocking with respect to viewers and fail-silent with respect
   to coding agents.
4. Preserve crash-safe append-before-checkpoint behavior for durable Source
   Adapters.
5. Make every derived view rebuildable from the canonical spool.
6. Remove spool, index, tailer, and subscriber-hub knowledge from callers.
7. Migrate incrementally without dual writes.

## Non-goals

- Changing the event envelope, privacy meanings, spool format, export format, or
  local HTTP interface;
- changing any Source Adapter mapping or inventing new source payload shapes;
- consolidating adapter installation and doctor metadata;
- adding retention, cloud sync, accounts, telemetry, or network dependencies;
- changing the Go-versus-Rust engine decision;
- introducing a global total order across independent processes;
- making Live Subscriptions a second source of truth.

## Approved invariants

### One engine in both hosts

The long-running daemon and daemonless TUI construct the same Capture Engine.
The daemon adds the local HTTP adapter. The TUI connects directly to the in-process
engine. Both modes persist Codex and process observations to the canonical spool.

This intentionally replaces the current daemonless exception that displays direct
Codex and process observations without persisting them.

### Adapter seam

The Capture Engine accepts normalized Observations, not raw native payloads.
Source Adapters remain responsible for transforming a native record into zero or
more Observations. A deliberate filter remains zero Observations; a parse or drift
failure remains adapter-local and may produce a safe Capture Warning Observation.

There are multiple real adapters at this seam: Codex durable files, process
watching, pushed hooks, generic ingest, and supplemental OTLP.

### Admission commit point

Admission is serialized within one engine instance:

```text
Observation
    │
    ▼
validate → enrich workspace identity → apply Capture Policy → append
                                                             │
                                    durable commit point ─────┘
                                                             │
                                                             ▼
                                                  idempotent Projection
                                                             │
                                             ┌───────────────┴───────────────┐
                                             ▼                               ▼
                                       derived index                  Live Subscriptions
```

Persistence returns the exact Captured Event written, including any assigned ID,
schema version, and capture time. Projection always uses that returned value, never
the pre-append copy.

The durable append is the commit point:

- Before append succeeds, the Observation is not a Captured Event.
- After append succeeds, Admission succeeds even if an immediate Projection later
  needs reconciliation.
- A Projection failure cannot cause a durable Source Adapter to retry and append a
  second copy.

### Persistence failure

If append fails:

- the original Observation is not indexed or published;
- a durable Source Adapter does not advance its checkpoint and retries later;
- a one-shot caller receives an error;
- fail-silent hooks shield the coding agent from that error;
- a best-effort Capture Warning may be published or written to diagnostics, but it
  never substitutes for the missing Captured Event.

The current process-watcher fallback that publishes an unpersisted source event is
removed.

### Projection and reconciliation

After a successful local append, the engine immediately applies the Captured Event
to derived state and Live Subscriptions. It does not wait for the polling tailer.

The spool tailer remains an internal reconciliation adapter for:

- One-shot Admissions written by short-lived processes;
- writes from another process;
- records recovered after restart;
- the append-before-project crash window.

Projection is idempotent by stable event ID. Reconciliation suppresses a duplicate
Projection but never deletes the duplicate observation from the append-only spool or
export.

### Ordering

One engine instance serializes Admission so its append and Projection order agree.
External processes retain `O_APPEND` whole-line safety but do not share the engine's
sequencer. Their records are projected in reconciliation order.

The system makes no global cross-process ordering guarantee. Source time,
capture time, and native `sequence` fields remain the evidence for source ordering.

### Live backpressure

A Live Subscription has a bounded queue and can never block Admission or
Projection for other subscribers. When its queue overflows, the engine terminates
that subscription rather than silently dropping individual Captured Events.

The adapter reconnects and reloads durable history before resubscribing. An optional
synthetic Capture Warning may explain the gap, but disconnection is the authoritative
recovery signal.

### Capture Policy

The Capture Engine owns the active in-memory Capture Policy. It enriches workspace
identity before applying that policy and applies the result before persistence.
Source Adapters and hosts cannot bypass it.

Configuration loading and persistence remain outside this module. A host supplies
the initial privacy mode; an approved live update changes the active policy
atomically. Other configuration fields retain their restart-required semantics.

### Source Adapter lifecycle

The Capture Engine starts, supervises, and stops long-running Source Adapters,
spool reconciliation, and idle-state advancement under one context-controlled
lifecycle. One Source Adapter failure must not stop other capture paths.

Adapters keep their own source-specific recovery rules. Durable adapters use the
Admission result to decide whether a checkpoint may advance. Engine supervision
reports failures as Capture Warnings and applies bounded retry where the adapter does
not already own its polling loop.

## Proposed module shape

The new package is `internal/capture`. Its external interface is behavior-oriented;
no spool, index, tailer, hub, cursor, or polling type crosses the seam.

Illustrative Go shape:

```go
package capture

type Options struct {
    SpoolDir string
    Policy   privacy.Mode
    Sources  []Source
}

type Source interface {
    Run(context.Context, Sink) error
}

type Sink interface {
    Admit(context.Context, event.Event) (event.Event, error)
}

type Subscription struct {
    Events <-chan event.Event
    Done   <-chan error
}

func New(Options) (*Engine, error)
func (e *Engine) Run(context.Context) error
func (e *Engine) Admit(context.Context, event.Event) (event.Event, error)
func (e *Engine) SetPolicy(privacy.Mode) error
func (e *Engine) Subscribe(context.Context) *Subscription

func (e *Engine) Recent(limit int) ([]event.Event, error)
func (e *Engine) Sessions() []Session
func (e *Engine) Session(id string) ([]event.Event, error)
func (e *Engine) Trace(id string) ([]event.Event, error)
func (e *Engine) Files() []FileArtifact
func (e *Engine) Export(io.Writer) (int, error)

func AdmitOnce(context.Context, OneShotOptions, event.Event) (event.Event, error)
```

The names are illustrative; implementation may reduce them further while preserving
the approved interface limits. In particular:

- lifecycle ends through context cancellation rather than `Start` + `Wait` ordering;
- test clocks, persistence substitutions, and queue sizes are construction-time
  internal seams, not mutable public fields;
- query results use capture-owned domain types while retaining their frozen JSON
  shapes at the local HTTP adapter;
- `AdmitOnce` shares the exact private admission implementation used by `Engine`.

## One-shot Admission

Hook and CLI fallback processes must not rebuild the full index or start Source
Adapters. `AdmitOnce` performs only:

```text
validate → enrich → apply Capture Policy → append → return stored Captured Event
```

If a long-running engine exists, normal routing should still prefer it. When no
engine is reachable, the short-lived process performs One-shot Admission and exits.
A running engine or future engine start discovers the record through reconciliation.

One-shot Admission is an internal seam within the capture package, not a second set
of capture semantics.

## Internal implementation

Suggested file organization:

```text
internal/capture/
  engine.go          lifecycle and public interface
  admission.go       ordered enrich/policy/append commit path
  one_shot.go        short-lived entry point
  projection.go      deduplication and derived state
  subscription.go    bounded live subscriptions
  history.go         canonical queries and export
  sources.go         Source lifecycle supervision
  internal/
    spool/           append-only persistence and reconciliation
    projection/      disposable session/trace/file implementation
```

The final move under nested `internal/` directories enforces the seam in Go. During
migration, the existing `internal/spool` and `internal/index` packages may remain in
place temporarily, but only the capture package may import them. No compatibility
shim may become a permanent parallel interface.

The frozen `internal/event` envelope remains a separate module because adapters,
clients, schema tests, and the capture module all use that contract. The privacy and
workspace implementations may also remain separate modules, but only the Capture
Engine chooses when they run during Admission.

## Host adapters

### Daemon

`internal/daemon` becomes the local HTTP adapter. It owns HTTP concerns only:

- request limits and media types;
- loopback and origin enforcement;
- translating HTTP requests into Source Adapter parsing or engine operations;
- translating engine results into frozen response shapes;
- mapping subscription termination to stream closure.

It does not construct watchers, append to the spool, apply the index, manage a hub,
or implement privacy.

### Daemonless TUI

`cmd/firehose` constructs and runs the Capture Engine in process, preloads recent
history through the engine, and supplies a Live Subscription to `internal/tui`.
It does not import Codex, process watching, privacy, spool, or index packages.

### CLI and hooks

Pushed observations first attempt the daemon adapter. Transport failure falls back
to One-shot Admission. A daemon rejection is returned as a real rejection and does
not trigger a second local write.

The existing neutral hook response remains outside the Capture Engine: the hook
adapter catches capture errors, attempts a safe Capture Warning, writes `{}`, and
returns success.

### OTLP

The OTLP adapter retains bounded JSON parsing, content allowlists, and unconditional
exporter-facing success. Parsed Observations cross the same engine Admission seam.
Supplemental OTLP failure never changes the canonical hook baseline.

## Failure matrix

| Failure | Durable state | Projection | Caller behavior | Recovery |
|---|---|---|---|---|
| Adapter deliberately filters native record | none | none | success | none |
| Adapter cannot parse native record | optional safe Capture Warning | warning only | adapter-specific; hooks stay neutral | fixture/drift update |
| Observation validation fails | none | none | Admission error | fix adapter |
| Workspace identity unavailable | event without claimed identity | normal | success | none |
| Spool append fails | none | none | Admission error; hooks shield agent | durable adapter retries |
| Immediate Projection fails after append | Captured Event exists | delayed | Admission remains successful | reconciliation/rebuild |
| One Source Adapter fails | existing history intact | others continue | engine remains running | warning + bounded retry |
| Subscriber queue overflows | history intact | subscriber terminated | reconnect | durable reconciliation |
| Engine stops after append, before Projection | Captured Event exists | delayed | restart | spool reconciliation |
| Duplicate stable ID replays | duplicate remains in spool/export | projected once | success | idempotent Projection |

## Compatibility

This design does not require a schema-version or export-version bump.

| Frozen surface | Required result |
|---|---|
| Event envelope | No removal, rename, or semantic change |
| Privacy semantics | Identical modes; one enforced Admission path |
| Spool format | Same daily append-only NDJSON and at-least-once rule |
| Export format | Same oldest-first schema-versioned envelopes |
| Local HTTP interface | Same routes and response meanings |

Closing an overloaded event stream is compatible with the current best-effort live
interface. Clients must be changed to reconcile history before reopening the stream;
no new persisted event kind is required.

Daemonless persistence of Codex and process observations changes which already-valid
events survive restart, not the meaning or shape of a frozen field.

## Incremental TDD migration

The migration must not dual-write an Observation through old and new paths.

### Slice 1 — Stored-event persistence

- Begin with a failing test proving append returns the exact stored event with ID,
  schema version, and capture time.
- Preserve the existing NDJSON bytes and append-only behavior.
- Add concurrent whole-line and ordering coverage.

### Slice 2 — Admission and One-shot Admission

- Test enrich-before-policy-before-append ordering.
- Test all privacy modes through the public Admission interface.
- Test that append failure produces no Projection.
- Route CLI local emit and ingest through One-shot Admission.
- Delete their direct enrich/redact/writer orchestration.

### Slice 3 — Projection and reconciliation

- Test append-before-immediate-Projection.
- Test exact-ID replay suppression in derived state and live delivery.
- Test restart recovery across the append-before-project crash window.
- Move index building, application, and spool tailing behind the engine seam.

### Slice 4 — Live subscriptions

- Test ordered delivery for serialized local Admissions.
- Test that one slow subscriber cannot block Admission or another subscriber.
- Test overflow termination and durable client reconciliation.
- Replace the daemon hub with engine subscriptions.

### Slice 5 — Source Adapter lifecycle

- Adapt Codex durable watching to the engine `Sink`; preserve append-before-checkpoint
  tests with the real sanitized fixture.
- Adapt process watching to return Admission failures instead of broadcasting an
  unpersisted event.
- Prove one failing Source Adapter does not stop another.
- Move idle-state advancement into the engine runtime.

### Slice 6 — Daemon adapter

- Route emit, ingest, OTLP, recent events, sessions, traces, files, export, and live
  streaming through the engine.
- Keep HTTP contract tests unchanged where possible.
- Delete direct spool, privacy, index, and watcher ownership from `daemon.Server`.

### Slice 7 — Daemonless adapter

- Replace `cmd/firehose.viewFeed` with the same engine used by the daemon.
- Prove daemon and daemonless modes write byte-equivalent Captured Events for the
  same Observation and Capture Policy.
- Prove Codex and process observations persist in daemonless mode.
- Delete direct watcher, privacy, and spool wiring from the command package.

### Slice 8 — Seal the seam

- Move spool and projection implementations behind `internal/capture`.
- Remove obsolete exported implementation types and compatibility shims.
- Add a dependency check that daemon, CLI, and TUI do not import private capture
  implementation packages.
- Update `CLAUDE.md`, `README.md`, `docs/adapters.md`, and `docs/contracts.md` only
  where the implementation description changed.

## Tests that must survive

- Real-fixture parser and privacy tests for every Source Adapter;
- hook neutral-response and daemon-fallback tests;
- Codex append-before-checkpoint, cursor quarantine, truncation, rotation, and restart
  tests;
- workspace identity and privacy-mode tests;
- spool append/read, partial-line, corrupt-line, large-record, and at-least-once tests;
- index rebuild-equals-fold tests;
- daemon loopback, origin, request-limit, stream, shutdown, and local HTTP contract
  tests;
- TUI pause/filter/detail/export behavior;
- desktop compatibility, connection, feed-state, and orbit-model tests.

New acceptance tests must additionally prove:

1. A failed append never reaches any query or Live Subscription.
2. A successful append projects the exact bytes represented by the stored event.
3. Projection failure after append is recovered without source retry.
4. One-shot writes reconcile exactly once into a running engine.
5. Daemon and daemonless hosts enforce identical Capture Policy behavior.
6. A slow subscriber disconnects while capture remains healthy.
7. Concurrent local Admissions preserve per-engine order under `go test -race`.
8. Restart rebuilds all derived state solely from the spool.
9. The five frozen surfaces remain byte- and behavior-compatible.

## Validation gates for implementation

Run the repository gates after each migration slice:

```sh
gofmt -l .
go vet ./...
go test ./...
go test -race ./...
go build ./cmd/firehose ./cmd/firehosed
```

After daemon or desktop-facing slices:

```sh
bash scripts/build-sidecar.sh
pnpm -C apps/tauri-desktop test
pnpm -C apps/tauri-desktop build
cargo test --manifest-path apps/tauri-desktop/src-tauri/Cargo.toml
```

Final acceptance requires both daemon and daemonless live runs. Static tests alone
cannot prove sidecar lifecycle, stream reconnection, or direct local capture.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Refactor duplicates durable writes | Move one origin at a time; prohibit dual-write shims |
| Immediate Projection races reconciliation | One idempotent Projection path keyed by stable ID |
| Hook fallback becomes slow | One-shot path never builds index or starts Source Adapters |
| Engine interface grows with transport details | Keep raw parsing and HTTP concerns in adapters |
| Slow viewer affects capture | Bounded queues; terminate and reconcile |
| Daemonless mode changes history volume | Document intentional persistence; keep privacy identical |
| Projection error triggers durable-source retry | Treat append as the commit point; reconcile Projection separately |
| Public internals survive migration | Seal implementation under the capture package and delete shims |

## Completion criteria

The design is implemented when:

- daemon and daemonless hosts use one Capture Engine implementation;
- no caller outside `internal/capture` directly appends, tails, indexes, or publishes
  Captured Events;
- every source Observation crosses the same enrich/policy/persist Admission path;
- failed persistence never leaks the original Observation into a view;
- local Projection is immediate and reconciliation is idempotent;
- slow subscriptions recover from durable history;
- existing adapter fixtures and frozen contract tests remain green;
- full Go, race, desktop, Rust, and live daemonless/daemon acceptance pass;
- the old orchestration paths are deleted rather than retained as alternatives.
