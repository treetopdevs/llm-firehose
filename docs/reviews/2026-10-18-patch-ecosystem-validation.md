# Patch Ecosystem validation

Base e007b2f; independent of unmerged PR37–40.

- Full frontend35 files /511 tests passed; TypeScript/Vite production build passed.
- Go format/vet/full suite/CLI build passed; sidecar built and Rust3 tests passed.
- Argon4 High bounded plan review PASS; implementation review pending.
- Actual daemon Engine+Handler isolated fixture spool:101 captured session events include20 file observations across4 beds. Browser verified exact load, stable beds at cursor1, distinct attempts/completions, explicit file chronology and receipt lookup, correct101-event Score scope. No user config/adapters/filesystem mutated; native packaged interaction untested.

## TDD

# Patch Ecosystem model TDD
Worktree: /Users/nicholas/.codex/worktrees/patch-ecosystem-prototype/llm-firehose
Owned files: apps/tauri-desktop/src/ui/ecosystem/model.ts and model.test.ts.

1. Added six tests before implementation using the actual 101-event Score session and existing internal/capture/testdata/activity_real_shapes.ndjson receipts (README records capture provenance). Covered true file observations, exact scope/workspace separation, duplicate/conflicting IDs, undated exclusion, stable replay beds and actual Codex changes-map/patch-text behavior.
   - RED: `pnpm -C apps/tauri-desktop exec vitest run src/ui/ecosystem/model.test.ts --no-file-parallelism`: missing ./model.
   - Implemented pure model, conservative stage classification and prefix replay.
   - GREEN: 6 tests passed, 534ms total.
2. Added coverage over documented normalized envelope contract mutations (not invented raw adapter payloads): multi-key changes map, digest object exclusion, path field precedence, workspace prefixes, failed/attempt/complete/unknown stages, deterministic tie order, cursor bounds and mutation isolation. Actual Codex phase=start/status=completed receipt verifies attempt precedence. Added 10k fixture-derived observations, exact counts and stable replay prefix with no timing threshold.
   - GREEN: 12 tests passed, 310ms total / 80ms tests.
3. `pnpm -C apps/tauri-desktop exec tsc --noEmit`: exit 0.

Counters apply only after exact source/session and file-category filtering, per parent decision. duplicates counts additional copies; conflicts counts unique captured IDs excluded entirely; missingIds counts missing-ID file records; missingPaths counts surviving unique file observations without usable path, including undated. Undated never enters temporal beds/replay. Dated unknown-path observations remain cursor-accessible. Paths mirror projection.EventFilePaths; no patch text parsing or path normalization. Workspace is first nonempty prefixed worktree_id/cwd/repo_id/repo, else unknown.

# Patch Ecosystem panel TDD

Worktree /Users/nicholas/.codex/worktrees/patch-ecosystem-prototype/llm-firehose.

First4 DOM/API tests written before implementation (missing module red /tmp/firehose-patch-ui-red.log). Parent map and model integrated; nine panel tests passing (/tmp/firehose-patch-ui-green.log), tsc --noEmit passes.

Coverage: choices no fanout, full session explicit view=undefined + AbortSignal, exact receipt/source/session/Score, replay zero/end/250ms step/stop/deactivation and selection pause, stable bed page membership across replay and local filters, scoped history cancellation, dated unknown-path and undated excluded growth paths, receipt mismatch/stale cursor guard, bounded40-member paging, safe path text and focus reveal, failed reload removes old snapshot, choice failure permits manual scope.

Data shapes use existing real Score file fixture; repeated/copied normalized records test volume and state (no new raw adapter fixtures). Replay-visible prefix drives dated growth and unknown-path receipts; undated stays separately accessible. Beds filter/paginate against stable complete bed set, replay retains empty beds. Full JSON fetched only after explicit receipt action despite already-loaded full session metadata. Load/replay/filter/page/focus/deactivation cancel obsolete receipt and stop playback as appropriate. Choice refresh never implicitly reloads file history. Labels say dated file observations and disclose full history transfer/unbounded server scan, noncanonical paths, no reversion/content proof. No commits.


Map red on missing module, green2 bounded/safe/selectable tests after implementation.
