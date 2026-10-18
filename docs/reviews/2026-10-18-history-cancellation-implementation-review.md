# History cancellation implementation review

Claude Sonnet 5.5 High, e007b2f..d0d805c, static read-only.

**PASS.** I found no blocking or correctness defects in `e007b2f..HEAD`. I only read code and ran nothing, so the tests are unverified. Line numbers are approximate. I skipped the HTML journal as instructed.

**Plan corrections**
1. **Handler convention (`endpoints.go`, both handlers):** each now returns silently on `r.Context().Err() != nil` before the not-found and 500 mapping. A live client still gets 404 for a missing ID and 500 for a scan error. The view check still runs before any scan.
2. **Check ordering (`history.go`):**
   - `SessionContext` and `TraceContext` check the context before the projection lookup and again after it. Cancellation therefore wins over not-found, including for unknown IDs.
   - `history()` checks before each day. It checks again after each scan, ahead of the scan-error return and the `len(out)==0` not-found return. It checks once more at completion, so a fully built result is discarded if cancellation is seen.
   - Every cancellation path returns `nil` events, so there is no partial success. The compatibility wrappers pass `context.Background()`. The caller's `ctx` is passed to `scanDay` without wrapping.
3. **Tests:**
   - Identity check: `got != ctx` per scan.
   - Cancel-then-return-nil stubs at day 1 and day 3 of the 3-day fixture, plus a no-yield cancel.
   - Pre-cancel and expired-deadline cases for present and absent IDs.
   - The `calls` counter is safe without a recorder reset, because `newEngine` builds the projection with `projection.Build` and not through the `scanDay` seam.
   - The live-client 500 test makes the day file a directory, so the open succeeds and the read fails.
4. **Claims are bounded:** `contracts.md` and the plan say cooperative checkpoints only, no filesystem preemption, no memory bound, and no shutdown cancellation. I found no `BaseContext` or request-level timeout in `daemon.go`, so client disconnect is the only trigger.

**Compatibility:** `Session(id)` and `Trace(id)` keep their signatures. The only production caller outside tests is `endpoints.go`. Response shapes, view allowlists, ordering, and deduplication are untouched. The new `contracts.md` section is documentation only. A disconnected client can't observe the status, so no frozen surface changes.

**Non-blocking gaps**
- **Handler tests (`internal/daemon/history_context_test.go`):** they use only already-cancelled or expired contexts, so the handler never reaches a scan. Mid-scan and last-day cancellation are covered only at the engine seam, and I think that is acceptable. A handler-level assertion that a cancelled request for an unknown ID gives no 404 would make the precedence rule explicit.
- **Real `ScanDay` mid-file cancellation:** no new test, which the plan accepted because the 128-record cadence is already covered in the spool tests.
- **Inconsistency:** `Event()` still returns `ErrNotFound` for an unknown ID with a cancelled context, while the new methods return the context error. The plan review asked for one choice. The handler guard makes it harmless.
- **Doc typos (`contracts.md` and the plan):** missing spaces in "not-found404", "error500", "remains404", "every128", "Sonnet5.5". Worth fixing before the PR.
- **Plan doc:** it doesn't link `docs/reviews/2026-10-18-history-cancellation-plan-review.md`.

Before merge, run `gofmt -l .`, `go vet ./...`, `go test ./...` and `go test -race` on `internal/capture` and `internal/daemon`.

## Residual closure

Added handler assertions for cancelled unknown session/trace IDs (no404/server error/body), corrected touched contract/plan typography, and linked the plan review. Event API behavior is intentionally untouched; plan explicitly documents cancellation-first precedence for new methods. Existing real ScanDay mid-file tests and full/race gates provide complementary coverage.
