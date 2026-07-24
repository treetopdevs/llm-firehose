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
firehose install codex         # adds lifecycle/tool hooks; review trust in Codex /hooks
firehose install opencode      # writes a plugin into ~/.config/opencode/plugin/
firehose doctor                # verify everything is wired
firehose                       # open the live view
```

Codex assistant messages need no hook: the engine durably tails
`~/.codex/sessions`. Installing Codex hooks adds lifecycle, permission, and
tool observations without replacing rollout message streaming.

## The daemon

The capture engine can run as a long-lived local daemon that owns the spool
and serves a localhost API (default `127.0.0.1:4517`):

```sh
firehose daemon            # run the engine: watchers, spool writes, local API
firehosed                  # same engine as a dedicated binary (used as the desktop sidecar)
firehose status            # is it running? which version/schema?
```

When the daemon is running, `firehose emit` (and every installed adapter)
routes payloads through it, and the TUI consumes its live stream instead of
tailing files itself. When it isn't, everything falls back to direct spool
access — capture never depends on the daemon being up. The API surface
(events, live SSE stream, sessions, doctor, export) is documented in
[docs/contracts.md](docs/contracts.md).

## The desktop app

A Tauri shell in [apps/tauri-desktop](apps/tauri-desktop) wraps the engine
for non-terminal users: live feed, session explorer, touched-file view,
doctor with one-click adapter install, settings, and a first-run onboarding
wizard. It bundles `firehosed` as a sidecar and spawns it when no daemon is
already running — a daemon you run yourself always wins.

```sh
scripts/build-sidecar.sh                    # compile firehosed into the sidecar slot
pnpm -C apps/tauri-desktop install
pnpm -C apps/tauri-desktop tauri dev        # develop
pnpm -C apps/tauri-desktop tauri build      # package (.app / .msi / AppImage)
```

Packaging for macOS, Windows, and Linux is validated in CI
([desktop workflow](.github/workflows/desktop.yml)); signing and the update
feed are documented in the [release runbook](docs/release-runbook.md).

## Supported sources

| Source | Depth | How it works |
|---|---|---|
| Claude Code | deep | hooks forward every lifecycle event to `firehose emit` |
| Codex | deep | durable rollout tail plus optional lifecycle/tool hooks |
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

- [Platform contract](docs/contracts.md) — frozen surfaces: envelope schema, spool/export formats, privacy semantics, local API
- [Event schema](docs/event.schema.json) — JSON Schema for the normalized envelope
- [Adapter guide](docs/adapters.md) — how each adapter works and how to add one
- [Migration plan](docs/agent-firehose-migration-plan.md) — daemon → desktop shell → optional cloud (with status)
- [Compatibility](docs/compatibility.md) — daemon/UI schema-version rules
- [Release runbook](docs/release-runbook.md) — signing, packaging, updater feed
- [Pain review](docs/migration/pain-review.md) — Phase 4 engine decision framework
- [Cloud control plane](docs/architecture/cloud-control-plane.md) — Phase 5 design (deferred)
- [Contributing](CONTRIBUTING.md)

## License

MIT
