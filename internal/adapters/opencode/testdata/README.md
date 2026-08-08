# OpenCode bus fixtures

Captured from a live OpenCode **1.18.10** interactive session on **macOS
arm64** on **2026-08-07** (session UTC day 2026-08-08). Transport: the
OpenCode plugin event callback — a temporary variant of the installed
`agent-firehose.js` appended every raw bus event to a capture file *before*
any Firehose adapter or privacy processing, so these shapes never passed
through the code under test. Trigger: a normal coding turn (prompt →
reasoning → glob/grep/read/bash/edit tools → patch → idle) inside a real Go
repository.

Sanitization replaced values only: session/message/part/event/call IDs were
renumbered consistently (`ses_fixture01` …), personal repository paths became
`/tmp/agent-firehose-opencode-fixture/work`, and prompt text, reasoning,
titles, diffs, tool inputs/outputs, file lists, and provider reasoning
metadata use conspicuous `SECRET-*-MARKER` values for privacy-negative tests.
Keys, nesting, scalar types, optional-field presence, and intra-event
structure are unchanged. Product metadata (OpenCode version, agent/mode,
model/provider IDs, token/cost numbers, epoch timestamps, tool names,
status enums, exit codes) is real.

One deviation: fixtures are stored one representative event per file rather
than as an ordered stream, so cross-event ordering is not preserved here;
the `evt_fixture` numbering does not encode bus order.

## Families covered

- `session.created` / `session.updated` / `session.status` (busy + idle) /
  `session.idle` / `session.diff`
- `message.updated` — user, assistant started (zero tokens), assistant
  completed (`finish`, tokens, cost)
- `message.part.updated` — `text`, `reasoning`, `step-start`, `step-finish`
  (tokens/cost/snapshot), `patch`, and `tool` parts in `pending`, `running`,
  and `completed` states (glob, bash with exit metadata, edit)
- `message.part.delta` — the streaming delta the plugin deliberately filters
- `file.edited`, `file.watcher.updated`
- Unmapped drift material: `plugin.added`, `catalog.updated`,
  `integration.updated`, `reference.updated`, `project.directories.updated`

## Known gaps (not triggerable in the capture session)

`session.error`, `session.deleted`, `session.compacted`, permission
request/reply, retry, tool `error` state, and PTY exit did not fire (the
session's permission configuration auto-allowed all tools, no tool failed,
and no session was deleted). Their parser mappings remain blocked on a
future real capture; do not invent them. The inline test payloads for
`session.error`, `session.deleted`, `permission.updated`, and
`permission.replied` are unproven inherited shapes.
