# Daemon / UI compatibility

The desktop shell, the TUI, the CLI, and the daemon ship separately-updatable
pieces held together by two versioned contracts (docs/contracts.md):

- **`schema_version`** — the event envelope. Currently **1**.
- **`export_version`** — the export format. Currently **1**.

## The rule

Every client probes `GET /health` before consuming events and compares
`schema_version` with the version it was built against:

- **Equal** → compatible. Proceed.
- **Different** → refuse to render events; tell the user to update the older
  side. The desktop shell shows a blocking banner (`src/compat.ts`); the Go
  client exposes `Health.SchemaVersion` for the same check.
- **Absent/0** → pre-versioning daemon; treated as version 1.

Minor version drift between app and daemon (`version` in `/health`) is fine
as long as `schema_version` matches — new optional envelope fields do not
bump the schema version, and consumers must ignore unknown fields.

## Matrix

| App (shell) | Bundled firehosed | schema_version | Works with daemon… |
|---|---|---|---|
| 0.1.x | 0.1.x | 1 | any daemon reporting schema 1 (or none) |

Add a row per release (release runbook §0).

## Invariants updates must never break

- Updating the app must not touch `~/.agentfirehose/` (spool, config). The
  bundle contains no spool paths; all state lives in the user's home.
- The daemon restarts independently of the UI: killing either side never
  corrupts the other. Capture falls back to direct spool appends when the
  daemon is down (contracts.md client rules).
- Old spool files stay readable: envelope evolution is additive within a
  schema version; removals/renames require a version bump plus a reader
  that understands both versions.
