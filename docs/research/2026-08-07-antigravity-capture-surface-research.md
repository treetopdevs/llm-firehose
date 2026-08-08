# Antigravity capture surface research

Date: 2026-08-07

> **Why this document exists.** This research feeds a plan amendment for
> [the agent capture expansion plan](../plans/2026-07-25-agent-capture-expansion.md).
> That plan's Priority 5 (Gemini CLI hooks, "all 11 hook types" fixture matrix)
> is blocked: Google decommissioned the classic Gemini CLI for individual
> accounts on 2026-06-18, and the block is confirmed locally —
> `IneligibleTierError UNSUPPORTED_CLIENT` observed on gemini-cli 0.46.0 with
> `oauth-personal` auth on 2026-08-07. This document surveys what its
> replacement, Antigravity (`agy`), offers as a capture surface.

## Executive answer

Antigravity CLI (`agy`, observed locally at 1.1.10; upstream latest 1.1.11) has
an **officially documented hook system, but a much smaller one than classic
Gemini CLI**: five events (`PreToolUse`, `PostToolUse`, `PreInvocation`,
`PostInvocation`, `Stop`) versus Gemini CLI's eleven. There is **no documented
local OpenTelemetry or file exporter**; `enableTelemetry` only controls
Google-bound anonymous usage/crash reporting. The local data stores
(`conversations/*.db`, `conversation_summaries.db`, `history.jsonl`,
`brain/<conversation-id>/`) are **internal and undocumented as formats**,
with one partial exception: the hook input contract hands every hook a
`transcriptPath` and `artifactDirectoryPath` pointing into the `brain/` store.
The best-documented machine-readable surface is **headless mode**
(`-p --output-format stream-json`), an NDJSON event stream with per-step
`tool_info` and `subagent_info` — but it only exists for runs Firehose itself
launches. Classic Gemini CLI **survives upstream**: the repo is not archived,
released v0.54.4 on 2026-08-07, keeps its full hook implementation in
`packages/core/src/hooks/`, and remains served for enterprise licenses and
paid API keys — just not for individual OAuth accounts.

Per-claim status labels used below: **documented** (primary source states it),
**observed** (seen locally on disk / in the `agy` 1.1.10 binary), and
**absent** (no primary source addresses it — which for frozen-contract
purposes means "internal, no contract").

## Question 1 — Hook support

**Documented: yes, hooks exist — five events, not eleven.**

Google's transition announcement states Antigravity CLI "retains our most
critical features, including Agent Skills, Hooks, Subagents, and Extensions
(now Antigravity plugins)"
([Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)).

