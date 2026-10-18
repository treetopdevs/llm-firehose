# Sonnet 5.5 High initial adversarial review

Argon 4 High timed out after two minutes without a verdict. This read-only fallback reviewed implementation and plan during ongoing local validation; status/browser documentation was updated concurrently and is recorded separately.

I'll start by locating the plan doc and the court-related sources.
Shell globbing blocked the greps; retrying the Go handler and caller search.
# Evidence Court review: needs changes before PR

Nothing here loses data or fabricates evidence. The notebook layer is solid. The problems are in the panel's attach flow, recovery, and gaps between the plan and its tests. I read the plan, `court/*`, the `detail.ts` and `main.ts` diffs, and the Go `Engine.Event` and `handleEventByID`. I did not run the tests.

Paths below are under `apps/tauri-desktop/src/`.

## What holds up

- **Persistence.** [notebook.ts](apps/tauri-desktop/src/ui/court/notebook.ts) validates strictly and rejects unknown fields, so payloads can't persist.
- **Save safety.** There is no write on load. `save()` compares the raw stored value before writing (L73). A failed write leaves state untouched, and both `read()` and `save()` return copies.
- **Receipt honesty.** `Engine.Event` looks up by ID in the projection and returns the full envelope. "Open receipt" re-verifies id, source and session ([index.ts](apps/tauri-desktop/src/ui/court/index.ts) L98–100). The "not verified" copy is consistent.
- **Event rendering.** Events render as text in a `pre`, not HTML.
- **Stale previews.** Abort plus a version token handle them in `lookup`.
- **Handoff.** The `main.ts` handoff ordering is correct (`show("court")`, then `offerEvent`).
- **Score drawer.** `offerEvidence` closes the drawer without calling Score's `dismiss`. I checked `score/index.ts` L334–337 and it is guarded by `!root.isConnected`, so this is benign.

## Findings

### High / medium

**1. A requirement is silently preselected, and the preview doesn't name the attach target.**
- `reload()` auto-selects the first claim and first requirement ([index.ts](apps/tauri-desktop/src/ui/court/index.ts) L114).
- `lookupButton` is therefore enabled on startup, and `draw()` keeps selection as is.
- The handoff notice says "Select a requirement" (L119), but one is already selected.
- The preview shows only the event JSON and an "Attach receipt" button (L101–105). It never says which claim or requirement it will attach to.
- The only selection cue is `aria-pressed` and a CSS outline ([styles.css](apps/tauri-desktop/src/styles.css) L806).
- With 2+ claims, a user clicking "Use in Evidence Court" can attach evidence to the wrong requirement without noticing.
- This contradicts plan L9: "no attachment until the user selects a requirement and confirms".
- Fix: don't auto-select a requirement on load or handoff. Render "Attach to: <claim> → <requirement>" in the preview.

**2. A corrupt or future-version notebook is a permanent dead end.**
- `reload()` sets `notebook = undefined` (L115). `draw()` then renders nothing (L44), and `mutation` returns early (L36).
- There is no "discard and start fresh", no raw export, and no way to see the offending value. The message only says "Reload notebook to retry".
- One out-of-bounds entry (say a 1001-char claim edited by hand, or a 21st claim) bricks the feature until app data is cleared.
- Strict unknown-field rejection (notebook.ts L12) also means any additive field from a later v1 writer bricks older builds.
- Blocking is correct per the plan. The gap is that the plan (L13) never specifies a user-initiated recovery path.
- Fix: add an explicit, confirmed "Discard stored notebook" action, or show the raw JSON for copy.

**3. Silent receipt replacement.**
- "Look up event" stays enabled when the selected requirement already has a receipt (L59, L91).
- "Attach receipt" then overwrites it (L104) with no warning, no old-vs-new display, and no undo.
- "Remove claim" and "Remove requirement" (L63–64, L84–85) also drop receipts with no confirmation.
- The plan (L19) is silent on replace and delete semantics.

**4. A failed attach discards the preview; typing anywhere cancels it.**
- `mutation()` calls `cancelPreview()` before saving (L37).
- On a quota or conflict failure the user has lost the evidence view and must re-fetch.
- The test at index.test.ts L28 papers over this by clicking "Look up" again.
- Every textarea input cancels previews and in-flight lookups (L28, L120), including the unrelated "New claim" box.
- That is broader than the plan's "edits/removal" guard (plan L21). Scope it to the selected requirement or claim, and save only after the user has seen the failure.

