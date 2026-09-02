# Agent Firehose

A local-first developer tool that shows a live, structured timeline of what AI
coding agents are doing on your Mac. Like a Twitter firehose, but for agent
activity: fast, scrollable, information-dense, readable.

```
AGENT FIREHOSE  ● LIVE  1,204 events  NEEDS YOU · 1 · approve Run: rm -rf build
│ claude   ▂▄▆█▄▂ ▂▄         │         4s working   ran Edit on auth.go
│ opencode ▂▂  ▄▂     █▌     │         1m NEEDS YOU approve Run: rm -rf build

10:04:12 │ claude   ▸ prompt: "fix the login bug"                   …/dev/app
     :15 │ claude   $ ran: go test ./...
     :19 │ codex    ■ patched router.ex, health.ex                  …/dev/api
     :20 │ opencode ? permission requested: Run: rm -rf build
     :21 │ claude   ■ ran Edit on auth.go ×3                        …/dev/app
? help · esc workspace · l lanes
```

Everything runs on-device. No backend, no accounts, no sync, no telemetry.

## Install

```sh
go install agentfirehose/cmd/firehose@latest   # or: git clone && go build ./cmd/firehose
```

Put the `firehose` binary on your `PATH`, then wire up the agents you use:

```sh
firehose install claude-code   # merges hooks into ~/.claude/settings.json (backs it up first)
firehose install claude-otel   # optional local-only Claude usage/diagnostic stream
firehose install codex         # adds lifecycle/tool hooks; review trust in Codex /hooks
firehose install opencode      # writes a plugin into ~/.config/opencode/plugin/
firehose doctor                # verify everything is wired
firehose                       # open the live view
```

Codex assistant messages need no hook: the engine durably tails
`~/.codex/sessions`. Installing Codex hooks adds lifecycle, permission, and
tool observations without replacing rollout message streaming.

## The daemon

The capture engine can run as a long-lived local daemon host that serves a
localhost API (default `127.0.0.1:4517`):

```sh
firehose daemon            # run the engine: watchers, spool writes, local API
firehosed                  # same engine as a dedicated binary (used as the desktop sidecar)
firehose status            # is it running? which version/schema?
```

When the daemon is running, `firehose emit` (and every installed adapter)
routes payloads through it, and the TUI consumes its live stream instead of
running the engine in process. When it isn't, push adapters use the same
One-shot Admission sequence and the TUI runs the same engine and Sources
locally, including durable Codex and process capture. Capture never depends
on the daemon being up. An OS lock grants Source ownership to exactly one
daemon or daemonless host per user; additional viewers reconcile the shared
spool without duplicating source observations and inherit ownership when it
is released. Live clients bracket replacement streams with durable history
snapshots when a bounded stream disconnects. The API surface
(events, live SSE stream, sessions, doctor, export) is documented in
[docs/contracts.md](docs/contracts.md).

## The desktop app

A Tauri shell in [apps/tauri-desktop](apps/tauri-desktop) wraps the engine
for non-terminal users: dwell bars as the landing view (time in state against
a five-minute hairline), a workspace matrix of repos by agents, live feed,
session lanes on a wall-clock axis, a session band with sparklines, an event
detail that pairs a tool call's request and response, touched-file view,
doctor with one-click adapter install, settings, a first-run onboarding
wizard, and the orbit view as an opt-in ambient display. It bundles `firehosed` as a sidecar and spawns it when no daemon is
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
| Claude Code | deep | asynchronous metadata-only hooks forward through a fail-silent local command |
| Claude Code OTel | supplemental | opt-in loopback request/usage metadata; identity and content are discarded |
| Codex | deep | crash-safe durable rollout tail plus optional lifecycle/tool hooks |
| OpenCode | deep | manifest-filtered plugin forwards high-signal bus events and bounded drift warnings |
| any process | shallow | process watcher emits start/stop for known agent binaries |
| anything else | generic | pipe NDJSON into `firehose ingest`, or call `firehose emit` |

## The viewer

- **live mode** pins to the bottom; `space` pauses and counts unread events
- a **session band** above the feed shows one line per live session: agent, a
  sparkline of events per 30s over the last 5m, time in its current state as a
  **dwell bar** against a hairline at 5m and full at 10m (a session waiting
  past the line is the one you forgot), the engine's state, and what it last
  did; sessions that need you come first, longest wait first
- rows print the clock and workspace only when they change, use one glyph per
  category (`?` shows the legend), and reserve color for warn, error, and
  needs-you; under the default privacy mode a workspace prints as the first
  eight digits of its digest
- three **altitudes**, one glyph grammar: `esc` ascends to the **workspace**
  matrix (one row per workspace, one column per agent, each cell a sparkline,
  state glyph, and session count); `enter` on a cell descends into a session
  view scoped to it, with the scope kept in the header as a breadcrumb;
  `enter` on a row descends to the **call**
- `l` switches the strip above the rows between the band and **lanes**: wall
  time across with now at the right edge, one lane per session, tool calls
  drawn as spans, and gaps left blank as the idle signal; `-` and `+` zoom the
  window between 1m and 1h
- `f` cycles category filter (session/prompt/message/tool/file/permission/shell/error/meta)
- `a` cycles source filter, `/` searches summaries
- the **call** view is a designed table, not a payload dump: start and end
  paired by call id with the duration, capture latency when the source
  supplies its own clock, ids, then the request and the response as key/value
  tables with privacy digests shown as a short hash and a length
- `t` hides the working directory column, `e` exports the current view to NDJSON
- bursty repeats coalesce into one row with a `×N` counter
- adapter failures and unparseable lines surface *in the timeline* as `meta/warn` events
- an engine state is only trusted while it is plausible: a needs-you state is
  kept for 24h and a working state for 30m past the session's last report;
  idle and done are judged on the last event alone, so a daemon restart that
  stamps every old session idle does not make them live

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
- [Adapter capabilities](docs/adapter-capabilities.md) — transport fidelity, mapped/filtered coverage, and fixture status
- [Migration plan](docs/agent-firehose-migration-plan.md) — daemon → desktop shell → optional cloud (with status)
- [Compatibility](docs/compatibility.md) — daemon/UI schema-version rules
- [Release runbook](docs/release-runbook.md) — signing, packaging, updater feed
- [Pain review](docs/migration/pain-review.md) — Phase 4 engine decision framework
- [Cloud control plane](docs/architecture/cloud-control-plane.md) — Phase 5 design (deferred)
- [Contributing](CONTRIBUTING.md)

## License

MIT