The official hooks reference ([antigravity.google/docs/hooks](https://antigravity.google/docs/hooks),
filed under "Antigravity 2.0 > Customizations", i.e. the shared platform layer
used by both the IDE and the CLI) documents exactly five events:

| Antigravity event | Fires | Event-specific input | Output contract |
| --- | --- | --- | --- |
| `PreToolUse` | before a tool executes | `toolCall` (name + args), `stepIdx` | `decision`: `allow`/`deny`/`ask`/`force_ask`/`deny_unless_prior_grant`; optional `reason`, `permissionOverrides` |
| `PostToolUse` | after a tool completes | `toolCall`, `stepIdx`, `error` | empty object `{}` |
| `PreInvocation` | before the model is called | `invocationNum`, `initialNumSteps` | optional `injectSteps` |
| `PostInvocation` | after each model invocation | `invocationNum`, `initialNumSteps` | optional `injectSteps`, optional `terminationBehavior` (`force_continue`/`terminate`/default) |
| `Stop` | when the execution loop terminates | `executionNum`, `terminationReason`, `error`, `fullyIdle` | required `decision` (`continue` or other), optional `reason` |

Common stdin JSON fields for all events (camelCase): `conversationId`,
`workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`.
Configuration lives in `hooks.json` in `.agents/` (workspace) or
`~/.gemini/config/` (global); handlers are `type: "command"` only, default
timeout 30 s; `PreToolUse`/`PostToolUse` accept tool-name matchers (`""`/`"*"`,
exact names, regex); the other three ignore matchers. Plugins may also ship a
`hooks.json` ([Plugins & Skills](https://antigravity.google/docs/cli/plugins)).

Observed corroboration in the `agy` 1.1.10 binary (strings): exactly the five
event names above appear (`PreToolUse`, `PostToolUse`, `PreInvocation`,
`PostInvocation`, `Stop`), plus hook plumbing (`failed to parse hooks.json`,
`plugins/<name>/hooks.json`, and an `ANTIGRAVITY_CONVERSATION_ID=%s`
environment variable passed to hook commands). A bare `Compress` string also
matches but cannot be attributed to a hook event from strings alone. None of
the classic Gemini names (`BeforeTool`, `SessionStart`, `Notification`,
`PreCompress`, `BeforeToolSelection`, …) appear.

Hooks are in-band and can block: the CLI changelog fixes "stop hooks that
always block hanging the agent forever" and orders user hooks "before the
built-in termination checks"
([CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md)).
The docs are silent on payload-schema stability and on failure semantics.

**Mapping against the classic 11-hook contract** (analysis, not documented —
no primary source maps the two):

| Gemini CLI hook | Antigravity equivalent |
| --- | --- |
| BeforeTool / AfterTool | `PreToolUse` / `PostToolUse` |
| BeforeModel / AfterModel | `PreInvocation` / `PostInvocation` (metadata only — no request/response body fields documented) |
| AfterAgent | approximately `Stop` (loop termination, with `terminationReason`) |
| BeforeAgent | none documented |
| BeforeToolSelection | none documented |
| SessionStart / SessionEnd | none documented |
| Notification | none documented |
| PreCompress | none documented (ambiguous `Compress` binary string only) |

Nothing in the docs, blog, or migration guide announces the missing six as
planned; they are simply absent.

## Question 2 — Telemetry / OpenTelemetry

**Documented: `enableTelemetry` is Google-bound only. Local export: absent.**

The CLI settings reference
([antigravity.google/docs/cli/settings](https://antigravity.google/docs/cli/settings))
documents `enableTelemetry` (boolean) as sending "anonymous usage statistics
and crash reports" — to Google. No endpoint, exporter, OTLP, log-file, or
collector configuration is documented anywhere on antigravity.google. The
migration guide
([gcli-migration](https://antigravity.google/docs/cli/gcli-migration)) says
nothing about migrating classic Gemini CLI's rich telemetry configuration
(local OTLP/file exporters per
[geminicli.com/docs/cli/telemetry](https://geminicli.com/docs/cli/telemetry/)).
That surface did not carry over.

Observed locally: `~/.gemini/antigravity-cli/settings.json` contains
`"enableTelemetry": false` alongside `colorScheme`, `model`, and
`trustedWorkspaces`. The binary embeds the OpenTelemetry Go SDK
(`google3/third_party/golang/go_opentelemetry_io/...`), standard `OTEL_*`
limit env-var names, "telemetry client" shutdown strings, and a Prometheus
`promhttp` handler string — so telemetry machinery exists internally, but
there is no documented (or observed) configuration to point it at a local
collector, and whether standard `OTEL_EXPORTER_*` env vars activate anything
is untested. A `cli.log` file and `crashes/` directory exist in the app data
dir; neither is documented.

Conclusion: nothing locally consumable. This is the largest regression versus
classic Gemini CLI, Claude Code, and Copilot CLI, all of which document local
OTel export.

## Question 3 — Local data stores

**Absent from documentation as formats — internal, no contract — with one
documented pointer into them.**

Observed layout under `~/.gemini/antigravity-cli/` (agy 1.1.10):

| Store | Observed shape | Documentation status |
| --- | --- | --- |
| `conversations/<uuid>.db` (+`-shm`/`-wal`) | SQLite, WAL mode; tables `steps`, `trajectory_meta`, `trajectory_metadata_blob`, `parent_references`, `gen_metadata`, `executor_metadata`, `battle_mode_infos` | Undocumented. Binary strings ("serializing trajectory", "trajectory %s not found in any store") confirm it is the live trajectory store |
| `conversation_summaries.db` | SQLite, table `conversation_summaries` | Undocumented (`summary_store: open db` string in binary) |
| `history.jsonl` | one JSON object per prompt: `display`, `timestamp`, `workspace`, `type` (e.g. `slash_command`), `conversationId` | Undocumented |
| `brain/<conversation-id>/` | agent-authored artifacts (task/plan files, `scratch/`), each dir its own git repo; `.system_generated/logs/transcript.jsonl` and `transcript_full.jsonl` (record keys observed: `content`, `created_at`, `source`, `status`, `step_index`, `type`); `.system_generated/messages/*.json`; `.system_generated/tasks/task-N.log` | Directory itself undocumented as a format, **but** the hooks contract documents `transcriptPath` and `artifactDirectoryPath` input fields that resolve into it ([docs/hooks](https://antigravity.google/docs/hooks)) |
| `cli.log`, `crashes/`, `jetski_state.pbtxt`, `installation_id`, `knowledge/`, `presence/`, `implicit/`, `cache/` | misc internal state (internal codename "jetski"/"cortex" per binary strings) | Undocumented |

No antigravity.google page describes any of these on-disk formats, schema
versions, or compatibility guarantees. The changelog even warns that two CLI
instances on one conversation "interleave writes into one trajectory"
([CHANGELOG](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md))
— i.e. Google itself treats the store as a single-writer internal file.
Treat all of the above as internal: passive reading requires drift checks and
must never lock or mutate (WAL SQLite is actively written; `immutable=1`
reads can see torn state on a live db).

### Local schema observations (addendum, 2026-08-07, agy 1.1.10 stores)

Read-only inspection of the stores on this machine adds concrete shapes to the
table above (structure only; no content was extracted):

- `conversations/<uuid>.db` — `steps(idx, step_type int, status int,
  has_subtrajectory, metadata blob, error_details blob, permissions blob,
  task_details blob, render_info blob, step_payload blob, step_format int)`,
  indexed on `status` and `step_type`. Every payload column is a protobuf
  blob (classic wire-format prefixes such as `08 0E 20 03 2A …`) with no
  published schema. Observed `step_type` values in one finished conversation:
  7, 8, 9, 14, 15, 17, 21, 23, 98, 101, 132 — all with `status` 3.
- `conversation_summaries.db` — plain-typed columns:
  `conversation_id, title, preview, step_count, last_modified_time,
  workspace_uris, status, source, project_id, agent_name,
  parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
  not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
  app_data_dir`, indexed on both time columns. Notably this is almost exactly
  the shape of Firehose's derived attention model (`internal/index`):
  status + `not_fully_idle` + `last_user_input_time` per conversation with
  parent/nesting links. If internal-store reading is ever re-scoped, this
  summaries table is the highest-value, lowest-risk seam — but it remains
  undocumented and the same internal-store caveats apply.
- The IDE variant (`~/.gemini/antigravity/`) mirrors this design
  (`conversations/*.db`, `brain/`, plus `mcp_config.json`, `skills/`,
  `global_workflows/`, `knowledge/`, protobuf state files);
  `~/Library/Application Support/Antigravity` holds only Electron chrome, no
  agent stores.
- Corroboration: the five documented hook event names appear in the local
  `agy` 1.1.10 binary strings; `~/.gemini/config/` exists locally
  (`config.json`, `mcp_config.json`, `plugins/`, `projects/`, `sidecars/`)
  with no `hooks.json` yet, matching "hooks not configured".

## Question 4 — Plugin / extension / observation APIs

Four surfaces exist; only hooks and headless mode can observe events.

1. **Plugins** ([docs/cli/plugins](https://antigravity.google/docs/cli/plugins)) —
   namespaced bundles at `~/.gemini/antigravity-cli/plugins/<name>/`
   packaging skills, subagents, MCP configs, rules, and `hooks.json`.
   Documented lifecycle observation is **only via hooks** — there is no
   richer event-subscription API for plugins.
2. **MCP servers** ([docs/cli/mcp](https://antigravity.google/docs/cli/mcp)) —
   configured in `~/.gemini/config/mcp_config.json` (global) or
   `.agents/mcp_config.json` (workspace); stdio or `serverUrl`
   (streamable HTTP/SSE). MCP servers are *called by* the agent; the docs
   describe no way for an MCP server to subscribe to or observe agent
   lifecycle events.
3. **Headless mode** ([docs/cli/headless](https://antigravity.google/docs/cli/headless)) —
   `agy -p "<prompt>" --output-format stream-json` emits documented NDJSON
   events: `init` (cwd, tools, permission_mode, model), `step_update`
   (`conversation_id`, `step_index`, `state`, `step_type` in
   user_input/agent_response/tool/checkpoint, `tool_name`, `text_delta`,
   `duration_seconds`, per-step `usage` tokens, `tool_info` {name,
   parameters, output, error{type,message}}, `subagent_info`
   {type_name, role, conversation_id, log_uri, workspace_uris}), and a
   terminal `result` (status, error, duration_seconds, num_turns, usage with
   input/output/thinking/cache_read/total tokens). `--continue` /
   `--conversation <id>` resume prior conversations. This is the richest
   documented event stream — but it only observes sessions launched through
   it (owned-run, in the July research's taxonomy), not the user's
   interactive sessions.
4. **Antigravity SDK** ([google-antigravity/antigravity-sdk-python](https://github.com/google-antigravity/antigravity-sdk-python)) —
   a Python library "for building AI agents that leverage the full power of
   Google Antigravity", with its own richer hook taxonomy (Inspect/Decide/
   Transform; `PreToolCallDecideHook`, `PostToolCallHook`, `OnToolErrorHook`,
   `OnInteractionHook`, `PreTurnHook`, `PostTurnHook`;
   [hooks README](https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/hooks/README.md)).
   It is a surface for agents you build, not for observing the user's `agy`
   or IDE sessions; no stability guarantees are documented.

Note on source availability: the CLI itself is **closed source**. The
[google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli)
repo (latest release 1.1.11, 2026-08-07) contains only README, CHANGELOG,
examples (statusline, title), and issue tracking — no source code.

## Question 5 — Gemini CLI → Antigravity migration and upstream survival

**Documented timeline and tiers**
([Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/),
[discussion #27274](https://github.com/google-gemini/gemini-cli/discussions/27274)):

| Date | Event |
| --- | --- |
| 2026-05-19 | Antigravity CLI announced/available; 30-day migration window |
| 2026-06-18 | Gemini CLI "will stop serving requests for Google AI Pro and Ultra, as well as those using it free of charge" (individual OAuth tiers) |

**Where the classic hook contract survives (documented):**

- Enterprise: "If your organization uses Gemini CLI … via a Gemini Code
  Assist Standard or Enterprise license … your access remains fully
  supported."
- Paid keys: "Gemini CLI will also remain accessible via paid Gemini and
  Gemini Enterprise Agent Platform API keys" (which includes Vertex-style
  key/enterprise auth paths).
- Repo: "The project remains available to the community as an Apache 2.0
  licensed repository with no changes", maintained with "latest model
  releases, bugs and security fixes for our enterprise customers"
  (maintainer statement in
  [#27274](https://github.com/google-gemini/gemini-cli/discussions/27274)).

**Observed upstream status (2026-08-07/08):**
[google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) is
**not archived**; latest release v0.54.4 published 2026-08-07, pushed
2026-08-08. The hooks implementation is intact at
`packages/core/src/hooks/` (`types.ts`, `hookTranslator.ts`, `hookRunner.ts`,
`hookRegistry.ts`, `trustedHooks.ts`, tests). The
[geminicli.com hooks reference](https://geminicli.com/docs/hooks/reference/)
remains live, documenting all eleven events, with a banner: "Unpaid tier and
Google One users: Gemini CLI will be replaced by Antigravity CLI on
June 18th."

**Migration guide**
([antigravity.google/docs/cli/gcli-migration](https://antigravity.google/docs/cli/gcli-migration)):
documents `agy plugin import gemini` for extensions→plugins, the skills path
move (`.gemini/skills/` → `.agents/skills/`), MCP config extraction into
dedicated files, and context-rule compatibility. It contains **no hook-event
mapping and no telemetry migration guidance** — the 11→5 hook contraction is
undocumented, and classic hook configs do not carry over automatically.

## Implications for Agent Firehose

Viable capture routes, in order of contract strength:

1. **Antigravity hooks adapter (documented, supported — the Priority 5
   replacement).** Merge a Firehose forwarder into `~/.gemini/config/hooks.json`
   (global) — the same merge-with-backup discipline as the Claude installer,
   satisfying the "never overwrite managed hooks" STOP. Register
   `PostToolUse` (tool name/args/error + `stepIdx`), `PostInvocation`
   (invocation counts), and — carefully — `Stop` (`terminationReason`,
   `error`, `fullyIdle`). Every hook receives `conversationId` (native
   correlation ID), `workspacePaths`, and `modelName`. Cautions:
   - hooks are in-band and can block; `PreToolUse` output is a permission
     *decision* and `Stop` output is a required decision whose blocking value
     can force continuation (the changelog documents hang bugs here). To honor
     the plan's "never put Firehose in a decision path" STOP, prefer post-only
     events, and fixture-test the exact non-blocking `Stop` response before
     shipping it — or omit `Stop` entirely at first.
   - coverage is structurally poorer than the planned Gemini adapter: no
     session start/end, notification, compression, or tool-selection events
     exist to capture.
   - payload schema has no documented stability guarantee → capture real
     fixtures from `agy` 1.1.x and record the observed version, per the TDD
     rule.
2. **Headless `stream-json` (documented, owned-run only).** Rich, documented
   NDJSON with `tool_info`, `subagent_info`, per-step usage, and
   `conversation_id`/`log_uri` correlation — but only for sessions Firehose
   launches. Per the plan's taxonomy this is an owned-run transport, which the
   current plan scopes out; note it for a future Adapter Lab mode, not
   ambient capture.
3. **No local OTel route.** Unlike Claude Code / classic Gemini / Copilot,
   there is nothing to receive. Do not enable `enableTelemetry` (Google-bound
   only; irrelevant to local capture).
4. **Internal stores (conversations SQLite, `brain/` transcripts,
   `history.jsonl`).** Undocumented internal formats with observed
   multi-writer hazards. The plan's "Out of scope" already forbids
   tail-reading internal transcript/recovery stores as stable contracts; that
   applies verbatim here. If ever revisited, it would need an explicit
   re-scope decision plus version/drift checks, read-only access, and
   metadata-only extraction — the hook-provided `transcriptPath`/
   `artifactDirectoryPath` fields are the only sanctioned pointers into this
   area, and even they only name paths, not formats.

STOP conditions from the plan that apply now:

- **Fixture STOP (Priority 5):** "Authentication or a paid model call is
  required without explicit approval" / "require paid/authenticated external
  activity not already authorized" — capturing the planned "all 11 hook
  types" Gemini CLI fixtures now requires a paid API key or enterprise
  license; `oauth-personal` fails with `IneligibleTierError
  UNSUPPORTED_CLIENT`. Priority 5 as written cannot proceed on this machine.
- **Decision-path STOP:** an Antigravity `PreToolUse`/`Stop` hook returning
  decisions would "put Firehose in a tool/permission decision path"; the
  replacement adapter must be post-event-only until the neutral responses are
  fixture-proven.
- **Managed-settings STOP:** installation must merge, never overwrite,
  `~/.gemini/config/hooks.json` (shared with the Antigravity IDE and other
  plugins).

Recommended plan amendment: keep the Gemini adapter design shelved (its
upstream contract is alive for enterprise/API-key users and unchanged in the
repo), and replace Priority 5's individual-account milestone with an
Antigravity hooks adapter (`internal/adapters/antigravity/`) built on the
five-event contract, with an explicit coverage note that session, notification,
and compression events are unavailable from this source.

## Primary sources

Antigravity (Google-owned):

- [Transition announcement — Google Developers Blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Official transition discussion #27274 (maintainer statements)](https://github.com/google-gemini/gemini-cli/discussions/27274)
- [Hooks reference](https://antigravity.google/docs/hooks)
- [CLI settings reference](https://antigravity.google/docs/cli/settings)
- [Headless mode](https://antigravity.google/docs/cli/headless)
- [MCP configuration](https://antigravity.google/docs/cli/mcp)
- [Plugins & Skills](https://antigravity.google/docs/cli/plugins)
- [Using AGY CLI](https://antigravity.google/docs/cli/using)
- [CLI features](https://antigravity.google/docs/cli/features) and [CLI reference](https://antigravity.google/docs/cli/reference)
- [Gemini CLI migration guide](https://antigravity.google/docs/cli/gcli-migration)
- [antigravity-cli release/issues repo + CHANGELOG](https://github.com/google-antigravity/antigravity-cli)
- [antigravity-sdk-python hooks README](https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/hooks/README.md)

Classic Gemini CLI:

- [gemini-cli repository (active, v0.54.4 2026-08-07)](https://github.com/google-gemini/gemini-cli)
- [Hooks implementation directory](https://github.com/google-gemini/gemini-cli/tree/main/packages/core/src/hooks)
- [geminicli.com hooks reference (11 events, live)](https://geminicli.com/docs/hooks/reference/)
- [geminicli.com telemetry docs](https://geminicli.com/docs/cli/telemetry/)

## Research boundaries

Documented claims trace to antigravity.google, developers.googleblog.com,
github.com/google-antigravity, github.com/google-gemini, and geminicli.com as
fetched on 2026-08-07. "Observed" claims come from this machine only: the
`agy` 1.1.10 binary (string inspection), `~/.gemini/antigravity-cli/` and
`~/.gemini/config/` contents, and read-only SQLite table listings; record
content was not read beyond structural keys. Where documentation is silent
(local telemetry export, store formats, hook schema stability, the six
missing lifecycle events), silence is reported as the finding — internal, no
contract. Antigravity CLI is closed source, so binary observations cannot be
cross-checked against code; they can drift with any release.

Local version snapshot (2026-08-07):

| Product | Observed local version |
| --- | --- |
| Antigravity CLI (`agy`) | 1.1.10 (upstream latest 1.1.11) |
| Gemini CLI | 0.46.0 (`oauth-personal` → IneligibleTierError UNSUPPORTED_CLIENT) |
| gemini-cli upstream | v0.54.4 released 2026-08-07 |
