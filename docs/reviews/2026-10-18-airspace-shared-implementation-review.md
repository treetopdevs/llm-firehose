# Shared Airspace implementation review

Claude Sonnet5.5 High, range aef9ab4..6ce01f3, static read-only.

Finished reading the diff, plan and code; writing up the findings now. Static review only: I ran no tests, made no edits and did no network calls.

**Verdict: FAIL.** There is 1 blocking finding, 4 should-fix, and a few lows.

## Blocking

**1. Every Airspace redraw cancels shared-file requests, clears the receipt and resets the page.**
- `airspace/index.ts:38` calls `sharedFiles.setSessions(...)` on every `draw()`. `shared-files.ts:97-98` then runs `invalidateList(); cancelReceipt(); page = 0` unconditionally, even when the session membership hasn't changed.
- The plan only calls for cancelling on parent filter changes and attention refresh start (corrections 3 and 4).
- Failure scenarios:
  - **Paging attention sessions.** Open a shared receipt and go to shared page 3, then click "Next sessions". The `draw()` at `index.ts:53` clears the receipt and sends shared files back to page 0, although membership is identical.
  - **Slow load or refresh.** Click "Load shared files" while the first attention fetch from `activate()` is still running. When attention completes, `draw()` aborts the file fetch. The user sees the Load button again, with no error and no indication why.
  - **Retained rows.** The refresh already set `error = ''` and `stale = true`, so a prior error is silently lost.
  - **Recent-window selector.** The spec says it only changes bands, but it also cancels the request through `localChange` and `draw`.
- Fix: in `setSessions`, compare the new identity set and stale flag with the old ones. Only invalidate the request and receipt, and reset the page, when membership actually changed or on an explicit call from `localChange` or refresh start.
- No test covers attention paging, a window change, or attention completion while a shared fetch is pending. The one integration test, `index.test.ts:139+`, only covers search and deactivate.

## Should fix

**2. Inspect button names aren't unique, so participants are indistinguishable by accessible name.**
- `shared-files.ts:54` labels each button `Inspect file observation: source / session` without the path.
- A session in several lanes gets identical button names. Control-stripped IDs can also collide.
- Fix: add the lane path to an `aria-label`. Also give each `<ol>` (`shared-files.ts:51`) an `aria-label` naming its path.

**3. Lane headings don't show per-lane participant counts.**
- The spec asks for "displayed/total participant and group counts" to explain partial lanes.
- `shared-files.ts:41` only shows global totals and "Lanes may continue across pages".
- A repeated lane heading on page 2 doesn't say "participants 31–40 of 85 in this lane".
- No test covers it.

**4. Stale files aren't prominently marked.**
- The spec says retained stale rows are "prominently marked".
- The notice at `shared-files.ts:15` is plain text. It has no class toggle like Airspace's `.airspace-notice.stale` (`styles.css:835-836`).
- Nothing marks the lanes themselves as stale.
- Add a class and CSS, plus a stale label on the lanes region.

**5. The receipt is labelled as if it covers the whole lane.**
- `shared-files.ts:76` heads it "Captured file observation", but it is only the latest event for that participant (`last_event_id`).
- The button text doesn't say "latest" either.
- Neither the button nor the receipt says that one receipt does not prove sharing, and the row's other observations are unverified.
- Airspace's own receipt has an equivalent "not proof" caveat (`index.ts:105`).
- Reword both the heading and the button to name the latest recorded observation.

## Low

- **6.** Receipt errors (`shared-files.ts:79`) offer only Close. The spec says "Errors provide explicit Retry", which most likely covers the list only. Confirm or add a retry.
- **7.** Test gaps against plan correction 8 and the TDD section:
  - Cross-region receipt independence is untested.
  - Attention replacement is only partly covered.
  - Late list or receipt responses on filter or page change aren't tested, only on deactivate.
  - Unrecognized nonempty row kinds aren't tested: the model test uses `cwd`, which may be a recognized kind.
  - Raw-vs-digest mixed identity is covered only by one case.
  - `files.test.ts` has no regression test for the changed `comparableFileScope` (empty-kind rejection now also applies to the Files panel, `files.ts:37`) or for `matchesFileReceipt`.
- **8.** The `role="status"` notice (`shared-files.ts:15`) is rewritten wholesale on every redraw, including each search keystroke. That can cause repeated screen-reader announcements. Update it only when the text changes.
- **9.** `sharedFileLanes` re-runs over the full history on every attention redraw, including each keystroke. It is linear and disclosed, so this is acceptable, but fixing #1 removes most of it.

## Checked and OK

