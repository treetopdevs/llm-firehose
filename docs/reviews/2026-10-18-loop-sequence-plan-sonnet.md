# Sonnet5.5 High plan review

Read-only review of03fa5ca; direct Claude CLI user-authorized fallback.

**Not a PASS.** The direction is feasible and the seams are right: `buildLoops` already gives sorted, deduplicated, scoped events with `fromIndex`/`toIndex`, so a run derivation over `events.slice(fromIndex+1, toIndex+1)` fits. But the plan has several concrete gaps. This was a static read only. I ran no tests and made no edits.

**Blocking**

1. **The token drops the field that tells tool calls apart.**
   - `source + category + name` is `codex|shell|PostToolUse` for every Codex tool event in the fixture. Claude Code events are `tool|PostToolUse`.
   - The timeline view keeps `payload.tool_name` (`TIMELINE_PAYLOAD_KEYS` in `score/model.ts:402`), and `eventLabel` already prints it digest-aware.
   - With the plan's token, real intervals collapse into one big `PostToolUse ×N` run. Equality then depends almost entirely on N, which contradicts the plan's own read/edit/test/fail goal.
   - Fix: add recorded `tool_name` as an optional token component, shown as-is and never classified. Otherwise state plainly that the comparison is near-vacuous on real data.

2. **Severity is invisible, and the closing recurrence is buried.**
   - Each interval ends with the recurring error event itself, since the interval includes the `to` event.
   - Because the token ignores severity, that failing `PostToolUse` merges into any preceding successful `PostToolUse` run. The fixture shows both share source, category and name.
   - Fix: carry a recorded `severity` flag, or mark the closing run's last event, so the recurrence is never hidden inside a run. Equality should still be defined on whichever fields you pick.

3. **Token identity must not be a `|`-joined string.**
   - Source and name are free text, and the existing `errorSignatureKey` already joins with `|`.
   - `("a|b","c","d")` and `("a","b|c","d")` would collide, which breaks the plan's "exact" equality claim.
   - Fix: compare tuples, or use a length-prefixed or JSON key. Add a collision test.

4. **Alignment tie-break is unspecified.**
   - "Tie-break consistently" cannot be tested as written.
   - Specify the row model (`match` / `only-A` / `only-B`) and one backtrack rule, for example prefer diagonal, then A-removal before B-insertion. Pin the expected rows for an ambiguous case.
   - Worst case is 400 aligned rows, which is 10 pages. Say so.
   - Same token with different counts renders as two unmatched rows. Consider a "same name, different count" annotation on adjacent rows, or the diff will look more alien than it is.

5. **The comparand chooser has no design.**
   - A signature can have thousands of intervals (the 100k test yields about 6,666). A `<select>` of all of them breaks the bounded-DOM rule.
   - Unspecified: how the user picks interval B (paged list or numeric input), whether self-compare is blocked, and whether two intervals auto-pair.
   - Interval numbering must match the existing "Compare interval i" labels (`index.ts:117`).
   - The plan also doesn't say whether the existing evidence list and its `Next evidence` test (`index.test.ts:140`) stay or change.

**Stale-scope and state**

6. **Reset logic is scattered and will drift.**
   - `interval` and `evidencePage` are reset by hand at about six sites: `open`, the empty-session handler, the source change, the signature click, `derive`, and compare.
   - The signature click does not even reset `evidencePage`.
   - The plan adds comparand, run-open and per-side page state. Require one `resetComparison()` helper.
   - Specify late-membership behaviour for two intervals. `derive` today keeps one interval by `from.id` and `to.id`. Say which survives when only A or only B vanishes.
   - Interval numbers can shift when ids survive, so key identity by ids and re-announce the renumbered label.

7. **Detail-region lifetime is undefined.** Today, paging evidence doesn't cancel the open detail. Say which comparison actions (comparand change, run open or close, paging) call `cancelDetail`, and keep the identity check at `selectEvent:68`.

8. **Alignment should be computed at selection time, not in `draw()`.** `draw()` runs on every page click and refresh. Memoize runs and alignment per (A, B) id pair. Add a scale test: a 100k-event interval with alternating tokens must take the unavailable path in O(n) without building a matrix.

**Accessibility**

9. **Focus is lost on the last page.**
   - `keepFocus` refocuses by `data-key`, but `focus()` on the just-disabled Next button silently does nothing, so focus drops to `body`.
   - The plan must handle this: move focus to the heading or the Previous button, and add a live region announcing the range.
   - Pager labels are matched with `includes()` in tests and would clash across sides. Use distinct labels such as "Next A runs" and "Next B runs".

10. **Duplicate `data-key`s.** Aligned-row buttons and per-side run buttons point at the same runs, and `keepFocus` takes the first match. Namespace the keys, for example `run:A:n` and `row:n`.

11. **Row semantics.**
    - Use a real table, or a list with captions and header scopes.
    - State match / only-A / only-B in text, not by colour.
    - Truncate run names and counts with `stripControl`, as `eventLabel` does.

