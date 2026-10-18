# Final adversarial review

Model: Claude Sonnet 5.5 High through agy. Reviewed code commit `85444e9` against `a150daa16408e6578467ceb1d196cb07022751b2`. Subsequent evidence-only documentation does not change reviewed code.

I'll start by scoping the diff and reading the plan and the prior review.
**Verdict: PASS.** I found no concrete correctness, evidence, performance or async defects that should block the commit. This was read-only, so I made no edits and ran no tests. The `/plan` workflow didn't apply because there are no code changes to approve.

## Prior six findings (sonnet-initial)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 1 | Source change during loading or error shows a false "empty" state | **Fixed** | `phase` guards `draw` ([index.ts:90](../../apps/tauri-desktop/src/ui/loops/index.ts#L90)) and `derive` ([index.ts:137](../../apps/tauri-desktop/src/ui/loops/index.ts#L137)). The source select is disabled outside `ready` ([index.ts:160](../../apps/tauri-desktop/src/ui/loops/index.ts#L160), [index.ts:181](../../apps/tauri-desktop/src/ui/loops/index.ts#L181)). The change handler returns unless `phase === "ready"` ([index.ts:203](../../apps/tauri-desktop/src/ui/loops/index.ts#L203)). |
| 2 | Dropped events not disclosed | **Fixed** | `excluded.invalidTime` and `excluded.duplicate` are counted in [model.ts:13-19](../../apps/tauri-desktop/src/ui/loops/model.ts#L13-L19) and shown at [index.ts:97-98](../../apps/tauri-desktop/src/ui/loops/index.ts#L97-L98). |
| 3 | `Date.parse` called per sort comparison | **Fixed** | Timestamps are parsed once into `{event, at}` ([model.ts:14-23](../../apps/tauri-desktop/src/ui/loops/model.ts#L14-L23)). `elapsedMs` reuses `timed[i].at` ([model.ts:48](../../apps/tauri-desktop/src/ui/loops/model.ts#L48)). Interval counts come from prefix sums, so they stay linear. |
| 4 | Fallback count covers hidden observations | **Fixed, as the plan intends** | Each group now has `fallbackOccurrences` ([model.ts:39](../../apps/tauri-desktop/src/ui/loops/model.ts#L39)), shown per selected signature ([index.ts:111](../../apps/tauri-desktop/src/ui/loops/index.ts#L111)). The overall `fallbackCount` ([model.ts:35](../../apps/tauri-desktop/src/ui/loops/model.ts#L35)) still includes signatures hidden by the two-occurrence filter. Its wording ("error observations across this loaded session/source", [index.ts:95](../../apps/tauri-desktop/src/ui/loops/index.ts#L95)) is accurate. |
| 5 | Late signature arrival discards the selection | **Fixed** | `derive` keeps `activeKey` while its group exists and re-resolves the interval by `from.id`/`to.id` ([index.ts:139-148](../../apps/tauri-desktop/src/ui/loops/index.ts#L139-L148)). It resets only when the group or interval is gone. |
| 6 | Interval evidence can't be paged | **Fixed** | Evidence is paged with `evidencePage` ([index.ts:128-132](../../apps/tauri-desktop/src/ui/loops/index.ts#L128-L132)). The slice bounds and the total `n = toIndex - fromIndex` match the "strictly after first through second" rule. |

The optional `AbortSignal` on `sessionEvents` ([api.ts:137](../../apps/tauri-desktop/src/api.ts#L137)) is wired through `getJSON` and aborted on session switch, reset and failure.

## Non-blocking nits

- [index.ts:92](../../apps/tauri-desktop/src/ui/loops/index.ts#L92): the "Choose a session" early return skips `restore()`. This is harmless, because focus restore matters only in the other branches.
- [index.ts:51](../../apps/tauri-desktop/src/ui/loops/index.ts#L51): after clicking the last "Next" page button, `keepFocus` tries to refocus a button that is now disabled. Keyboard focus falls to `body`.
- [index.ts:204](../../apps/tauri-desktop/src/ui/loops/index.ts#L204): "Refresh history" re-runs `open()`, which resets the active signature and interval. The late-signature path preserves them, but a manual refresh does not. This looks intentional, since it is a new snapshot.
- [index.ts:169](../../apps/tauri-desktop/src/ui/loops/index.ts#L169): the 4-second signature timeout runs from `open()`, so a slow spool scan can force fallback identity. This is disclosed in the UI as "Signature lookup unavailable".
- [index.ts:97](../../apps/tauri-desktop/src/ui/loops/index.ts#L97): the invalid-time count includes non-error events, which can also skew interval category counts. The word "may" in the disclosure covers this.

## Scope and limitations

- **Read:** the full diff stat for 85444e9 against a150daa, the plan, the prior review, `loops/model.ts` and `loops/index.ts` in full, and the `api.ts`, `main.ts` and `sessions.ts` diffs.
- **Spot-checked:** the `styles.css` diff, `keepFocus`, `memberSignatureKeys`, `errorSignatureKey`, `getJSON`, the Tauri CSP, and the timeline endpoint ([endpoints.go:48-52](../../internal/daemon/endpoints.go#L48-L52)).
- **Not read in full:** the test files (I only listed the test names and read the TDD journal entry) and the HTML coordination log. I did not reproduce the claimed RED/GREEN results or check the #33/#34 merge claims.
- **Not verified:** runtime behavior, including the 100k-event performance claim, browser rendering, and `Date.parse` handling of nanosecond timestamps in WKWebView.
