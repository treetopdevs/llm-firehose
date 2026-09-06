# Attention inbox

Status: implemented and locally validated; independent standards and spec reviews have no remaining actionable findings. Publication and hosted CI are tracked on the PR. Test boundaries confirmed by the user on 2026-09-06. Baseline: origin/main 5841aad (includes the shipped Altitudes views).

## Outcome

A user supervising several local agents can look away, then find the session
requiring a decision and inspect the captured evidence. Preserve the shipped
Dwell, Workspace, Lanes and Orbit views; Live becomes home with a shared attention
strip visible across views. This increment delivers desktop supervision, with the
same read-only attention query available to other local clients.

## Requirements

1. Add a source + native-session scoped attention Projection and `GET /attention`
   snapshot. Rebuild it from canonical history, deduplicate captured IDs and keep
   all existing session/API/envelope/privacy/spool/export meanings unchanged.
   Include stable evidence IDs, source timestamps, observation timestamps, agent,
   privacy-processed workspace identity, derived state and last observation.
2. Track explicit permission/input requests and session failures. Keep one current
   attention episode per session. Known permission replies, later user/agent/tool
   activity, or session completion resolve it; a later distinct request creates a
   new episode. Metadata and subagent completion cannot resolve a parent request.
   Known source-native event rules only; unknown notifications are passive and
   explain uncertainty. Ordinary tool failures, successful completion and silence
   must never produce desktop alerts. Stale source-time events cannot reopen an
   already resolved episode. Retain pending requests until contrary evidence.
3. Shared attention strip reports unresolved and snoozed counts, connection state,
   and observation limitations. Inbox prioritizes unresolved requests, then explicit
   session failures, then recent active sessions. History is searchable by ordinary
   substring and scoped by source/workspace. Every row shows source, workspace,
   reason, elapsed time and an evidence action that opens the exact captured event.
   Distinguish observed events from inferred “no later resolution captured”.
4. Snooze an episode for 15 minutes and allow early unsnooze. Persist snooze and
   notification receipts locally across desktop restarts. A new episode is not
   hidden by an old snooze. Resolution removes the item from the unresolved queue.
   Persistence failures leave the inbox usable and clearly explain degraded state.
5. Desktop notifications are explicitly opt-in through a user gesture. Use the
   official Tauri notification plugin. Default messages omit captured summaries and
   paths. Notify once per current episode, only from an authoritative fresh snapshot;
   replay/reconnect/restart must not re-notify the same episode. Suppress old (>24h)
   requests, offline data, snoozed episodes and initial historical backlog. New
   episodes discovered after reconnect are eligible. Delivery failure/denial is
   visible and must never interrupt capture or break the inbox. Desktop must be open
   for notifications; OS delivery remains controlled by system notification settings.
6. Show snapshot freshness, per-session last observation and a stale/unknown label,
   plus captured warning evidence (parse/capture/schema warnings) and a Doctor link.
   Never claim complete coverage or infer source health from the daemon being live.
7. Keep all interactions keyboard accessible. Test stale asynchronous responses,
   evidence loading failures, polling recovery and empty states. Add no Go dependency,
   cloud call, telemetry, approval/kill action or adapter fixture fabrication.

## Implementation sequence and validation

- Confirmed public boundaries: Capture Engine Admit/Attention/Session
  queries, local HTTP request/response, and rendered desktop interactions (HTTP,
  time, storage and OS notification boundary substituted in tests).
- Build vertical failing-test → implementation slices: pending episode + recovery;
  resolution/classification/identity/privacy; API; inbox evidence and filtering;
  persisted snooze/notification delivery; shell integration and capture health.
- Verify each slice at its public boundary. Use existing real adapter captures when
  validating source mappings. Normalized envelope scenarios are engine input tests,
  not fabricated native adapter fixtures.
- Required gates: gofmt -l . → go vet ./... → go test ./...; Go builds; build-sidecar;
  pnpm desktop test/build; cargo test. Exercise the rendered UI using isolated demo
  data without reading or modifying the user's capture history or agent settings.
- Review against this spec and AGENTS.md/CLAUDE.md/CONTRIBUTING.md in separate
  standards and spec reviews, address findings and rerun affected gates.
- Commit, push, open a ready-for-review PR, monitor checks on the final head and
  resolve actionable review findings. Human PR approval and merging remain human
  actions; do not self-approve or merge.

## Explicit follow-ons

Cross-agent edit collision detection, automatic failure/loop inference, historical
forensics, native agent navigation and notification actions are later increments.
This feature only observes and links evidence; it never answers agent permissions.

## Baseline evidence

2026-09-06, isolated worktree `llm-firehose-attention-inbox`, commit 5841aad:
Go formatting, vet and all Go tests passed. All 107 desktop tests passed.
CLI and sidecar compilation and the frontend production build passed. Vite reports its
existing large-chunk advisory. All three native Rust tests passed, including
the desktop crate compilation and doc-test gate.
Test boundaries confirmed before feature tests, per the TDD skill.

## Completion evidence

The initial implementation was reviewed at `631970d`; the review record also
tracks subsequent regression-tested remediation from the hosted PR review.
See [the separate standards and spec reports](../reviews/2026-09-06-attention-inbox.md)
for findings, resolutions, and verification limits. Final local gates passed:
Go formatting, vet, full suite, capture/daemon race checks, CLI and sidecar builds;
128 desktop tests and production build; three native Rust tests and doc tests.
Isolated browser checks exercised evidence inspection, snooze, filtering,
disconnect/reconnect, and resolution without using personal capture history.