### Lower

**5. Drafts are lost on any in-panel navigation.**
- `draw()` rebuilds every textarea.
- Selecting a claim or requirement (L55, L69), adding one, or saving anything discards unsaved edits in the other fields.
- Plan L21 says "keep manual drafts on ordinary navigation". The test (index.test.ts L22) only covers `refresh()`.
- After a conflict failure, the Reload the UI recommends also wipes the draft (L113), so the user's edit is lost.

**6. Wrong error copy for a saved-receipt identity mismatch.**
- The L100 throw lands in the L109 handler.
- The result reads "Evidence unavailable: Error: Receipt identity mismatch. The attached reference remains; availability does not verify the claim."
- A mismatch is not "unavailable", and the sentence implies the reference is still meaningful.
- A mismatched receipt should be flagged as conflicting with the saved identity.

**7. `crypto.randomUUID()` is called outside the try (L48, L77).**
- If it is missing (insecure context or an older webview) the click handler throws uncaught.
- The user gets no notice, and the plan's "visible errors" promise is broken.

**8. Cosmetic and a11y.**
- Errors display as "Save failed: Error: …" because of `String(error)`.
- Textareas have both a wrapping `<label>` and an `aria-label` (L27, L52).
- Textareas are typed as `HTMLInputElement` in the test helpers (index.test.ts L10).

**9. Dev and release origins.** `localStorage` is origin-scoped, so notes from a dev build (`http://localhost`) won't appear in the release build (`tauri://localhost`). The UI copy (L16) mentions clearing app data but not this. It is a doc-level fix, but the plan promises persistence.

**10. Detail action coverage.**
- "Use in Evidence Court" is wired only for the `main.ts` drawer (Live and Score).
- Graph's own `renderDetail` call (graph/index.ts L876) has no such action.
- Plan L9 says "the shared detail drawer", so this is acceptable, but the plan doesn't say so.
- The button sits after the payload tables and before the JSON disclosure, with no class or title (detail.ts L144–148). It is easy to miss on long events.

## Test-body gaps

- **Attach-guard tests don't test the guards.**
  - "switching requirements cannot attach the old preview" (index.test.ts L42–45) actually tests "mutation clears the DOM".
  - The Attach callback's guard (L103) is redundant after `cancelPreview` removes the button, so it is dead and unexercised.
  - A selection-change test would hit `cancelPreview` too.
- **Plan promises that no test covers:**
  - "explicit read count" (plan L25). Nothing asserts `toHaveBeenCalledTimes` for lookup or open.
  - Replace-receipt behavior.
  - Remove receipt persisting across reload, and a reload that restores an attached receipt.
  - Stale cross-window conflict in the panel (only in the notebook unit test).
  - Panel-level behavior after invalid notebook: index.test.ts L31 only checks init, and no mutation is attempted. Clicking is impossible because the body is empty.
  - Failed attach preserving the preview (it doesn't, see finding 4).
- **Weak assertion.** index.test.ts L17 checks only that `event.summary` is absent from storage. Other payload fields (`name`, `payload`, `category`) are not checked, so a regression that copied them would pass. Compare the stored JSON against the exact `{id,source,session_id}` shape instead.
- **`main.ts` handoff untested.** The `offerEvidence` wiring is only checked via a stub callback (detail.test.ts L172+). Nothing exercises `show("court")` plus `offerEvent`, or `show()`'s `refresh` clearing the handed-off preview.
- **`settle()` is brittle.** It uses a fixed 10 microtask ticks and could flake if `capturedEvent` mocks chain more awaits.

## Plan doc issues ([2026-10-18-evidence-court.md](docs/plans/2026-10-18-evidence-court.md))

- **L3:** "Status: planned" is stale. Implementation and `CONTEXT.md` edits already exist, and there is no record of the Argon timeout or fallback.
- **L9 vs implementation:** the preselect behavior (finding 1) breaks the plan's own contract.
- **L19, L21:** it doesn't specify replace, delete confirmation, target display, or how drafts behave across in-panel selection.
- **L13:** "Unknown versions/invalid state block mutations rather than reset" has no recovery story (finding 2).
- **L27:** it requires browser verification against an isolated daemon, but none is evidenced in the tree. Treat it as unverified.

## Verdict

**Not ready for PR.** Findings 1–4 should be fixed test-first. Add tests for them and for the missing plan promises, then re-review. The notebook persistence layer needs no change beyond optionally providing a recovery hook for finding 2.
