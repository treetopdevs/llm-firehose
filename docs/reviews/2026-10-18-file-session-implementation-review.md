# Scoped file activity implementation review

Model claude-sonnet-5-5, effort high, existing direct CLI account. Read-only review launched at b38266c; concurrent follow-up fixes were outside its pinned code review.

**Verdict:** no blockers and no medium issues. The backend identity, privacy and durability path passes. The Files UI passes with low-severity items only. I reviewed the committed `e007b2f..HEAD` and ran nothing.

The working tree has uncommitted edits to `apps/tauri-desktop/src/ui/files.ts` and `files.test.ts` that aren't in HEAD. They already fix three things:
- Summary mode no longer truncates paths.
- Closing a receipt restores focus to the opener.
- Retry now moves focus to the heading.

I didn't review those edits beyond reading the diff.

## Low issues

1. **Session-mode paths are truncated.** `files.ts` (HEAD ~line 57) renders the row `h3` through `label()`, which cuts at 160 characters. Two exact paths that differ only after character 160 look identical. The plan says exact path spellings are the unit. The pending edits fix summary mode only. Fix: add a `title` or an expand control with the full string, or show the tail.
2. **Summary cells lost `class: "mono"`.** `files.ts` summary `<td>` dropped the class, so `.mono`'s `word-break: break-all` (`styles.css:41`) no longer applies. Long paths overflow the "unchanged" default view, and the pending edits don't restore it.
3. **Filtering in the error state removes Retry.** `filter.oninput` and `shared.onchange` call `draw()`, which clears `body` and returns while `phase !== 'ready'`. Typing in the filter after a failed load deletes the Retry button. "Refresh files" still recovers. Guard `draw()` on `phase === 'ready'`, or don't redraw in the error phase.
4. **No multi-event rebuild test.** `TestFileSessionsRebuildMatchesIncremental` (`file_sessions_test.go:103`) appends one event. Plan correction 8 asks for out-of-order rebuild equality. The `assertBuildEquivalent` datasets do contain file events, but they compare `Build` against an in-order `Apply`, so they can't catch time-order dependence. `TestFileSessionsChronologyAndOpaquePaths` covers out-of-order arrival only through incremental `Apply`. Add a spool with shuffled times and several scopes, compared against `Build`.
5. **Plan step 2 is only partly covered at the HTTP level.** `internal/daemon/file_sessions_test.go` checks one populated row, empty, and the origin guard. It never asserts that `/artifacts/files` is unchanged, and it never checks multi-row sort order.
6. **Scaling is unbounded on the client.** `draw()` rebuilds the group map with `JSON.stringify` per row and lowercases and joins every row on each filter keystroke, with no debounce. That is fine at 10k rows and O(n) per keystroke beyond that. `TestFileSessionsScale` measures `TotalAlloc` for the whole projection, including `sessions` and `seen`. That is conservative, but it doesn't isolate the per-tuple cost the docs describe.
7. **Style mismatch.** `files.ts`, `files.test.ts`, `main.test.ts` and `api.ts` use dense one-line code with 1-space indents and no spaces after commas. The surrounding TS uses 2-space indents and spaced formatting.

## Checked and fine

- **Identity and ordering:**
  - Scope order is `worktree_id`, `jj_workspace_id`, `cwd`, then `unknown` with an empty value.
  - There is no repo-name or repo-ID fallback.
  - The tuple key includes the scope kind.
  - `FileSessions()` returns detached copies under `RLock`, never nil.
  - The sort is total (time, then the full tuple).
  - Latest receipt ID uses time then ID, and ID-less admissions each count.
- **Privacy and durability:**
  - `Admit` redacts before `Append`, and `e.project(stored)` projects the redacted event. Live rows therefore match spool rebuilds, and the receipt scope comparison holds outside full mode.
  - `foldFileSession` sits behind the `seen` dedupe in `ApplyResult`, so `Build` and live `Apply` share one fold. `fileSessions` is added to the equivalence comparison, and the fixtures include file events.
  - The projection is never spooled.
