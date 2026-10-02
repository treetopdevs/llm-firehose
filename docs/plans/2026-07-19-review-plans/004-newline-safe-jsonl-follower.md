# Plan 004: Share a newline-safe JSONL follower across spool and Codex capture

> **Executor instructions**: Follow the TDD order and every verification gate.
> Preserve the append-only spool contract and do not solve unrelated Codex
> history/context behavior. Update `plans/README.md` when complete unless a
> reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat 9801acf..HEAD -- internal/spool/spool.go internal/spool/spool_test.go internal/adapters/codex/watcher.go internal/adapters/codex/codex_test.go internal/jsonl docs/contracts.md`
> Material drift is a STOP condition until the excerpts are reconciled.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / tech-debt
- **Planned at**: commit `9801acf`, 2026-07-19

## Why this matters

Both live tailers use `bufio.Scanner`, treat its final unterminated token as a
record, and advance by `len(line)+1` even when no newline exists. A writer split
across polls can therefore be parsed/skipped once and never delivered after the
line is completed. Scanner size errors are also not handled consistently. A
small stdlib-only follower should make a complete newline the sole commit
boundary and give both consumers identical offset/error behavior.

## Current state

- `internal/spool/spool.go:205-231` scans from an offset and advances manually;
  it ignores `Scanner.Err` in the live loop.
- `internal/adapters/codex/watcher.go:88-106` duplicates that logic with an 8 MiB
  limit and silently skips parse errors.
- `internal/spool/spool.go:117-134` also uses a scanner for historical reads,
  accepting a final token without a newline even though the spool contract is
  one complete event per line.
- `Tailer.Prime` and Codex startup record raw file size, which may point past an
  incomplete trailing record.
- `docs/contracts.md:46-55` defines newline-delimited append-only records and
  says bad spool lines become `meta/warn` events in the tailer.
- Existing concurrency style is context-aware channel send with no blocking of
  the capture producer; follow `spool.go:223-227`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Shared helper tests | `go test ./internal/jsonl` | exit 0 |
| Consumer tests | `go test ./internal/spool ./internal/adapters/codex` | exit 0 |
| Race tests | `go test -race ./internal/jsonl ./internal/spool ./internal/adapters/codex` | exit 0 |
| Format check | `gofmt -l .` | no output |
| Vet | `go vet ./...` | exit 0 |
| Full suite | `go test ./...` | all pass |

## Scope

**In scope**:

- `internal/jsonl/follower.go` (create)
- `internal/jsonl/follower_test.go` (create)
- `internal/spool/spool.go`
- `internal/spool/spool_test.go`
- `internal/adapters/codex/watcher.go`
- `internal/adapters/codex/codex_test.go`
- `docs/contracts.md`

**Out of scope**:

- Do not change spool writer format, filenames, schema version, or export order.
- Do not reconstruct Codex session metadata for already-existing files; that is
  a separate finding.
- Do not refactor SSE, CLI ingest, or process-output scanners; they do not track
  append offsets and have different protocol boundaries.
- Do not add fsnotify or any dependency; retain polling.
- Do not touch dirty Orbit files.

## Git workflow

- Suggested branch: `advisor/004-newline-safe-jsonl-follower`
- Commit helper/tests first, then migrate consumers and docs.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Specify record-boundary behavior in failing helper tests

Create `internal/jsonl` with tests for a reader/follower primitive that accepts
a path, starting byte offset, maximum record size, and a callback. The exact API
may vary, but it must return the next committed byte offset and expose a typed
`ErrLineTooLong` (or equivalent) record error.

Tests must prove:

1. LF and CRLF complete records are yielded without terminators and return the
   exact byte after the terminator.
2. A final unterminated fragment is not yielded and the returned offset remains
   at that record's first byte. After appending the rest plus newline, it is
   yielded exactly once.
3. A completed oversized record is consumed through its newline, surfaced as a
   typed error without retaining unbounded memory, and the next valid record is
   still delivered.
4. A callback error does not commit past the rejected record.
5. A helper that computes the last complete offset returns file size when the
   file ends in newline and the last newline boundary otherwise.

Use `bufio.Reader.ReadSlice('\n')` or equivalent chunked stdlib logic; do not
use `Scanner` or unbounded `ReadAll`.

**Verify**: `go test ./internal/jsonl` → tests initially fail, then pass after
the helper is implemented.

### Step 2: Migrate spool historical and live reads

Replace scanner-based `readFile` and `Tailer.poll` record framing with the
shared helper. Preserve consumer semantics:

- historical reads skip malformed completed records;
- live spool reads convert malformed/oversized completed records into one
  `source=firehose`, `category=meta`, `severity=warn`, `name=parse-error` event;
- an incomplete trailing fragment emits nothing and remains pending;
- offsets advance only after a complete record is handled;
- context cancellation still unblocks a channel send.

Change `Tailer.Prime` to record the last complete newline boundary, not raw file
size, so a record being appended at the snapshot boundary is delivered after
completion. Add an integration test that writes half a valid event, waits for a
poll with no output, appends the remainder and newline, then receives that event
exactly once and no parse warning.

**Verify**: `go test ./internal/spool` → all old tests and new split-write,
oversize, and prime-boundary tests pass.

### Step 3: Migrate the Codex watcher

Use the same shared helper and complete-offset priming in `watcher.go`. Keep one
`FileParser` per path and preserve current skip rules. On a completed malformed
or oversized line, emit a bounded `meta/warn` event that names the Codex source
file but does not include raw line contents; capture failures must be visible
without leaking payloads.

Add a watcher test based on the existing `sessionMetaLine`: create a new rollout
file, write a complete metadata line and half a `user_message` line, assert no
prompt is delivered yet, append the rest plus newline, and assert one prompt is
delivered. Use polling/deadlines, not fixed long sleeps, where possible.

Do not use this plan to parse old content merely to recover session ID/CWD; only
an incomplete line present at the startup boundary may be delivered later.

**Verify**: `go test ./internal/adapters/codex` → all parser/watcher tests pass.

### Step 4: Document incomplete-record recovery

Update the spool contract to state that readers commit only newline-terminated
records, retain an incomplete trailing fragment for a later poll, and surface a
bounded warning for a completed invalid/oversized live record. This clarifies
the existing NDJSON contract and does not change its version.

**Verify**: `rg -n "newline-terminated|incomplete trailing|oversized" docs/contracts.md` → all behaviors are documented.

### Step 5: Run focused race and full gates

**Verify**:

```sh
gofmt -l .
go vet ./...
go test -race ./internal/jsonl ./internal/spool ./internal/adapters/codex
go test ./...
git status --short
```

Expected: empty formatting output, all commands exit 0, and only scoped files
plus pre-existing user changes appear.

## Test plan

- Pure helper tests for exact offsets, LF/CRLF, split writes, oversized lines,
  callback failure, and complete-boundary priming.
- Spool integration: a split valid event appears exactly once with no warning.
- Spool integration: completed malformed/oversized line produces one bounded
  warning and does not block the next event.
- Codex integration: split prompt appears only after newline and once.
- Existing history ordering, schema stamping, and watcher mappings remain green.

## Done criteria

- [ ] Neither live tailer uses `bufio.Scanner` for append-offset framing.
- [ ] Incomplete records never advance committed offsets or emit errors.
- [ ] Completed split records are delivered exactly once.
- [ ] Oversized records are bounded, surfaced, and do not wedge later records.
- [ ] Priming uses the last complete record boundary.
- [ ] No new dependency, spool-version change, or Codex history replay is added.
- [ ] Format, vet, race, and full tests pass.
- [ ] The index status row is updated.

## STOP conditions

- A real captured record requires a limit larger than the proposed bounded
  maximum; report its byte size and source without reproducing sensitive data.
- Supporting file replacement/truncation requires inode/file-identity semantics
  that cannot be made portable in this small helper; report separately.
- The helper would require changing writer atomicity or the frozen spool format.
- The change begins replaying pre-existing Codex events or inventing session
  context for them.

## Maintenance notes

The shared helper owns byte framing and offsets only; parsing and error-event
policy stay with each consumer. Future append-only JSONL adapters should reuse
it. Review any future scanner reintroduction carefully: `Scanner`'s convenient
EOF token semantics are exactly what causes this loss mode.

