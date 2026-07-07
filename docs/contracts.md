# Platform contract

This document freezes the compatibility boundary of Agent Firehose (migration
plan, Phase 0). Adapters, spool data, exports, and clients built against these
contracts must keep working as the UI evolves. Changing anything here requires
a version bump and a documented migration.

The five frozen surfaces:

1. **Event envelope schema** — [`event.schema.json`](event.schema.json)
2. **Privacy mode semantics** — below
3. **NDJSON spool format** — below
4. **Export format** — below
5. **Local API** — below

## Event envelope (`schema_version`)

Every captured event is normalized into the envelope defined in
[`event.schema.json`](event.schema.json). The current `schema_version` is
**1** (`event.CurrentSchemaVersion`).

Evolution rules:

- New optional fields may be added without bumping the version. Consumers
  MUST ignore unknown fields.
- Removing, renaming, or changing the meaning of a field requires a version
  bump and a reader that understands both versions.
- Spool lines written before versioning have no `schema_version` field;
  readers treat absent/`0` as version 1.

## Privacy modes

Redaction happens **before persistence** — the spool never contains more than
the configured mode allows. The mode is applied at the engine boundary: at
spool-append time for emitted/ingested events, and at broadcast time for
events read directly from other tools' files (codex).

| Mode | `raw` | `payload` values | Metadata (source, category, name, times, ids, repo/cwd, summary) |
|---|---|---|---|
| `minimal` | dropped | replaced with `{"sha256": "...", "len": N}` digests | kept |
| `balanced` (default) | dropped | strings truncated to 240 runes (with `…`) | kept |
| `full` | kept | kept verbatim | kept |

## Spool format

- Location: `spool_dir` (default `~/.agentfirehose/spool`).
- One file per UTC day, named `YYYY-MM-DD.ndjson`; files sort chronologically.
- Each line is one JSON event envelope; writers append whole lines with
  `O_APPEND` so concurrent producers never interleave.
- The spool is the canonical, append-only source of truth. Derived stores
  (indexes, caches) must be rebuildable from it.
- Readers skip unparseable lines; the tailer surfaces them as `meta`/`warn`
  events instead of failing.

## Export format (`export_version`)

`export_version` **1** (`cli.ExportVersion`) is NDJSON of schema-versioned
event envelopes, one per line, oldest first — the spool format, concatenated
across days. Produced by `firehose export` and `POST /export` (which sets
`X-Firehose-Export-Version: 1`).

## Source adapter contract

An adapter maps a source's native payloads to canonical envelopes. Rules:

- Set `source` to the agent family and preserve the source's own session
  identifier in `session_id` whenever one exists.
- Map activity onto canonical categories: `session`, `prompt`, `message`,
  `tool`, `file`, `permission`, `shell`, `error`, `meta`.
- Put structured details in `payload`; never pre-truncate — privacy redaction
  is the engine's job.
- An adapter may deliberately skip payloads that carry no signal; a skip is
  not an error.

Current mappings (details in [adapters.md](adapters.md)):

| Source | Transport | Notes |
|---|---|---|
| `claude-code` | hooks → `firehose emit --source claude-code` | lifecycle hooks per event |
| `codex` | engine tails `~/.codex/sessions` rollout files | no install needed |
| `opencode` | plugin → `firehose emit --source opencode` | bus events |
| `generic` | `firehose ingest` / `emit --source generic` | envelope passthrough or meta-wrap |
| `procwatch` | engine polls `ps` | agent process lifecycle |

## Local API

The daemon (`firehose daemon`) serves a localhost-only HTTP API, default
`127.0.0.1:4517` (`daemon_addr` in config). Trust model: localhost, tokenless
(single-user machine); harden before ever binding beyond loopback.

| Endpoint | Meaning |
|---|---|
| `GET /health` | `{status, version, schema_version}` — reachability + compatibility probe |
| `GET /config` | effective engine configuration |
| `GET /events?limit=N` | recent events, oldest first (default 500) |
| `GET /events/stream` | live feed, Server-Sent Events (`data: <envelope JSON>`) |
| `POST /events` | ingest NDJSON envelopes; returns `{ingested: n}` |
| `POST /emit?source=S` | normalize one raw source payload; 204 on success |
| `GET /sessions` | session summaries derived from the spool, most recent first |
| `GET /sessions/{id}` | all events for one session, oldest first |
| `GET /doctor` | adapter wiring checks `[{name, ok, detail}]` |
| `POST /export` | NDJSON export stream; `X-Firehose-Export-Version` header |

Client rules:

- Probe `GET /health` and compare `schema_version` before assuming
  compatibility.
- `firehose emit` (and therefore all push adapters) routes through the daemon
  when one is reachable and falls back to direct spool append when not —
  capture never depends on the daemon being up.
- The daemon writes emits locally; it never proxies them (no self-forwarding).
