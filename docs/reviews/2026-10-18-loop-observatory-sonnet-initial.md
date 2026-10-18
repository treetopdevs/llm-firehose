# Loop Observatory: initial adversarial review

Reviewer: `agy --model claude-sonnet-5-5-high --effort high`, fallback after Argon 4 High timed out. Scope: plan and in-progress implementation. This verdict predates the fixes listed in the coordination journal.

I'll start by reading the plan and the two implementation files.
Next I'll check the helpers the model depends on. They are the signature identity functions and the `sessionEvents` and `errorSignatures` API semantics.
**Verdict: not PASS.** I found four actionable issues and two minor ones. I read the files and a few helpers only. I edited nothing and ran no tests.

**Medium**
1. **Source change during loading or after a failure shows a false "empty" state.** [index.ts:170](../../apps/tauri-desktop/src/ui/loops/index.ts#L170) and [index.ts:128](../../apps/tauri-desktop/src/ui/loops/index.ts#L128).
   - `open()` sets `events = []`, but the source `<select>` stays live.
   - A `change` event then calls `derive()`, which draws "No captured events in this session and source." That overwrites the Loading message or the "History unavailable" alert and Retry button.
   - **Fix:** add a `phase: "idle" | "loading" | "error" | "ready"` variable. Make `derive()` and `draw()` act only in `ready`, and disable both selects while loading.
2. **Events dropped by the model are not disclosed.** [model.ts:13-17](../../apps/tauri-desktop/src/ui/loops/model.ts#L13-L17) and [index.ts:89](../../apps/tauri-desktop/src/ui/loops/index.ts#L89).
   - Events with unparseable times, duplicate ids and wrong-session or wrong-source events vanish silently.
   - The "N captured events in this snapshot" line counts only the survivors. An error observation with a bad timestamp silently reduces a signature's recurrence count.
   - **Fix:** return `excluded: {invalidTime, duplicate}` from `buildLoops` and show it. When it is non-zero, say recurrence counts may be understated.

**Low**
3. **Sort cost.** [model.ts:17](../../apps/tauri-desktop/src/ui/loops/model.ts#L17) calls `Date.parse` twice per comparison, about 2·N·log N parses. Parse once into `{e, t}` pairs, sort those, then map back. Reuse `t` at lines 14, 40 and 80 as well.
4. **Fallback count covers hidden observations.** [model.ts:28](../../apps/tauri-desktop/src/ui/loops/model.ts#L28) increments `fallbackCount` for every error observation, including signatures with fewer than two occurrences that are filtered out at line 45. The disclosure can therefore describe events the user never sees. A group can also mix authoritative and fallback occurrences with no per-group indication. **Fix:** count it per group (`fallbackOccurrences`) after the filter, and show it per selected signature.
5. **Late signature arrival discards the user's selection.** [index.ts:147](../../apps/tauri-desktop/src/ui/loops/index.ts#L147) unconditionally resets `activeKey`, `interval` and the pages. This wipes an interval the user is already comparing, without telling them. **Fix:** keep `activeKey` and `interval` if the group key still exists (re-resolve the interval by `from.id`/`to.id`). Reset only when the group is gone.
6. **Interval evidence can't be paged, and the notice overstates access.** [index.ts:121-123](../../apps/tauri-desktop/src/ui/loops/index.ts#L121-L123) shows only the first 40 events after `from`. The text says "endpoints remain accessible above", but the `to` occurrence can be on another occurrence page. Events 41 to n−1 are unreachable. The plan says "paginate or cap with explicit notice", so the cap is allowed. **Fix:** add the existing `pager` for the evidence list, or reword the notice to say the remaining events are not shown.

**Notes (no change required)**
- [api.ts:137](../../apps/tauri-desktop/src/api.ts#L137): `sessionEvents` has no `AbortSignal`. The `version` guard keeps the UI correct, but superseded loads still download. Adding a `signal` parameter would let `open()` abort them.
- [model.ts:17](../../apps/tauri-desktop/src/ui/loops/model.ts#L17): `Date.parse` truncates to milliseconds. Events within the same millisecond fall back to id order, which matches the plan but isn't true capture order. The interval counts at `i+1` / `before+1` are correct against the "strictly after first through second" rule.
