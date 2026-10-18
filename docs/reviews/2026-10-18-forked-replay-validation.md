# Forked Replay Lab validation

Fresh branch from e007b2f; independent of PR37–41. No capture/API/dependency changes.

- Go format/vet/full suite/CLI build passed; sidecar built and Rust3 tests passed.
- Frontend36 files /512 tests passed; TypeScript/Vite build passed.
- Actual-daemon isolated Engine/Handler fixture browser: explicit2-observation Codex route, exact receipt required before newbranch,3 hypothetical steps saved, dirty refresh blocked, explicitdiscard restoredsavedtext, reload retainedbranch without verification, explicitbranchroute paired lanes, title edit saved, deleteconfirmation removed only test-createdbranch. Local preview notebook ended with0branches; live user capture/config untouched.
- Native packaged interaction untested. Full session scan unbounded; DOM bounded. Notebook storage optimistic rather than transactional, local profile scoped, no encryption guarantee.
- Independent plan review identified fullscope pairing, dirty-state transitions and bounded raw recovery; clarified plan and implemented regression coverage.
- Requested-model plan/final reviews pending known quota: Argon147h+, Sonnet5.5High resets~18:01UTC Oct18, Gemini3.1 unavailable. See Patch review-unavailable evidence at immutable26ff2a04c4ffa4448ad7109063b5c16332efe51a. No duplicate retries before known reset; not approval. Draft until required external gate completed.

## TDD

# Forked Replay Lab storage and route TDD
Worktree: isolated codex/forked-replay-prototype worktree
Owned files: ui/replay/notebook.ts, notebook.test.ts, model.ts, model.test.ts.

1. Storage tests first: empty/valid roundtrip, strict fields and limits, corrupted/future/oversize read-only retention, optimistic token conflict/refresh, unavailable storage and quota failure, no mutation or payload persistence.
   RED `pnpm -C apps/tauri-desktop exec vitest run src/ui/replay/notebook.test.ts --no-file-parallelism`: missing notebook module.
   Implemented exact allowlist validation, reference/text limits, 1–12 steps, UTF-8 512KiB budget, unique IDs, read-only fallback and optimistic save checks. GREEN 5 tests (706ms total).
2. Route tests first: actual Score 101-event captured session, exact source/session isolation, duplicated/conflicting IDs, missing IDs, invalid clocks retained last, deterministic tie ordering, object property-order equivalence and input immutability. Negative cases explicitly normalized-contract mutations, not raw adapter fixtures.
   RED model test: missing model module.
   Implemented pure normalization. GREEN 9 combined tests (485ms total).
3. Added regression for sparse steps: RED saved sparse array claimed success while JSON became invalid null entries. Save now validates serialized representation before write. Also tested exact legal field maxima, multibyte byte budget, malformed required types and preservation of exact references.
   GREEN final targeted: 2 files / 12 tests passed, 533ms total. `pnpm -C apps/tauri-desktop exec tsc --noEmit`: exit 0 on final run; earlier concurrent integration lacked ui/replay entrypoint, subsequently resolved.

Read failures return empty book/read-only and retain raw token if available. Saves never reset corrupted/future documents even with matching token. All annotations are user text plus exact reference fields; no captured payload fields allowed. No mutation and no atomic cross-window guarantee beyond synchronous optimistic token check; Storage.setItem normal atomic failure behavior assumed. Model duplicates count extra records; conflicts count excluded captured IDs; invalidTimes count surviving unique undated receipts.

# Forked Replay UI TDD

Worktree isolated codex/forked-replay-prototype worktree.

Initial4 interaction tests written before module implementation (/tmp/firehose-replay-ui-red.log). Read-only recovery bounded-prefix test failed before implementation (/tmp/firehose-replay-recovery-red.log). Final10 panel tests pass (/tmp/firehose-replay-ui-green.log), tsc --noEmit passes.

Coverage: choices nohistoryfanout; exact timeline and captured receipt identity gating; identity-only manual annotation persistence; immediately-dirty new editor; dirty text survives source changes/navigation/refresh/conflicts; explicit discard restores saved or closes new; dirty replacement refused; failed save/delete retains fields; saved branch reopening no verification/history; explicit branch route missing-anchor status; different source with same captured ID never pairs alternative/anchor; bounded read-only token recovery (65536 chars withtotal/truncation, no reread/reset); pending receipt cancellation and mismatch;20branch/40route paging; local search and escaped titles; UUID failure and blank-step rejection.

UI imports notebook/model seams independently, only verified current receipts enable New hypothetical branch. Immutable reference copied into unsaved editor; later scope changes preserve text but never map it against other scope. Notebook refresh refuses dirty overwrite; optimistic writes keep prior token/state on failure. Initial test-first checkpoint (before implementation commits).

Map red on absent module then2 tests green:20captured window centered onexactanchor,12hypothetical steps cap, safe text, missinganchor disclosure and callbacks.

Independent spec and standards reviews PASS ondbbab7f with no findings. They do not substitute for requested external-model review; draft gate remains.
