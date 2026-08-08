# Adapter capabilities

Firehose distinguishes wiring from capture fidelity. `firehose doctor` and
`GET /doctor` report both: a transport can be correctly configured while
still being supplemental, partial, or unavailable.

| Source | Transport | Fidelity | Supported events | Deliberately filtered | Source schema |
|---|---|---|---:|---:|---|
| Claude Code | `hook` | `supported-in-band-hook` | 11 | 2 | Claude Code 2.1.218 hook payloads captured locally |
| Claude Code | `otel-http` | `supported-passive-stream` | 5 | 0 | Claude Code 2.1.218 OTLP/HTTP JSON captured locally; identity/content attributes always dropped; nine further observed names await sanitized captures (see the claudeotel testdata README) |
| Codex | `hook` | `supported-in-band-hook` | current installed hook matrix | 0 | current Codex hook contract |
| Codex | `durable-jsonl` | `passive-internal-file` | rollout parser families | reasoning, duplicated messages, instruction bodies, complete world state | current local rollout JSONL |
| OpenCode | `plugin` | `supported-passive-stream` | 13 | 1 | OpenCode 1.18.10 event callback captured locally; streaming text/reasoning parts, step-start markers, and nonterminal tool updates are also dropped inside `message.part.updated` |
| Antigravity | `hook` | `supported-in-band-hook` | 5 mapped (3 installed) | 0 | Antigravity CLI 1.1.10 hook payloads captured locally; payloads carry no event-name field, so the forwarder tags each registration via `--event`; only the post-only `PostToolUse`/`PostInvocation`/`Stop` are installed — `PreToolUse` output is a permission decision and pre-events add in-band latency |
| Process watcher | `process` | `process-only` | process start/stop | semantic activity | local process table |

Counts describe native event families, not a promise that every locally
installed source has emitted every family. Unknown native types produce a
bounded `meta`/`warn` observation with a stable daily ID. A deliberately
filtered high-volume type is a documented skip and does not produce a drift
warning.

## Fidelity meanings

- `supported-passive-stream`: a supported callback or stream observes events
  without putting Firehose in an execution decision.
- `supported-in-band-hook`: a supported command hook runs in the agent path;
  Firehose returns neutral success and never makes policy decisions.
- `passive-versioned-file`: a documented versioned append-only source.
- `passive-internal-file`: a local durable file whose record contract is less
  stable and therefore needs explicit drift handling.
- `owned-run-protocol`: Firehose owns the process protocol.
- `process-only`: only process presence is observable.

## Fixture status for the 2026-07-25 expansion

The local baseline is OpenCode 1.18.10, Claude Code 2.1.218, and Gemini CLI
0.46.0. The Claude hook adapter maps the eleven event families its manifest
declares (the `supported_events` count doctor reports); ten are backed by the
real fixture corpus, while `PreCompact` keeps its pre-merge mapping and awaits
a captured payload (see the claudecode testdata README). Other documented
Claude hooks remain coverage gaps until their payloads are observed. The
OpenCode adapter maps thirteen bus families; nine are backed by the sanitized
1.18.10 bus-event corpus, while `session.error`, `session.deleted`, and the
two permission families keep their pre-corpus mappings as unproven inherited
shapes (see the opencode testdata README). Five further observed bus types
(`plugin.added`, `catalog.updated`, `integration.updated`,
`reference.updated`, `project.directories.updated`) deliberately surface as
bounded drift warnings. The Gemini hook adapter is blocked as
planned: Google decommissioned classic Gemini CLI service for individual
accounts (the installed 0.46.0 client fails auth with `IneligibleTierError
UNSUPPORTED_CLIENT`), so its 11-hook fixture matrix now requires a paid API
key or enterprise license. Its replacement, the Antigravity CLI hooks
adapter, is built on that product's five-event contract — see the
[plan amendment](plans/2026-07-25-agent-capture-expansion.md#priority-5--add-gemini-cli-hooks)
and [Antigravity research](research/2026-08-07-antigravity-capture-surface-research.md).
The Antigravity adapter maps all five hook families against the sanitized
real agy 1.1.10 corpus (`internal/adapters/antigravity/testdata/`, eight
fixtures with per-event provenance since the payloads name no event
themselves). Error-populated `PostToolUse` and `Stop` variants were not
triggerable live (a failing `run_command` still carried `error: ""`), so
those branches are proven by value-substituted real fixtures and remain
flagged until genuine captures exist; session start/end, notification,
compression, and tool-selection coverage does not exist in this source, and
Antigravity has no local OTel route.
Pi and GitHub Copilot CLI are not installed, so their adapter milestones also
remain blocked by the plan's real-fixture STOP condition. No payload is
invented to claim support.

Claude `WorktreeCreate` is deliberately not installed: registering that hook
replaces Claude's built-in worktree creation, and a neutral observer cannot
return the required path safely. `FileChanged` is also not installed until a
user supplies a bounded filename matcher. These are visible filtered coverage
gaps, not silent omissions.

`firehose install claude-otel` is a separate opt-in. It writes only a
loopback OTLP/HTTP JSON environment block when no user, process, or managed
telemetry setting already exists. The receiver ignores all OTLP resource
attributes and never retains raw OTLP, prompt/response/body attributes, or
account, organization, email, host, installation, and user identity fields.
Claude hooks remain the daemon-optional baseline when this supplemental
receiver is unavailable.
