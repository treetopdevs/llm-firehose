# Loop Observatory: compare captured sequences

Base: latest origin/main e007b2f (PR36). Fresh worktree codex/loop-sequence-comparison. Existing unmerged prototypes remain separate. User delegated routine design and test-seam decisions.

## Outcome

Extend the existing Loop Observatory beyond category totals: choose two consecutive-occurrence intervals of the same Error Signature, see which recorded activity runs match or differ, and inspect the captured observations behind each run. This advances the brainstorm's read/edit/test/fail comparison without inventing a strategy classifier from reduced payloads.

## Contract

- Use the existing scoped, sorted, deduplicated Loop model. An interval excludes its first recurrence and includes the next. Existing timestamp ordering and fallback membership disclosures remain visible; no new chronology or causal claim.
- Tokens are exact source + category + event.name, with an explicit empty-name label. Adjacent equal tokens become one run with exact count and ordered event references. Do not classify reads, edits, tests, successful work, attempts or strategies from names or absent payloads. Different source/category/name/count means a different run.
- Compare one selected interval against another numbered interval from the SAME active signature. Selection resets on source/session/signature change, load/refresh and incompatible late membership changes. With only one interval show why comparison needs a third occurrence.
- Deterministic longest-common-subsequence alignment of complete runs when both have at most200 runs; each matrix at most201x201. Tie-break consistently. Equality is exact for all runs, including counts; no percentage score, fuzzy matching or outcome inference.
- If either exceeds200 runs, disclose alignment unavailable; show both complete sequences via pagination without prefix-based equality claims. Total sequence memory scales with the two selected intervals, not all interval pairs. No automatic pairwise comparison or session fanout.
- Render at most40 aligned rows or40 runs per side at once. Each run permits opening an accessible paginated list of its observations (40/page), and explicit receipt lookup uses the existing cancellation/identity guards. Never fetch details merely to compute a comparison. Captured labels use textContent.
- Label matching as same recorded source/category/name/count only. Differences may reflect capture gaps, duplicate start/end observations or tool-name changes. Repeated strategy, retry, content changes and success remain unknown. All-source scope retains source identity in every token.
- No new API, dependency, persistence, capture behavior or frozen contract change.

## Seams and test-first acceptance

Exported pure run/alignment derivation and observable Loops DOM/API are the delegated public seams. Use real Score/Error Signature fixtures, and clearly labelled normalized contract mutations for multi-interval and boundary cases (never invented raw adapter fixtures). Vertical red→green tests cover interval boundaries; ordered repeated runs; exact count/source/name distinctions; deterministic insert/remove alignment; empty sequences;200/201 run cutoff; no mutation; same-signature selection; one-interval notice; pagination to every run/observation; explicit receipt lookup; reset and stale response guards.

## Gates

Requested-model adversarial plan review then implementation; code review with independent spec/standards agents plus requested-model final review; fix and re-review. Argon4/Gemini3.1 unavailable through current capability/quota evidence; use user-authorized direct Claude CLI Sonnet5.5 High fallback. Full Go formatting/vet/tests/CLI; frontend tests/build; sidecar then Rust tests; isolated actual-daemon browser check; commit, PR and hosted CI/review follow-up. Main merge remains human-approved. Record all decisions and actual evidence in HTML coordination log.
