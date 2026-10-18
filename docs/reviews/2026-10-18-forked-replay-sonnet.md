# Sonnet 5.5 High adversarial review

Direct Claude CLI, exact model `claude-sonnet-5-5`, `--effort high`; static read-only review e007b2f..5d2f3f6. User-authorized fallback after Argon quota exhaustion.

**PASS** for `e007b2f..5d2f3f6`, with no blocking findings. This was a static read of the code and tests at head. I ran no tests and made no edits.

`dbbab7f..5d2f3f6` touches only docs, so the validation and review claims in those docs still describe the code at head.

## What I checked

- **Persistence conflicts and corruption** (`notebook.ts:24-74`, `index.ts:68-92`):
  - **Read-only on bad data:** corrupt, future-version, oversize or extra-field documents fall back to a read-only empty book. The raw token is kept, and `saveReplayBook` refuses to overwrite them even when the token matches.
  - **Optimistic write check:** a stale token fails before `setItem`. Sparse steps and the UTF-8 byte budget are checked on the serialized form.
  - **In-memory state:** `book` and `token` are always updated together. Editor copies don't alias `book`, and a failed save or delete leaves them untouched.
  - **Recovery view:** the recovery textarea is read-only, capped at 65536 characters and discloses the full length.
- **Dirty edits:**
  - **Refresh notebook:** refused while dirty.
  - **Open branch and New branch:** refused while dirty.
  - **Discard edits:** restores the saved branch, or closes a new draft.
  - **Scope edits and navigation:** both keep the text.
  - **Failed save or delete:** keeps all fields.
  - **Every `fill()`:** also clears a pending delete confirmation, so a stale confirmation can't be acted on after a refresh or open.
- **Exact source/session/anchor identity:**
  - **Route filter and receipt gating:** `buildReplayRoute` filters on exact source and session. A receipt only verifies if its id, source and session all match, and only a verified receipt enables New branch.
  - **Map pairing:** the map pairs an anchor or alternative only when the branch's source and session equal the loaded scope. Same event ID in a different source never pairs.
  - **Missing anchors:** a missing anchor is disclosed and nothing nearby is substituted.
- **Stale async replies:** `loadVersion`, `receiptVersion`, `choiceVersion` and abort controllers are all checked after each await. `inspect` also checks that the focused event is unchanged. Scope edits, paging, search, selection, `deactivate` and Open Score all cancel receipts.
- **Timestamps:** invalid times sort last, ties break by ID, and the route list shows "Undated". The load time is labeled as a client-clock "loaded" stamp.
- **Hypothetical vs captured:** the alternative lane is numbered, capped at 12, and has no time, outcome or success styling. Receipt JSON is never persisted, and saved stored-reference branches are never treated as verified.

## Non-blocking advisories

- **Low, `index.ts:80`:** confirming deletion of the branch that is open in the editor drops its unsaved edits through `fill(undefined)`. The plan allows clearing the editor after a successful delete, but the confirmation text (`index.ts:76`) doesn't warn about unsaved changes. Suggest adding "unsaved edits to this branch will be lost" when `dirty && editor?.id === branch.id`.
- **Low, `index.ts:51-63`:** `newBranch` doesn't check `writable`. In a read-only notebook it opens a draft that can't be saved (Save is disabled at `index.ts:49`), and Refresh notebook is blocked until the user discards it. Suggest refusing with a message when `!writable`.
- **Low, `index.ts:33`, `map.ts:13`, `model.ts:31`:**
  - **Raw invalid times:** the selection panel and map buttons show the raw `event.time` even when it is invalid. Only the route list says "Undated".
  - **Lenient parsing:** `Date.parse` is engine-lenient. For non-RFC3339 strings, the V8 and WebKit engines can disagree on whether a time is valid, and so on its sort position. A strict RFC3339 check would remove that.
  - **Untested:** none of this is covered by tests.
- **Trivial, `index.ts:137`:** `deactivate()` can leave `choicesStatus` stuck at "Loading session choices…" until the next `refresh()`, which runs on re-entry.
- **Trivial, `index.ts:26` and `map.ts:8`:** when the anchor is missing, the "anchor not in loaded snapshot" message appears twice.
- **Process, `docs/reviews/2026-10-18-forked-replay-validation.md`:** the TDD section still says "No commits". The Argon/Gemini gates are recorded as not met, so keep the PR draft until the user decides whether this Sonnet 5.5 High fallback satisfies them.

## Remediation

Deletion warns about dirty text; read-only notebooks refuse new drafts; RFC3339 clocks preserve fractional ordering and invalid times are labelled Undated everywhere. Deactivation clears loading notice and missing-anchor notice appears once. Four new regressions failed first; all 516 frontend tests and build pass. Follow-up pending. User explicitly authorized this Sonnet fallback.
