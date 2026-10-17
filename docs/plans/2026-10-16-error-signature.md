# Error Signature v1: build brief

**Status:** Brief agreed 2026-10-16; shipped the same day (see end). Source: the "Shared deferred
work" section of
[2026-10-16-session-score-and-activity-map.md](2026-10-16-session-score-and-activity-map.md).
Canonical term in `CONTEXT.md`: Error Signature — "A normalized identity under
which recurring error observations are recognised as the same error; the basis
for any claim that an error repeated or belongs to a file."

Three deferred pieces need this concept defined once, in the projection,
before any view claims two errors are the same or ties an error to a file:
storm cells on the Activity Map, motifs on the Session Score, and the Loop
Observatory / Session Stratigraphy brainstorm items. This slice defines the
identity and exposes it; it builds **no view**.

## Scope

1. `internal/capture/internal/projection/errsig.go`: the qualification
   predicate, the keying rule, and the per-signature aggregation folded in by
   `ApplyResult`.
2. `internal/capture/history.go`: an `ErrorSignatures` passthrough on the
   Engine, mirroring `Sessions()` (history.go:42).
3. `internal/daemon`: an additive `GET /errors` route.
4. `docs/contracts.md`: one row in the local API table. Additive only — no
   `schema_version` bump, nothing in the envelope changes.

Nothing in the TUI, the desktop app, or any adapter package changes.

## Decisions

### What qualifies

Exactly the predicate the attention overlay already uses for `HasError`
(attention.go:66): `Category == error || Severity == error`. Extract it as
`isErrorObservation(ev event.Event) bool` in errsig.go and have
`Transition` call it, so the two surfaces can never drift. Synthetic
`firehose`/`state.transition` frames never reach `ApplyResult`'s body and so
never qualify.

### The key

A signature's identity is the readable tuple, joined for transport as a
single string `source|category|name|class`:

