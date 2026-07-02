# Adapter guide

Every capture path produces the same normalized envelope (`internal/event`):

```json
{
  "id": "…", "time": "…", "source": "claude-code", "agent": "claude",
  "session_id": "…", "category": "shell", "name": "PostToolUse:Bash",
  "severity": "info", "summary": "ran: go test ./...",
  "cwd": "/repo", "payload": { }, "raw": "…"
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
   (Codex) are tailed by the viewer directly and are not re-persisted.

## Claude Code (deep)

`firehose install claude-code` merges hook entries into
`~/.claude/settings.json` (a `.bak` backup is written first; existing hooks
are preserved; reruns are idempotent). Each hook pipes its JSON payload to
`firehose emit --source claude-code`.

Hooked events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
PostToolUse, Notification, Stop, SubagentStop, PreCompact. Mapping highlights:
`Bash` tools → `shell`, `Edit/Write/MultiEdit/NotebookEdit` → `file`,
`Notification` → `permission`.

## Codex (deep)

No install. The viewer walks `~/.codex/sessions/**/rollout-*.jsonl`, skips
pre-existing content to its end, and streams appended lines. Files created
after startup (new sessions) are read from the top.

Line mapping: `session_meta` → session start; `event_msg` `user_message` /
`agent_message` → prompt/message; `exec_command_end` → shell (non-zero exit →
warn); `patch_apply_end` → file (failure → error); `web_search_end` → tool;
`task_started`/`task_complete` → session; errors → error. Token counts,
encrypted reasoning, and duplicate call records are skipped deliberately.

## OpenCode (deep)

`firehose install opencode` writes `~/.config/opencode/plugin/agent-firehose.js`.
The plugin subscribes to the OpenCode event bus and forwards each event to
`firehose emit --source opencode` (the binary must be on OpenCode's PATH).

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
