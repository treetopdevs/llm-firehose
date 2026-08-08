# Adapter guide

Every capture path produces the same normalized envelope (`internal/event`):

```json
{
  "id": "…", "time": "…", "capture_time": "…",
  "source": "claude-code", "agent": "claude",
  "session_id": "…", "prompt_id": "…", "call_id": "…",
  "category": "shell", "name": "PostToolUse:Bash",
  "severity": "info", "summary": "Bash completed",
  "cwd": "/repo", "repo_id": "/repo/.git", "worktree_id": "/repo",
  "payload": {
    "tool_name": "Bash", "phase": "end", "status": "success",
    "duration_ms": 4652
  },
  "raw": "…"
}
```

Optional source-native correlation fields (`upstream_event_id`, `prompt_id`,
`message_id`, `parent_id`, `request_id`, and `sequence`) survive the spool,
export, API, and clients unchanged. `transport` records how the observation
arrived and `source_version` is present only when the source supplied or the
adapter actually observed it. See [adapter-capabilities.md](adapter-capabilities.md)
for fidelity and deliberate-filter coverage.

Categories: `session, prompt, message, tool, file, permission, shell, error, meta`.
Severities: `info, notice, warn, error`.

Events reach the viewer two ways:

1. **Spool** — producers run `firehose emit --source <name>` with the raw
   payload on stdin. Emit normalizes, applies the privacy mode, and appends
   one NDJSON line to `~/.agentfirehose/spool/YYYY-MM-DD.ndjson`. The viewer
   tails this directory. The spool *is* the local history.
2. **Direct tail** — sources that already persist their own structured logs
   (Codex) and the process watcher are tailed/polled by the engine. When the
   daemon runs, it redacts these events per the privacy mode and appends them
   to the spool like any other event, so the spool stays the canonical source
   of truth; the daemonless TUI tails Codex files directly without
   re-persisting them.

## Claude Code (deep)

`firehose install claude-code` merges hook entries into
`~/.claude/settings.json` (a `.bak` backup is written first; existing hooks
are preserved; reruns are idempotent). Each Firehose-owned command hook is
asynchronous and pipes its JSON payload to
`hook-forward --source claude-code`, which always returns neutral success,
never makes a policy decision, and records a best-effort warning when the
spool remains writable.