- `source`, `category`, `name`: straight off the envelope.
- `class`, the most structured discriminator available, in order:
  1. `payload.error_class` when it is a non-empty string (claude-code
     StopFailure: `rate_limit`, `authentication_failed`, …).
  2. `payload.error_class` when it is a privacy digest — the
     `map[string]any{"sha256": …, "len": …}` shape minimal mode writes. Use
     the first 16 characters of the sha256 as the class token. Deterministic,
     so recurring errors still group; mirrors the digest handling the score
     view already does, and the `changes` digest bug fixed on branch
     `claude/friendly-haibt-461b3e` — accept both shapes, crash on neither.
  3. Otherwise the normalized `Summary` (below). Empty summary and no class →
     class is `""`; the tuple still keys on source/category/name (codex
     `turn_aborted`'s summary normalizes to its name anyway).

The key stays **readable** (power over privacy: this is host-local derived
state, never spooled). No hashing of readable keys.

### Summary normalization

Conservative, so distinct errors stay distinct:

- Lowercase; collapse whitespace runs to one space; trim.
- Replace every decimal digit run with `#`.
- Replace every hex run of 6+ characters with `#` (ids, digests, addresses).
- Truncate to 160 runes after the above.

Nothing else. Deliberately **no** path stripping: `failed: mix test` groups
across sessions because the text repeats exactly; two `sed -n '<range>'`
reads of the same file group because only the digits differ; the same command
against two different files stays two signatures, which is the honest
reading. (The fixture pins all three behaviors.)

### Aggregation

Per signature, under the existing projection lock, folded in by
`ApplyResult` after the exact-ID dedupe (replays must never double-count):

```go
type ErrorSignature struct {
    Key       string    `json:"key"`                // source|category|name|class
    Source    string    `json:"source"`
    Category  string    `json:"category"`
    Name      string    `json:"name,omitempty"`
    Class     string    `json:"class,omitempty"`
    Sample    string    `json:"sample,omitempty"`   // raw summary of the earliest (Time, ID) carrier
    Count     int       `json:"count"`
    Sessions  int       `json:"sessions"`           // distinct session_ids (set kept internal)
    FirstTime time.Time `json:"first_time"`
    LastTime  time.Time `json:"last_time"`
    Paths     []string  `json:"paths,omitempty"`    // sorted, capped at 20, see below
}
```

- First/last times follow the same monotonic rules as sessions and traces
  (an out-of-order event may extend FirstTime backwards, never drag LastTime
  backwards).
- **File tie-in, v1 limit:** a signature ties only to paths the qualifying
  event *itself* carries, via the existing `EventFilePaths` (which already
  returns nil for non-file categories). No inference from neighboring
  events. Cap stored paths at 20 per signature, keep the set sorted; the cap
  is a defense, not a contract.
- Accessor: `ErrorSignatures(sessionID string) []ErrorSignature` — empty id
  means all; otherwise only signatures that include that session. Sorted by
  LastTime desc, then Key asc (stable, like `Sessions()`). Per-session counts
  are **not** re-scoped in v1: filtering selects which signatures appear;
  counts remain global. Document that in the method comment and contracts.md.

### Engine and daemon

- `internal/capture/history.go`: `type ErrorSignature = projection.ErrorSignature`
  alias next to the existing aliases, and
  `func (e *Engine) ErrorSignatures(sessionID string) []ErrorSignature`.
- `internal/daemon`: `GET /errors` and `GET /errors?session={id}` in
  endpoints.go + the route table in daemon.go, JSON array response, same
  plain local-origin handling as `GET /sessions` (not the workspace-graph
  `graphResponse` wrapper). Returns `[]` not `null` when empty.
- `docs/contracts.md`, local API table row:
  `GET /errors[?session={id}]` — derived Error Signature summaries, most
  recently seen first; additive. Note global counts under session filter.

### Determinism (must be pinned by a test)

`Build(dir)` over the fixture spool and `New()` + `ApplyResult` per event in
any order must agree on every signature's Count, Sessions, FirstTime,
LastTime, Paths. Replaying the same event id twice must change nothing.

## Fixture

`internal/capture/internal/projection/testdata/errsig.ndjson` — 11 real
captured events (personal paths rewritten, long outputs truncated; same
convention as the score fixture):

- 2× codex `error/turn_aborted` (no session_id on one — a signature must
  tolerate events without sessions; Sessions counts distinct non-empty ids).
- 4× claude-code `error/StopFailure`: 2× `error_class=rate_limit` (two
  different sessions → one signature, Count 2, Sessions 2), 2×
  `authentication_failed`.
- 3× codex `shell/PostToolUse` severity=error, `failed: mix test`, across
  two sessions → one signature, Count 3, Sessions 2.
- 2× codex `shell/PostToolUse` severity=error, `sed -n '<different
  ranges>' src/assets/vue/pages/profile.vue`, same session → one signature
  via digit normalization, Count 2, Sessions 1.

Expected: **5 signatures** over the fixture (turn_aborted, StopFailure ×2
classes, mix test, sed). A minimal-mode variant must also be exercised by
redacting a real fixture event through `internal/privacy` (`Mode` minimal)
in the test — never by hand-writing a digest shape — and asserting the two
redacted copies of the same error still share one signature.

## Validation gate

`gofmt -l .` (empty) → `go vet ./...` → `go test ./...`. TDD: the failing
test lands before the behavior. Standard library only.

## Shipped 2026-10-16

As specified above, with one deliberate deviation: `Sample` is pinned to the
summary of the earliest `(Time, ID)` qualifying observation, not the first
applied. "First seen" depends on application order, and a rebuild reads the
spool in file order while the live process folded events in arrival order —
the same spool would have shown a different sample after a restart. With the
pin, the determinism test compares every field across Build, reversed, and
rotated application orders with no exclusions.

Files: `internal/capture/internal/projection/errsig.go` (+`errsig_test.go`,
12 tests over the real fixture, including minimal-mode redaction through
`internal/privacy` and the paths cap), a one-line refactor of
`attention.go`'s `HasError` onto the shared `isErrorObservation`,
`history.go`'s Engine passthrough, `GET /errors` in `internal/daemon`
(endpoints.go, daemon.go, endpoint tests driving all 11 fixture events
through real admission), and the contracts.md row.

Reviewed through three lenses (determinism/concurrency, frozen
surfaces/privacy shapes, test/fixture authenticity); no must-fix findings.
Known inherited edge: `EventFilePaths` still misreads a minimal-mode
`changes` digest as paths (fix lives on `claude/friendly-haibt-461b3e`,
f52d681); a signature over such an event would list `len`/`sha256` as paths
until that branch merges — add a minimal-mode file-error test then. A `|`
inside an event `name` could in principle collide two keys; adapter names
carry none today.

## Addendum 2026-10-16: session-scoped member event ids

`GET /errors?session={id}` now additionally carries `members` on each
signature: that session's qualifying event ids in `(Time, ID)` order, capped
at the 500 earliest per signature+session (`len == 500` signals truncation).
Without the `session` filter the field is omitted. Additive only — same
projection order-independence rules as `Paths`, pinned by the extended
determinism test (session-filtered snapshots across Build, reversed, rotated,
and replay). This lets clients group a session's error events by signature
without mirroring the keying rule.
