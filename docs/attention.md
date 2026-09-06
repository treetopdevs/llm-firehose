# Attention inbox

Live is the desktop landing view. The attention strip stays visible across all
views; open **attention** to inspect the working set, snooze a request, or search
history. Existing Dwell, Workspace, Lanes, Sessions and Orbit views remain available.

The inbox groups by **source and native session ID**, keeps pending requests until
contrary evidence arrives, and links directly to the captured event. A request is
an observation; “No later resolution captured” is a derived conclusion, not proof
that the agent is currently blocked. Per-session timestamps, stale labels and the
capture setup link explain that distinction. Warning cards show the latest recorded
warning per source/name, with up to 20 displayed; their recovery status is unknown.

## Signals

| Captured source signal | Inbox behavior |
| --- | --- |
| Codex `PermissionRequest` | Request |
| OpenCode `permission.updated` | Request |
| Claude Code `Notification` with readable `notification_type=permission_prompt` | Request |
| Claude Code `StopFailure`, OpenCode `session.error`, Codex `error` | Session failure |
| OpenCode `permission.replied`, later non-error prompt/message/tool/file/shell activity, recognized session completion | Resolve current episode |
| Subagent completion, metadata, ordinary tool errors, Codex stream errors or cancellations | No interruption |
| Unrecognized or privacy-redacted permission notifications | Passive uncertainty explanation |

A repeated request with the same native request/call ID keeps its episode ID.
Without a native correlation ID, distinct captured event IDs are separate episodes.
Exact event-ID replay never duplicates state. Older event timestamps cannot reopen
a resolved episode. Snapshot data is rebuilt from the canonical spool on startup.
Older `/sessions` fields and stream-only state transitions retain their existing
semantics; `/attention` provides the more conservative evidence-based view.

## Snooze and notifications

Snooze hides an episode from the unsnoozed count for 15 minutes; the item stays
inspectable and can be unsnoozed early. A new episode is never hidden by an old
snooze. Snooze, notification preference and receipts are stored in desktop-local
preferences, separate from captured history. Only IDs and timestamps are stored.

Desktop notifications require explicit opt-in, OS permission, and an open desktop
app. Delivery uses the [official Tauri notification plugin](https://v2.tauri.app/plugin/notification/).
Notifications contain a fixed message with no captured summaries or paths. The
initial history snapshot is quiet. New episodes found after reconnect can notify;
replayed events, resolved or snoozed requests, and requests older than 24 hours do
not. A snooze expiring does not repeat a notification already attempted.

Each attempt is recorded **before** sending it to the OS to avoid duplicates after
an ambiguous crash. This means a crash or native delivery failure can lose a
notification; the inbox remains authoritative and delivery errors are shown there.
Storage failures leave the inbox usable with a visible preference warning. OS
focus modes and notification settings control presentation. Windows native
notifications require an installed app. Notification clicks/actions and opening
an agent's native UI are not part of this increment.

## API and validation

`GET /attention` returns `{sessions, warnings}` with `Cache-Control: no-store`.
Session records include source, ID, agent, privacy-processed workspace identity,
event count, derived state, last evidence, optional pending evidence and uncertainty.
Evidence includes event ID, source, kind, summary, primary/source time and observation
time. `GET /events/{id}` returns the exact captured envelope or 404 if unavailable.
Both endpoints inherit the existing loopback and browser-origin policy.

Engine/API tests cover rebuild, deduplication, source isolation, native request
coalescing, resolution, source clocks, redaction and detached snapshots. Desktop
interaction tests cover evidence selection, filters, snooze/restart/expiry, focus,
offline response invalidation, notifications and shell integration. Native tests
and compilation verify plugin integration; OS notification presentation must be
checked in an installed app on the target OS before a release claim.
