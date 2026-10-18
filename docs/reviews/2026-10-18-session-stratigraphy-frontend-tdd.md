# Session Stratigraphy frontend TDD evidence

Worktree: branch codex/session-stratigraphy-prototype

1. API client URL/abort test failed (`errorSignatureSessions is not a function`) before implementation. Log /tmp/firehose-strata-api-red.log.
2. Rendered panel tests written before module existed; import resolution failed. Log /tmp/firehose-strata-panel-red.log. Fixtures import existing real score/fixture.errsig.json; aggregate response metadata is synthetic test state.
3. Empty later-page regression test failed (`51–3 of 3` impossible range); corrected pager. Log /tmp/firehose-strata-empty-red.log.
4. Final targeted run: src/api.test.ts (4 tests) and src/ui/strata/index.test.ts (8 tests), 12 total passing. `pnpm exec tsc --noEmit` passed.

Observable tests cover API URL encoding and AbortSignal forwarding; no session fanout until explicit selection; global/local count language; source/text filters; 50-signature page bound; server paging; cancellation and stale fences across selection/filter/refresh; newer evidence wins; mismatched event scope does not render; old daemon notice; unavailable/empty states; escaped text; Loop/Score scoped navigation.

Decisions: signature selection is explicit (no automatic per-session fetch). Time strips have shared axis per visible page, labeled first-to-last observations only; uniform row heights. Each new snapshot resets owned evidence. No use of shared detail pane. Empty pages retain previous/refresh navigation. All event-derived content uses DOM text nodes.

5. Browser-identified indistinguishable error summaries: real captured rate_limit/authentication_failed examples produced identical signature buttons. Regression test failed before fix (/tmp/firehose-strata-identity-red.log). Buttons and selected heading now display authoritative key alongside sample, ensuring identity differences are readable and accessible. Final run now 13 tests passing + tsc.

6. Initial Sonnet review findings 6–8: navigation retention and explicit 404 ambiguity regression tests failed before fixes (/tmp/firehose-strata-review-red.log). New activate() preserves completed or pending historical snapshot on panel return; explicit refresh still cancels requests and resets scope. 404 explains older daemon OR signature missing from current projection. Removed nested pager styling. Full serial frontend suite: 32 files, 488 tests passing (/tmp/firehose-strata-frontend-full.log). Production build (tsc + vite) passed (/tmp/firehose-strata-frontend-build.log).

Lifecycle decision: bounded in-flight requests may complete while this panel is hidden, matching existing panel conventions. Returning retains fetched-at timestamp and selected historical page; this is not live-refresh semantics. No new hide/dispose lifecycle or background polling introduced.