- **API:** `/attention/event` returns `Engine.Event` unprojected (`endpoints.go:151`), so the path and scope checks work in production. The route is additive, gets the same origin guard, and the docs (`contracts.md`, `capture-engine.md`) match the implementation.
- **Extraction parity:** `EventFilePaths` and `recordedFilePaths` agree on the `{sha256,len}` digest rule and on sorting. A shared fixture test covers this.
- **Receipt guard:** it checks ID, source, session, scope kind, scope value and path, and a mismatch shows "unavailable". The detail and list requests are version-gated and aborted.
- **Lifecycle:** `show()` calls `deactivate()` on leaving Files, and `main.test.ts` asserts the abort.
- **Paging and focus:** rows page at 40 and the last page is reachable. Shared badges exclude unknown scopes, empty sessions and `…`-ended paths, while counts still come from all loaded rows, so filtering doesn't change them.
- **Scale test:** it exists, with ceilings of 64 MiB allocated and 16 MiB of JSON, plus a benchmark.

## Remediation

All actionable findings addressed in fbe53d1 and 7b2bd61: preserve full summary/session paths, restore mono wrapping, retain Retry during filter edits, restore receipt/retry focus, expand rebuild test to shuffled times and multiple scopes, assert legacy HTTP shape and multi-row ordering, cache shared-group counts per snapshot, and format new TypeScript. Text filtering remains O(all loaded rows) and full-array scaling remains explicitly disclosed. Tests measure total projection allocation conservatively, not isolated per-tuple retained cost. Sonnet 5.5 High follow-up PASS on 7b2bd61.

## Final follow-up

**PASS.** I found no new regression in `b38266c..7b2bd61`. I read the diff and the surrounding code. I ran no tests, as you asked.

- **Summary and session paths:** Summary rows use `stripControl(f.path)` and session headings use `stripControl(row.path)`, so neither truncates. Both carry `class="mono"`, and `styles.css:41` gives `.mono` `word-break: break-all`, so long paths wrap. Two tests cover the full suffix: a 170+ character summary path and a 200+ character session path. The 160-character `label()` truncation remains on workspace, source and session only. It is marked "[display truncated]".
- **Receipt focus:** `inspectRow` takes the opener button. Close calls `cancelDetail()` and then focuses the opener if it is still connected, otherwise the heading. A test checks that `document.activeElement` is the opener.
- **Retry focus and filter:**
  - Retry focuses the heading before it calls `refresh()`, so the button's removal doesn't drop focus.
  - The filter and checkbox handler now calls `draw()` only when `phase === "ready"`. Before, it would have called `clear(body)` in the error phase and removed the Retry button.
  - A test fails a refresh, types in the filter, and confirms Retry is still there.
- **Out-of-order multi-scope rebuild:**
  - The test appends `late`, `other` (`WorktreeID` `/other`), then `real`, and compares `Build(dir)` with `foldProjection(events)`.
  - The fixture time is 2026-10-16 09:04 and the offset is +1h, so all three events land in one day file and the append order is what gets scanned.
  - `foldFileSession` is order-independent: it takes the minimum first time and the maximum last time, with ties broken on event ID.
- **Legacy HTTP shape and sort:**
  - The daemon test adds an earlier event from a different session. It expects two scoped rows, the newer one first (ordered by `LastTime`).
  - It then checks that `/artifacts/files` still returns one row with exactly 5 keys (`FileArtifact` has `path`, `events`, `sources`, `first_time`, `last_time`), `events == 2`, and the same `path`.
- **Group cache:** `groups` is rebuilt only when `groupedRows !== rows`. `rows` is reassigned only on a successful sessions load, so the cache can't go stale. The first draw after a load rebuilds it, even for an empty array.
- **Formatting:** The `api.ts`, `files.ts` and test changes are reformatting plus the fixes above. I saw no behavior drift, including in the `main.test.ts` abort test.

The remaining O(n) work (the full-array snapshot, and the filter pass in `draw()`) is as you described it. I checked for a runtime-bound claim and found none in the diff.

One weak spot, not a regression: the mono-wrap tests only assert `textContent`, so nothing checks the CSS wrap itself.

I did not open the added PNG or the one-line change to `docs/plans/2026-10-18-backlog-coordination.html`.
