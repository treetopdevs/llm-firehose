**PASS** — No actionable defects found in `e007b2f..b43fd4d`.

### Verification Summary

- **Native reference semantics** ([`buildLoom`](../../apps/tauri-desktop/src/ui/loom/model.ts#L22-L77), [`loomNeighborhood`](../../apps/tauri-desktop/src/ui/loom/model.ts#L80-L86), [`renderLoomMap`](../../apps/tauri-desktop/src/ui/loom/map.ts#L5-L24)):
  - Directed parent references are restricted strictly to `source === "opencode" && event.name === "message.updated"` with non-empty `message_id` and `parent_id`, joining `["message", parent_id] -> ["message", message_id]`.
  - Any other `parent_id` and all `upstream_event_id` values are never joined and are counted in `unsupportedParents`.
  - Missing parent messages materialize a zero-member `message` group with `status: "missing"`; self-references (`parentKey === childKey`) and multiple distinct parent IDs for one child (`childReferences.size > 1`) mark all candidate references `"conflicting"` without choosing a winner.
  - `loomNeighborhood` expands strictly one hop from the focused event's direct groups (`direct.has(p.parentKey) || direct.has(p.childKey)`), with no recursive traversal.

- **Exact `source` / `session` scoping** ([`model.ts`](../../apps/tauri-desktop/src/ui/loom/model.ts#L25-L35), [`index.ts`](../../apps/tauri-desktop/src/ui/loom/index.ts#L65-L99)):
  - `buildLoom` filters `event.source !== source || event.session_id !== session` before counting `omitted`, `duplicates`, `conflicts`, `unsupportedParents`, or `invalidTimes`, and before constructing namespace-isolated groups (`JSON.stringify([kind, id])`).
  - Duplicate event IDs with identical canonical envelopes collapse deterministically; conflicting envelopes under the same event ID increment `conflicts` and exclude all records for that ID.
  - `inspect` verifies `full.id === event.id && full.source === loadedSource && full.session_id === loadedSession` before rendering the full receipt or exposing `Open Score`.

- **Stale receipts & lifecycle cancellation** ([`createLoom`](../../apps/tauri-desktop/src/ui/loom/index.ts#L7-L130)):
  - `cancelReceipt()` increments `receiptVersion`, aborts `receiptAbort`, and clears `evidence` on scope edits, filter changes, focus changes, group selection, all pagers, choice refresh, `Open Score`, and panel deactivation (`deactivate()`).
  - `load()`, `inspect()`, and `refresh()` guard both resolution and error paths against aborted signals and stale version tokens, and `load()` clears prior scope upfront so failed reloads never present stale relationships as current.

- **Paging & visual bounds** ([`index.ts`](../../apps/tauri-desktop/src/ui/loom/index.ts#L18-L64), [`map.ts`](../../apps/tauri-desktop/src/ui/loom/map.ts#L7-L10)):
  - Observations and group members paginate at 40 with exact filtered/total/range disclosure; neighborhood groups and parent references paginate at 20 in both the map (`slice(0, 20)`) and accessible lists.

- **Unchanged `full` / `timeline` / privacy** ([`CorrelationView`](../../internal/capture/history.go#L226-L233), [`handleSessionByID`](../../internal/daemon/endpoints.go#L34-L61)):
  - [`TimelineView`](../../internal/capture/history.go#L182-L206) and default/`full` session responses are untouched.
  - `CorrelationView` starts from `TimelineView(ev)` (preserving the allowlisted payload copy and privacy digests without mutating input) and adds only `SourceTime`, `CaptureTime`, `TraceID`, `PromptID`, `MessageID`, `ParentID`, `UpstreamEventID`, `RequestID`, `Sequence`, `Transport`, and `SourceVersion`, excluding `Raw`, arbitrary payload keys, and host/filesystem fields.
  - `handleSessionByID` validates `view` (`""`, `"full"`, `"timeline"`, `"correlation"`) before calling `s.engine.Session(id)` and returns `400` on unknown views.
