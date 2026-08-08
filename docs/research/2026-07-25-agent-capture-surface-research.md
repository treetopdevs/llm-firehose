# Agent capture surface research

Date: 2026-07-25

## Executive answer

Yes. Agent Firehose can capture substantially more useful activity without
capturing substantially more sensitive text.

The highest-value missing signals are:

- source-native correlation: prompt, message, request, tool-call, parent, and
  upstream event IDs;
- source timestamps and event sequence numbers;
- tool completion, failure, duration, retry, and permission-decision metadata;
- model, token, cache-token, cost, finish-reason, and rate-limit metadata;
- compaction, context pressure, session status, task/subagent, worktree, and
  configuration lifecycle events;
- explicit adapter coverage and drift warnings when an upstream event is
  observed but not understood.

The best near-term work is not a transcript scraper. It is:

1. expand the OpenCode parser, because the installed plugin already receives a
   much larger typed event bus;
2. expand Claude Code hook coverage and preserve its native IDs/timing;
3. add a local Claude Code OpenTelemetry receiver for cost, tokens, request
   timing, decisions, retries, and attribution;
4. add Gemini CLI through its official hooks;
5. add Pi through its versioned append-only session log, optionally augmented
   by a fail-silent extension;
6. add GitHub Copilot CLI, whose documented local session log, hooks, and local
   OpenTelemetry exporter make it an unusually complete future adapter.

Raw prompts, assistant text, reasoning streams, full tool results, full diffs,
model request bodies, credentials, identity attributes, and elicitation form
values should remain out of the default capture profile.

## Current Firehose baseline

This assessment is based on the current working checkout, including its
in-progress additive correlation and timing fields.

| Source | Current capture seam | What Firehose currently handles | Largest visible gap |
| --- | --- | --- | --- |
| Claude Code / Cursor-compatible hooks | Hook forwarder | Nine Claude lifecycle/tool events; a small Cursor-compatible alias set | Most current hook events and common correlation/timing fields |
| OpenCode | Global plugin event callback | Session basics, messages, terminal tool parts, permissions, file edits | The plugin receives far more events than the parser maps |
| Codex | Hook plus durable rollout JSONL | Strong turn/call correlation, token/rate/model/settings/subagent data, durable replay | Mostly coverage accounting and multi-transport deduplication |
| Generic / process watch | Manual JSON and process observation | Presence and basic process activity | Intentionally shallow; should not pretend to be semantic capture |

Relevant local sources:
[event envelope](../../internal/event/event.go),
[Claude adapter](../../internal/adapters/claudecode/claudecode.go),
[OpenCode adapter](../../internal/adapters/opencode/opencode.go), and
[adapter documentation](../adapters.md).

## Recommended normalized metadata

Keep universal semantics small. Promote fields only when multiple sources
provide the same concept; leave source-specific details in a safe, allowlisted
payload until their meaning is proven.

| Candidate | Why it matters | Likely sources | Recommendation |
| --- | --- | --- | --- |
| `upstream_event_id` | Stable deduplication and replay | OpenCode v2, durable logs | First-class optional field |
| `prompt_id` | Correlates prompt, turn, and telemetry | Claude hooks/OTel | First-class optional field |
| `message_id` | Correlates response, parts, tools, usage | Claude, OpenCode, Pi | First-class optional field |
| `parent_id` | Exact causal/session tree | OpenCode, Pi, ACP | First-class optional field |
| `request_id` | Connects agent turn to model request | Claude OTel, Copilot OTel | First-class optional field |
| `sequence` | Orders equal-timestamp or streamed events | Claude OTel and other logs | Optional integer/string with source-defined scope |
| `duration_ms` | Cross-source latency and tool duration | Most deep sources | Payload first; promote after unit/scope audit |
| model/provider, tokens, cost, finish | Core usage data | Claude, OpenCode, Pi, Gemini, Copilot | Typed source payload first |
| phase/status | Start, progress, success, failure | Every tool stream | Preserve native phase; normalize conservatively |
| adapter/upstream version | Explains schema drift | Every source | Add capture capability metadata |

`source_time` and `capture_time` are already being added in the current
checkout. Every adapter should populate them consistently and never invent a
source clock. Stable source IDs should replace time-window heuristics when two
transports observe the same action.

## Claude Code

### Hook surface

The current official reference lists 30 lifecycle events when the display-only
`MessageDisplay` stream is included; Firehose installs nine. The most useful
additions are:

