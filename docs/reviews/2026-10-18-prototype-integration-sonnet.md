# Sonnet 5.5 High combined adversarial review

Direct Claude CLI, exact model claude-sonnet-5-5, high effort; immutable e007b2f..724a378. No runtime tests run by reviewer.

**Verdict: no blocking integration regressions in code. There are 3 non-blocking findings, mostly stale or contradictory evidence docs.**

I did a static read of `e007b2f..724a378`. I made no edits, ran no tests, made no network calls and delegated nothing. The worktree HEAD moved to `263c606` partway through the review. That commit touches only Activity files and docs, so I checked Activity at `724a378` using `git show`.

**1. Medium: the integration evidence is stale for `724a378`.**
- `docs/reviews/2026-10-18-prototype-integration-validation.md` was not touched in `735d8e7..724a378`. It still pins `e388b60`/`8e38e86` and 677 frontend tests, so no combined test, build or Go result exists for the final head.
- That range changed Ecosystem, Replay, Activity and the Go `activity.go` and `workspace_graph.go`.
- Lines 11 and 23 of that doc still say the requested external review is pending and that the Sonnet attempt is "running, no verdict yet". The same tree already records Sonnet 5.5 High PASS verdicts for Patch (`docs/reviews/2026-10-18-patch-ecosystem-sonnet.md:73`) and Replay (`docs/reviews/2026-10-18-forked-replay-sonnet.md:47`).
- `docs/plans/2026-10-18-prototype-coverage.html` is stamped "code 8e38e86". Its "Open gates" line lists Patch and Replay final reviews as open, which contradicts those PASS records.
- The coverage doc's Activity row cites tests from `735d8e7`, but the Activity review is still unresolved (see item 3).

**2. Low: the validation doc miscounts sidebar destinations.**
- `docs/reviews/2026-10-18-prototype-integration-validation.md:13` says "twelve existing sidebar destinations".
- `main.ts:103-123` has 13 existing panels: live, attention, dwell, workspace, matrix, lanes, sessions, score, loops, strata, files, doctor, settings. Either one was not exercised or the count is wrong.

**3. Low: the Activity overlay at `724a378` still has the open items from its Sonnet first follow-up.**
- `errorPage` persists across scope changes, so a new repo or workspace lands on the old page number (`activity/index.ts:248`).
- Pager focus is lost when the map re-renders.
- There is no daemon test for error-only paths in unresolved groups.
- The validation doc and `contracts.md:451` are stale or narrower than the behavior.
- `263c606` appears to address these, but the Activity requested-model review is still not closed. Do not count the combined diff as reviewed at `724a378`.

**4. Low: `court/index.ts` `offerEvent` hides a notebook failure.**
- When the notebook is unavailable, `offerEvent` replaces the "Notebook unavailable" notice with "Select a requirement, look up the event, then attach…".
- Lookup stays disabled and no requirement can be selected, so the guidance is misleading. It should keep the failure notice.

**What I verified and found sound:**
- **Navigation and lifecycle (`main.ts` `show`):**
  - Leaving a panel runs the right cleanup: Court `refresh` aborts its lookup, Handoffs `refresh` invalidates, and Airspace, Loom, Ecosystem and Replay `deactivate`.
  - Ecosystem `deactivate` pauses playback, and it now runs only on departure because `refresh` no longer pauses.
  - Entering Court, Handoffs, Airspace, Loom, Ecosystem or Replay clears the shared detail pane.
  - Drafts persist. Court drafts live in a map. Handoffs fields are not cleared. Replay keeps dirty edits through `refreshNotebook`.
