# Evidence Court UI TDD

Worktree branch codex/evidence-court-prototype.

Initial observable panel tests added before implementation: missing index module failed resolution (/tmp/firehose-court-ui-red.log). Implemented createCourt with existing captured score fixture for event shapes. Nine targeted interaction tests now pass (/tmp/firehose-court-ui-green.log); tsc --noEmit passed.

Coverage: explicit lookup (no fanout/handoff fetch), missing/attached status and counts, identity-only save, reopen/remove receipt, Score scope, persistent navigation drafts, abort/stale lookup after handoff or editing/selection/new lookup, mismatched ID/source, failed save preserving gap, corrupt/unavailable storage and retry, unavailable saved evidence retaining reference, HTML text escaping, sessionless receipt with no Score, requirement/claim removal, explicit reload clearing drafts without saving.

Initial implementation (superseded by review fixes below): local notebook loads once on construction; refresh only aborts/clears evidence while preserving form draft DOM. Explicit Reload notebook reconstructs validated store and clears drafts. Handoff carries an ID, leaves selected requirement unchanged, and requires lookup then Attach receipt. Mutations abort prior preview before saving; failed write retains prior notebook state and text drafts, with visible retry/reload guidance. Only IDs and manual text reach notebook storage.

## Initial Sonnet review fixes

Regression tests added first for explicit target choice/target label, identity-only roundtrip, replacement block, delete confirmation cancellation, failed-preview preservation, drafts across selection, raw recovery, UUID failures. Failed before implementation (/tmp/firehose-court-review-red.log). Fixed all review findings 1–7 and origin/profile copy.

Final targeted panel run 14 passing tests (/tmp/firehose-court-review-green.log), tsc passed. Additional tests verify storage conflicts preserve preview/drafts, detached stale Attach callbacks cannot mutate a different requirement, scope switches abort and reject delayed events. UI now names saved attach target; handoff/reload select no requirement; replacement requires Remove receipt with in-panel confirmation; all destructive removals require confirmation/cancel. Draft map preserves text across selections and unrelated mutations; successful creation clears only that form's draft. Failed saves keep evidence available. Raw invalid/future storage is read-only copyable recovery text, never reset. Explicit reload warns it discards drafts.

Full suite/build delegated to parent after targeted completion. No commits.