| Event group | Metadata worth retaining | Default content policy |
| --- | --- | --- |
| Common hook input | `prompt_id`, `transcript_path`, `permission_mode`, effort level/downgrade, `agent_id`, `agent_type` | Keep IDs/modes; path follows path privacy rules |
| Tool lifecycle | `tool_use_id`, tool name, duration, success/failure, interrupt flag, error class | Keep bounded error metadata; drop full input/output by default |
| Permission lifecycle | request, suggestions, denial reason, decision source | Keep decision and source; drop sensitive arguments |
| Session lifecycle | startup/resume/clear/compact/fork, model, session title, end reason | Keep enum/model; title only in permissive mode |
| Subagent/task lifecycle | agent/task IDs and types, task state, background-task state | Keep IDs/types/state; drop task descriptions by default |
| Stop/failure | stop status, background-task counts, cron counts, rate/auth/billing/server/max-token class | Keep counts and error class |
| Workspace/config | instruction load reason, config source, CWD change, watched file change, worktree create/remove | Keep source/path under configured path privacy |
| Compaction | manual/auto trigger, completion, token counts or summary size/hash | Never persist full compacted summary by default |
| Elicitation | MCP server, mode, elicitation ID, action | Never persist form values, auth URLs, or returned secrets |
| Display stream | turn/message IDs, delta index, final flag | Skip delta text; only use if IDs cannot be sourced elsewhere |

The common fields alone close important holes in the current adapter:
`tool_use_id` maps naturally to `call_id`; `prompt_id` gives turn-level
correlation; `duration_ms` and failure hooks distinguish started, successful,
failed, and interrupted tools. Notifications also need their native type:
permission prompts, authentication, elicitation, and completed background
agents should not all be classified as permission activity.

The forwarder must always return an empty/no-decision response and exit
successfully. Firehose is an observer, not a policy hook, and must not block a
tool or agent if capture fails. Even neutral command hooks are synchronous and
in-band unless configured asynchronously, so durable logs or local
OpenTelemetry are more passive observation seams.

