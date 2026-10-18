# Sonnet 5.5 High adversarial review

Direct Claude CLI, exact `claude-sonnet-5-5`, `--effort high`; static read-only e007b2f..265e1dd. User-authorized fallback after Argon quota exhaustion.

**Verdict: no blocking defects.** There are two Medium findings and several Low ones. Nothing breaks the plan's core contract.

This was a static read of `e007b2f..265e1dd` at head. I ran no tests, made no edits and delegated nothing.

## What I checked and found sound

- **Canonical signature parity:** `projection.ErrorObservationKey` (`errsig.go:138`) reuses `isErrorObservation`, `errorClass` and `errorSignatureKey`, the same functions `foldErrorSignature` uses. The qualification predicate and key cannot drift from the projection's.
- **Heat unchanged:**
  - Non-file errors return before `FileEvents`, `UnreadableFileEvents` and the Heat map are touched (`activity.go:~156`).
  - File-category errors take the same Heat path as before.
  - The `paths` reassignment for errors uses the same `activityPaths` extractor, so file-category Heat paths are identical.
  - Heat truncation and ordering are untouched.
- **Alias dedupe:** the per-event `resolved` set stops two aliases that resolve to one path from double-counting one observation, and a regression test covers it.
- **Caps and omissions:**
  - Paths are ordered by total descending, then group, then path. Signatures are ordered by total descending, then key.
  - The caps are 2000 paths and 20 signatures per path.
  - `omitted_error_paths` and `omitted_signatures` are computed correctly, and `total` includes omitted signatures as `contracts.md` says.
  - The result is deterministic, and the cap test checks that.
- **Privacy and compatibility:** the minimal-mode early return still happens before any scan, and `error_paths` is always a non-nil `[]`. The client treats an absent field as "unavailable" rather than zero errors, and `contracts.md` is additive-only.
- **Brush scope:** `errorRange` uses `[a,b)` over bucket indices. `render()` rebuilds the overlay and the list on every brush change, so both stay in step with the Heat tiles.
- **Tile identity:** the key is `[group, path]`, and `node.group` and `node.path` for file leaves equal the API `group` and `path`.

## Findings

**1. Medium — `activity.go:127-130`: the dedupe set now holds every in-window event.**
- The original code returned early for non-file events, so `seen` only held file-event IDs. The category gate was removed, so `seen[ev.ID]` and `EventDay` now run for every repo/workspace-scoped event in the window: tool, shell, session and so on.
- Aggregation memory therefore grows with all matching history, not just file and error history, even for callers that only want Heat.
- That quietly widens the "memory proportional to matching history" claim. `contracts.md` says Heat behaviour and scan cost are unchanged, and that is no longer strictly true.
- Fix: run the dedupe only for events that are file-category or qualify as errors, which is a cheap pre-check before `seen`. Alternatively, state the larger footprint explicitly.

**2. Medium — `activity.go:135-139`: error path extraction is wider than the canonical `EventFilePaths`.**
- The code sets `pathEvent.Category = CategoryFile`, which bypasses the category gate at `projection.go:434`. Any `severity=error` event, whatever its category, now yields paths from `payload.file_path`, `path`, `file` or `changes`, and from the apply_patch text fallback.
- The projection's `foldErrorSignature` uses plain `EventFilePaths(ev)`, so `ErrorSignature.Paths` for the same event is empty. The overlay attributes a path that `/errors` signatures do not. That departs from the "same-event, canonical" framing.
- A shell or tool error with a directory-valued `path` would be drawn as a file-error tile. A failed `apply_patch` attributes the paths in its attempted patch.
- I checked the real adapters. The Claude Code adapter only writes `file_path` for file tools. Its `PostToolUseFailure` events are `warn`, so they do not qualify. In practice this path is hit by category=error events that carry a path, and by codex or opencode `severity=error` events. The practical blast radius is small.
- The plan permits "existing path extraction" and `contracts.md` discloses the apply-patch behaviour, but neither documents the category bypass.
- Fix: either restrict the extraction to explicit keys plus `changes`, matching `EventFilePaths` semantics, or add a negative test (tool or shell category with severity error and `path`) and document the widening in `contracts.md`.

