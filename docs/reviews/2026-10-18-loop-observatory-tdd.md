# Loop Observatory test-first evidence

Branch: `codex/loop-observatory-prototype`

- Model tests added first over existing score/fixture.errsig.json real captured events. `pnpm -C apps/tauri-desktop exec vitest run src/ui/loops/model.test.ts`: RED, missing ./model. After implementation: 3 passed. Added regression checks for transitions, partial membership, distinct signatures/sources.
- DOM tests added before view: `pnpm -C apps/tauri-desktop exec vitest run src/ui/loops/index.test.ts --no-file-parallelism`: RED, missing ./index. After implementation: 4 passed. Covered explicit detail fetch, session and history races, retry/old daemon envelopes, bounded occurrence pagination.
- Sidebar test added before integration: `pnpm -C apps/tauri-desktop exec vitest run src/main.test.ts --no-file-parallelism`: RED, loops button undefined. After wiring navigation/sessions: green.
- Empty selector regression added before fix: RED, previous 2 occurrences remain after choosing placeholder. Fixed clear/reset with request invalidation; green.
- Final targeted run: `pnpm -C apps/tauri-desktop exec vitest run src/ui/loops src/main.test.ts src/ui/sessions.test.ts --no-file-parallelism`: 4 files / 32 tests passed (3.81s). Includes late detail rejection, signature failure/timeout, paging and real membership tests.
- `pnpm -C apps/tauri-desktop exec tsc --noEmit`: exit 0.
- Initial `pnpm test -- <path>` unexpectedly ran full suite; 7 timing assertions failed under concurrent load plus expected missing model suite. Do not count that run as validation; parent handles full serial suite.
- Parent requested history cancellation: added API + DOM tests first; RED both signals undefined. Added optional third client AbortSignal argument and abort on open/reset. GREEN targeted 5 files / 36 tests, typecheck exit 0.
- Sonnet review remediation: added four failing regressions first (source disabled/loading/error guard; invalid-time/duplicate accounting and group fallback; late membership preserves valid interval; interval evidence pagination). RED 4 failures / 15 passes. Added explicit phase, cached parsed timestamps, accurate exclusion disclosure, per-group fallback, preservation of surviving key/interval and paginated evidence. GREEN 19 loops tests.
- Added 100,000 fixture-derived observations with three interleaved signatures, exact occurrence/interval/category assertions (no wall-clock threshold); existing DOM test bounds occurrence rendering to 40 rows. Final targeted run: 5 files / 41 tests passed in 3.80s; tsc --noEmit exit 0. Editing settled for parent browser/whole-suite validation.
