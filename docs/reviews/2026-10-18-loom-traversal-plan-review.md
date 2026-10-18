# Loom traversal plan review

Claude Sonnet5.5 High, read-only. User-requested fallback after substantive Argon quota exhaustion earlier this day.

**Verdict: not PASS.** I found 3 blocking gaps, 5 should-fix gaps and a few minor ones. I read the plan and `apps/tauri-desktop/src/ui/loom/*`. I ran no tests and made no edits.

## Blocking (resolve in the plan before building)

1. **"Both" direction is undefined, and the existing test contradicts a plain reading of the plan.**
   - `traversal.test.ts:16` is untracked and has no plan counterpart. It expects `both` to be upstream ∪ downstream run as two independent directed walks. A sibling of an ancestor must not appear, so `sibling` is absent at depth 2.
   - The plan only says "both directions" and "shortest reference distance". An implementer could reasonably do an undirected BFS, which would pull in `sibling`.
   - State this explicitly. Also say how depth and distance combine when a cycle reaches the same group via both directions (minimum, per the plan's wording).

2. **"Terminal evidence" for missing and conflicting references is ambiguous.**
   - The plan doesn't say which endpoint is "adjacent". It doesn't say whether the terminal edge and its far endpoint group are included in the output, or whether that inclusion is allowed one step past the depth limit.
   - It also doesn't say whether an edge between two visited groups that wasn't traversed is emitted. A 3-cycle cut at depth 2 is an example.
   - `buildLoom` marks every parent of a multi-parent child as `conflicting` (`model.ts:70`). Walking downstream from one of those parents would therefore stop at an edge that isn't itself the conflict. The tests should pin this.
   - Define the rule as: emit an edge if at least one endpoint was reached over resolved edges within depth, and never expand through a non-resolved edge.

3. **The return shape and the one-hop equivalence aren't specified.**
   - The plan doesn't give the signature or return type of `loomTraversal`. It also doesn't say whether `loomNeighborhood` becomes `loomTraversal(model, id, "both", 1)` or stays as a separate function.
   - `loomNeighborhood` includes all of the focus's identifier groups: call, turn, prompt, trace and request, not only message groups.
   - It's unspecified whether `upstream` and `downstream` modes keep those groups.
   - "Preserve all one-hop tests" needs that equivalence stated, including the `{groups: [], parents: []}` result for an absent focus.

## Should fix

4. **Hop distance is computed but never shown.**
   - Output stays in model order, which is lexicographic on `JSON.stringify([kind, id])`. At depth 4 the user sees groups with no indication of which hop or direction each one is.
   - There is also no signal that the walk was cut off by the depth limit while more resolved references exist. A user can't tell "chain ended" from "stopped at depth".
   - "Label direction/depth" covers the controls only.
   - Either expose per-group and per-reference distance and direction and render them, or add a "N further resolved references beyond depth" count. Without one of these, the evidence claim is weak.

5. **The map degrades at depth greater than 1.**
   - `renderLoomMap` draws an arrow only if both endpoints are in the current 20-group page. It also applies the 20-reference page slice first (`map.ts:9`, `index.ts:43`).
   - Groups are paged in lexicographic key order, not distance order. Beyond 20 groups, most arrows will be clipped ("0 of N parent references shown"), which defeats the feature.
   - The plan has no map change, no distance-aware ordering and no test for this.
   - The copy "One-hop native neighborhood… No recursive traversal" at `index.ts:42` also becomes false and must be rewritten. The plan doesn't list it.

6. **No scale or perf gate.**
   - Today's `loomNeighborhood` is O(groups × members). `drawGroups` re-runs it on every page click.
   - Traversal that rescans `model.parents` per frontier would be O(P × depth) per redraw. A 10k-child fork at depth 4 is the worst case.
   - The plan should require adjacency maps built once, or a memoized result per (focus, direction, depth). It should also add a 10k-fan-out test, like the existing 10k test.

7. **Option-reset semantics have gaps.**
   - `clearFocus()` is also called from the search, errors and observation-pager paths (`index.ts:34,122`). The new options must not be reset there. Nor should any state living in `clearFocus` clear them.
   - The plan says "cancel any pending receipt", but `cancelReceipt()` also wipes an already-completed receipt (`index.ts:15`). Pick one behaviour and test it.
   - Clicking "Load relationships" again calls `clearScope`, so it resets the options. The plan should state that on purpose.
   - Programmatic reset to defaults must also write the select DOM values. State the single source of truth: DOM value or variable.
   - The plan should test that `membersRegion` is cleared on an option change, not just `selectedGroup`.

8. **Clamp edge cases are unspecified.**
   - Does `Infinity` default to 1 (as the plan's "nonfinite defaults 1" implies) or clamp to 4?
   - What happens to 2.5, 0, negatives, and an invalid direction string?
   - Pin all of these in the unit tests.

## Minor

9. **Test and evidence coverage.**
   - The plan lists fixtures but not the cases that bite: self-reference at depth, a cycle that closes back to the focus, a fork under a conflicting child, a missing parent mid-chain, a focus with zero message group (a call-only receipt), and a diamond under `both`.
   - The `row()` helper in `traversal.test.ts` also inherits `upstream_event_id` from the fixture. That inflates `unsupportedParents`, which is harmless but easy to assert wrongly.

10. **"Resolved" is looser than the plan implies.**
    - `buildLoom` marks a parent `resolved` if any event carries that `message_id`, including a tool receipt, not only a `message.updated` (`model.ts:70`). So "resolved" means "a receipt carries this message_id".
    - Traversal will walk through such parents. The caveat copy should say so, or the plan should accept it explicitly.

11. **Session history may be truncated.** `sessionEvents(..., "correlation")` has no visible bound here. If the daemon ever caps it, "missing" at depth could be a window artifact. The existing "not proof of capture loss" copy covers this, and the plan could reference it.

12. **Review-quota note.** The plan's gate text says "Requested Argon4 High if substantive access is available, otherwise Sonnet5.5 High". Argon quota is exhausted today, so record that the fallback was used and make that plan review the artifact.

## Disposition

Plan ambiguities resolved in the plan-review decisions. Both means undirected and includes sibling paths; the earlier assertion that the test omitted siblings was incorrect. Cache keyed by model/focus/options, wrapper delegation,10k fan-out, page/member reset and option-preservation tests added. Final wording notes corrected. Cache reuse verified by static review, avoiding implementation-coupled spy tests. Temporary preview helper removed. Independent spec and standards follow-ups PASS at329a1a0.