**3. Low — `workspace_graph.go:447` with `errors.ts:25`: error-only paths in unresolved groups are shown by raw group ID.**
- `resp.Groups` is built only from `result.Paths` (Heat). An error-only path whose group has no Heat has no `groups` entry.
- The list prints `stripControl(p.group)`, which is the raw worktree identity. In balanced mode that is a long digest. The Heat map instead shows `digestLabel(...)` or "Outside known worktrees".
- The literal group `"unknown"` also appears raw.
- Fix: include error-path groups in the group set, and format the group in the list the same way as the map (`digestLabel` or the group label).

**4. Low (accessibility) — `errors.ts:34`: pagination destroys the focused control.**
- `draw()` calls `clear(root)` and rebuilds the buttons. Activating "Next error paths" removes the focused button, so keyboard focus drops to `<body>`. This code path does not use `keepFocus`, and there is no `aria-live` region announcing the new page.
- The page also resets to 0 on any re-render, including brush drags, zoom and live refresh, so a keyboard user loses their place.
- Fix: refocus the same button after redraw, or the heading. Add `role="status"` to the "Showing a–b of n" line. Persist `page` across `render()`, clamped to the new length.

**5. Low — `errors.ts:13`: rows with zero in-range count are still listed.**
- The filter `p.count>0||p.omitted>0` keeps a path that has only omitted signatures and nothing retained in range. It renders as "0 retained error observations".
- The plan says the list "shows all retained file paths with errors in range", and this row may have none in range. The disclosure text mitigates it, but the row can mislead.
- Fix: label it explicitly ("no retained observations in range; N signatures omitted"), or exclude it and rely on the aggregate omission notice.

**6. Low — test gaps against the plan's TDD list (`activity_errors_test.go`).**
- The duplicate-ID test uses `b,b` in the same day file. Nothing exercises the cross-day canonical replay branch (`EventDay != day`) on the error path.
- There is no workspace-scope mutation. Only repo and window are mutated, although the plan asks for "scope".
- There is no negative test for a non-error, non-file event carrying a path (it should produce nothing), and none for severity-error events in non-file, non-error categories (see finding 2).
- `TestActivityErrorCapsAreDeterministic` tests the helper in isolation, not through `Activity`. The daemon test covers only the happy path: two errors, one path.
- The frontend test checks only that `.map-storm` appears once. It does not assert that the list ordering matches the API ordering, or that the old-daemon notice appears when `error_paths` is absent in a non-empty map.

**7. Nit — docs.**
- `docs/reviews/2026-10-18-activity-error-overlay-validation.md` pins code `4ba6787` and says the Sonnet 5.5 High review is still pending. That is stale once this review lands, so update it with the outcome. `Truncated` language also still describes only Heat caps.
- `contracts.md` says "at most2000" and "at least2" in several places (missing spaces).

## Recommendation

Fix 1 and 2 before un-drafting. Finding 3 is also cheap to fix. Findings 4 to 6 can follow in the same branch. Everything else matches the plan, including the canonical key, same-event attribution, exact sparse counts, deterministic caps, brush `[a,b)` scope, the paginated accessible list with error-only paths, and the old-daemon "unavailable" disclosure.

## Remediation

Unrelated events excluded before dedupe; any-category same-event explicit path attribution documented and tested (paths can be directories or attempted patch targets). Error-only groups included; readable group labels, retained pagination/focus and status announcements, explicit omission-only wording. Added workspace/non-file negatives and cross-day canonical replay tests, plus old-daemon nonempty-map coverage. Prior caps helper test remains the deterministic cap contract gate. Independent spec and standards follow-ups PASS; full Go/CLI/sidecar/Rust gates and 493 frontend tests/build passed before final coverage additions; focused added coverage passes. Sonnet follow-up pending.

## First follow-up on c4ad1fe

**Not a PASS.** I found no blocking defects, but two of the Sonnet review's dispositions are only partly true, and the fixes have test and doc gaps. This was a static read of `265e1dd..c4ad1fe` only. I ran no tests, made no edits, made no network calls and delegated nothing.

## Dispositions I verified