- **`offerEvidence` ordering:** `show("court")` runs before `offerEvent`, so the new lookup is not cancelled by `refresh`. Hoisting is safe because the references are lazy.
- **Notebook storage:** the keys are distinct (`firehose.evidence-court.v1`, `agentfirehose.replay.v1`), as is Handoffs'.
- **Styles:** the selectors are all scoped by class prefix. `.map-storm > rect` comes after `.map-tile > rect`, so the outline wins. The sidebar `overflow-y:auto; min-height:0` is sound.
- **API and Go:**
  - `view=correlation` is additive, and the 400 message is updated.
  - `CorrelationView` builds on `TimelineView`, so it carries no payload bodies or filesystem identity fields.
  - `error_paths` is always a non-nil array, and older daemons omit it, which the client treats as "unavailable".
  - The 2000-path and 20-signature caps match `contracts.md`.
  - File Heat is unchanged for file-category errors, and non-file, non-error events are excluded before the dedupe set.
  - Group ordering via `slices.Sort` matches the previous "" first, then sorted order.
- **`735d8e7..724a378` remediation:** the RFC3339 fractional-clock ordering in Ecosystem and Replay is consistent. The read-only guard on `newBranch` is present. Replay `deactivate` no longer leaves a stuck loading notice.

## Dispositions

Current validation and coverage updated at263c606; historical checkpoints explicitly separated. Browser record conservatively states six new and twelve of thirteen existing destinations (one not individually recorded). Activity fixes integrated at263c606 with independent PASS and external follow-up pending. Court offered-event guidance now preserves unavailable-notebook notice; regression failed before fix. Follow-up pending.

## Final follow-up — 724a378..0360ec0

**PASS.** I found no concrete actionable bugs in `724a378..0360ec0`. This was a static read only. I made no edits and ran no tests, made no network calls and delegated nothing.

**Review dispositions**
- **Current evidence:** The validation doc now has a "Current combined remediation checkpoint — 263c606" header. It labels the older Argon and quota notes as historical, so the stale-evidence finding is addressed. The prototype-coverage page now says code `263c606`. Its open gates list only the Activity and combined-integration follow-ups, CI and merge approval. Patch and Replay are recorded as Sonnet 5.5 High PASS, which matches their review docs.
- **Browser count:** The doc now says six new and twelve of thirteen existing destinations. `main.ts:103-123` has exactly 13 existing panels (live through settings) and 6 new ones (court, handoffs, airspace, loom, ecosystem, replay), so the count is correct.
- **Court `offerEvent`:** `court/index.ts:134` only sets the "Select a requirement…" notice when `notebook` exists, so the "Notebook unavailable" notice survives. The new test checks that notice, checks the guidance text is absent, and checks `setItem` was never called. `reload()` resets `notebook` on every load, so there is no path where a stale notice persists.
- **Activity fixes:**
  - `errorPage.page = 0` is reset when `scopeKey` changes. `load()` only runs from `update` and the handlers, never during construction, so `errorPage` is declared before use.
  - The pager and heading now carry `data-key`, so `keepFocus` can restore them across redraws. The fallback focuses the heading when the focused button is gone or disabled.
  - The status paragraph now lives outside the redrawn body, which keeps the live region stable. `activityGroupLabel` is shared, so the group label logic is not duplicated.
  - `errorRange` preserves API order, so the new "last page" test is consistent with it.
  - The two new Go tests exercise the non-file patch error, the ineligible duplicate, the path cap and error-only groups in unresolved and unknown worktrees.
  - The `contracts.md` wording ("any category") matches `activity.go:124-138`, where any file-category event or any error observation is admitted.

**Non-blocking doc nits**
- The checkpoint and coverage page are stamped `263c606` and quote 691 frontend tests. `0360ec0` adds one Court test and a code change after that, so the count would be about 692 and the Court change sits outside the "independent reviews PASS on 263c606" claim. Each doc marks the Court change as follow-up pending, so this does not mislead.
- `error-path-heading` is the only focus fallback. The "Signature counts" `<details>` open state and summary focus are lost on a live refresh. That behavior was already there and is not a regression.

I did not re-run the 691/496 test counts or the Go checks. Those claims rest on the docs.

Disposition: PASS. Current checkpoint updated to0360ec0 / 692 tests; independent Court follow-ups PASS on263c606..db82b69. No additional code changes after reviewed0360ec0. Existing details expansion is transient presentation state, not persisted evidence. Hosted checks remain separate.
