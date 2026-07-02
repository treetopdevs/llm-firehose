# Agent Firehose v0.1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A local-first macOS Go binary (`firehose`) that shows a live, structured, filterable timeline of AI coding-agent activity (Claude Code, Codex, OpenCode, generic NDJSON, process watcher) in a TUI, with local NDJSON persistence, privacy modes, and export.

**Architecture:** All capture paths funnel through a normalized `Event` envelope. Hook/plugin-driven sources invoke `firehose emit --source <name>` which parses the raw payload, applies privacy redaction, and appends one NDJSON line to a daily spool file in `~/.agentfirehose/spool/`. The viewer (`firehose view`, default command) tails the spool, tails Codex rollout JSONL session files directly, and runs a process watcher; everything merges into an in-memory ring buffer rendered by a Bubble Tea TUI. Export reads spool + ring. `firehose doctor` validates adapter wiring; `firehose install <agent>` wires hooks/plugins.

**Tech Stack:** Go 1.26, charmbracelet/bubbletea + lipgloss + bubbles (TUI), stdlib everywhere else (no SQLite — daily NDJSON spool is the store; YAGNI).

**Capture flow:**

```
Claude Code hooks ─┐
OpenCode plugin  ──┼─► firehose emit ─► normalize ─► redact ─► spool/*.ndjson ─┐
custom NDJSON ─────┘   (stdin JSON)                                            ├─► viewer ring ─► TUI / export
Codex rollout *.jsonl ────────────────► viewer-side tail + normalize + redact ─┤
process watcher (ps polling) ─────────────────────────────────────────────────┘
```

---

### Task 1: Scaffolding (no test — config only)
- `go.mod` (module `agentfirehose`), `.gitignore`, MIT `LICENSE`, stub `README.md`. Commit.

### Task 2: `internal/event` — envelope
Envelope fields: `ID, Time, Source (agent family), Agent, SessionID, Category, Name, Severity, Summary, Repo, CWD, Payload (map), Raw (string, optional)`. Categories: `session, prompt, message, tool, file, permission, shell, error, meta`. Severities: `info, notice, warn, error`.
- Tests: JSON round-trip preserves fields; `Validate` rejects empty source/category/time; unknown category rejected; `NewID` produces unique IDs.

### Task 3: `internal/privacy` — capture modes
`Mode` = `minimal | balanced | full`. `Redact(ev, mode)`: full = untouched; balanced = payload string values truncated to 240 runes, `Raw` dropped; minimal = payload replaced by `{sha256, len}` digests per key, `Raw` dropped, summary kept.
- Tests: each mode's behavior on a sample event with long payload string.

### Task 4: `internal/spool` — writer + reader + tailer
Daily file `<dir>/YYYY-MM-DD.ndjson`, O_APPEND single-write lines. Reader loads recent events (last N across files, ordered). Tailer polls (100 ms) for appended lines and day rollover, emits events on a channel; malformed lines emit a `meta/parse-error` event (FR10).
- Tests: append→read round-trip; multiple appends ordered; tailer sees line appended after start; malformed line surfaces parse-error event; reader lastN across two day files.

### Task 5: `internal/adapters/claudecode` — hook payload → Event
Parse Claude Code hook stdin JSON (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `prompt`, `message`). Map: SessionStart/SessionEnd/Stop→session, UserPromptSubmit→prompt, PreToolUse/PostToolUse→tool (Bash→shell; Edit/Write/MultiEdit/NotebookEdit→file), Notification→permission/meta, error-ish→error.
- Tests: one per mapping; summaries human-readable; unknown hook → meta with warn.

### Task 6: `internal/adapters/codex` — rollout JSONL → Events
Parse `~/.codex/sessions/**/rollout-*.jsonl` lines: `session_meta`→session start; `response_item` payload types `message` (role user/assistant → prompt/message), `function_call`/`local_shell_call`→tool/shell, `function_call_output`→tool; `event_msg` user/agent messages; unknown→skip (nil). Also `Watcher`: scan dir tree for `.jsonl` files, tail each with spool-style polling, track offsets, discover new files.
- Tests: parse each line type from fixture lines; watcher picks up appended line in temp dir.

### Task 7: `internal/adapters/opencode` — plugin payload → Event
Ship a JS plugin (embedded) that forwards opencode `event` hook payloads to `firehose emit --source opencode`. Parser maps `session.created/updated/idle/error`, `message.updated/part.updated` (role→prompt/message, tool parts→tool), `permission.updated/replied`, `file.edited`.
- Tests: mapping per event type; plugin install writes JS file.

### Task 8: `internal/adapters/generic` — NDJSON ingest
Line = either full envelope (used as-is after validate/fill defaults) or arbitrary JSON (wrapped as `meta/ingest` with payload).
- Tests: envelope passthrough; arbitrary JSON wrap; invalid line → parse-error event.

### Task 9: `internal/adapters/procwatch` — process watcher
Poll `ps -axo pid,comm,args` for known binaries (`claude`, `codex`, `opencode`, `aider`, `agy`, `gemini`, `cursor-agent`, `copilot`). Diff pids → session/agent-start & agent-stop events. Injectable lister for tests.
- Tests: start emits event; disappearance emits stop; no dup while running.

### Task 10: `internal/store` — ring buffer + filters
`Ring` (capacity ~20k) with `Add`, `Snapshot`, and `Filter` (agent family/name, repo, cwd, session, category, name, severity, free-text summary substring). Coalescing: consecutive same source+session+category+name within 2 s marked grouped (count).
- Tests: capacity eviction; each filter dimension; free-text; coalesce count.

### Task 11: `internal/tui` — Bubble Tea model
Timeline list, live-follow pinned bottom, pause/resume (space) with unread count, filter prompt (`/` category cycling via `f`, agent via `a`), detail pane (enter) with JSON payload, compact/expanded toggle (`t`), export current view (`e`), quit (`q`). Event rows: time, agent badge, session color, category badge, summary. Throughput counter in status bar.
- Tests: pure Update/View logic — pause stops auto-scroll & counts unread; filter narrows visible; enter opens detail with payload JSON; new event while live scrolls to bottom.

### Task 12: `cmd/firehose` CLI wiring
Subcommands: `view` (default), `emit --source X`, `ingest`, `export [--out f]`, `install <claude-code|opencode>`, `doctor`, `version`. Config `~/.agentfirehose/config.json` (privacy mode, spool dir). `install claude-code` merges hook entries into `~/.claude/settings.json` (backup first). `doctor` checks: binary on PATH, spool writable, hooks present, codex/opencode dirs found.
- Tests: emit writes spooled normalized event (integration via temp HOME); export produces NDJSON; install merges settings without clobbering; doctor reports statuses.

### Task 13: Docs
README (install, quickstart, privacy modes), `docs/adapters.md` (per-adapter wiring + adding your own), `CONTRIBUTING.md`.

**Every task:** write failing test → run (verify RED) → minimal impl → run (verify GREEN) → commit.
