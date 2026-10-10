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
emitted, ingested, rollout, or process observations are appended. Daemon and
daemonless hosts use the same Admission path.

| Mode | `raw` | `payload` values | Metadata (source, category, name, source/capture times, ids, summary) | Path identity (`cwd`, `repo_id`, `worktree_id`) |
|---|---|---|---|---|
| `minimal` | dropped | replaced with `{"sha256": "...", "len": N}` digests | kept | replaced with sha256 hex digests |
| `balanced` (default) | dropped | strings at every nesting level truncated to 240 runes (with `…`) | kept | replaced with sha256 hex digests |
| `full` | kept | kept verbatim | kept | kept (canonical absolute paths) |

These modes govern **captured history**: the event spool, the live event stream
and exports. They do not redact the local workspace-graph views or the
host-private repository list, which are readable in every mode (see
[Workspace graph](#workspace-graph-and-scoped-timeline-additive)). That change
touches only the graph routes and the `graph-roots.json` host file: the event
envelope, the spool format, the export format, the mode semantics in the table
above and every non-graph route are unchanged, so there is no `schema_version`
bump.

## Spool format

- Location: `spool_dir` (default `~/.agentfirehose/spool`).
- One file per UTC day, named `YYYY-MM-DD.ndjson`; files sort chronologically.
- Each line is one JSON event envelope; writers append whole lines with
  `O_APPEND` so concurrent producers never interleave.
- The spool is the canonical, append-only source of truth. Derived stores
  (Projections, caches) must be rebuildable from it.
- Capture is at-least-once across a crash window: the spool may contain the
  same stable event `id` more than once after replay. Derived Projections and
  presentation deduplicate exact IDs; the append-only spool and export retain
  the observations as written.
- Readers skip unparseable lines; the tailer surfaces them as `meta`/`warn`
  events instead of failing.
- Capture Engine source-supervision and hook-capture Warning summaries contain
  bounded source/status metadata only. Their potentially sensitive error detail
  remains in `payload`, where the active privacy mode hashes, truncates, or
  retains it according to this contract. Existing adapter capture- and
  parse-warning summaries keep their established shapes.

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
| `GET /attention` | source + native-session scoped attention snapshot `{sessions, warnings, gaps}`; pending captured evidence, uncertainty and last observations; see [attention semantics](attention.md) |
| `GET /attention/event?id={id}` | exact captured envelope by stable ID, or 404; additive evidence lookup |
| `GET /sessions` | session summaries (derived Projection), most recent first; additive attention fields `state`, `state_since`, `state_reason`, `has_error`, `last_summary`, `last_category` |
| `GET /sessions/{id}` | all events for one session, oldest first |
| `GET /traces/{id}` | all events sharing one `trace_id`, oldest first |
| `GET /artifacts/files` | touched-file summaries `[{path, events, sources, first_time, last_time}]`, most recently touched first |
| `GET /doctor` | adapter wiring checks `[{name, ok, detail}]`; adapter entries add `transport`, `fidelity`, `supported_events`, and `filtered_events` |
| `POST /install/{adapter}` | wire an adapter (claude-code \| claude-otel \| codex \| opencode \| antigravity); `{ok, detail}` |
| `POST /export` | NDJSON export stream; `X-Firehose-Export-Version` header |

Session, trace, and file queries are served from an in-memory Projection derived
from the spool (rebuilt at startup, updated from the tail); the spool stays
the source of truth and the Projection is always disposable. Attention `state` is
derived only — never written to the spool. Stream-only `source=firehose`
/`name=state.transition` frames on `/events/stream` announce transitions for
live clients; they are never persisted or exported.

Live streams are bounded presentation channels, not durable history. Queue
overflow closes only the affected stream; clients close the failed transport,
reload up to 10,000 durable events, open a replacement, and take a second
durable snapshot before consuming it. Exact-ID deduplication merges both
snapshots with buffered live frames without a history/live race. Browser
EventSource clients disable implicit reconnect because it does not perform
that history reconciliation.

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
  when one is reachable and falls back to One-shot Admission on transport
  failure or a daemon `5xx` persistence failure — capture never depends on the
  daemon being up. An authoritative parse/validation rejection (`4xx`) is
  returned and never triggers a second write.
- The daemon writes emits locally; it never proxies them (no self-forwarding).

### Workspace graph and scoped timeline (additive)

The local daemon exposes read-only VCS inspection through the same loopback and
browser-origin restrictions as existing routes:

- `GET /workspace-graph/repos`: registered repository descriptors.
- `POST /workspace-graph/repos` with `{root, vcs}` registers an absolute local
  directory (`vcs` is `git`, `jj`, or empty for detection). This writes only host
  registration configuration, never VCS state. Scan roots persist in the private
  `~/.agentfirehose/graph-roots.json` host file (see below), which is not exposed
  by the API.
  Graph `id` fields (`Repository.id`, `Workspace.id`, `repo_id`) follow the
  privacy mode: canonical paths in `full`, SHA-256 digests in `minimal` and
  `balanced`, exactly the identities Capture stamps on events, so a captured
  session keeps associating with its workspace. Every graph **display** value is
  readable and untruncated in every mode (see below).
- `GET /workspace-graph?repo_id=...&cursor=...&refresh=true`: disposable topology
  snapshot with actual parent edges, every discovered workspace, explicit
  boundaries, warnings, stale state, and an optional continuation cursor.
- `GET /workspace-graph/compare?repo_id=...&revision=...&target=...`: revision-set
  differences, merge bases, and committed changed files (plus optional per-file
  `changes`, see below); checkout dirty state is separate workspace metadata. No
  operation modifies a repository or fetches.
- `GET /workspace-graph/timeline`: durable event page, newest compatible `time`
  first, then descending exact ID for deterministic ties. Optional `repo_id`,
  `workspace_id`, `source`, `session_id`, `category`, `search`, `cursor`, and
  `limit` (default 200, maximum 1000) scope the original captured association.
  `session_id` requires `source`. Response fields are `events`, `next_cursor`,
  `has_more`, `order: "newest_first"`, and `capture_gap`. Exact-ID duplicates
  are removed. Cursor paging never infers cross-provider causality; clients
  reconcile the newest page after reconnect/resume to include late arrivals.
  The query never reads the whole spool. The Projection keeps a disposable
  index from each repository/workspace identity value (Git and JJ, including
  the aliases the graph resolves) to the UTC day files that hold it; a request
  reads only the intersection of those day files, newest first, and stops once
  `limit`+1 matching events older than the cursor are in hand (every event in an
  older day file sorts after every event in a newer one). Cost is bounded by the
  days a page needs, not by spool size. The scan stops promptly when the client
  abandons the request. `capture_gap` is true if the Projection saw an
  unreadable spool record at rebuild or from the live tailer, or a record read
  for this page was unreadable. The index is rebuilt from the spool with the
  rest of the Projection and updated on every Admission and reconciliation.

Existing event/session/attention routes retain their representations. Graph
scans run independently of capture. Debounced metadata polling detects repository
changes; full reconciliation every 30 seconds catches missed signals and checkout
content changes. Explicit/focus refresh is also supported. Observed roots are
learned before privacy processing only in a running capture engine, with no
filesystem crawl; a root that does not scan (not a repository, VCS unavailable)
is never remembered. A privacy-mode transition invalidates graph caches, because
`id` fields change with the mode.

Repository roots are persisted in `~/.agentfirehose/graph-roots.json` (0600,
written atomically) in **every** privacy mode, so the repository list survives a
daemon restart. A root is added when it is registered explicitly or when a root
learned from observed agent activity scans successfully; the file is loaded at
startup in every mode (entries that are not absolute paths or name an unknown VCS
are ignored) and is never deleted or rewritten because the privacy mode changed.
The file holds raw absolute paths: it is host-private state, never part of the
event spool, the live stream, an export or any API response, and `0600` plus the
loopback-only, browser-origin-restricted daemon are its protection. This
replaces the earlier rule that kept raw roots on disk only in `full` mode, which
emptied the repository list after every restart in `minimal`/`balanced`.

Display values in graph responses are never hashed or truncated, in any mode:
`Repository.label` is the canonical root path, a Git workspace `label` is its
worktree path, a JJ workspace `label` is the workspace name, and branch or
bookmark names (`refs`, `default_target_ref`), revision descriptions,
`changed_files`, comparison `changed_files` and `FileChange.path` are the VCS's
own text. This replaces the earlier rule that hashed these values in `minimal`
and truncated them at 240 runes in `balanced`. The same applies to the
synthetic `unavailable` repository rows, whose `label` is the root path and
whose `id` is an opaque digest.

#### Per-file change statistics (additive)

Graph snapshots and comparisons carry optional structured file changes next to the
existing, unchanged `changed_files` string lists (`changed_files` keeps its raw
porcelain-entry meaning). Every field below is optional and
`omitempty`; consumers ignore what they do not know, and no `schema_version` bump
applies.

| Where | Field | Meaning |
|---|---|---|
| `GET /workspace-graph` snapshot | `default_target_ref` | Name of the ref behind `default_target` (`main` or `master` for Git, the bookmark for JJ). Present exactly when `default_target` is. |
| `workspaces[]` | `changes` | Uncommitted checkout changes (a list of `FileChange`). |
| `workspaces[]` | `changes_truncated` | `true` only when the workspace has more than 200 changed files; `changes` then holds the first 200 in the VCS's stable path order. |
| `GET /workspace-graph/compare` | `changes` | Committed per-file changes from `target` to `selected` (a list of `FileChange`). |
| `GET /workspace-graph/compare` | `changes_truncated` | `true` only when more than 200 files differ. |

`FileChange`:

- `path` (string): repository-relative path (the new path for a rename). An
  untracked directory is listed as its individual files in `changes` (so the
  200-entry bound counts files), while the legacy `changed_files` keeps git's
  single `?? dir/` entry.
- `status` (string): one of `M` modified, `A` added, `D` deleted, `R` renamed,
  `C` copied, `T` type changed, `U` unmerged, `?` untracked. For a checkout where
  a file is staged and also edited, the working-tree letter wins over the index
  letter (a staged add edited again is `M`). Comparison statuses come from the
  committed difference and are never `U` or `?`. A rename is one entry for the new
  path; the old path is not listed.
- `additions`, `deletions` (integers, optional): added and removed line counts.
  Zero is a real value and is serialized (`"deletions": 0`); the fields are
  omitted when no counts exist: untracked (`?`) and unmerged (`U`) paths, binary
  files, a checkout whose HEAD is unborn, or when the VCS cannot supply them
  (JJ counts are best effort and are dropped for any file whose `--stat` bar was
  scaled; Git workspace counts are relative to HEAD, comparison counts to the
  target revision).
- `binary` (boolean, optional): `true` only for a binary change; counts are then
  omitted.

Privacy: `path` and `default_target_ref` are display values and are returned
verbatim in every mode, like `changed_files` and refs (see above). `status`,
`additions`, `deletions` and `binary` are structural metadata. Only `id` fields
follow the privacy mode, so a privacy transition still drops the snapshot cache.

Omission and bounds: `changes` is omitted for clean workspaces, for identical
revisions, and whenever details are unavailable (the legacy fields are still
returned); a failure to read statistics never fails the snapshot or comparison.
At most 200 entries are returned per list, then `changes_truncated` is set.
Statistics are collected only for dirty workspaces.

Read-only collection: Git statistics run in the same shadow git directory as
`git status` (an inert, config-sanitized git dir sharing the repository's
objects, refs and index), as `git diff --numstat -z HEAD` with
`--no-ext-diff --no-textconv --ignore-submodules=all` and
`diff.autoRefreshIndex=false`, so no configured driver or filter runs and the
real index is never rewritten. Comparisons run tree-to-tree
(`git diff --raw -z` and `--numstat -z` with the same flags). JJ uses
`jj diff --summary` (path and status, required) and `jj diff --stat` (counts)
through the existing `--ignore-working-copy` runner for the workspace's last
recorded working-copy commit, so scans never snapshot a working copy.

Optional `jj_repo_id` and `jj_workspace_id` identities use the separate `jj:`
namespace followed by canonical shared-repository/workspace paths in full mode;
minimal/balanced apply the same SHA-256 path protection as Git identities. Git
fields keep their existing meaning, including in colocated repositories. The
source-scoped attention session projection carries both optional JJ fields.
Timeline scope matching accepts the registered repository's exact canonical and
hashed identity aliases, preserving historical associations across privacy
changes without interpreting hashes as paths.

Graph snapshots add `attention_associations`, keyed by source + NUL + native
session ID, with `{repo_id, workspace_id, event_id}` values resolved from exact
observed identity aliases. The optional `event_id` identifies the attention
observation used for that association; clients must not apply a stale map entry
after newer session evidence arrives. Timeline pages similarly add `associations`, keyed by exact
event ID. An empty associated workspace ID means no currently available graph
workspace could be resolved; it does not relocate the captured event. These
maps support cross-view navigation across privacy transitions while preserving
original event envelopes. Session movement updates the current attachment only;
late observations cannot restore an older attachment.