Primary sources:
[Claude Code hooks reference](https://code.claude.com/docs/en/hooks) and
[hooks guide](https://code.claude.com/docs/en/hooks-guide).

### Local OpenTelemetry

Claude Code's official OpenTelemetry surface is a better metadata source than
transcript parsing for:

- event sequence, prompt ID, message UUID, request/client-request IDs;
- model, latency, retries, refusals, API errors, and internal errors;
- input/output/cache tokens and monetary cost;
- tool duration, success, error type, input/result sizes, and permission
  decision/source;
- permission-mode changes;
- hook registration/execution outcome and duration;
- compaction trigger, pre/post token counts, outcome, and duration;
- skill, plugin, MCP, agent, and query-source attribution;
- active time and aggregate lines/commits/pull-request counters.

Firehose could expose a localhost OTLP/HTTP JSON receiver and configure only
local export. It should use a strict attribute allowlist and strip account,
organization, installation, and email-like identity attributes at the adapter
boundary.

Do not enable content-bearing telemetry options by default, including user
prompts, assistant responses, tool details/content, or raw API bodies. Those
options can disclose complete conversations, source, outputs, and secrets.

Primary source:
[Claude Code monitoring and OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage).

### Transcript and status-line seams

Claude's project session files contain complete conversation transcripts and
could supply exact parent/message causality. They are high-privacy and less
contractual than hooks or telemetry, so transcript tailing should be an
Adapter Lab or explicit opt-in mode, not the default.

The status-line input includes session/model, CWD/worktree, cost, duration,
lines changed, context usage, and rate-limit windows. Wrapping the singleton
status-line command risks conflicting with the user's UI configuration.
OpenTelemetry should supply most of this data; status-line wrapping is only a
fallback for fields such as current rate-limit state.

Primary sources:
[Claude Code data and session storage](https://code.claude.com/docs/en/claude-directory)
and
[status-line reference](https://code.claude.com/docs/en/statusline).

## OpenCode

The installed Firehose plugin already receives OpenCode's global event
callback. The high-return change is parser expansion, not a new transport.

### Legacy/current SDK events worth mapping

- message identity and ancestry, created/completed timestamps, provider/model,
  mode, working/root directory, finish reason, error, cost, input/output/
  reasoning/cache tokens;
- tool-part `callID`, source timestamps, start/end duration, terminal output
  metadata, error, and attachments;
- step start/finish, snapshot/patch metadata, retry, compaction, agent changes;
- session status (`busy`, `retry`, `idle`), compaction, update, diff summary,
  parent session, title/version, and created/updated times;
- todo lifecycle, command execution, permission request/reply;
- VCS branch changes, file watcher events, PTY lifecycle, LSP diagnostics, and
  message/part removals.

### V2 events to feature-detect

OpenCode's newer generated types add a source event ID and explicit events for:

- session next-agent/model, prompt queue/admission, move, context, and synthetic
  work;
- shell start/end with timestamp, message ID, call ID, command, and result;
- step start/end/failure with cost, tokens, finish, snapshot, and file set;
- tool input/start/progress/called/success/failure with assistant message ID,
  call ID, timestamps, output paths, and provider execution metadata;
- retry, compaction streaming, revert staging/commit;
- permission and question request/reply/reject;
- workspace/worktree ready/failure/status, MCP tool changes, and project
  updates.

Do not forward text/reasoning deltas or full before/after diffs into the spool.
Filter them before spawning the Firehose process. Unknown event types should
produce a bounded `meta/warn` drift event or counter rather than disappearing
silently.

Primary sources:
[OpenCode plugin callback](https://github.com/anomalyco/opencode/blob/5e2a6257b22c0141a20c281f4c2a641311afe5a5/packages/plugin/src/index.ts),
[generated event types](https://github.com/anomalyco/opencode/blob/5e2a6257b22c0141a20c281f4c2a641311afe5a5/packages/sdk/js/src/gen/types.gen.ts),
and
[v2 generated event types](https://github.com/anomalyco/opencode/blob/5e2a6257b22c0141a20c281f4c2a641311afe5a5/packages/sdk/js/src/v2/gen/types.gen.ts).

## Pi coding agent

Pi has two complementary official surfaces.

### Durable session JSONL

Pi's versioned v3 session format is append-only and organized by working
directory. A session header records ID, timestamp, CWD, and optional parent
session. Every entry has its own ID, parent ID, and timestamp, giving Firehose
exact causal trees rather than heuristic grouping.

Useful entry types include:

- messages and tool results with model usage/cost/cache data;
- model and thinking-level changes;
- compaction with tokens-before, retained-entry boundary, usage, and whether a
  hook supplied it;
- branch summaries and tree navigation;
- session name/info and labels.

A cursor-checkpointed tailer, modeled after the Codex durable adapter, is the
best default Pi integration. Extract metadata from content-bearing records;
do not persist full messages, compacted summaries, or custom extension details
in the default profile.

### Live extension events

A global fail-silent extension can add live visibility for:

- session start/resume/new/fork/switch/tree/compact/shutdown;
- agent start/end/settled and turn start/end;
- tool start/update/end with call ID, error, partial result, and usage;
- model/thinking-level selection, retry and queued steer/follow-up input;
- pre/post provider request status and safe response headers;
- user shell commands and resource discovery.

It must catch every exception and return no policy decision. In particular, a
failing pre-tool extension handler must never block the tool.

Primary sources:
[Pi session format](https://github.com/earendil-works/pi/blob/8eef62ed3ea62d646a7fad92fa583fc8d71fec17/packages/coding-agent/docs/session-format.md),
[extension events](https://github.com/earendil-works/pi/blob/8eef62ed3ea62d646a7fad92fa583fc8d71fec17/packages/coding-agent/docs/extensions.md),
[extension type definitions](https://github.com/earendil-works/pi/blob/8eef62ed3ea62d646a7fad92fa583fc8d71fec17/packages/coding-agent/src/core/extensions/types.ts),
and
[session manager](https://github.com/earendil-works/pi/blob/8eef62ed3ea62d646a7fad92fa583fc8d71fec17/packages/coding-agent/src/core/session-manager.ts).

## Gemini CLI

Gemini CLI is a strong next deep adapter because it is installed locally and
has an official hook contract.

Its eleven hook points cover session start/end, before/after agent, before/
after tool, notifications, pre-compression, before/after model, and before tool
selection. Common input includes session ID, transcript path, CWD, event name,
and a source timestamp.

Useful safe metadata includes:

- tool and MCP server/name, completion/failure, and bounded error information;
- session reason, notification type, and compression trigger;
- model and generation settings;
- response finish reason and safety-block flags;
- prompt/candidate/total token counts;
- selected-tool count/mode.

Before/after-model payloads can contain full request messages, response text,
MCP URLs, and other sensitive content. The adapter should extract only
allowlisted metadata and discard content before persistence. As with Claude,
the hook forwarder must emit no decision and exit successfully.

Gemini also supports local OpenTelemetry. It can add tool decisions and
duration, API usage and finish reason, retry/fallback/recovery, model routing,
compression, agent timing, security verdicts, and startup phases. Prefer an
allowlisted local exporter with prompt logging disabled.

Primary sources:
[Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/),
[hook types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/types.ts),
[hook translation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookTranslator.ts),
and
[Gemini telemetry](https://geminicli.com/docs/cli/telemetry/).

## GitHub Copilot CLI

Copilot CLI is a notable additional target because it offers three documented
local capture seams:

1. `~/.copilot/session-state/<session-id>/events.jsonl`, plus workspace plans,
   checkpoints, tracked files, and artifacts;
2. lifecycle hooks for session, prompt, tool success/failure, permission,
   agent/subagent, error, compaction, and notification activity;
3. OpenTelemetry through a local JSONL file exporter or OTLP.

Its telemetry can provide session, turn, interaction, and tool-call IDs;
requested/resolved model; time to first token and server duration; input,
output, and cache tokens; cost/AI-unit usage; tool duration/success; lines
changed; hook lifecycle; compaction/truncation; and skill attribution. Full
prompt and result content is opt-in and should remain disabled.

Prefer the supported local telemetry exporter and hooks. The session
`events.jsonl` is documented as recovery state, but its individual record
schema is not a public capture contract; treat it as an internal passive file
with version/drift checks.

This may be the cleanest new telemetry-plus-live adapter after the currently
installed Claude/OpenCode/Gemini sources.

Primary sources:
[Copilot CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
and
[Copilot CLI OpenTelemetry reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#opentelemetry-monitoring).

## Cursor

Cursor's documented `--print --output-format stream-json` mode exposes session,
model, permission mode, tool-call IDs, tool arguments/results, request ID, and
duration. That seam only covers non-interactive print mode; wrapping ordinary
interactive execution would change the user's workflow and is not a default
capture strategy.

The existing Claude adapter accepts a small Cursor-style camelCase hook shape,
but it does not install or validate a complete Cursor hook configuration. A
proper Cursor adapter should wait for real captured fixtures from the installed
version, explicitly strip identity fields, preserve tool failure semantics,
and report unsupported events. Rank it after sources with versioned public
contracts.

Primary source:
[Cursor CLI output formats](https://docs.cursor.com/en/cli/reference/output-format).

## ACP and other agents

### Agent Client Protocol

ACP's `SessionUpdate` union includes user/agent/thought chunks, tool calls and
updates, plan changes, commands, modes, configuration, session information,
and usage updates; permission requests are also protocol operations.

An opt-in local ACP proxy could become a multi-agent capture multiplier. It is
not a first adapter: a proxy sits in the control path and therefore needs a
strict transparent/fail-open design so Firehose never becomes an agent
availability dependency.

Primary sources:
[ACP protocol](https://agentclientprotocol.com/) and
[SessionUpdate types](https://agentclientprotocol.github.io/typescript-sdk/types/SessionUpdate.html).

### Goose

Goose documents a local SQLite session database containing session metadata,
messages, tool calls/results, arguments, responses, and success/failure. A
read-only incremental adapter is possible, but the database schema is an
internal storage detail and can migrate. Prefer a documented ACP/API seam when
available; otherwise require schema/version checks and never lock or mutate the
database.

Primary sources:
[Goose logs](https://goose-docs.ai/docs/guides/logs/),
[session management](https://goose-docs.ai/docs/guides/sessions/session-management/),
and
[Goose ACP support](https://block.github.io/goose/).

### Aider

Aider can write a local analytics event log and separate chat/input/raw-LLM
history files. The analytics record includes event name, timestamp, an
installation user ID, model names, system/version properties, and
event-specific properties. It is lower priority: the analytics vocabulary is
an implementation detail, the installation ID should be discarded, and
history files are content-heavy. If added, consume only a user-enabled local
analytics log through a field allowlist; do not turn on network analytics.

Primary sources:
[Aider analytics implementation](https://github.com/Aider-AI/aider/blob/main/aider/analytics.py)
and
[Aider configuration sample](https://github.com/Aider-AI/aider/blob/main/aider/website/assets/sample.aider.conf.yml).

### Roo Code, Cline, and Continue

Roo Code exposes a typed live VS Code extension API covering task lifecycle,
delegation, messages, token usage, tool failures, mode/model switches,
compaction/truncation, and parent-child tasks. A companion extension is
preferable to tailing its internal task files.

Cline documents hooks for task lifecycle, prompts, tool calls, failures, and
compaction. Common fields include task ID, version, timestamp, workspace roots,
and model; tool completion includes success and duration. Its enterprise
OpenTelemetry catalog is richer but should not be assumed available to every
local user.

Continue persists local CLI sessions with workspace, mode, model, token/cost
totals, history, tool-call state, reasoning, and applied rules. The persisted
session is currently the practical seam; content-bearing records require the
same metadata-only extraction policy as other transcript stores.

Primary sources:
[Roo event types](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/packages/types/src/events.ts),
[Roo extension API](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/extension/api.ts),
[Cline hooks](https://docs.cline.bot/customization/hooks),
[Cline OpenTelemetry events](https://docs.cline.bot/enterprise-solutions/monitoring/opentelemetry-events),
[Continue session implementation](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/session.ts),
and
[Continue CLI guide](https://docs.continue.dev/cli/quickstart).

### Owned-run protocols

Codex app-server, Pi RPC/JSON mode, and similar machine protocols expose rich
structured streams, but only when Firehose launches, hosts, or proxies the
agent. Classify these as owned-run transports rather than ambient observation.
They should not quietly replace direct agent invocation or put Firehose in the
availability path.

## Cross-adapter safeguards

### Privacy

Apply a source-specific allowlist before the generic privacy transform.
Balanced mode truncates strings; it does not make arbitrary attributes safe.
Drop by default:

- prompts, assistant messages, reasoning/thinking, system prompts;
- tool input/output bodies, full diffs, file contents, compacted summaries;
- raw model requests/responses and request/response headers;
- emails, account/organization IDs, installation IDs;
- authorization URLs, elicitation form values, credentials, tokens, and
  environment variables.

Keep content-derived sizes, hashes, counts, enums, IDs, timing, token/cost
numbers, and bounded error classes where useful.

### Coverage and drift

Every deep adapter should publish:

- upstream product/version and transport (`hook`, `otel`, `jsonl`, `plugin`);
- native event types observed, mapped, deliberately skipped, and unknown;
- a bounded warning for a newly observed event or shape;
- cursor/replay health and last source timestamp;
- deduplication key and which transport supplied an observation.

This turns “no events” into an explainable state rather than apparent success.
Useful fidelity labels are: supported passive stream/exporter, supported
in-band hook, passive versioned file, passive internal file, owned-run
protocol, and process-only detection.

### Multi-transport deduplication

Claude hooks plus OTel, Codex hooks plus rollout JSONL, and Pi extensions plus
session JSONL can observe the same operation. Prefer exact native IDs:
tool-use/call ID, prompt ID, message ID, request ID, upstream event ID, and
source timestamp/sequence. Keep distinct start/progress/end phases; coalesce
only proven duplicate observations.

## Suggested implementation sequence

1. Define the small correlation-field additions and adapter capability/drift
   record. Complete source/capture-time consistency and source-specific privacy
   allowlists.
2. Expand OpenCode's parser and move high-volume delta filtering into the
   plugin before process spawn.
3. Expand Claude hook registration and parsing, starting with tool failure,
   permissions, subagents/tasks, compaction, workspace changes, and common IDs.
4. Add a localhost Claude OTLP/HTTP receiver with content telemetry disabled.
5. Add Gemini hooks using real payload fixtures from the installed CLI.
6. Add Pi's durable v3 JSONL tailer, then optionally its live extension.
7. Add Copilot CLI durable log/hooks/OTel when the binary is in the supported
   test matrix.
8. Validate Cursor fixtures; then consider ACP, Goose, and Aider as broader but
   less stable integrations.

Every behavior change should begin with a real captured upstream payload
fixture, per the repository's TDD rule. New capture paths should be exercised
with the agent unavailable, Firehose unavailable, malformed payloads, version
drift, restart/replay, and privacy-mode tests.

## Research boundaries

This is a source-contract survey, not live behavioral proof for every agent.
It used current official documentation and upstream source on 2026-07-25,
plus the currently installed local versions where available. Public contracts
and generated event unions can change; implementation should pin real fixtures
and record the observed upstream version.

Local version snapshot:

| Product | Observed local version |
| --- | --- |
| Claude Code | 2.1.218 |
| OpenCode | 1.18.0 |
| Gemini CLI | 0.46.0 |
| Codex CLI | 0.144.5 |
| Cursor agent | 2026.05.05-84a231c |
| Pi, Aider, Goose, Amp, Copilot CLI | Not found on the current `PATH` |
