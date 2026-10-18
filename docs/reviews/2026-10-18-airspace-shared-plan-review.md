# Airspace shared-file plan review

Claude Sonnet 5.5 High, static read-only review.

**Verdict: FAIL, 2 blockers.** The plan can be fixed with edits to the text. I didn't run tests or the browser.

**Blockers**

1. **The session-to-row join drops legitimate rows and doesn't say so.** The plan matches rows on "exact workspace kind/value using worktree_id, then jj_workspace_id, then cwd".
   - Attention's scope fields are latest-wins and set per field (`internal/capture/internal/projection/inbox.go:106-122`). A session reports one current scope.
   - FileSession rows are keyed per event scope. `docs/contracts.md:480-505` says "A session can appear in multiple scopes."
   - A session that moved from cwd to a worktree, or gained a jj id, keeps rows under older kinds and values. Those rows never match the snapshot's current scope.
   - It can also match the wrong way. Attention can combine fields from different events, while a row's kind comes from one event.
   - The effect is silent undercounting, and the lanes get presented as the shared files.
   - Correction: make eligibility depend only on source and session being in the filtered snapshot, and group by the row's own kind, value and path. Disclose that the workspace filter selects sessions, not rows. If you keep the scope match, add an "N rows for these sessions excluded: different recorded scope" count. Add model tests for a session with rows in two scopes and for one whose scope changed.

2. **No-lane and false-negative copy is missing.** Exact string matching has several known misses:
   - Mixed privacy modes: the same cwd is raw in full mode and a digest later, because `privacy.go:55-60` digests path identity outside full mode.
   - Truncated paths.
   - Relative against absolute paths.
   - Symlinks and case differences.
   - Correction: require empty-state and region copy to say "no lane does not prove no shared file". Add an acceptance case that asserts this copy and that no empty state claims "no shared files".

**Ambiguities that will cause rework**

3. **Relative paths under a shared worktree or jj scope.** Under `worktree_id` or `jj_workspace_id`, two sessions with different cwds can record the same relative string, such as `src/a.go`, for different files. Correction: either require absolute paths for the worktree and jj kinds, or disclose it and add a test. Check what real fixtures record first.

4. **"Refresh" is overloaded.** The plan says refresh invalidates the selection, but there are two refreshes: attention and shared. Correction: say that an attention refresh regroups retained rows against the new snapshot and invalidates the shared selection, and that the existing `refresh()` and `cancelReceipt()` must not clear the shared region without a decision.

5. **Cross-region receipt cancellation.** The existing `cancelReceipt` clears `selection` and `evidence`. Correction: state whether selecting a session receipt closes the shared receipt, and the reverse.

6. **Staleness of the attention side.** The region derives from the attention snapshot, which can itself be stale or failed. `index.ts:137-143` keeps the old snapshot on error. Correction: the region must show the attention snapshot's staleness and fetch time separately.
   - Define the state when shared files are loaded before any attention snapshot exists, or when the snapshot is dropped.
   - Add a case where an attention refresh adds or removes sessions while shared rows are retained.

7. **Duplicate-participant rule is undefined.** The server key already includes kind, value, path, source and session, so duplicate rows would only come from a bug or ID-less admissions. Correction: pick merge or reject, for example sum events, take min/max time, and take the newest `last_event_id`. Then test it.

8. **Display rules conflict with Files.** The plan says "complete wrapped path and scope", but `files.ts:33-38` truncates labels at 160 characters.
   - Correction: say path is full (`stripControl`) and scope is full or truncated with a visible marker.
   - Also apply `stripControl` to source and session ID. Test bidi and newline characters.
   - Keep the opaque-scope label for 64-hex values.

9. **Order and reuse details.**
   - Specify the comparator as the code-unit `lexical` function in `model.ts`, not `localeCompare`.
   - Export and reuse `comparable`, `recordedFilePaths` and `recordedFileScope` from `ui/files.ts` instead of copying them. `comparable` is currently private.
   - `workspace()` is duplicated in `index.ts:22` and `model.ts:46`. Use one.

10. **Disconnect during the first load.** Define the end state: not "Loading…" forever, but idle or stale with an explicit Load. Add a test.

