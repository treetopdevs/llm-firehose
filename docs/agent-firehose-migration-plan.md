# Agent Firehose Migration Plan

## Goal

Evolve the current local-first Go TUI into a distributable cross-platform desktop product in three stages:

1. **Current state:** Go CLI/TUI + local adapters + NDJSON spool.
2. **Next state:** Go daemon + Tauri desktop app for macOS, Windows, and Linux.
3. **Optional future state:** Phoenix cloud backend for sync, fleet analytics, collaboration, and hosted observability.

The key principle is to preserve the current event model and spool/export contract as the durable platform boundary rather than rebuilding the entire system immediately.[cite:66]

## Why this path

The current implementation already has the right product core: a normalized `Event` envelope, adapter-driven ingestion, privacy redaction before persistence, local NDJSON spool files, export, install/doctor commands, and a viewer that can tail live activity.[cite:66]

That means the risky and product-defining work is largely done already. The missing layer is a better desktop packaging and visualization story for non-TUI users, not a new ingestion model.[cite:66]

Tauri is a strong fit for the desktop shell because it is designed for small, secure cross-platform desktop apps with a web frontend and Rust backend, and it supports updater workflows for macOS, Windows, and Linux distributions.[cite:72][cite:68][cite:75]

Phoenix should be treated as an optional later control plane, not as the local desktop runtime. It is most valuable if the product grows into shared dashboards, team views, remote ingestion, or cloud-hosted observability.[cite:66]

## Architectural north star

Use a **three-layer architecture**:

- **Capture engine:** local Go runtime responsible for adapters, normalization, privacy, spool writes, export, install, and diagnostics.[cite:66]
- **Desktop shell:** Tauri app responsible for timelines, graphs, settings, onboarding, tray behavior, filters, and installer/update UX.[cite:72][cite:75]
- **Cloud control plane (optional):** Phoenix backend responsible for team accounts, cloud sync, multi-device session aggregation, remote analytics, and organization features.

The compatibility contract should be:

- Event envelope schema.
- Privacy mode semantics.
- NDJSON spool format.
- Export format.
- Local API or IPC contract.

These should remain stable so adapters and data survive UI changes.[cite:66]

## Phase 0: Freeze the platform contract

### Objective

Before adding a GUI, define what must stay stable.

### Deliverables

- `event.schema.json` or equivalent documented schema for normalized events.
- Versioned spool format (`schema_version` field in each event).
- Versioned export format (`export_version`).
- Written privacy contract for `minimal`, `balanced`, and `full` capture modes.[cite:66]
- Source adapter contract describing how Claude Code, Codex, OpenCode, and generic NDJSON inputs map to canonical event categories.[cite:66]

### Implementation notes

Add schema versioning now, before a GUI or cloud backend exists. This avoids painful migrations later when older desktop clients and adapters are already in the wild.

### Exit criteria

- Old spool files remain readable after minor schema evolution.
- New fields can be added without breaking old viewers.
- Export can be consumed by external tools.

## Phase 1: Split the current app into engine and clients

### Objective

Refactor the Go app from “CLI with embedded viewer” into “local engine + thin clients.”

### Target shape

- `firehose-agent` or `firehosed`: long-running local daemon.
- `firehose` CLI: install, doctor, export, status, config, developer tools.
- Existing TUI becomes an optional client of the daemon instead of the main architecture.

### Engine responsibilities

- Hook/plugin ingest.
- File tailing and process watching.[cite:66]
- Event normalization.[cite:66]
- Privacy redaction.[cite:66]
- Spool append and read.[cite:66]
- Live subscription stream.
- Health/status reporting.
- Adapter management.

### Client responsibilities

- TUI rendering.
- Desktop UI rendering.
- Filter state.
- Session exploration.
- Export invocation.

### Recommended local interface

Use one of these two patterns:

| Option | Recommendation | Notes |
|---|---|---|
| Local HTTP API + SSE/WebSocket | Best default | Easy for Tauri, CLI, and future external tooling. |
| Unix socket / named pipe IPC | Good later optimization | Better for local-only security posture, but adds more platform complexity. |

