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
are preserved; reruns are idempotent). Each hook pipes its JSON payload to
`firehose hook-forward --source claude-code`, which never lets capture errors
interrupt Claude Code and records a best-effort warning when the spool remains
writable.

Hooked events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
PostToolUse, PostToolUseFailure, Notification, Stop, StopFailure,
SubagentStop, PreCompact. Mapping highlights: `Bash` tools → `shell`,
`Edit/Write/MultiEdit/NotebookEdit` → `file`, `Notification` → `permission`,
and response failures → `error`.

Claude hook events preserve native `prompt_id` and map `tool_use_id` to the
envelope's `call_id`. Tool lifecycle payloads retain only the tool name,
start/end phase, started/success/error/interrupted status, native
`duration_ms`, and interruption flag. `StopFailure` retains only Anthropic's
documented bounded API error class, mapping future unknown values to `unknown`.
The default balanced privacy path does not persist prompt or notification
message bodies, transcript paths, tool inputs, tool responses, or detailed
error text. Full privacy mode may still retain the original hook JSON in
`raw`; this is the existing explicit opt-in behavior.

## Codex (deep)

Codex has two complementary observational transports:

- The engine tails `~/.codex/sessions/**/rollout-*.jsonl`. On first activation
  it baselines existing files without importing history. Per-file offsets and
  parser context are checkpointed only after a synchronous spool append, so
  lines written while the daemon is down are recovered at least once after
  restart. A corrupt checkpoint is quarantined, safely re-baselined, and
  surfaced as a warning instead of disabling capture. Rollouts are
  authoritative for streaming assistant commentary.
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

Mapping highlights: `session.*` → session (errors → error), `message.updated`
→ prompt/message by role, tool parts → shell/file/tool once they reach a
terminal state (streaming text parts are skipped), `permission.*` →
permission, `file.edited` → file.

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
