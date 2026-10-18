# Loom traversal final review

Claude Sonnet5.5 High, read-only. User-requested fallback after substantive Argon quota exhaustion earlier this day.

**Verdict: PASS, with no blocking defects.** I read `d2c4488..HEAD` statically. I ran no tests, builds or network, and I made no edits.

**Checked and holding**
- **Direction** (`model.ts:87-109`): upstream follows child→parent and downstream follows parent→child. `both` is undirected, so it reaches siblings through a shared parent, as the plan now says.
- **Depth:**
  - A hop is a reference, not receipt membership. Edges and far endpoints are added only from a frontier at distance below the limit.
  - Fractional depths floor, finite depths clamp to 1–4, and nonfinite values (including `Infinity`) default to 1, as the plan says.
  - An absent focus returns empty arrays.
- **Cycles and shortest distance:** the visited set is filled only after each hop, so expansion is breadth-first and terminates on cycles. I traced the 6-cycle test by hand: 6 edges at depth 4, and `a` downstream gives `[a..e]`.
- **Terminal references:** missing and conflicting edges are shown but never enter `next`. A missing placeholder group cannot be in the frontier. The foreign-scope test confirms a foreign `x` stays missing.
- **Seeding:** traversal starts only from the focus event's own groups. Non-message groups touch no references, so membership never bridges to other message groups.
- **UI lifecycle:**
  - Both selects live outside `groupsRegion`, so a redraw doesn't steal focus.
  - `changeTraversal` calls `cancelReceipt()`, which bumps the receipt version, aborts the request and clears completed evidence. It also resets all three pages and the selected group, and fetches nothing.
  - The cache is keyed on model, focus id, direction and depth, and `clearFocus` drops it.
  - `clearScope` resets the options and `selectFocus` preserves them, as the plan says.
- **Plan claims:** the 10k fan-out, reset/paging, abort and late-response tests exist and match the plan. The static caveats match the code. The new D88 HTML link resolves, since the HTML and the plan are both in `docs/plans/`.

**Non-blocking findings**
1. **Misleading test title** (`traversal.test.ts:11`): "…without crossing sibling branches" contradicts its own expectations. `b` downstream and `c` both/2 do include `sibling`, which is what the plan decision says. That title probably caused the earlier review's wrong claim. Rename it to something like "…siblings are reached only by undirected (`both`) traversal; upstream and downstream stay directed".
2. **Preservation is untested.** The plan says focus, search, errors and paging preserve direction and depth, but no test selects a non-default option and then changes focus, search, errors or observation page. The `choices` select resetting the options is also untested. Only the `Source` input reset is covered. A regression that resets the options in `clearFocus` or `selectFocus` would pass.
3. **Cache is unverified.** The plan's "pagination does not rescan" has no test. A spy on `loomTraversal` across a pager click would pin it.
4. **Grammar and wording:** "maximum 1 reference hops" (`index.ts:48`). The "siblings through a shared parent" sentence shows in upstream and downstream modes, where it doesn't apply.
5. **Housekeeping:** `cmd/loom-preview/` is untracked and outside the range. If it supports the "isolated fixtures" browser proof, it isn't reproducible from the commits, so keep it out of the PR or commit it deliberately.

I couldn't verify the HTML's external claim that PR43's platform checks were green at `4479455`.

## Disposition

Plan ambiguities resolved in the plan-review decisions. Both means undirected and includes sibling paths; the earlier assertion that the test omitted siblings was incorrect. Cache keyed by model/focus/options, wrapper delegation,10k fan-out, page/member reset and option-preservation tests added. Final wording notes corrected. Cache reuse verified by static review, avoiding implementation-coupled spy tests. Temporary preview helper removed. Independent spec and standards follow-ups PASS at329a1a0.
