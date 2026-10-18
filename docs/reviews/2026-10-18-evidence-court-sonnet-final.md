# Sonnet 5.5 High final adversarial review

Immutable code commit f3e46c0; requested fallback after Argon timed out.

I'll start by looking at the commit, the diff against base, and the docs.
Now the implementation and tests.
**PASS.** I found no concrete blockers in f3e46c0 against base e007b2f. Seven low, non-blocking items are listed at the end.

I didn't edit the repo. I ran `tsc --noEmit` and the full vitest suite on a `git archive` copy of f3e46c0 in the scratch directory. `tsc` was clean, and vitest passed 531 tests across 34 files, matching the committed validation report. I did not rerun the browser check, as you directed. Because this is a review, I didn't write a plan artifact.

## Initial findings

Each finding is checked against the implementation and the test bodies. Line numbers refer to [index.ts](apps/tauri-desktop/src/ui/court/index.ts) unless noted.

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Requirement preselected, target not named | **Fixed** | `reload()` sets `requirementID = ""` (L125) and `offerEvent` does the same (L134). `lookupButton` is disabled with no requirement (L69). The preview shows `Attach to: claim → requirement` from saved state (L112). Tests at index.test.ts L53–60 cover this. |
| 2 | Corrupt or future notebook is a dead end | **Fixed** (read-only, no reset) | `reload()` appends the raw stored text in a `pre` and says no reset or overwrite occurred (L127–130). `mutation` blocks without a notebook (L39). index.test.ts L66–67 asserts raw text and no `setItem`. |
| 3 | Silent receipt replacement and removal | **Fixed** | The lookup button is disabled when a receipt exists (L69), and L102 also rejects it. `confirmRemoval` (L48–51) names the target and covers claim, requirement and receipt, with Cancel. Tests at L53–60 cover replace, cancel and confirm. |
| 4 | Failed attach discards the preview; typing cancels it | **Fixed** | `cancelPreview()` now runs only after a successful save (L41), so a failed save keeps the preview. Only scoped fields cancel (L31, `scoped` is true for claim and requirement text), plus the event-ID input. index.test.ts L61–65 and L70–74 cover it, including a quota failure and a stale cross-window attach. |
| 5 | Drafts lost on in-panel navigation | **Fixed** | The `drafts` map is keyed per field (L13, L30–31) and survives `draw()`. Reload clears it, with a warning at L20. The test at L64 checks drafts survive claim and requirement switching. |
| 6 | Mismatch worded as "unavailable" | **Fixed** | The mismatch branch (L120) says the evidence conflicts with the saved identity and must not be relied on. L39 asserts "Receipt identity mismatch" and L27 asserts "Evidence identity mismatch". |
| 7 | `crypto.randomUUID()` outside a try | **Fixed** | `newID()` (L44–47) shows a visible notice. The test at L68 covers it. |
| 8 | Cosmetic: "Error:" prefix | **Fixed** | Messages use `error.message`. The duplicate label plus `aria-label` remains and is purely cosmetic. |
| 9 | Dev and release origins | **Fixed** | Copy at L19 says development and release builds are separate. |
| 10 | Detail action only in the main drawer | **Open, low** | Not wired in graph/index.ts L876. The plan still says "shared detail drawer" without scoping it. See item 6 below. |

Test gaps from the initial review:

- **Fixed:** the failed-attach test, the stale-detached-Attach test (L75–79) and the cross-window conflict test.
- **Fixed:** remove-receipt persisting across reload (L59) and plan L3 status.
- **Partly addressed:** the "explicit read count" test (L16, L64) and the weak payload assertion (L17).

## Plan contract

I checked the plan point by point against the code:

- **Storage and write behavior:** the versioned key, no save-on-load and strict validation all match. Storage and quota failures are visible. Failed mutations preserve prior state (notebook.ts L71–78, L35–54).
- **Save semantics:** compare-and-write against the original raw string happens before every save (notebook.ts L73). Callers get copies (L70). A save returns only after `setItem` succeeds.
- **Multi-window storage:** the comment at notebook.ts L62, UI copy L19 and validation report L21 all call it best-effort and not atomic. I did not flag it.
- **Receipt shape:** receipts hold only `{id, source, session_id}`, and unknown fields are rejected. Session ID may be empty. Bounds are enforced, including sparse arrays via `Array.from` (L28).
- **Lookups:** they are explicit only. Each one aborts the previous request and is guarded by a version token plus claim and requirement IDs (L104–108, L119).
- **Mismatch checks:** the code checks the returned ID against the requested ID, and source and session against the saved receipt (L109–111). It rejects a mismatch rather than attaching.
- **Saved receipts:** failed lookups of a saved receipt keep the reference and show an error.
- **Navigation and rendering:** "Open Score" appears only for a nonempty session ID (L117). Evidence and notes render as text through the `el()` helper and `pre`, with no `innerHTML`.
- **Other plan points:** the 20-claim and 20-requirement display caps, the gap-only counts (L75–76) and `offerEvent` (L134) all match. Handoff in main.ts L61–66 closes the drawer, calls `show("court")` (which runs the cancelling `refresh`), then calls `offerEvent`, so the ordering is safe.
- **Detail change:** detail.ts L144–148 is additive and only active when a callback is passed. The `main.ts` and `detail.ts` wiring type-checks.

## Docs

The plan status, backlog journal and validation report agree: base `e007b2f`, 531 frontend tests and 3 Rust tests. The validation report says the browser check ran against an isolated actual-daemon fixture. It names the handoff, attach, reload persistence, gaps, reopen and Score navigation. It also discloses that this is not a packaged-native test.

I didn't rerun the Go gates or the Rust tests. The commit touches no Go or Rust files.

## Non-blocking items

1. **Vacuous assertion:** index.test.ts L54 has `...?.disabled ?? false).toBeDefined()`, which can never fail. The real check is on the next line.
2. **Open receipt read count:** the "Open receipt" re-fetch at L18 doesn't assert a call count. `settle()` (L8) uses a fixed 10 ticks and could flake if the mock chains more awaits.
3. **Misleading test title:** the test at L42 is named for requirement switching, but its second half only covers `mutation` clearing the preview. The real switch case is at L75–79.
4. **Handoff wiring:** `offerEvidence` (main.ts L62–66) is unit-tested only through a stub in detail.test.ts. The browser report is the only evidence that `show("court")` plus `offerEvent` works end to end.
5. **Auto-select after add:** creating a claim or requirement selects the new item (L60, L88). It is user-initiated, and the target is still named in the attach preview and requires "Attach receipt". It does not violate "never preselect on reload or handoff", but the plan doesn't state it.
6. **Graph drawer not wired:** the "Use in Evidence Court" button (detail.ts L144–148) has no class or title. It sits after the payload tables, so it is easy to miss on long events. The graph drawer at graph/index.ts L876 doesn't offer it either. A one-line plan note would close this.
7. **Strict unknown-field rejection:** notebook.ts L12 means any additive field from a later v1 writer blocks mutation in this build. This is intentional, and the raw recovery text mitigates it.
