# Agent Firehose

A local-first developer tool that shows a live, structured timeline of what AI
coding agents are doing on your Mac. Like a Twitter firehose, but for agent
activity: fast, scrollable, information-dense, readable.

```
AGENT FIREHOSE  ● LIVE  1,204 events
10:04:12 │ [claude]   [prompt]     prompt: "fix the login bug"            …/dev/app
10:04:15 │ [claude]   [shell]      ran: go test ./...                     …/dev/app
10:04:19 │ [codex]    [file]       patched router.ex, health.ex           …/dev/api
10:04:20 │ [opencode] [permission] permission requested: Run: rm -rf build
10:04:21 │ [claude]   [file]       ran Edit on auth.go ×3                 …/dev/app
space pause · ↑/↓ scroll · enter detail · f category · a source · / search · t density · e export · q quit
```

Everything runs on-device. No backend, no accounts, no sync, no telemetry.

## Install

```sh
go install agentfirehose/cmd/firehose@latest   # or: git clone && go build ./cmd/firehose
```

Put the `firehose` binary on your `PATH`, then wire up the agents you use:

```sh
firehose install claude-code   # merges hooks into ~/.claude/settings.json (backs it up first)
firehose install opencode      # writes a plugin into ~/.config/opencode/plugin/
firehose doctor                # verify everything is wired
firehose                       # open the live view
```

Codex needs no install step — the viewer tails `~/.codex/sessions` directly.

## Supported sources

| Source | Depth | How it works |
|---|---|---|
| Claude Code | deep | hooks forward every lifecycle event to `firehose emit` |
| Codex | deep | viewer tails rollout session JSONL files |
| OpenCode | deep | plugin forwards bus events to `firehose emit` |
| any process | shallow | process watcher emits start/stop for known agent binaries |
| anything else | generic | pipe NDJSON into `firehose ingest`, or call `firehose emit` |

## The viewer

- **live mode** pins to the bottom; `space` pauses and counts unread events
- `f` cycles category filter (session/prompt/message/tool/file/permission/shell/error/meta)
- `a` cycles source filter, `/` searches summaries
- `enter` opens a detail pane with the full structured payload
- `t` toggles compact density, `e` exports the current view to NDJSON
- bursty repeats coalesce into one row with a `×N` counter
- adapter failures and unparseable lines surface *in the timeline* as `meta/warn` events

## Privacy modes

Set in `~/.agentfirehose/config.json` (`{"privacy_mode": "balanced"}`):

- `minimal` — payload values stored as `{sha256, len}` digests only
- `balanced` (default) — payload strings truncated to 240 chars, raw payloads dropped
- `full` — everything, including raw source payloads

Captured events live in `~/.agentfirehose/spool/*.ndjson`. Delete the
directory to delete your history.

## Export

```sh
firehose export -o events.ndjson    # everything captured
```

Or press `e` in the viewer to export exactly what you're looking at
(filters applied).

## Docs

- [Adapter guide](docs/adapters.md) — how each adapter works and how to add one
- [Contributing](CONTRIBUTING.md)

## License

MIT
