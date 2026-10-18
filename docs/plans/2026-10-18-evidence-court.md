# Evidence Court v1

Status: implemented and locally validated; final Sonnet, standards and spec reviews passed on `f3e46c0`. PR #37 open; hosted checks tracked on the PR. Argon timed out; Sonnet fallback findings recorded in docs/reviews. Base main `e007b2f26e61042a43f802c13844a761946e8e3a` after authorized PR #36 merge.

## Outcome and scope

A manual local evidence notebook: write a completion claim, list requested evidence, attach an exact Captured Event to each requirement, and inspect the receipt. Missing receipts stay visible gaps. An attachment is a user-chosen association, never a verified claim, inferred success, or proof of universal correctness. Chosen next from the concept backlog because it adds a practical review workflow without speculative inference.

No capture/Go/API/schema changes, dependencies, cloud, command execution, automatic claim extraction or export. Reuse `capturedEvent(id, signal)` and the shared Live/Score detail drawer; the separate graph inspector is outside this slice. Add `court` navigation; the shared detail drawer offers “Use in Evidence Court” to carry an event ID into the notebook (no attachment until the user selects a requirement and confirms). Manual event ID entry also works.

## Local notebook contract

Use versioned localStorage key `firehose.evidence-court.v1`, host-private UI state separate from captured history, not spooled/exported/synced. Persist only manual text and receipt identity `{id,source,session_id}`; never copy event payloads/summaries. UI explains local storage and that clearing app data loses notes. No save-on-load or silent corrupt/future-version overwrite. Storage unavailable, invalid data, quota failures and stale cross-window writes produce visible errors; failed mutations preserve prior state. Compare stored original value before every save, rejecting conflicts with reload guidance. This is optimistic best-effort single-client storage, not a transactional multi-window database.

Notebook shape `{version:1,claims:[{id,text,requirements:[{id,text,receipt?:{id,source,session_id}}]}]}`. Max 20 claims, 20 requirements each, claim text 1000 chars, requirement text 500 chars; trim nonempty manual text. IDs bounded to 512 chars, identity fields strings (source/id nonempty; session may be empty). Validate parsed state strictly, including unique claim IDs and unique requirement IDs within each claim. Unknown versions/invalid state block mutations rather than reset. Return copies to callers. UI-created IDs use crypto.randomUUID. Save returns only after successful storage write.

## Interaction and evidence

Create/select/edit/remove claims; add/edit/remove evidence requirements. Confirm removal of claims, requirements and receipts in-panel, naming the target; cancellation changes nothing. Do not replace an existing receipt silently: remove it explicitly first. Each requirement says “Missing receipt” or “Receipt attached — not verified”. Counts reflect attachment gaps only. At most 20 visible claims and 20 requirement rows, no history fanout. A selected requirement receives explicit event ID lookup. Resolve and validate ID/source/session before saving identity; handle not-found/mismatch/unavailable. Creating a claim or requirement selects the item the user just created. Never preselect a requirement on reload or incoming handoff. Before attaching show the saved claim and requirement target alongside full captured evidence and require “Attach receipt”. Open attached receipt re-fetches it and verifies all saved identity fields; unavailable evidence remains an attached reference with a visible unavailable error, not proof. Remove receipt restores a gap.

Own full JSON evidence region rendered as text; abort and version guard every lookup across claim/requirement changes, edits/removal, refresh, new lookup and navigation handoff. Never attach a stale preview. Keep manual drafts across panel and in-panel navigation; only selected-scope edits invalidate previews. Failed saves keep preview and drafts available. Explicit reload clearly warns it discards drafts, re-reads storage and clears preview. Invalid/unsupported notebook state offers read-only raw JSON for manual recovery without overwriting storage. Notes are scoped to the current app origin/profile; dev and release notebooks are separate. No trusted HTML from notes or events. Offer Score navigation only for a nonempty session ID.

## TDD and validation

User delegates routine decisions; seams are notebook persistence API, observable panel interaction/API requests, and shared detail action. Red→green vertical slices. Test roundtrip, bounds, corrupted/future data, storage failure/conflict, copied state, missing gaps, attach/remove, explicit read count, stale/aborted previews, wrong identity, failed save, safe text, handoff and reload. Use existing captured fixtures for receipt shapes.

Run gofmt → go vet → go test, full frontend tests/build, sidecar build then Rust tests, browser against isolated actual daemon fixture history. Plan and final review via Argon 4 High, fallback Sonnet 5.5 High on timeout/unavailability; fix findings test-first. Separate standards/spec reviews. Commit/open PR and monitor final CI. Human approval required to merge this new PR. CodeRabbit capacity and Autofix billing limits remain distinct from completed reviews. Update running HTML journal.