Start with localhost HTTP plus tokenless local trust, then harden later if needed.

### Suggested API surface

- `GET /health`
- `GET /config`
- `POST /config`
- `GET /events/stream`
- `GET /sessions`
- `GET /sessions/:id`
- `GET /traces/:id`
- `GET /artifacts/files`
- `POST /export`
- `POST /install/:adapter`
- `GET /doctor`

### Exit criteria

- TUI reads from daemon API instead of directly tailing files.
- Adapters write only through daemon.
- Viewer logic is fully separated from capture logic.

## Phase 2: Improve local storage without breaking compatibility

### Objective

Keep NDJSON as the canonical append-only log, but add indexes or derived state for faster GUI queries.

### Recommended approach

Do **not** replace NDJSON immediately. Instead:

- Keep daily spool files as the source of truth.[cite:66]
- Add a lightweight derived index for sessions, traces, file paths, and time ranges.
- Rebuild indexes on startup if missing or corrupt.

### Storage options

| Option | Use | Recommendation |
|---|---|---|
| NDJSON only | Source of truth | Keep. |
| BoltDB / bbolt / Pebble / SQLite index | Query acceleration | Add only for desktop responsiveness. |
| Full relational replacement | Primary store | Avoid in this phase. |

This protects backward compatibility while allowing fast UI operations like timeline zoom, session search, and file-based filtering.

### Exit criteria

- Cold start remains reliable using only spool files.
- Large local histories still feel responsive in the GUI.
- Export remains based on canonical spool data.

## Phase 3: Introduce the Tauri desktop shell

### Objective

Ship a polished desktop UI without rewriting the Go ingestion engine.

### Recommended structure

- **Tauri app:** UI shell, onboarding, settings, charts, timeline, graph, tray, update UX.[cite:72][cite:75]
- **Go daemon sidecar:** spawned or installed companion process that owns capture and storage.
- **IPC/API bridge:** Tauri frontend talks to Go daemon over localhost.

### Why this is the best near-term compromise

- It preserves the current Go investment.[cite:66]
- It gives a much better distribution story than a raw TUI.[cite:72][cite:75]
- It avoids a full Rust rewrite before product-market validation.

### Desktop UX priorities

1. Onboarding wizard: choose privacy mode, install adapters, verify doctor status.
2. Live dashboard: fleet roster, waterfall timeline, session explorer, artifact view.
3. Settings: adapter status, spool location, retention, export, redaction.
4. Background behavior: tray icon, startup at login, notifications for failures.
5. Update flow: desktop updater and daemon version compatibility checks.[cite:68]

### Packaging model

| Component | Packaged with desktop app? | Notes |
|---|---|---|
| Tauri app | Yes | Main visible app. |
| Go daemon | Yes | Bundled sidecar or installed companion binary. |
| CLI tools | Optional | Useful for power users and support workflows. |
| Adapter scripts/plugins | Yes | Installed by guided onboarding. |

### Desktop release tasks

- Sign macOS app bundle.
- Build Windows installer.
- Build Linux packages/AppImage.
- Add updater feed metadata for desktop releases.[cite:68][cite:73]
- Define daemon/UI compatibility matrix.

### Exit criteria

- A non-terminal user can install the app, enable adapters, and see live events.
- Updating the app does not destroy spool data or settings.
- The daemon can be restarted independently from the UI.

## Phase 4: Decide whether to keep or replace the Go engine

### Objective

Make the stack decision based on real product pain rather than speculation.

### Keep Go if

- Adapters are stable and easy to maintain.
- Process watching and file tailing are reliable across platforms.
- Performance is acceptable for local workloads.
- The main remaining work is UI polish and product packaging.

### Consider selective Rust migration if

- Tauri-side native integrations are blocked by the Go sidecar model.
- Packaging the sidecar becomes fragile.
- Cross-platform process or filesystem edge cases become a chronic maintenance burden.
- Native plugin ecosystems on the Rust/Tauri side clearly reduce operational complexity.[cite:72][cite:75]

