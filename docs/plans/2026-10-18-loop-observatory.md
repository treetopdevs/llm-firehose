# Loop Observatory v1

Status: implemented and locally validated, PR #35, 2026-10-18. Base: origin/main a150daa16408e6578467ceb1d196cb07022751b2.

## Outcome

A usable desktop prototype to inspect repeated Error Signatures within one session and compare captured activity between recurrences. Prerequisites #33 (timeline view) and #34 (projection build memory) are merged. This is the next backlog slice. No automatic intervention or claims about causality, identical strategies, code quality, or a successful fix.

## Workflow

Plan → Argon 4 High adversarial plan review → test-first implementation → local validation and interactive browser check → Argon 4 High diff review → fix findings and re-review → commit and PR → inspect CI/reviews and autofix. Merges remain human-approved. Review fallback is Claude Sonnet 5.5 High only if Argon is unavailable.

## Scope and decisions

- A desktop Loops panel reachable from navigation and a session entry point, using existing session summaries, `sessionEvents(id, "timeline")`, and session-scoped `errorSignatures`.
- Pure derivation sorts valid events by time then id, deduplicates event ids, excludes synthetic transitions, and scopes to the selected session/source. Reuse the Score's signature identity helpers; authoritative member ids take precedence. Fallback identity is explicitly disclosed when membership is missing, unavailable, or capped.
- Only signatures with at least two observed occurrences in the loaded session are shown. Counts come from those observations, never global signature counts. Call these recurrences, not proven attempts. The same call may have multiple error observations; do not claim independent retries.
- Compare each consecutive pair of occurrences: actual timestamps, elapsed time, category counts for captured events strictly after the first occurrence through the second (deterministic time/id order). Exclude synthetic state transitions. No inference of file edits, commands, reads, or successful tests from missing payloads. The first occurrence is a baseline, not an attempt.
- A compact orbit/recurrence overview plus accessible buttons/list/table offers signature selection and interval evidence. Preserve real gaps, show exact counts even when visual rendering is bounded; paginate or cap rendered rows with an explicit notice. Avoid quadratic filtering across occurrences: group/index events once and derive interval counts efficiently.
- Evidence opens full captured event details on explicit selection only, with cancellation/stale-response guards and projected fallback on failure. The view owns its detail presentation or otherwise respects the shared pane's ownership guards. Switching sessions, refreshes, failures, loading, empty history, unavailable signatures and old-daemon full envelopes have explicit states. A late response cannot overwrite another session or a newer selection.
- No new dependency, persistence, network service, API route, or frozen-surface change. No automatic attention inference in this slice.

## Test seams and acceptance

User delegated routine decisions; seams are the exported pure recurrence model and observable DOM/API behavior of the Loops panel. Follow vertical red/green cycles, using existing real captured Score/Error Signature fixtures. Pin deterministic order/dedupe, local counts, membership precedence and fallback disclosure, interval boundaries and category counts, invalid times, transitions, empty/single occurrence, multiple signatures, source/session isolation, and bounded rendering for large histories.

DOM tests cover successful selection, full detail fetch only on explicit click, stale responses and session switching, errors/retry, missing signatures and old-daemon full events. The panel is reachable from the application. No unsafe innerHTML for captured text.

Validation: `gofmt -l .` → `go vet ./...` → `go test ./...`; desktop tests (serial files under machine load), desktop build; build sidecar then Rust tests. Interactive browser check using real captured fixture responses served locally, without changing live spool or agent settings. Record actual evidence and limitations in the HTML coordination log.

## Backlog after this slice

Attention loop inference (only after recurrence semantics are useful), Attention notifications/collision; Session Stratigraphy; Evidence Court manual receipts; Handoff Subway explicit links. Existing Map and Score are working prototypes. Causal Loom, Patch Ecosystem, Attention Airspace and Forked Replay Lab remain concepts pending bounded plans/data prerequisites. Storm cells remain blocked on file-tied errors. Adapter expansion needs real payloads. Cloud/signing/release gates remain separate.

## Review refinements

The first completed external review used Claude Sonnet 5.5 High after Argon 4 High timed out without a verdict. Findings and their regression fixes are recorded in `docs/reviews/2026-10-18-loop-observatory-sonnet-initial.md` and the HTML journal.

- Explicit view phase protects loading and error/retry states from source-filter changes; session switching remains available.
- Invalid timestamps are reported as excluded observations that may understate recurrence counts. Duplicate ids are reported separately as deduplication, not lost occurrences. Session/source filtering is intentional scope.
- Parse timestamps once for sorting. Equal millisecond timestamps use event-id order, not inferred sub-millisecond causality.
- Selected signatures disclose their own fallback membership count in addition to the overall count.
- Late signature membership retains selection if its group and interval still exist; otherwise it resets invalid selection.
- Interval evidence is paginated rather than permanently hiding observations after the first 40.
- Session-history requests accept an optional AbortSignal so abandoned scans can be cancelled. This is a backward-compatible client helper change, not a local API contract change.

## Implementation evidence

Code commit `85444e9`; all 476 frontend tests and build pass, along with Go and Rust gates. Interactive browser fixture check and limits: `docs/reviews/2026-10-18-loop-observatory-validation.md`. Sonnet 5.5 High final adversarial review: PASS. Hosted CI/reviews and human merge are tracked by PR #35.
