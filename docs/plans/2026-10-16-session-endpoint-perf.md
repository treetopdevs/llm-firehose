# GET /sessions/{id} performance: findings (2026-10-16)

Status: fix A implemented in `internal/capture/history.go` (branch
`claude/sharp-feynman-8b9a32`); before/after measured below under
"Result after fix A".

Target: session `019f3e42-c2e2-7503-902c-a6c2d4b2fb85` (Codex, 123,273 events,
2026-07-07 to 2026-09-02). The Session Score desktop view replays it through
`GET /sessions/{id}` and waits 12 to 16 s for a 132 MB body.

## Summary

The daemon spends the time JSON-decoding every record of the 22 day files the
session touches (545,754 records, 743 MB) in order to keep the 123,273 (22.6%)
that belong to the session. Reading the bytes, deduplicating, and encoding the
response together take under a second. The fix is to stop decoding the other
77%: stream each day file through the existing `spool.ScanDay` with a
`Prefilter` on the session id, which `graph_history.go` already does for
workspace queries. No new persisted state and no frozen surface.

## Measurements

All numbers are from this machine (Apple M1 Max, 34 GB) on 2026-10-16.
The live daemon is Homebrew `firehosed` v0.2.1 built with go1.26.4 (classic
`encoding/json`). The Go harness ran against a copy of the spool in a temp
directory with go1.27.2; the "v1 json" column uses `GOEXPERIMENT=nojsonv2` to
match the shipped daemon, the "v2 json" column is what a go1.27 rebuild would
get.

### Live daemon (read-only `curl -w`, three runs)

| Run | Body | Time to first byte | Transfer |
|---|---|---|---|
| parent session, earlier today | 132 MB | 16.4 s | 0.05 s |
| this session, run 1 | 131,945,256 B | 14.28 s | 0.46 s |
| this session, run 2 | same | 12.46 s | 0.04 s |

During run 2 the daemon process consumed 24.5 s of CPU time (`ps -o cputime`
before and after) for 12.5 s of wall clock. Resident set 1.36 GB.

### Payload composition (saved body, 123,273 events)

| Measure | Value |
|---|---|
| Compact JSON bytes | 129.5 MB (1,050 bytes/event) |
| `payload` | 35.9% |
| Envelope fields (everything else) | 64.1% |
| `worktree_id` + `repo_id` + `cwd` (same three strings on every event) | 21.6% |
| `capture_time` + `source_time` + `time` | 11.1% |
| `transport` (present in envelope and again in payload) | 4.6% |
| `payload.usage` + `payload.rate_limits` (31,639 `token_count` meta events) | 16.8% |
| `payload.output` + `payload.input` + `payload.arguments` | 10.7% |
| `raw` present | 0 events |
| Longest string | 241 runes; 30,695 strings are exactly 240 runes + `…` |
| Duplicate ids in response | 0 |
| Distinct UTC days by event time | 22 (the session spans 57 calendar days) |

Privacy: balanced mode is honored. No `raw`, every string capped at 240 runes
plus the truncation marker. The weight is repetition, not leakage.

Lighter envelope variants computed from the same body:

| Variant | Bytes | Share |
|---|---|---|
| Full envelope (today) | 132.0 MB | 100% |
| Envelope without `payload` | 85.3 MB | 65% |
| Timeline fields only (`id time category name severity summary turn_id call_id session_id`) | 36.5 MB | 28% |
| Timeline fields + `duration_ms status tool_name phase item_type` from payload | 42.3 MB | 32% |

### What the engine reads

`Engine.Session` asks the projection for the session's day set (22 days), then
`spool.ReadDays` decodes every record of each day, then `filterDeduplicate`
keeps the session's events.

| Day files read | 22 |
|---|---|
| Bytes on disk | 743,135,675 |
| Records decoded | 545,754 |
| Records kept | 123,273 (22.6%) |

Per-day share of records belonging to the session ranges from 80% (07-10) down
to 0% (one or two events in 08-11, 08-24, 09-01, 09-02, each costing a full
decode of a 14 to 40 MB file).

### Go harness: where the time goes (same 22 files, warm page cache)

| Phase | v1 json (as shipped) | v2 json (go1.27) |
|---|---|---|
| Raw line scan of 743 MB, no decode, 4 KB buffer | | 0.20 s |
| Raw line scan, 1 MB buffer | | 0.09 s |
| `spool.ReadDays` (decode all 545,754) | 8.55 s | 5.18 s |
| `filterDeduplicate` | 0.05 s | 0.32 s |
| `json.Encode` of the 123,273-event array | 0.60 s | 0.51 s |
| **`Engine.Session` end to end** | **8.47 s** | **5.23 s** |
| `ScanDay` + `Prefilter` on the session id (decodes 123,273) | 2.65 s | 1.99 s |
| Byte-offset index: build pass (one needle scan, no decode) | | 1.05 s |
| Byte-offset index: read + decode only indexed records (125 MB read) | | 0.96 s |