### Do not rebuild the whole engine just because Tauri uses Rust

A sidecar architecture is acceptable for a long time. Rebuild only the subsystems that are actually painful.

### Exit criteria

- A written “pain review” after real desktop beta usage.
- A measured decision based on install failures, crash reports, performance, and support load.

## Phase 5: Add optional Phoenix cloud backend

### Objective

Add a hosted/team layer without breaking the local-first promise.

### What Phoenix should do

- User/org auth.
- Device registration.
- Encrypted or privacy-aware sync of allowed event subsets.
- Team dashboards.
- Multi-device or multi-user session aggregation.
- Long-term analytics.
- Shared traces, search, alerts, and collaboration.

### What Phoenix should not do initially

- Replace the local collector.
- Become required for the product to function.
- Break offline mode.

### Deployment modes

| Mode | Description |
|---|---|
| Local only | No cloud sync; all data stays on device. |
| Personal sync | Optional backup/sync across one user’s devices. |
| Team mode | Multiple users/devices sending approved metadata to cloud. |
| Enterprise self-hosted | Organization-hosted Phoenix control plane. |

### Data flow

- Local daemon captures full-fidelity events.
- Local policy decides what may leave the machine.
- Cloud receives a transformed subset based on privacy mode and org policy.
- Local export remains available regardless of cloud status.

### Why Phoenix fits here

Phoenix is strongest when the product becomes a **shared realtime system**, such as team dashboards and fleet aggregation, which is different from the local desktop runtime concern.[cite:66]

### Exit criteria

- Local-only mode remains first-class.
- Sync can be disabled completely.
- Cloud features add value without increasing local complexity.

## Suggested repo strategy

A monorepo will keep this manageable.

```text
agent-firehose/
  apps/
    go-daemon/
    go-cli/
    tauri-desktop/
    phoenix-cloud/         # optional later
  packages/
    event-schema/
    export-schema/
    adapter-fixtures/
    ui-contracts/
  docs/
    architecture/
    migration/
    adapters/
```

## Recommended milestones

### Milestone 1: Platform hardening

- Freeze schema and spool contract.
- Add versioning.
- Separate engine from TUI.
- Provide local API.

### Milestone 2: Desktop alpha

- Tauri shell with live feed, sessions, detail panes, settings.
- Bundled Go daemon.
- Installer for macOS first, then Windows and Linux.

### Milestone 3: Desktop beta

- Timeline and graph views.
- Export UX.
- Auto-update.
- Crash reporting and compatibility checks.

### Milestone 4: Cloud preview

- Phoenix service for accounts and optional sync.
- Team dashboards and shared search.
- Privacy-aware cloud policies.

## Agent execution plan

### Immediate next tasks

1. Extract current viewer logic behind a local API boundary.
2. Introduce schema versioning into every normalized event.[cite:66]
3. Add stable session/trace identifiers if not already universal.
4. Build a tiny daemon process that owns spool append, tail, and live stream.
5. Make the TUI consume daemon events.
6. Build a Tauri proof-of-concept that renders:
   - live event feed,
   - session list,
   - detail pane,
   - doctor/install status.
7. Validate packaging on macOS, Windows, and Linux.
8. Only after beta feedback, decide whether any Go subsystems should be ported.

### Anti-goals

- Rewriting ingestion before the desktop UX exists.
- Replacing NDJSON before query pain is real.
- Adding cloud sync before local desktop usage is solid.
- Rebuilding in Elixir for the local runtime.

## Final recommendation

The best migration path is:

- **Keep Go as the engine now.**[cite:66]
- **Add a daemon boundary next.**[cite:66]
- **Ship a Tauri desktop shell for cross-platform productization.**[cite:72][cite:68][cite:75]
- **Introduce Phoenix only as an optional cloud control plane later.**

This path preserves the current product insight, minimizes rewrite risk, and keeps the door open for later Rust or cloud evolution without forcing a premature rebuild.