**Other**

12. **Real fixtures give one interval at most.** Both qualifying sessions in `fixture.errsig.json` have 2 occurrences, which is 1 interval holding only the second event. Real data can only drive the one-interval notice. Every alignment case needs mutations, so label them clearly, as the plan intends.

13. **"Receipt" is ambiguous.** It reads as the Evidence Court prototype's shared pane. Define it as the Loops-local detail region only, which never writes the shared pane (`index.ts:12`).

14. **Faithfulness caveat.** The timeline view is already a reduced projection. The disclosure copy should say runs come from reduced timeline events, not full payloads. It should also say the interval includes its closing recurrence and excludes the baseline.

**Good as written:** the ≤200 and ≤201×201 bounds, no automatic pairwise comparison, the three-occurrence notice, no new API, `textContent` for captured labels, and the 40-per-page cap.

All fourteen points incorporated into the plan before implementation; follow-up pending.

## Plan follow-up

**PASS.** I found no concrete plan blockers in `03fa5ca..e8a2d8e`, and all fourteen findings are addressed. This was a static read of the plan, the review doc and `score/model.ts`. I ran no tests, made no edits and used no network or delegation.

The revised plan is `docs/plans/2026-10-18-loop-sequence-comparison.md` (lines 12-18). I checked the plan against `TIMELINE_PAYLOAD_KEYS` and `TIMELINE_FIELDS` in `score/model.ts:400-402`. Both `tool_name` and `severity` survive the timeline projection, so the new token fields are available.

| # | Status | Where the plan covers it |
|---|---|---|
| 1 | Addressed | The token now includes `payload.tool_name`, shown only when it is a string. Missing and opaque values are marked unavailable, never inferred. |
| 2 | Addressed | The token includes severity. The closing recurrence is marked on the run that contains it, even when it merges with preceding events. |
| 3 | Addressed | Identity is a JSON tuple, and there is a delimiter-collision test in the acceptance list. |
| 4 | Addressed | Row types are match / only-A / only-B. The tie-break prefers a diagonal match, then consumes A before B, and an ambiguous-sequence test is pinned. The plan also states the 400-row, ten-page maximum. Counts are shown on unmatched rows instead of adding a "same name, different count" annotation. That was only a suggestion in the review, so I accept it. |
| 5 | Addressed | B is chosen with a bounded 1-based numeric input and an explicit Compare button. Self-compare and out-of-range values are rejected. The default is the preceding interval, or the next one for interval 1. The existing evidence list and Next evidence behaviour are kept. |
| 6 | Addressed | A single `resetComparison` helper owns comparison state. A/B identity is stored as endpoint ID pairs. On late membership the pair is kept only if both survive, with the numbering updated. Otherwise the comparison is cleared and the reason announced. |
| 7 | Addressed | Comparand edits, comparison execution, run open/close and every pager cancel Loops-local detail. The `selectEvent` identity checks stay, and the shared pane is never touched. |
| 8 | Addressed | Runs and alignment are derived only when a pair is selected, and the result is cached across draws. A 100k alternating-event test must take the unaligned O(n) path with no matrix. |
| 9 | Addressed | After a redraw, focus goes to an enabled matching control or the region heading. A status line announces ranges. Pager labels are distinct. |
| 10 | Addressed | Data-keys are namespaced by region, side and run or row index. |
| 11 | Addressed | A semantic table has scoped headers and textual statuses, plus labelled lists as the fallback. Labels go through `textContent` and `stripControl` and are capped at 160 characters with a truncation disclosure. |
| 12 | Addressed | Real fixtures give at most one interval, so multi-interval cases are explicitly labelled contract mutations. |
| 13 | Addressed | Detail is Loops-local and never touches the shared pane. The word "receipt" is still not defined outright. |
| 14 | Mostly addressed | Labels must say the runs are reduced timeline fields. See nit 1. |

**Non-blocking nits** (fixable in the plan text or at the first red test):
1. The disclosure copy requirement covers "reduced timeline fields" but not the other half of finding 14. The contract on line 11 states the interval boundaries (excludes the first recurrence, includes the next), but no requirement says the UI copy shows them. Adding that sentence to line 12 would close it.
2. The acceptance list on line 22 has no named tests for several new behaviours. These are the last-page focus restore, the duplicate data-key check, self-compare and out-of-range rejection, late-membership retain-versus-clear, and truncation disclosure.
3. Line 13 says selection resets on "load/refresh" but also says a late-membership rederive retains the pair. Say that "refresh" means a user-initiated reload and "late membership" means a rederive of the already-loaded session. Otherwise two implementers could read these differently.
4. The plan does not say that a renumbered interval label is re-announced after late membership. It does say numbering is updated.

Disposition: PASS. UI copy states both boundaries; refresh means explicit history reload, while late membership is a rederive of loaded history. DOM regressions cover focus, unique keys, invalid/self selection, retention/clearing and label truncation; numbering changes are announced.
