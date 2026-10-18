# Claude Sonnet 5.5 High — final adversarial review

Requested fallback after Argon timeout. Immutable code commit 620e9c3.

I'll start by looking at the commit, the plan doc and the initial findings.
# Verdict: PASS for `620e9c3`

I found no blockers or medium findings. There are three low-severity notes, none of which needs code changes.

## What I ran

- `git rev-parse HEAD` is `620e9c3b…`.
- `gofmt -l internal` and `go vet ./internal/...` printed nothing.
- `go test ./internal/capture/... ./internal/daemon/... -run 'ErrorSessions|ErrorSignature|Errsig' -count=1` passed.
- `vitest run src/api.test.ts src/ui/strata/index.test.ts` passed 15 of 15.
- I did **not** run the full Go suite, the full frontend suite (the validation doc claims 488 tests), the production build, the Rust tests, or the browser walkthrough. Those claims in the validation doc are unverified by me.
- The worktree has an uncommitted change to `docs/reviews/2026-10-18-session-stratigraphy-validation.md`. I made no edits. The commit I reviewed is immutable, so this change is outside it.

## Remediation of the initial findings

| # | Initial finding | Status | Evidence |
|---|---|---|---|
| 1 | Medium: malformed query strings fell back to defaults | Fixed | `handleErrorSessions` in `internal/daemon/endpoints.go` now uses `url.ParseQuery(r.URL.RawQuery)` and returns 400 on error. `TestErrorSessionsRejectsMalformedAndAmbiguousQuery` covers `%zz` and `;` for offset and limit. |
| 2 | `Atoi` accepted `+5`, `-0` and `007`; duplicate params used the first value | Fixed | The handler requires ASCII digits only and rejects duplicate `key`, `offset` and `limit` with 400. The test covers `%2B5`, `-0` and duplicates. The contract in `docs/contracts.md` and the plan both state this. |
| 3 | The 404 body echoed the key | Fixed | The 404 body is the fixed `"error signature not found"`. The test sends `key=secret-not-found` and asserts the exact body `"error signature not found\n"`. |
| 4 | Empty `ev.ID` bypasses the dedupe | Accepted (see L1) | Admission assigns IDs. `TestErrorSessionsAdmissionAssignsEvidenceID` covers a source-supplied empty ID: `Admit` assigns one, a replay deduplicates, the sample is retrievable via `Event`, and a rebuild keeps it. |
| 5 | Delimiter ambiguity in the signature key | Out of scope | You said this is pre-existing and intentionally unchanged. |
| 6 | Panel switch lost the user's place | Fixed | `main.ts` calls `activate()`, which refreshes only when `!initialized`. A test asserts that returning keeps the selected signature and page, and that explicit refresh resets them. |
| 6b | Hidden panel does not abort in-flight requests | Out of scope | You said this is the existing lifecycle convention. Explicit scope changes do abort superseded requests. |
| 7 | 404 could not distinguish an old daemon from an unknown key | Fixed | The 404 text now names both causes. A test asserts both phrases. |
| 8 | Nested pager markup | Fixed | The extra wrapper style is gone from `styles.css`. `signaturePager` is now a plain `div`. |

## Plan versus implementation

- The route is additive. It is registered in `internal/daemon/daemon.go`, sits behind the existing `cors` wrapper, and the origin test expects 403 for a foreign origin.
- The handler matches the contract: `Cache-Control: no-store`, 400 before any lookup, 404 for an unknown key, and `sessions: []` when the page is empty.
- `ErrorSessions` in `internal/capture/history.go` re-validates bounds and reads only the projection. The engine test replaces `scanDay` with a stub that calls `t.Fatal` to prove the spool is never scanned.
- The per-session aggregate in `foldErrorSignature` (`errsig.go`, about lines 181-193) is independent of the 500-member cap.
  - It tracks the earliest `(time, id)` as the sample.
  - It tracks the last time with `After`, and `Count` increments after the `ApplyResult` ID dedupe.
  - Sessions with an empty ID are skipped. The signature key includes the source, so `Source` is stable.
- `/errors` is unchanged: members stay at 500, count at 509 and sessions at 3.
- Sorting happens on copies taken under the read lock. The sort key is `LastTime` descending, then `SessionID` ascending. The page slice is cut from the local copy, so callers cannot alias internal state.

## Test coverage (from reading the test bodies)

- `TestErrorSessionsExactPagedRebuild`:
  - It applies 505 events in reverse order, each twice, plus an earlier-ID event at the same timestamp, and checks the sample is `"earliest"` and `Count` is 506.
  - It checks a three-way tie order (a, b, c), paging, an empty page and an unknown key.
  - It checks that mutating a returned page does not alias state, that the legacy `/errors` shape is unchanged, and that a spool rebuild with duplicates is `DeepEqual` to the live projection.
- `TestErrorSessionsFixtureAndPrivacy`: it runs the real errsig fixture in minimal, balanced and full modes and checks `page.Total == sig.Sessions`, the source, a positive count and a non-empty sample ID.
- `TestErrorSessionsWithoutSessionIsKnownEmpty`: a signature with no session is known but has zero rows.
- The engine and HTTP tests above cover bounds, the offset overflow cases (`9223372036854775807` returns an empty 200, `…808` returns 400), the fixed 404 body, and the foreign-origin 403.
- UI tests read as meaningful rather than just present:
  - One request per selection with no fan-out, and evidence only on click.
  - Abort-signal assertions at both the sessions and detail layers, and late-resolution ignoring.
  - A "newer evidence wins" race test where the old request ignores cancellation.
  - An evidence identity-mismatch test that asserts `UNRELATED` is never rendered.
  - An XSS-style summary rendered as text, an empty later page (the "51–3" regression), and the real `rate_limit` / `authentication_failed` fixture label distinction.
- `api.test.ts` asserts the exact URL encoding and that the abort signal is forwarded.

## Remaining findings

**L1, Low / informational: `projection/errsig.go` (~181-193, session fold).** The projection does not guard `ev.ID == ""`. `ApplyResult` skips dedupe for an empty ID, so such an event would double-count and produce `sample_event_id: ""`.
- Admission now guarantees non-empty IDs, and that is tested at the Engine level.
- The projection unit tests never feed an empty ID directly.
- Optional hardening: skip the session aggregate for an empty ID, or add a projection-level test. I don't recommend blocking on it.

**L2, Low: `internal/daemon/error_sessions_test.go` and `docs/contracts.md`.** The contract says leading zeros are allowed. No test asserts a positive case such as `limit=007` returning 200, or `limit=100` returning 200, so only the rejection side is pinned. Cosmetic.

**L3, Low: `apps/tauri-desktop/src/ui/strata/index.ts`, `drawSessions` (`<li class="strata-row">`).** `.strata-row` has a fixed height of 150px (210px under 700px) with no overflow handling, set in `styles.css`.
- A long `Source` string, or narrow widths with zoom, could clip the action buttons.
- The session ID is ellipsized and the times wrap, so only the heading line and the actions row are at risk.
- I did not exercise this in a browser. The validation doc reports a screenshot, which I did not re-verify.

## Disposition

PASS. Initial finding #1, the only contract deviation, is fixed and tested on both the accept and reject sides. The other remediations are present in code and in test bodies. Excluded per your instructions: key delimiter ambiguity (#5) and hidden bounded requests (#6b). L1–L3 are advisory.
