# File session plan review

Sonnet 5.5 High, read-only.

**Verdict: not PASS.** I found 3 blockers and 8 further gaps to fix before implementation. I read only; I edited nothing and ran no tests or network calls.

## Blockers

1. **The receipt route doesn't exist.**
   - The plan says it calls `/events/{id}`. No `/events/{id}` route is registered (`internal/daemon/daemon.go:117-133`).
   - The real lookup is `GET /attention/event?id=`, with the client `capturedEvent(id, signal)` at `apps/tauri-desktop/src/api.ts:236`.
   - Fix: name that endpoint and client, and reuse its fixed 404 and 500 handling.
   - The lookup relies on `projection.EventDay`, which reads `seen`. A row whose `last_event_id` is empty is unreachable. Say so explicitly: no ID means the receipt is unavailable and the button is disabled.
   - Checking the event ID, source and session isn't enough. It never confirms the receipt actually touches the row's path. `EventFilePaths` is sealed in `capture/internal/projection`, so the UI can't call it.
   - Fix: either show the path from the receipt payload and mark a mismatch as unavailable, or have the server return that fact.

2. **Workspace scope is a digest in the default privacy mode.**
   - `privacy.Redact` digests `CWD`, `WorktreeID` and `JJWorkspaceID` to sha256 hex outside `full` mode (`internal/privacy/privacy.go:51-57`).
   - `Admit` redacts before it projects. So in balanced mode three of the four scope kinds hold 64-hex strings, and only `repo` is readable.
   - The plan calls cwd and repo "recorded scope labels" and promises to "distinguish known workspace scopes". It never says how the UI shows a readable name.
   - The workspace-graph code already joins digest aliases to registered roots (`internal/daemon/workspace_graph.go:226-236,458-500`). That is the precedent to reuse, or the plan should state that the UI shows opaque IDs.
   - The same applies to the 240-rune truncation of paths in balanced mode. Two long paths with the same prefix collapse into one "exact" path, and the text ends in `…`.
   - The plan must disclose the truncation and the minimal-mode behaviour. In minimal mode `file_path` becomes a `{sha256,len}` map, so there are no rows at all.

3. **Scope grouping rules will mislead.**
   - Precedence picks the first non-empty field. One session with `worktree_id` and another with only `cwd` never share a group, even in the same directory.
   - cwd is the raw working directory, so `/repo` and `/repo/sub` never group.
   - `repo` is a short name. Two unrelated repos both called `app` collapse into one scope.
   - The plan skips `repo_id` and `jj_repo_id`, which are the stronger repo identities.
   - Decide this explicitly. Either add the repo IDs, group by repo-qualified scope, or disclose "same recorded string only" in the UI and docs. A cross-kind scope mismatch must show as "not comparable", not "not shared".

## Gaps

4. **Memory and response size aren't quantified.**
   - The projection keeps one row per tuple of scope, path, source and session, and repeats the path and workspace strings in every row. The plan only says to "document" the cost.
   - The API returns every row, including the single-session rows that dominate, on every refresh.
   - Shared-group computation is client-side, so the client must download everything.
   - Existing patterns to follow: `/errors/sessions` is paged server-side, and there are scale and benchmark tests (`activity_scale_test.go`, `graph_history_scale_test.go`, `build_bench_test.go`).
   - Fix: add a scale or benchmark test with a ceiling on rows, memory and bytes. Consider server-computed shared groups with `offset` and `limit`, or an explicit cap and truncation flag.
   - If you keep client-side paging over one snapshot, say that it deliberately avoids rows moving between pages.

5. **Counts are event counts, not edits.**
   - Claude Code emits file-category events for both the start and the end of each tool call. Codex emits `patch_apply_end` on both success and failure.
   - One edit can therefore count as 2 events. "Attempts" is accurate, but the column should read "events", with the caveat in the UI.
   - The file-tool set is write-class only (Edit, Write, MultiEdit and similar). Say that the evidence is limited to those tools.

6. **The UI lifecycle doesn't fit `main.ts`.**
   - `show()` calls `panels[name].refresh()` on every navigation (`main.ts:112-122`). That conflicts with "loads only on explicit selection/refresh".
   - `createFiles()` returns only `{root, refresh}`. There is no activate or deactivate, no abort controllers, and no version tokens.
   - Fix: define persisted mode state, what `refresh()` does in each mode, and that leaving the panel aborts in-flight requests.
   - The Strata panel (`ui/strata/index.ts`) shows the pattern: an `AbortController` plus version tokens, and an `activate()` that loads once.
   - Also specify the mode toggle semantics, the "scope" and "filter" controls the plan mentions, and focus handling, since the plan lists them without a design.

7. **Old daemons and the API client need handling.**
   - A new UI against an older daemon gets a 404 on `/artifacts/file-sessions`. The plan needs an "unavailable on this daemon" state.
   - Add a typed `fileSessions(signal?)` to `api.ts` and include `signal` in the test seam.
   - `contracts.md` and `docs/architecture/capture-engine.md` also need the endpoint, the field list, and the "disposable, never spooled" statement. The plan only says to "document".
   - Also specify the HTTP response shape. The `capture` package must expose a `FileSession` alias, since the daemon can't import the sealed projection.

8. **Dedupe and equivalence edge cases aren't covered.**
   - `ApplyResult` skips dedupe when `ev.ID == ""`, so a startup replay would double-count those events. Say whether that is accepted for this projection. If it is, test it.
   - `Build` and `Apply` equivalence depends on the `(time, id)` tie-break. `build_equivalence_test.go` exists; extend it with this projection and with out-of-order arrival.
   - Add a test for a multi-path Codex event: each path gets one observation, and the `changes` map is sorted.

9. **A session can appear in several scopes.** If a session changes cwd or worktree, it produces several rows. The "distinct tuples" rule counts it once per scope. Document that, and test it.

10. **Test seam ordering.** Step 1 says "start with a failing test", but the worktree already has uncommitted code (below). Either restart from the tests or record how the TDD ordering was kept.

## State of the worktree

The worktree isn't clean, despite the session-start snapshot. There are untracked `internal/capture/internal/projection/file_sessions.go` and `file_sessions_test.go`, and an edit to `projection.go`. The edit adds the `fileSessions` map and a call to `foldFileSession` in the apply loop.

The code implements the plan's scope precedence as written. It has none of the digest handling, label resolution or caps from findings 2–4. The plan should be corrected before this code is built on.

The fixes for 1–3 (and 7's endpoint list) belong in the plan text, so the plan needs editing before implementation continues.

## Response

All findings are addressed by the numbered plan corrections. Projection-only test-first implementation was concurrent with review; API/UI remain unimplemented pending follow-up.
