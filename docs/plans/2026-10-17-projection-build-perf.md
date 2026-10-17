# Projection Build at startup: stream the spool instead of materializing it

Date: 2026-10-17. Status: landed (results below).

## Problem

`capture.newEngine` (`internal/capture/engine.go`) calls `projection.Build(spoolDir)`
once at engine startup. On heavy real spools it takes about 25 s and reaches
7.4 GB HeapSys (`2026-10-16-session-endpoint-perf.md`, "worth its own ticket"),
and `2026-10-08-graph-mockup-fidelity.md` reports about 3 GB RSS on a 2.2 GB
spool.

`Build` calls `spool.ReadForProjection`, which decodes every record of every
day file into a per-file `[]event.Event`, appends those into one spool-wide
slice, and only then applies the events one by one. Every decoded event,
including its full `Payload` map, stays reachable until the last one is
applied. `event.Event` is 464 bytes before its payload.

## Measurement method

The machine's load average is 60 to 900, so wall-clock time is noise. The
metrics are `go test -bench -benchmem` (B/op, allocs/op) plus
`runtime.MemStats` after `Build` (HeapSys, HeapInuse, and the TotalAlloc delta
of one `Build`). The spool is synthetic: `writeSyntheticSpool` in
`internal/capture/internal/projection/build_bench_test.go` cycles the real,
sanitized records in `internal/capture/testdata/*.ndjson` and
`internal/capture/internal/projection/testdata/errsig.ndjson`, with fresh ids,
times, 2000 sessions and rolling trace ids, into a temp dir. It never reads or
writes `~/.agentfirehose`.

```sh
go test -run '^$' -bench BenchmarkBuild -benchtime 3x ./internal/capture/internal/projection/
```

## Baseline (main at 64affe6; 10 day files × 10,000 records = 100k events)

| Metric | Value |
|---|---|
| B/op | 803,555,888 (≈ 8.0 KB/event) |
| allocs/op | 3,579,761 (≈ 36/event) |
| HeapSys after Build | 331 MiB |
| HeapInuse after Build | 240 MiB |

Allocation profile (`-focus='projection\.Build$'`): the growing event slices
(`readFileReport` flat ≈ 400 MB/op, `ReadForProjection` flat ≈ 373 MB/op) are
about 70 % of bytes. The rest is per-record decode: `readLine`'s fresh line
buffer (≈ 133 MB/op), payload boxing (`reflect.unsafe_New`, `mapassign`), and
`time.Format` of the day string, which `ApplyResult` computes twice per event.

## Prototypes measured before deciding

| Prototype | B/op | allocs/op | HeapSys |
|---|---|---|---|
| Baseline | 804 MB | 3.58 M | 331 MiB |
| Stream each day file through `ScanDay` into `Apply` | 327 MB | 3.58 M | 55 MiB |
| Streaming + decode only the payload keys the projection reads | 321 MB | 2.69 M | 55 MiB |

After streaming, JSON decode is about 57 % of `Build` CPU.

## Decisions

1. **Stream.** Add `spool.ScanForProjection(dir, onGap, yield)`: it walks the
   same sorted `*.ndjson` list, reads each file with a 1 MiB `bufio.Reader`,
   and yields each validated event in file order. Gap semantics match
   `ReadForProjection` exactly: oversized, undecodable, or invalid records call
   `onGap`. A file that disappears between listing and open is still an error,
   as before. `Build` applies events as they arrive and never holds the spool.
   `ReadForProjection` stays: the equivalence test uses it as the reference and
   `graph_history_scale_test.go` uses it.
   Correction found while building: `applyInbox` does read `gap`. The old
   `Build` seeded the read-gap `CaptureGap` before applying any event, and an
   id-less legacy record replaces it only if strictly newer, while an applied
   `firehose`/`parse-error`/`meta` record with an id overwrites it outright.
   Streaming only learns about gaps at the end, so `Build` folds the seed in
   afterwards with the same rule (`resetsGap` mirrors the overwrite
   condition), and stamps the seed before the scan as before.
   `TestBuildEquivalenceReadGapMeetsInboxGaps` covers 11 orderings.
2. **Reuse the line buffer** in the streaming path. `json.Unmarshal` copies
   every string it decodes, so a scratch slice can back each line. The tailer
   and the other readers keep their current `readLine` behavior.
3. **Format the day string once per event** in `ApplyResult` and store that
   same string in `seen`. Semantics are identical, and it saves one allocation
   per event plus one retained string per event id.
4. **Not doing payload-key pruning.** It saves 25 % of allocs but only 2 % of
   bytes, and a projection-only decoder would drift from `event.Event`
   decoding semantics (type errors in `raw`, payload shape). Not worth the
   equivalence risk.
5. **Deferring the on-disk checkpoint.** It is the only remaining lever on
   decode CPU, but: (a) today's day file is appended continuously, so a
   size+mtime key never covers it; (b) the checkpoint must serialize every
   unexported field of `Projection` (attention state and idle clocks, inbox
   `Evidence` with `*time.Time`, error-signature members and samples, `seen`,
   `identityDays`, `allDays`) and prove an identical restore, and every future
   field becomes a silent-drift hazard; (c) the measured problem in the
   tickets is mostly memory, which streaming removes. It gets its own ticket
   with these numbers.

## Guardrails

- The spool stays the only source of truth; nothing new is persisted.
- No change to the five frozen surfaces and no `schema_version` bump.
- Equivalence: an in-package test builds a reference projection with
  `ReadForProjection` + `Apply` and compares it with `Build` field by field
  (unexported maps and all exported views), over both real testdata dirs and
  over a spool with an undecodable line, an invalid record, and an oversized
  record, so gap parity is proven.
- TDD: the failing-first test is an allocation bound per event on a synthetic
  spool (old ≈ 8 KB/event fails a 5 KB bound; streaming passes it).

## Results

Same synthetic spool and command as the baseline.

| Metric | Baseline | Streaming (this slice) | Change |
|---|---|---|---|
| B/op | 803.6 MB | 229.5 MB | −71 % |
| B/event (TotalAlloc delta) | ≈ 8,023 | 2,295 | −71 % |
| allocs/op | 3.58 M | 3.38 M | −6 % |
| HeapSys after Build | 331 MiB | 55 MiB | −83 % |
| HeapInuse after Build | 240 MiB | 37 MiB | −84 % |

Peak heap is now about the Projection's own live size, not the spool size.
Scaled linearly, the 7.4 GB HeapSys on a real spool should fall to roughly the
size of the live projection (≈ 1.2 to 1.4 GB on that machine, per the session
perf doc). That is an estimate: the live spool was not read.

Tests that guard it:
- `TestBuildAllocationsPerEvent`: under 5,000 B/event (failed at 8,023 first).
- `TestBuildEquivalence*`: every unexported field and every exported view of
  `Build` equals the `ReadForProjection` + `Apply` reference, over the real
  fixtures (split by day and in one file), a synthetic spool, a spool with an
  undecodable line, a record that fails `Validate`, a 9 MiB oversized record,
  and ids duplicated across days, plus the read-gap orderings above.
- `spool/scan_projection_test.go`: `ScanForProjection` yields exactly what
  `ReadForProjection` returns, with the same gap flag, open errors, CRLF, a
  final line without newline, and no aliasing of the reused line buffer.

Deferred (own ticket): an on-disk checkpoint for sealed day files, the only
remaining lever on decode CPU (≈ 57 % of `Build` CPU). See decision 5.