- **Eligibility before dedupe (finding 1): fixed.** `activity.go:124-127` computes `ErrorObservationKey` and returns for events that are neither file-category nor errors, before `seen` and `EventDay`. File-category events and Heat behave as before.
- **Category bypass (finding 2): fixed as documented.** It is disclosed in `contracts.md:461-466` and exercised by `TestActivityErrorsExplicitPathsAcrossCategoriesAndWorkspaceScope`. That test covers tool and shell errors with a directory path, an info-severity non-error, and a foreign worktree. It asserts that Heat stays empty and that `ErrorPaths` has one entry with total 2.
- **Cross-day canonical replay (finding 6): fixed.** The new test passes through the real `EventDay` branch.

## Findings

1. **Medium: the fix for finding 3 has no backend test.**
   - `workspace_graph.go:447-464` now adds error-only groups to `resp.Groups`. The diff changes no daemon test.
   - `TestActivityReturnsAdditiveErrorPaths` (`internal/daemon/activity_test.go:423`) uses a resolved path, so its group is `""`.
   - Nothing covers an error-only path with an unresolved group, or the `unknown` group. A regression there would pass the whole suite.

2. **Medium: the keyboard-focus claim is only partly true.**
   - `move()` (`errors.ts:34`) refocuses correctly after a click. It falls back to the `<h3>` when the target button is disabled, for example on the last page or on Previous at page 0.
   - Every `render()` rebuilds the section, including brush drags, zoom and live refresh. `keepFocus` (`dom.ts:47-58`) restores focus only for elements with a `data-key`, and the pagination buttons have none. A keyboard user who focused Next and then gets a refresh loses focus to `<body>`.
   - `role="status"` is on a `<p>` that `clear(root)` recreates on every `draw()`. Live regions inserted already populated are not reliably announced. Moving focus to the button is what actually helps.
   - The new focus test checks only the happy path, with Next enabled. It does not cover the h3 fallback or a re-render.

3. **Low: the page index is never reset when the scope changes.**
   - `errorPage` (`index.ts:248`) lives for the whole map. A repo, worktree or preset change gets a new response, and the old page is only clamped.
   - A user who was on page 3 lands on page 3 of a different list instead of page 1.

4. **Low: group labels differ between the list and the Heat map.**
   - For group `unknown`, the list shows "Outside known worktrees" (`errors.ts:25`). `buildTree` (`model.ts:118`) names the same tile `unknown`.
   - Known-worktree and digest groups match.
   - The label is also not an `OUTSIDE_LABEL` import. It is a duplicated literal.

5. **Low: the validation doc is stale.**
   - Review finding 7 asked for `docs/reviews/2026-10-18-activity-error-overlay-validation.md` to be updated, and it is untouched in this diff.
   - It still pins `4ba6787` and 491 frontend tests, and still says the external review has not passed.
   - The Sonnet doc's remediation cites 493 tests and spec and standards follow-ups that PASSed. Nothing in the repo records those results.
   - The `docs/plans/2026-10-18-backlog-coordination.html` edit is unrelated to this work. I did not diff it in full.

6. **Test gaps remaining from finding 6.**
   - No test shows an ineligible event not shadowing an ID. `ordinary` has a unique ID, so the dedupe-ordering fix is untested.
   - No test covers apply-patch text fallback on a non-file error, which `contracts.md` explicitly says is attributed.
   - `TestActivityErrorCapsAreDeterministic` still tests the helper in isolation.
   - The frontend test does not assert that list order matches API order.

7. **Nit: `contracts.md:451`.** It still says "an error-category observation with an explicit path can appear without contributing file Heat", which is narrower than the new any-category behavior.

## Recommendation

Fix 1 and 2 before un-drafting. Finding 5 is a quick doc update. Findings 3 and 4 are cheap to fix in the same branch.

I did not write a plan file or call ExitPlanMode, since this was a read-only report. Neither tool was available to me.

## Second remediation

Added daemon coverage for unresolved and unknown error-only groups, public Activity cap coverage, non-file patch extraction and ineligible duplicate regression, list-order and heading-focus tests. Main redraw preserves pager focus via stable keys and heading fallback, while scope changes reset the page. Page status survives local pagination redraws. Heat/list labels share one helper. Full Go gates and 496 frontend tests/build pass. Second follow-up pending.