Allocation during one `Engine.Session`: 6.1 GB (`ReadDays` 10 GB cumulative in
the first profile including the projection build). The CPU profile's biggest
real user is `json.Unmarshal` under `readFileReport`; the profile also puts a
fifth of samples in GC mark workers. (macOS pprof attributes much of the time
to `syscall.read`; the raw-scan rows above show the reads themselves cost
0.1 to 0.2 s, so that attribution is sampling skew, not I/O.)

Replicating the daemon's state (projection built over a copy of the full
2.3 GB, 223-file spool) did not slow `Session` further: 5.5 s and 6.5 s on two
runs with v2 json, live heap after GC 281 MB, HeapSys 7.4 GB. Nor did a 1.1 GB
pointer-heavy heap ballast (6.0 s). The remaining gap between the harness
(8.5 s v1) and the daemon (12.5 to 16.4 s) is therefore not explained by the
projection's live size. The 24.5 CPU-seconds for a 12.5 s request say the
daemon runs about two cores busy for the whole request, which fits GC workers
chasing a 6 GB allocation burst inside a long-lived 1.4 GB resident process
that also runs the tailer; the fix shrinks the burst in proportion to the
decodes it removes. Not fully reproduced; stated as the most likely cause.

Startup: `projection.Build` over the full spool takes 25 s and 7.4 GB HeapSys.
Out of scope here, worth its own ticket.

### Webview side (node v24, 132 MB body, three runs)

| Step | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| utf8 decode | 206 ms | 150 ms | 137 ms |
| `JSON.parse` whole array | 948 ms | 418 ms | 320 ms |
| `JSON.parse` line by line (NDJSON proxy) | 629 ms | 268 ms | 240 ms |
| Heap after parse | 439 MB | | |

Parsing is under a second. The webview cost that matters is the 440 MB heap
for one session, which only a smaller body fixes.

## Dominant cost

Decoding 422,481 records that are not the session's. Everything else in the
request path (file reads, dedupe, encode) is under 1 s combined, and the
webview parses the result in under 1 s.

## Candidate fixes

### A. Prefiltered streaming scan (recommended)

Replace `spool.ReadDays` + `filterDeduplicate` in `Engine.Session` and
`Engine.Trace` with a loop over `e.scanDay(ctx, dir, day, Prefilter{needles},
...)` where `needles` is `IdentityNeedles([]string{id})`, keeping the exact
`SessionID == id` check and the stable-id dedupe in the yield function.

- Measured: 2.65 s (v1) / 1.99 s (v2) versus 8.47 s / 5.23 s, a 3.2x cut in
  decode work and a proportional cut in the 6 GB allocation burst, so the live
  daemon's GC overhead shrinks with it. Scaling the live 12.5 to 16.4 s by the
  harness ratio gives roughly 4 to 5 s to first byte; to be confirmed by
  re-measuring after the change.
- Cost: small. The scanner, the prefilter, and the `scanDay` test seam already
  exist for `graph_history.go`. No new state, no startup cost, nothing to
  persist or rebuild.
- Frozen surfaces: none. Same route, same JSON array, same dedupe semantics.
- Behavioral deltas the implementing tests must pin down: `ScanDay` calls
  `ev.Validate()` and skips invalid records, `readFileReport` does not (parity
  held on this session, 123,273 both ways, but the test fixture must include
  an invalid-category record for the session and the implementation must
  decide to mirror the old semantics or document the change); and
  `IdentityNeedles` refuses ids with non-ASCII or escapable characters, so a
  full-decode fallback (nil prefilter) is required for those.
- Optional follow-on inside the same change: write the JSON array
  incrementally as events are yielded instead of materializing the slice. Same
  bytes on the wire, lower peak memory, earlier first byte. Implementation
  detail, not a surface change.

### B. Per-session byte-offset index built by the projection

Record `(day, offset, length)` per event at Apply time, read only those spans.

- Measured: 0.96 s read + decode (v2), about 1 s better than A. That 1 s is
  the needle scan over 743 MB plus `readLine` copying each line before the
  needle test. It does not remove any decode that A keeps.
- Cost: offsets must be plumbed through `Writer.Append`, `Tailer`, and
  `ReadForProjection`; the projection holds about 2.1M spans for this spool
  (roughly 35 MB resident, more with per-session grouping) or persists a
  sidecar that must be rebuilt on the 25 s startup path and reconciled after
  crash-window replays.
- Frozen surfaces: none if kept in memory; a persisted sidecar is new
  host-private state and needs a reconciliation story.
- Verdict: not justified by this profile. Revisit if A lands and sessions
  spread across hundreds of days become common.

### C. Lighter envelope via an additive `fields=` (or `view=timeline`) query parameter

Serve the timeline fields plus a few payload scalars.

- Measured: 132 MB to 36.5 to 42.3 MB (28 to 32%), with webview heap
  shrinking in proportion from 440 MB. Does nothing for the 12 s server
  side on its own: the server still decodes 545k records to find them.
- Cost: moderate. Needs `docs/contracts.md` wording for the additive
  parameter, daemon tests, client support in `internal/client` and the
  desktop.
- Frozen surfaces: additive to the local API, no version bump, but it is a
  contract change that must be documented. Not to be prototyped without the
  contracts.md update.
