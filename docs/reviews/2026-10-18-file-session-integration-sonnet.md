# Scoped Files integration review

Reviewer: Claude Sonnet 5.5, high effort. Range: 1f19035..b0062bd. Static read-only review.

**Result: PASS for code and shared-surface integration.** I found no new runtime or API regressions in `1f19035..b0062bd`. There are two low-severity documentation gaps, and the build and test gates are unverified here. This was a static read only. I made no edits, ran no tests, made no network calls and delegated nothing.

### What I checked (static proof)
- **Merge resolution, navigation and lifecycle:**
  - `main.ts` `show()` keeps every prior cleanup: court refresh, handoffs refresh, airspace/loom/ecosystem/replay `deactivate`, and the detail-pane clears for court/loom/ecosystem/replay/handoffs/airspace.
  - The merge adds only `if (active === "files" && name !== "files") panels.files.deactivate()`, which is the right place for it.
  - `panels` still holds every prior key (`loops`, `strata`, `court`, `handoffs`, `airspace`, `loom`, `ecosystem`, `replay`) plus `files`.
  - `files.deactivate` aborts both the list and detail controllers (`files.ts:83-86`), and `refresh` re-enters through `deactivate` (`files.ts:289`).
  - `files.ts` never uses the shared detail pane, so Files correctly doesn't clear it.
- **Main tests:** `main.test.ts` keeps the Loom "closes and empties shared detail pane" test and adds "leaving Files aborts its pending history request". Both are syntactically intact, and the shared `afterEach` resets modules.
- **Correlation metadata and accessor:**
  - `CorrelationView` and the `?view=correlation` handling in `endpoints.go:54` are intact.
  - `FileSession` and `Engine.FileSessions()` are added next to them in `history.go`.
  - `foldFileSession` runs inside `ApplyResult`, after duplicate admission and before the legacy `ix.files` fold.
  - The projection is rebuilt through `New()`, which initialises the new map, so no reset path misses it.
  - `build_equivalence_test.go` includes `fileSessions`.
  - `/artifacts/files` and its shape are unchanged.
- **Other API and client paths:**
  - The new route is wired once (`daemon.go:131`).
  - The `files()` signature change is backward-compatible (optional `signal`).
  - Files classes reuse existing CSS (`.files-table`), so there are no style collisions.
- **No leftovers:** there are no conflict markers anywhere. `docs/contracts.md`, `capture-engine.md` and the backlog HTML are purely additive against `1f19035` (the one link-path tweak still resolves). The decision IDs D01–D74 are all present, with D71–D74 added.
- **Prior prototypes retained:** the diff has no deletions in shared code.

### Findings (both low, documentation only)
1. **The API route table omits the new endpoint.** `docs/contracts.md:155-170` lists `/errors` and `/errors/sessions` as rows but has no `GET /artifacts/file-sessions` row. It is documented only in the section at `:479`. The `CLAUDE.md` route list also doesn't mention it. This is inconsistent, not wrong.
2. **The journal for this merge is not committed.** `git status` now shows uncommitted edits to `docs/reviews/2026-10-18-prototype-integration-validation.md` and `docs/plans/2026-10-18-prototype-coverage.html`. They add the "Scoped Files integration checkpoint — b0062bd" and the PR #46 and 720-test updates.
   - At `b0062bd` itself the validation doc's top entry is still the `94b4610` checkpoint, and the coverage HTML still calls shared-file overlap a follow-up.
   - Commit them or the integration head won't have its own evidence.
   - They claim "spec and standards reviews PASS", "720 tests across 56 files" and a green sidecar and Rust run, which I could not verify.

### Runtime gates I did not verify
- **Not run:** frontend tests and build, `gofmt`/`go vet`/`go test`, the CLI build, the sidecar and Rust tests, and a browser pass across all views. The 720-test and 56-file figures come from the uncommitted journal text, not from me.
- **Still open per D74:** the combined adversarial gates and hosted checks. The Files browser evidence is scoped to the standalone slice, not the combined head.

## Remediation

Both documentation findings resolved: contracts and CLAUDE route indexes now include the additive endpoint; updated validation, coverage and decision evidence committed with this report. Local validation was performed separately by the implementing agent, as recorded in the integration validation report. Hosted updated-head checks remain separate.