- **Model:**
  - Exact `[source, session]` join and group key.
  - Eligibility filter and the two-participant requirement.
  - Duplicate merge (max events, earliest valid first time, greatest ID on tied latest) is commutative, and the reversed-input test exists.
  - Code-unit ordering.
  - Linear grouping before pagination.
- **Receipt validation:** `matchesFileReceipt` checks id, source, session, scope kind and value, and path membership, and Files now shares it.
- **Request handling:** list and receipt tokens plus aborts are correct on deactivate and disconnect, and a first load without rows ends idle.
- **Rendering:** text goes through `el` and `textContent`, so escaping is fine.
- **Focus:** pagination moves focus to the persistent heading, and Close restores opener focus.
- **Unrequested spec items:** the plan lists the actual-daemon browser run, the HTML decisions and full gates as pending. I did not count them as defects.

## Remediation

Two failing-first regressions reproduced redraw cancellation and attention arrival during pending file load. setSessions now compares membership and snapshot metadata; unfiltered file requests survive attention arrival and unrelated redraws. Parent source/workspace/search changes explicitly cancel; attention refresh clears receipts, recent-window changes only alter bands. Pagination and unchanged membership preserve shared selection/page. Per-lane participant ranges, unique path/scope/ordinal accessible names, prominent stale notices, latest-observation wording and receipt Retry added. Status text changes only when different. Added lifecycle, cross-region, kind and shared predicate regressions. Follow-up pending.

## Final requested-model follow-up

**PASS.** I found no blocking or should-fix issues in `1bb429d` against `6ce01f3`. I read the diff, the review doc, plan correction 12, and the shared-files, Airspace, model and Files code. I ran no tests, edits, network calls or delegation, so the passing claims below come from reading the code and the tests, not from running them.

**Main focus**
- **Attention completion and redraws:** `setSessions` (`shared-files.ts:105-111`) now compares sorted `[source,id]` membership and the availability flag. It returns early if nothing changed, and it never touches the list token or abort controller. An attention arrival during a pending Files fetch therefore leaves the fetch alone and regroups when the rows land. This covers the original blocking finding.
- **Receipt and page on redraw:** The receipt and page are reset only when membership or availability changes. The receipt section lives outside `body`, so redraws don't wipe it. Attention paging goes through Airspace's own `cancelReceipt`, not the shared one, so shared page and receipt survive "Next sessions".
- **Window changes:** `deriveAirspace` uses the window only to assign bands (`model.ts:62`), so membership doesn't change. The window handler now bypasses `filtersChanged`.
- **Explicit filters:** Source, workspace and search all call `filtersChanged` (`index.ts:156-160`). That invalidates the list token and abort controller, clears the receipt and resets the page. A late response can't resurrect rows or a Loading state.
- **Refresh and lifecycle:** Attention refresh start clears the shared receipt (`index.ts:115`) and leaves the list alone. Deactivate and disconnect still invalidate both.

**Receipts**
- `matchesFileReceipt` is shared with Files. It checks id, source, session (`?? ""`), scope kind and value, and path membership.
- `comparableFileScope` now rejects empty kinds; Files and the shared model both use it. The new `files-paths.test.ts` case covers it.
- Receipt errors now offer Retry plus Close. The text names the latest observation for one participant and says it doesn't prove sharing.
- The opener falls back to the heading when it has been redrawn away.

**Other earlier findings**
- **Inspect names (#2):** names are unique via path, scope, lane and ordinal, and each `<ol>` has an `aria-label`.
- **Per-lane ranges (#3):** the range is computed from the visible slice and `<ol start>`.
- **Stale marking (#4):** stale lanes get a `.airspace-notice.stale` notice, and the CSS at `styles.css:836` is unscoped, so it applies.
- **Announcements (#8):** status text is rewritten only when it changes.
- **Tests (#7):** added for lifecycle, cross-region independence, unrecognized kinds and the shared predicate.

**Residual, all low and non-blocking**
1. **Index wiring tests:** none covers source, workspace or search changes cancelling a pending fetch, or attention completing during one. The shared-level tests exercise `filtersChanged` and `setSessions` directly, and the wiring is a one-liner. One cheap index test would pin it.
2. **Typing in search silently aborts a pending Files load:** the notice just shows "stale", with no "cancelled by filter change" message. This follows plan correction 12, so it's a UX note only.
3. **Late-response tests:** a late receipt response on shared page change still has no direct test; only filter and deactivate paths do.

Residual low fixes: index-level pending-search cancellation regression (failed before new feedback), explicit cancellation feedback, and late receipt/page regression added. Full suite rerun recorded separately.