- Verdict: the right follow-on after A for the webview's memory, not the fix
  for the latency.

### D. Streaming NDJSON response or a session-scoped spool shard

NDJSON is a new response format for an existing route and so a new surface
(or a new endpoint plus contracts.md). A session-scoped shard changes the
spool layout, a frozen surface, for a problem A solves without it. Neither is
recommended now; the node measurement shows line-by-line parsing is only
modestly faster than one `JSON.parse`.

## Recommendation

Implement A in `internal/capture/history.go`, test-first: a parity test that
`Session` and `Trace` return the same events as today's `ReadDays` path on a
fixture mixing the target session with others across several day files,
including an invalid-category record and a duplicate stable id; a test using
the `scanDay` seam proving only the session's day files are opened and that
the prefilter is passed; a test for a non-ASCII id falling back to a nil
prefilter. Then re-measure against the live daemon with the same `curl -w`
command and record the numbers here. Rebuilding the Homebrew formula with
go1.27 is a separate 1.6x tailwind on decode, not the fix.

## Result after fix A (2026-10-16)

`Engine.Session` and `Engine.Trace` now loop over `scanDay` (production
`spool.ScanDay`) with `Prefilter{IdentityNeedles(id)}`, keeping the exact
`SessionID == id` / `TraceID == id` check and the first-seen stable-id dedupe
in the yield function. Ids that `IdentityNeedles` refuses (non-ASCII or
escapable) scan with a nil prefilter. One semantic change, pinned by
`TestSessionMatchesFullReadMinusInvalidRecords` and its Trace twin: records
that fail `event.Validate` are now skipped, as `ScanDay`, the projection, and
the workspace timeline already do; the old full-decode path returned them.
The session the projection shows (its day set, its event count) never
included such records, so the response now agrees with it. Not a frozen
surface: same route, same JSON array, same dedupe.

Measured with a rebuilt `firehosed` on `127.0.0.1:4599`, `HOME` pointing at a
temp directory holding a copy of the 28 day files from 2026-07 to 2026-09
whose bytes mention the session id (a superset of the 22 days `SessionDays`
returns; the extra six only quote the id inside other sessions' payloads).
The live daemon on 4517 was not touched. Three `curl -w` runs per build,
warm page cache, the same `-o /dev/null` command as above. The response body
hashes identically before and after (131,945,256 bytes, 123,273 events).

| Build | Time to first byte, 3 runs | Daemon CPU time after 4 requests |
|---|---|---|
| before, go1.27.2 default (json v2) | 10.29 s, 9.83 s, 8.54 s | 44.3 s |
| after, go1.27.2 default (json v2) | 3.63 s, 2.87 s, 2.92 s | 24.2 s |
| before, `GOEXPERIMENT=nojsonv2` (classic json, as shipped) | 8.97 s, 8.70 s, 9.00 s | 46.9 s |
| after, `GOEXPERIMENT=nojsonv2` | 3.85 s, 3.23 s, 3.07 s | 27.9 s |

An earlier before run of the json v2 build on a quieter machine gave 6.82 s,
6.47 s, 6.77 s; the spread between that and the 8.5 to 10.3 s pass is
background load, so read the table as roughly 3x, not a precise ratio. The
CPU-time column includes the ~10 s projection build at startup, so the
per-request CPU went from about 8 to 9 s to about 3 to 4 s. The remaining
time is decoding the session's own 123k records plus the 0.5 s encode; the
lighter envelope (fix C) is the next step for both the server and the
webview's 440 MB heap.

Not done here: `Engine.Event(id)` still full-decodes one day file per
evidence link through `spool.ReadDays`; `Session`/`Trace` take no context,
so a client that disconnects does not cancel the scan.

## How these numbers were produced

- `curl -s -o body.json -w 'size=%{size_download} ttfb=%{time_starttransfer} total=%{time_total}' http://127.0.0.1:4517/sessions/<id>`
- Payload stats: a Python script over the saved body, counting compact JSON bytes per top-level field and per payload key.
- Spool share: `wc -l` and `grep -c <id>` over the 22 day files named by the response's event dates.
- Go harness: temporary `_test.go` files in `internal/capture` (not committed) timing `projection.Build`, `spool.ReadDays`, `filterDeduplicate`, `json.Encode`, `ScanDay` with and without `Prefilter`, a byte-offset index prototype, and `Engine.Session` over a copy of the spool in the scratchpad, with `-cpuprofile` and `-memprofile`, run with the default `GOEXPERIMENT` and with `nojsonv2`.
- Webview proxy: `node` reading the body, `Buffer.toString`, `JSON.parse`, and per-line `JSON.parse` over the same events re-stringified.
- After-fix table: `HOME=<tmp> firehosed -addr 127.0.0.1:4599` for each of four builds (`go build ./cmd/firehosed` at the parent commit and at the fix, each with and without `GOEXPERIMENT=nojsonv2`), wait on `/health`, then the `curl -w` command above three times, `ps -o cputime` on the daemon, and `shasum` of one saved body per build. Spool copy deleted afterwards.
