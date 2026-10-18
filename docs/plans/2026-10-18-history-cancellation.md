# Cancel obsolete session and trace history scans

Status: implemented; targeted checks pass, full gates and implementation review pending. Fresh worktree/branch codex/session-history-cancellation from verified main e007b2f. Independent of unmerged prototype branches. This closes the server-scan limitation documented in the combined prototype decisions D37/D80.

## Outcome

When a local HTTP client cancels a session or trace history request, the daemon stops scanning at the existing day scanner's cooperative cancellation checkpoints instead of using context.Background. Successful response JSON, order, stable-ID deduplication, identity matching, privacy and view allowlists remain unchanged. No new endpoint or schema version, dependencies, runtime external calls, persistence or capture-source changes.

## Implementation contract

Add Engine.SessionContext(ctx,id) and TraceContext(ctx,id). Preserve Session(id) and Trace(id) as compatibility wrappers using context.Background. Thread the caller context through history into scanDay; check ctx.Err before lookup, before each day and after each day/at completion, return nil events with the context error on cancellation/deadline. Never return partial successful history. Existing scan prefilter, exact predicate, deduplication and error paths remain intact. HTTP session/trace handlers pass r.Context(). Follow existing Event/graph handler convention: on engine error, return silently if r.Context().Err()!=nil; live-client not-found remains404 and genuine scan errors remain500. No new status code. Invalid view validation remains before any scan. Query source filtering is outside this slice.

Cancellation remains cooperative: ScanDay checks before opening and every128 records; this does not preempt a blocked filesystem read, bound individual record time, or make full successful histories bounded-memory. Projection lookup lock acquisition is unchanged. Do not write an error to an abandoned client; no success/partial-array claim. Daemon shutdown does not cancel in-flight scans because Server has no BaseContext; shutdown behavior is outside scope. Capture admission is independent and unaffected.

## TDD / acceptance

Use existing normalized history fixtures, not invented adapter captures. Engine table tests for session and trace: pre-cancel and expired deadline avoid scanner calls; passed context reaches each scan; mid-first-day cancellation returns nil/error and skips later days even if scanner returns nil; last-day cancellation cannot return accumulated partial data; healthy Context query equals compatibility wrapper; missing ID retains ErrNotFound for healthy context; scanner errors remain errors. Existing scan_day tests prove in-file cancellation cadence; add only uncovered seams.

HTTP tests use actual engine and local handler with populated spool, canceled/deadline request context: both session full/timeline and trace must not return success arrays; abandoned requests have no response body or explicit error status. Genuine scan errors with a live client retain500. Healthy full/timeline/trace results and invalid-view400 remain covered by existing suites. No production test injection API. Run targeted red then green, Go formatting/vet/full tests/CLI and race on affected packages. Frontend/build and sidecar/Rust baseline gates confirm compatibility. No new browser UI, so no additional browser proof required for this backend-only slice.

Sonnet5.5 High plan and final adversarial reviews: substantive Argon4 quota was freshly confirmed145h in prior slice and Gemini3.1 absent; no repeated probe needed minutes later. Independent spec/standards review, fix findings, commit/open PR, monitor hosted checks/comments. HTML journal records every decision and evidence. Main merges require explicit human authorization.

## Plan review corrections

1. Match existing cancellation-aware HTTP handlers: return silently on request context error before not-found/server-error mapping. Add live-client scanner-error500 regression.
2. Context errors take precedence over missing session/trace in new Context methods (including unknown IDs); compatibility wrappers retain healthy behavior. Check after each scan before not-found logic, including no-yield and final-day cancellation. Fully accumulated results are discarded if cancellation is seen at completion.
3. Multi-day tests assert the exact caller context reaches each scan and a cancelling scanner returning nil does not produce partial success. Existing fixture spans three days; pre-cancel and expired deadline cover present/absent IDs. Engine constructor uses projection.Build separately, not the injected scanDay seam, when no sources are configured; confirmed by engine.go inspection, so no startup recorder reset is needed for these tests.
4. Bound claims to cooperative client-request cancellation; no filesystem preemption, shutdown cancellation or successful-history memory bound.