Firehose installs the event families `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `StopFailure`,
`PreCompact`, `Notification`, `SubagentStop`, `Stop`, and `SessionEnd`. All
are fixture-proven except `PreCompact`, whose inherited metadata-only mapping
awaits a real capture. Tool-name matchers are added only to the three tool
hooks. Other documented hook families remain visible coverage gaps until a
genuine payload is captured. `WorktreeCreate` is filtered because merely
registering that hook replaces Claude's built-in worktree implementation and
requires a path result; `FileChanged` is filtered until a bounded filename
watch list is configured.

The safe payload is an explicit metadata allowlist: native
prompt/turn/message/tool/agent IDs, permission mode, effort, tool
name/phase/status/duration/interruption, notification type, and file path for
file tools. `StopFailure` retains only Anthropic's documented bounded API
error class, mapping future unknown values to `unknown`. Prompt text,
assistant text, tool arguments/results, notification bodies, transcript
paths, titles, detailed error text, and elicitation values remain only in
`raw`, so balanced/minimal persistence drops them. `Bash` tools map to
`shell`; file tools map to `file`; a single failing tool is `warn` severity,
while `StopFailure` maps to the `error` category as a session-level failure.

### Claude local OpenTelemetry (supplemental)

`firehose install claude-otel` adds an opt-in Claude settings environment block
for OTLP `http/json` logs and metrics at the daemon's loopback
`POST /v1/logs` and `POST /v1/metrics` endpoints. It refuses to overwrite any
existing user, process, or managed exporter, endpoint, protocol, header,
certificate, or other OTel setting. It never edits shell profiles and does not
enable content-bearing telemetry options.

The receiver limits request size, record count, attribute count, and retained
string size. Malformed individual records return exporter success and create a
bounded warning instead of retry pressure. It allowlists correlation IDs,
model/request/tool/hook metadata, latency, byte counts, tokens, cost, and the
four locally observed usage metrics. All resource attributes, identities,
prompt/response/body fields, and raw OTLP are discarded in every privacy mode.
OTel enriches the hook stream only while the daemon is available.

## Codex (deep)

Codex has two complementary observational transports:

- The engine tails `~/.codex/sessions/**/rollout-*.jsonl` through the reusable
  `internal/durablejsonl` core. On first activation it baselines existing
  files without importing history. Per-file offsets and parser context are
  checkpointed only after a synchronous spool append, so lines written while
  the daemon is down are recovered at least once after restart. Partial
  records wait for completion; truncation, replacement, and rotation reset
  only the affected cursor. A corrupt checkpoint is quarantined, safely
  re-baselined, and surfaced as a warning instead of disabling capture.
  Rollouts are authoritative for streaming assistant commentary.
- `firehose install codex` merges all current lifecycle, permission,
  compaction, subagent, and tool hooks into user-wide `~/.codex/hooks.json`.
  It preserves existing hooks, writes `hooks.json.bak`, and is idempotent.
  Codex requires a separate trust review in `/hooks`. Both `firehose` and
  bundled `firehosed` expose a fail-silent `hook-forward` command that always
  returns `{}` and falls back to direct spool writing if the daemon is down.

Rollouts map prompts, assistant messages, turn lifecycle, commands, patches,
searches, MCP/functions/custom tools, outputs, and errors. They also surface
token/context usage and rate-limit/credit state, plus safe model, effort,
approval, permission, collaboration, and sandbox settings. Tool starts and
ends preserve `turn_id` and `call_id`. Output is normalized to a top-level
string before privacy filtering.

Duplicate `response_item` messages, reasoning/encrypted reasoning, instruction
bodies, and complete world-state contents are skipped. World state emits only
changed section names and the full/update flag. Unknown meaningful record
types produce one adapter-drift warning per type.

Hook and rollout observations both remain in the spool. Live and session
presentation coalesce exact IDs and correlated observations within five
seconds while keeping start and completion phases separate.

Rollout events preserve the rollout timestamp as both `time` and
`source_time`, and separately stamp `capture_time`. If a daemon stops after a
spool append but before advancing its cursor, restart may replay the same
stable ID into the append-only spool; rebuilt/live indexes count that ID once
and still ingest later lines written while the daemon was down.

## OpenCode (deep)

`firehose install opencode` writes `~/.config/opencode/plugin/agent-firehose.js`.
The plugin subscribes to the OpenCode event bus and forwards each event through
the exact binary that installed it using
`hook-forward --source opencode`. The forwarder is fail-silent, and desktop
installs do not depend on a separate `firehose` binary being on `PATH`.

The generated plugin is driven by the same mapped/filtered manifest lists as
the Go parser. It drops text/reasoning deltas and nonterminal tool updates
before spawning a process, forwards mapped event families, and forwards at
most one observation per unknown native type per plugin run. The Go adapter
turns that observation into a bounded `adapter.unknown_event` warning.

Mapping highlights: `session.*` → session (errors → error), `message.updated`
→ prompt/message by role, tool parts → shell/file/tool once they reach a
terminal state (streaming text parts are skipped), `permission.*` →
permission, `file.edited` → file. Shell command text remains only in full-mode
raw input and is never copied into the summary.

## Process watcher (shallow)

The viewer polls `ps` every 2 s for known agent binaries (`claude`, `codex`,
`opencode`, `aider`, `agy`, `gemini`, `cursor-agent`, `copilot`, `goose`,
`amp`) and emits `agent-start` / `agent-stop` session events. Agents already
running when the viewer starts are baselined silently.

## Generic ingest — bring your own agent

Two options, no Go required:

```sh
# stream NDJSON (a full envelope per line passes through; anything else is
# wrapped as a meta event)
my-agent --log-json | firehose ingest

# or emit a single event
echo '{"source":"my-agent","category":"shell","summary":"ran make"}' \
  | firehose emit --source my-agent
```

## Writing a deep adapter in Go

1. Create `internal/adapters/<name>` with a `Parse([]byte) (*event.Event, error)`
   (return `nil, nil` to skip noise) — write the failing tests first from real
   captured payloads.
2. Wire it into `Emit` in `internal/cli/cli.go` (push model) or add a watcher
   goroutine in `cmd/firehose/main.go` (tail model).
3. Add a `doctor` check in `internal/cli/doctor.go` and, if setup is needed,
   an `install` step in `internal/cli/install.go`.
