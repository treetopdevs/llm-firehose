# History cancellation plan review

Claude Sonnet5.5 High, read-only.

**Verdict: not PASS.** One contract finding should change before implementation, plus three smaller gaps. I read the plan, `history.go`, `endpoints.go`, `spool.ScanDay` and the existing tests. I edited nothing and ran nothing.

**1. Cancellation → 500 contradicts the repo's own handler convention (`docs/plans/2026-10-18-history-cancellation.md:11,19`)**
- The plan keeps the error mapping and says "errors retain 500", including for cancellation.
- Every existing cancellation-aware handler instead returns silently once the client has gone: `handleEventByID` (`endpoints.go:155`), graph timeline (`workspace_graph.go:280`) and activity (`workspace_graph.go:434`).
- `TestGraphTimelineAbandonedRequestStopsWithoutAClientError` (`workspace_graph_test.go:41`) already pins that behavior.
- A 500 for a hung-up client is wrong. It is also indistinguishable from a real server failure in any status-based log or metric.
- **Fix:** in `handleSessionByID` and `handleTraceByID`, add `if r.Context().Err() != nil { return }` immediately after `err != nil`, before the `ErrNotFound` mapping.
  - Key the guard on `r.Context().Err()`, not `errors.Is(err, context.Canceled)`. A genuine scanner error with a live client then still returns 500.
  - Change the HTTP acceptance test to the precedent shape: `httptest.NewRequest(...).WithContext(canceled)` against `s.Handler()`, asserting `w.Body.Len()==0` and `Code` is neither 500 nor 404.
  - Keep one non-cancel failure test that still returns 500.
- This does not touch a frozen surface. A disconnected client cannot observe the status.

**2. Check ordering in `history` is underspecified (`history.go:84-109`)**
- "After each day/at completion" must run before the `len(out)==0` → `ErrNotFound` return. Otherwise a scanner that returns nil after cancellation, with nothing yielded, produces a 404 instead of the context error. The plan's own "scanner returns nil" test case would catch this, but only if the order is stated.
- "Check `ctx.Err` before lookup" means a cancelled call for an unknown ID returns the context error. `Event` (`history.go:148`) returns `ErrNotFound` in that case. Pick one and add a test. The handler guard from finding 1 makes either choice harmless.
- A cancel that lands after the final day completes discards a fully built result. That is acceptable, but say so in the plan.

**3. Engine test details that would make the planned tests vacuous**
- `newEngine` runs scans at startup. Reset the recorder after construction, as `TestEventByIDUsesPrefilteredScan` does (`history_test.go:452`). Otherwise "pre-cancel avoids scanner calls" fails or passes spuriously.
- "Passed context reaches each scan" needs an identity check per day (`seen == ctx`, as in `history_test.go:519`). That forces `history` to pass the caller's context through unwrapped, with no derived `WithCancel` or `WithTimeout`.
- The mid-first-day and last-day cases need a multi-day fixture. The scanner stub must cancel and then return nil, so the between-day and at-completion checks are the ones under test, not `ScanDay`'s own.
- Cover the expired-deadline case with `errors.Is(err, context.DeadlineExceeded)`, mirroring `graph_history_scale_test.go:415`.

**4. Lifecycle claim to bound**
- `Server.Serve` has no `BaseContext`, and `srv.Shutdown` (`daemon.go:166`) does not cancel in-flight request contexts. This slice therefore only stops scans on client disconnect.
- A running scan still delays graceful shutdown, up to the 3 s `shutCtx`.
- Add "daemon shutdown does not cancel scans" to the non-goals so the Outcome section is not read as covering it.

The cadence description matches the code (`spool.go:561-579`): `ScanDay` checks before opening and when the raw-line counter reaches a multiple of 128, and that counter includes lines the prefilter rejects. The `Session`/`Trace` wrappers are needed because tests call them. The only production caller is `endpoints.go:42,61`.

Corrections applied in plan; constructor scanDay claim was checked against actual engine.go and qualified. Final implementation review will verify corrections.
