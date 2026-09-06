# Attention inbox review and validation

Reviewed baseline: `5841aad`. Initial reviewed implementation:
`631970d460d6ad59d082f0e4ca132f1ad7b29281`. The hosted-review follow-up below records later remediation. Requirements: [attention inbox plan](../plans/2026-09-06-attention-inbox.md).
Two independent read-only reviewers assessed the immutable changes; execution
results below were verified separately by the implementing agent.

## Standards report

Final result: **no remaining actionable findings**.

- Evidence lookup originally collided with the existing SSE route for event ID
  `stream`. A dedicated query endpoint, `GET /attention/event?id=...`, now preserves
  the frozen stream route and every valid captured ID, including `.` and `..`.
  HTTP and rendered interaction tests cover dot segments and reserved characters.
- Projection-only envelope validation reports invalid history without changing
  ordinary reader/export behavior.
- No remaining privacy, compatibility, dependency, or serious maintainability
  violation was identified against AGENTS.md, CLAUDE.md, and CONTRIBUTING.md.

## Spec report

Final result: **no remaining actionable findings**.

- Native source chronology controls state: an old message captured later cannot
  resolve a newer request.
- Native request/call correlation produces a stable episode identity across
  reorder and restart, preserving snoozes while evidence follows the latest update.
- Unrecorded live parse failures and startup gaps are inspectable and explicitly
  distinguished from captured evidence. Startup checks also cover valid JSON
  with invalid envelopes (`{}`, `null`, and an invalid category).
- Last observation time is tracked separately from the activity used to infer state.
- Workspace identity includes the worktree, and evidence queries preserve arbitrary
  valid IDs. No unrequested feature scope was identified.

Each behavioral remediation started with a failing regression test before its
implementation. The four original spec findings and both evidence-route findings
were re-reviewed after remediation.

## Execution evidence

On 2026-09-06 in the isolated `llm-firehose-attention-inbox` worktree, the final
implementation passed:

- `gofmt -l .` (empty), `go vet ./...`, and `go test ./...`, in that order.
- `go test -race ./internal/capture/... ./internal/daemon`.
- `go build ./cmd/firehose` and `scripts/build-sidecar.sh`.
- `pnpm -C apps/tauri-desktop test`: 129 tests across 20 files after the hosted-review follow-up.
- `pnpm -C apps/tauri-desktop build`: TypeScript and production bundle succeeded;
  Vite retains the existing large-chunk advisory.
- `cargo test --manifest-path apps/tauri-desktop/src-tauri/Cargo.toml`: three Rust
  tests passed, plus compilation and doc tests with the notification plugin.

Rendered browser checks used the real inbox component and detail pane with
isolated normalized demo data. Verified request/failure/activity ordering, exact
captured evidence, separate worktree labels, snooze counts, history/source
filtering, offline labeling, reconnect persistence, and request resolution.
No warning/error console entries were observed during that check. The temporary
fixture and development server were removed afterward; personal history and agent
settings were not used.

## Verification limits

Hosted CI results belong to the PR checks for its current head. These local gates
and independent code reviews do not establish human GitHub approval, a merged
release, signing/notarization, or visible OS notification delivery. Notification
permission and delivery boundaries are tested and native compilation passes;
installed-app presentation remains an OS-specific release check. Notifications
require the desktop app to remain open and respect OS notification settings.

## Hosted review follow-up

CodeRabbit reviewed PR #6 at `958e5a1` and raised three actionable comments.
All three were reproduced with failing public-boundary tests and remediated:

- Session history ignores stale success and error responses, including switching
  source while the native session ID remains the same.
- Exact evidence responses set `Cache-Control: no-store`, including missing-record
  responses.
- Legacy records without stable IDs become attention coverage gaps during startup
  and live reconciliation. They cannot create or resolve attention episodes. The
  fix is deliberately confined to the new inbox projection: existing session
  history, live publication, export, and admission validation retain their prior
  behavior. Engine tests verify both paths and preservation of history/export.

The notification plugins are pinned to 2.4.0 in both manifests because the awaited
native command uses the verified command payload from that version. Frozen-lockfile
frontend installation and locked Cargo tests passed. Go formatting, vet, full tests,
capture/daemon race checks, CLI/sidecar builds, all 129 frontend tests, the production
bundle, and three native Rust tests passed after these changes.

The earlier hosted run at `958e5a1` passed Go and full desktop packaging on Linux,
macOS, and Windows. The PR checks remain the authority for the subsequent head.

A second hosted review at `21ed3e4` prompted a regression proving that legacy-gap
timestamps retain the latest persisted record time across restart and reverse
chronology, plus explicit handling of test-file close errors. Its suggestion to
filter ordinary Sessions rows by their source label was declined after independent
spec review: the frozen session projection groups by native ID only and retains
the first source label. Filtering that aggregate would hide other-source events.
A rendered regression preserves both sources on ordinary row clicks; Attention
entry points continue to pass an explicit source and filter their history.
