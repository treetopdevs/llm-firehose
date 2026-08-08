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
  MUST ignore unknown fields. (Examples: `trace_id` — optional, groups
  causally related events across sessions when a source supplies one — and
  `turn_id` — optional, groups events within a source-native turn — and
  `prompt_id` — optional, preserves the source-native prompt or interaction
  correlation id — and
  `call_id` — optional, the source-native tool/command correlation id;
  `upstream_event_id`, `message_id`, `parent_id`, and
  `request_id` — optional source-native correlation identifiers; `sequence`
  — an optional native ordering value within its documented source scope;
  `transport` and `source_version` — optional capture provenance;
  `source_time` / `capture_time` — the source clock and Firehose observation
  clock; and `repo_id` / `worktree_id` — observable local Git identities —
  were added additively within version 1.)
- Removing, renaming, or changing the meaning of a field requires a version
  bump and a reader that understands both versions.
- Spool lines written before versioning have no `schema_version` field;
  readers treat absent/`0` as version 1.

The original `time` field remains the adapter's compatible primary event
timestamp. `source_time` is present only when the source supplied a timestamp;
`capture_time` records when Firehose observed the event. For source-stamped
events such as Codex rollouts, `time` remains equal to `source_time`. For
capture-only hooks and process observations, `time` remains equal to
`capture_time`; Firehose does not invent a source clock.

When `cwd` resolves inside a local Git worktree, `repo_id` is the canonical
path to Git's common directory and `worktree_id` is the canonical worktree
root. Linked worktrees therefore share `repo_id` but have different
`worktree_id` values. The fields are absent when that identity cannot be
observed; path equality alone is never promoted to a repository claim.

## Privacy modes

Redaction happens **before persistence** — the spool never contains more than
the configured mode allows. The mode is applied at the engine boundary before
emitted, ingested, rollout, or process observations are appended. In
daemonless viewing, direct Codex observations are redacted before display.

| Mode | `raw` | `payload` values | Metadata (source, category, name, source/capture times, ids, repo/worktree/cwd, summary) |
|---|---|---|---|
| `minimal` | dropped | replaced with `{"sha256": "...", "len": N}` digests | kept |
| `balanced` (default) | dropped | strings at every nesting level truncated to 240 runes (with `…`) | kept |
| `full` | kept | kept verbatim | kept |

## Spool format

- Location: `spool_dir` (default `~/.agentfirehose/spool`).
- One file per UTC day, named `YYYY-MM-DD.ndjson`; files sort chronologically.
- Each line is one JSON event envelope; writers append whole lines with
  `O_APPEND` so concurrent producers never interleave.
- The spool is the canonical, append-only source of truth. Derived stores
  (indexes, caches) must be rebuildable from it.
- Capture is at-least-once across a crash window: the spool may contain the
  same stable event `id` more than once after replay. Derived indexes and
  presentation deduplicate exact IDs; the append-only spool and export retain
  the observations as written.
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
- Preserve source-native prompt and tool correlation identifiers in
  `prompt_id` and `call_id` whenever the source supplies them.
- Preserve a supplied clock in `source_time`, assign `capture_time` at
  observation, and leave `source_time` absent when the source has no clock.
- Attach `repo_id` and `worktree_id` only when `cwd` makes local Git identity
  observable.
- Map activity onto canonical categories: `session`, `prompt`, `message`,
  `tool`, `file`, `permission`, `shell`, `error`, `meta`.
- Put structured details in `payload`; never pre-truncate — privacy redaction
  is the engine's job.
- Content-bearing source fields may be deliberately excluded from the safe
  payload. In particular, an adapter may retain correlation/outcome metadata
  while omitting prompt/message bodies and sensitive tool inputs/outputs.
- An adapter may deliberately skip payloads that carry no signal; a skip is
  not an error.
- Deep adapters publish a capability manifest declaring source schema,
  transport, fidelity, mapped native events, and deliberately filtered
  events. Unknown native types surface as bounded `adapter.unknown_event`
  warnings rather than disappearing silently.

Current mappings (details in [adapters.md](adapters.md)):

| Source | Transport | Notes |
|---|---|---|
| `claude-code` | hooks → fail-silent `hook-forward --source claude-code` | lifecycle hooks per event |
| `codex` | durable rollout tail + observational `codex-hook` forwarding | rollout messages plus installable lifecycle/tool hooks |
| `opencode` | plugin → fail-silent `hook-forward --source opencode` | bus events |
| `antigravity` | hooks → fail-silent `hook-forward --source antigravity --event <name>` | post-only lifecycle/tool hooks; payloads carry no event-name field, so the forwarder tags each registration |
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
| `POST /config` | persist a partial config update; `privacy_mode` applies live, other fields are echoed in `restart_required` |
| `GET /events?limit=N` | recent events, oldest first (default 500) |
| `GET /events/stream` | live feed, Server-Sent Events (`data: <envelope JSON>`) |
| `POST /events` | ingest NDJSON envelopes; returns `{ingested: n}` |
| `POST /emit?source=S` | normalize one raw source payload; 204 on success. Additive optional `event=<name>` parameter (schema v1): the native event name for sources whose payloads carry none (antigravity); other sources ignore it |
| `POST /v1/logs` | opt-in loopback OTLP/HTTP JSON logs; `{}` on accepted batch |
| `POST /v1/metrics` | opt-in loopback OTLP/HTTP JSON metrics; `{}` on accepted batch |
| `GET /sessions` | session summaries (derived index), most recent first; additive attention fields `state`, `state_since`, `state_reason`, `has_error`, `last_summary`, `last_category` |
| `GET /sessions/{id}` | all events for one session, oldest first |
| `GET /traces/{id}` | all events sharing one `trace_id`, oldest first |
| `GET /artifacts/files` | touched-file summaries `[{path, events, sources, first_time, last_time}]`, most recently touched first |
| `GET /doctor` | adapter wiring checks `[{name, ok, detail}]`; adapter entries add `transport`, `fidelity`, `supported_events`, and `filtered_events` |
| `POST /install/{adapter}` | wire an adapter (claude-code \| claude-otel \| codex \| opencode \| antigravity); `{ok, detail}` |
| `POST /export` | NDJSON export stream; `X-Firehose-Export-Version` header |

Session, trace, and file queries are served from an in-memory index derived
from the spool (rebuilt at startup, updated from the tail); the spool stays
the source of truth and the index is always disposable. Attention `state` is
derived only — never written to the spool. Stream-only `source=firehose`
/`name=state.transition` frames on `/events/stream` announce transitions for
live clients; they are never persisted or exported.

CORS: browser origins are allowlisted to the desktop shell
(`tauri://localhost`, `http(s)://tauri.localhost`, `http://localhost:1420`).
Requests carrying any other browser origin are rejected with `403` — a random
website must not read or write the local event feed. Non-browser clients are
unaffected. The daemon refuses to bind a non-loopback listen address.
The OTLP endpoints reject every browser `Origin`, accept only bounded
`application/json` bodies, and never retain raw OTLP or resource attributes.

Compatibility rule for clients: see [compatibility.md](compatibility.md).

Client rules:

- Probe `GET /health` and compare `schema_version` before assuming
  compatibility.
- `firehose emit` (and therefore all push adapters) routes through the daemon
  when one is reachable and falls back to direct spool append when not —
  capture never depends on the daemon being up.
- The daemon writes emits locally; it never proxies them (no self-forwarding).
