# Codex adversarial review: streaming projection.Build (PR #34)

Date: 2026-10-17. Reviewer: `codex exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only`
over `git diff origin/main...HEAD` at 3a152ee. Result: no P0/P1, one P2, one P3.

## F1 (P2): the read-gap seed was stamped before the scan

The old `Build` called `time.Now()` after `ReadForProjection` had read the
whole spool. The streaming `Build` stamped the seed before scanning. An
id-less legacy record replaces the seed only when it is strictly newer, so a
record timed between those two instants (for example from a clock-skewed
source) would have won where the seed used to win. `/attention` would then
report a different gap.

**Disposition: fixed.** The seed is now stamped after the scan through a
`buildNow` seam. `TestBuildStampsReadGapAfterScan` failed first: its clock
repairs the spool when it is called, so a stamp taken before the scan records
no read gap. The plan doc wording is corrected.

## F2 (P3): the equivalence tests zeroed every gap time

The helper cleared `Time` on every gap, including gaps derived from captured
records, whose times are deterministic. A regression that kept the source and
summary but returned the wrong captured time would have passed.

**Disposition: fixed.** The equivalence helper pins `buildNow` to 2026-09-01
10:30 UTC for both builds and compares `gap` and `Inbox()` exactly, with no
normalization. Two new cases (a legacy record exactly at the clock and one
after it) test the boundary.

## Categories with no findings

Codex found nothing else in: ordering, gap resets, `readGap`, dedupe, vanished
files, CRLF, a final line without a newline, oversized and invalid records,
aliasing of the line buffer, other `readLine` callers (tailer offsets
unchanged), test vacuity, frozen surfaces and privacy, and error and close
handling. Its sandbox could not run `go test`, so those runs were done locally:
`gofmt -l .` was empty, and `go vet ./...` and `go test ./...` passed.
