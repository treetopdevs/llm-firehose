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

## Follow-up

**PASS.** I found no remaining blockers. I read the plan, the review, and the code they cite. I ran no tests, made no edits, and used no network or delegation.

**Review blockers**
- **Blocker 1, receipt route:** Resolved by corrections 1 and 8. `GET /attention/event` is registered at `internal/daemon/daemon.go:124`, and `capturedEvent(id, signal)` is at `api.ts:236`. An empty ID disables inspection. The plan also checks the selected path and scope kind/value against the returned envelope, which closes the gap that ID/source/session alone left open. `handleEventByID` returns the full envelope with the same redaction as the projection. That is why comparing scope digests on the client works.
- **Blocker 2, digested scope and truncated paths:** Resolved by correction 2, and the plan's premise holds. `privacy.Redact` runs `digestPath` on all five identity fields, and it is a plain unsalted sha256 (`privacy.go:55-69`). Digests are therefore stable, and exact-identity grouping on them is sound. Labelling them as opaque is correct, and so is making repo name descriptive only. Excluding ellipsis-ending paths from shared badges is conservative and fine. The plan also covers minimal mode, where there are no rows.
- **Blocker 3, grouping rules:** Resolved by correction 3. It removes the repo-name fallback, declines `repo_id`/`JJRepoID` as scope, and states that cross-kind, nested-cwd and missing-scope records are not comparable. Sharing means identical kind/value/path only. A session in several scopes is counted once per scope.

**Review gaps**
- **Gap 4, scale:** Correction 4 keeps the full-array snapshot on purpose. It adds a measured 10,000-row gate with 64 MiB allocation and 16 MiB JSON ceilings plus a benchmark. It says this is evidence at that size, not a runtime bound. It also says a failed gate means revising the design.
- **Gap 5, event counts:** Correction 5 fixes the column wording and the caveats.
- **Gap 6, lifecycle:** Correction 6 adds persisted mode, a `deactivate()` that invalidates both requests, activation on navigation, and a `main.ts` regression test.
- **Gap 7, old daemons and docs:** Correction 7 covers the typed `fileSessions(signal?)`, the `capture.FileSession` alias, the 404 state with Retry, and both docs.
- **Gaps 8–9, dedupe and equivalence:** Corrections 8 and 3 cover these. The ID-less decision is explicit, and the tests are listed: duplicate IDs, ID-less repeats, multi-path events, out-of-order rebuild, and a session moving between scopes.
- **Gap 10, TDD ordering:** Correction 9 records it. I checked `/tmp/file-session-red.txt` and `/tmp/file-session-green.txt`. They exist and match the plan's account: red shows `ix.FileSessions undefined`, and green is `ok` for the projection package.

**Non-blocking nits**
1. Correction 1 says to use "documented" extraction rules, but `EventFilePaths` is documented only in its code comment (`projection.go:431-435`). Correction 7 should also put the extraction rules (the `file_path`, `path`, `file` keys, the `changes` map, and the digest exclusion) in `docs/contracts.md`. Add a shared-fixture test for the TypeScript port so it cannot drift from the Go function.
2. Correction 6 says to persist the Files mode but not where. Name the storage, for example the same `localStorage` pattern the other panels use, and the key.
3. The `/tmp` red/green files won't last. If the TDD record matters, copy the lines into the review doc.

Durable test-first record: red `ix.FileSessions undefined`; green `ok agentfirehose/internal/capture/internal/projection`. HTTP red status404; green test suite passed. The first DOM attempt had missing test environment; after correcting that setup, the original implementation failed on missing Activity by session control, and the new implementation passed. A later stale-list regression failed before the assignment-order fix.