11. **Wording.** Call the count "observations (write-tool starts, ends and failures, not edits)". Say the range is the first-to-last record for that session's path across all history, not an activity window.

**Evidence and process**

12. **Browser validation has no data plan.** Two or more sessions with the same scoped path need seeding in an isolated daemon, per the memory note on the real 4517 daemon. State how it's seeded without invented adapter shapes, for example `firehose ingest` or emit of real captured payloads. Also state how the over-40-participants page is validated, or say it's unit-only.

13. **Review-model line.** "Argon/Gemini limits recorded in prior slice" points to a quota reset around 18:01 UTC on Oct 18, which may have passed. Re-probe availability. Your standing instruction is Codex Sol 6.1 High, so say why it's skipped if it is.

14. **Header and gates.** `e007b2f` exists, `aef9ab4` is an ancestor of HEAD, and `codex/prototype-integration` exists locally and on origin. The header is consistent. The gates list doesn't mention `docs/contracts.md`; confirm and state that no contract change is needed.

**Missing acceptance cases (add to the TDD list)**
- A session with rows in two scopes.
- A session whose scope changed after its file events.
- Shared files loaded before any attention snapshot.
- An attention refresh while shared rows are retained.
- Disconnect during the first load.
- Cross-region receipt cancellation.
- A relative path under a shared worktree scope.
- A duplicate-participant merge.
- Mixed digest and raw scope for the same cwd (expected: no lane).
- A zero-lane state with the false-negative disclosure.

Corrections are numbered in the plan. External reviewer statements about standing model preferences are not authoritative; user-requested ordering controls. Follow-up pending.

## Follow-up

**Verdict: PASS on the original blockers, with 4 small residual contradictions to clean up.** This was a read-only static check of the two docs plus a grep of `files.ts`. I ran no tests.

**Review items resolved**
- **Blocker 1 (join drops rows):** Correction 1 and the Data paragraph now match sessions by source/session only and group by the row's own kind/value/path.
- **Blocker 2 (no-lane copy):** Correction 2 requires the "No lane does not prove no shared file" text, and Correction 8 adds a zero-lane acceptance test.
- **Ambiguities 3–11 and 14:** Corrections 2–7 cover them, and Correction 9 states that `docs/contracts.md` needs no change.
- **Item 12 (browser data plan):** Correction 9 specifies it, with over-40 participants as a DOM gate only.
- **Item 13 (review model):** Correction 10 settles the reviewer order.
- **Missing acceptance cases:** all ten are covered by Correction 8 or the TDD list.

**Residual contradictions to remove (plan edits only)**
1. **Stale TDD case.** The TDD line lists "unrelated/unknown/repo-only scopes". Under Correction 1, a session's latest scope no longer affects eligibility, and the only row kinds in `files.ts:25` are `worktree_id`, `jj_workspace_id` and `cwd`. Reword it to "row scope kind/value invalid or unrecognized". Add that unrecognized row kinds are excluded, or keep them grouped by kind. The plan currently says neither.
2. **Ambiguous exclusion.** The Data paragraph says "Exclude unknown/empty workspace". Read as the session's attention workspace, it contradicts Correction 1, because a session with an unknown latest scope can still have valid historical rows. State that it means the row's scope value.
3. **Review-model line in the Gates section.** It still says "Sonnet 5.5 High fallback … (Argon/Gemini availability limits recorded in prior slice)". Correction 10 supersedes it with "recheck availability". Rewrite it as "Argon/Gemini first if available after a recheck, else Sonnet 5.5 High".
4. **First-load disconnect end state.** The Interaction text says disconnect "marks stale", which is meaningless when no rows were loaded. Correction 3 only covers the filter-invalidation case. State that with no prior rows, disconnect during a first load ends in idle with an explicit Load, and never "Loading…". This is the review's item 10 and is only half-resolved.

**Optional nit:** Correction 5's "earliest valid first time" and "latest valid last time" don't define "valid". Say whether unparseable timestamps are skipped.

Nothing else conflicts. Corrections 1–10 are consistent with each other and with the header, gates and Correction 4's cross-region rules.

Residual wording corrected in the plan: row scope is explicit; unrecognized kinds remain distinct; reviewer availability rechecked; first-load disconnect is idle. Invalid timestamp handling is specified.
