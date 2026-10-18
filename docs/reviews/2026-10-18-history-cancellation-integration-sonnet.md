# History cancellation integration review

Model: Claude Sonnet 5.5, high effort. Scope: da50662..9b72c66. Read-only review.

**PASS** for `da50662..9b72c66`, with one low-severity docs inconsistency and no code findings. This was a static read only. I made no edits, ran no tests, made no network calls and delegated nothing.

**Application diff** (`internal/capture/history.go`, `internal/daemon/endpoints.go`)
- **Correlation, full and timeline views:** the `CorrelationView` and `TimelineView` mapping in `handleSessionByID` is unchanged. The view allowlist check still runs before any scan, so an invalid view returns 400 even for a canceled request, which the new test covers.
- **File-session accessors:** `FileSessions()` and `Files()` are untouched and still projection-only (`history.go:269-270`). `/artifacts/file-sessions` and `/artifacts/files` handlers are unchanged. The `scanDay` callers in `activity.go` and `graph_history.go` are untouched. `e.history` has only the two callers that now pass a context.
- **Cancellation semantics:**
  - `Session` and `Trace` remain as wrappers over `context.Background()`, and there are no other non-test callers.
  - `ctx.Err()` is checked before the projection lookup, after the lookup, before each day and after each scan. A final check at the end of `history()` discards accumulated results, so cancellation never returns partial history.
  - Context errors take precedence over `ErrNotFound`.
  - The handlers return silently when `r.Context().Err() != nil`, matching `endpoints.go:165` and `workspace_graph.go:280,436`. A live client still gets 404 for not-found and 500 for a real scan error.
- **Tests:** the HTTP test covers all five paths (session default, full, timeline, correlation and trace). It also covers canceled and expired-deadline contexts, healthy responses, 500 for an unreadable day file, abandoned unknown IDs, and the invalid-view 400. The capture tests use the existing `newEngine` and `engineSeams{scanDay}` seam, which is present at `engine.go:51,82,124`.

**`docs/contracts.md`:** the new section sits under the Local API area, after file-sessions and attention, and changes no existing Activity or Files text. It is additive, with no schema bump, and bounds its claims to cooperative cancellation. It says nothing about filesystem preemption or shutdown cancellation, and it does not claim a memory bound.

**Docs (D82–D85):** the dated entries are consistent with D85's description. The conflict resolutions touched only docs, and I found no application-code conflict residue.

**Low finding:** D82 (`docs/plans/2026-10-18-backlog-coordination.html`) says canceled requests "keep existing error mapping". That contradicts D83, the plan's correction 1, and `docs/contracts.md`, which all say canceled requests return silently with no error status. Reword D82 to "return silently". There is also no blank line before the new `###` heading in `contracts.md`; GitHub still renders it.

**Not verified here:** `gofmt`, `vet` and the test suite, and the hosted PR #43 and #48 checks. I'm relying on the validation doc's claims for those.

I did not write a plan file or call `ExitPlanMode`, since this was a review with nothing to implement.

## Remediation

Clarified D82 to say abandoned requests return silently. Corrected the existing endpoint table to describe cooperative scan cancellation. Independent standards and spec reviews passed application behavior; all combined validation gates passed.
