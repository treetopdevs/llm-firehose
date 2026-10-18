# Handoff Subway validation

Code under review: `048a803` from main `e007b2f`. Independent branch; Evidence Court PR #37 remains unmerged and its implementation is not included.

## TDD and local gates

- Model: initial missing-module failure, then 28 persistence/derivation tests passed. Covers shape/version/limits, copies, conflicts, quota, duplicate pairs, identity consistency and deterministic grouping.
- Panel: real existing captured Score fixture endpoints; 9 tests cover explicit lookups/save, recent picker bounds, stale responses, identity mismatch, storage failure/recovery, confirmation, pagination and navigation refresh.
- Map: initial missing-module failure, then 2 tests passed. Actual browser found station dot obscuring arrow; a failing geometry regression preceded the fix, bringing map tests to 3.
- Full frontend suite: 528 tests across 35 files passed, followed by TypeScript/Vite production build.
- Go format output empty, vet/full tests passed; CLI build passed.
- Sidecar built before Rust tests: all 3 passed. No packaged native interaction or release/signing claim.

## Actual-daemon browser evidence

Used an isolated temporary spool and the existing real-captured sanitized Score fixtures, through the actual daemon Handler on localhost4630 and Vite localhost1420. No live capture service, hooks, user spool or privacy settings changed.

Created one explicitly synthetic manual annotation between `c5089b7d2673ba045c26b47175717f12` and `4572dfa2e2a3386cb8001acb0c545920` in different captured sessions. Verified full endpoint JSON, target direction, save, persistence after reload, transit map, visible arrowhead after fix, saved receipt re-fetch, exact Score navigation, bounded recent picker and cancel removal. Then confirmed removal of that test annotation and closed the preview. The fixture daemon and Vite were stopped.

[Preview](2026-10-18-handoff-subway-preview.jpg). The captured events are real fixtures; the annotated transfer is a test user's hypothesis, not captured evidence of a transfer.

## Review gates

Argon 4 High plan review timed out after120 seconds without verdict. Claude Sonnet5.5 High fallback hit account quota (RESOURCE_EXHAUSTED, reported reset about2h18m) before verdict. Neither is approval. A bounded Argon final review and independent standards/spec reviews are tracked separately. PR must remain draft until requested model review completes and actionable findings are fixed.

Hosted checks are tracked on the PR, not inferred from local tests. Main merge remains human-approved.

## Independent reviews of 048a803

Standards reviewer: PASS (static read-only). Confirmed local-only identity/label persistence, frozen surfaces unchanged, strict state validation, honest conflict/error semantics, cancelled/versioned requests, accessible controls and textual equivalent to map. No actionable Fowler-style design smell at this scope.

Spec reviewer: P2 — recent picker included synthetic stream-only `state.transition` frames from FeedState. Those are not stored receipts and can displace captured observations from the latest100 window. Required fix: exclude `isTransition` before limiting, with a mixed-stream regression. All other inspected plan requirements passed. Remediation tracked below.

## Remediation e32cd52

Excluded synthetic transitions before the latest100 window. Regression failed before fix, then10 panel tests and TypeScript passed; full frontend suite now529 tests across35 files and production build passed. Independent spec reviewer rechecked e32cd52: PASS, P2 resolved, no new issues. Standards review remains applicable to unchanged persistence/contracts.
