# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is **Agent Firehose**, a Go project — not an Elixir/`mix` project (an earlier
misplaced "Lattice" doc tree has been removed).

## What this is

Agent Firehose is a local-first developer tool that shows a live, structured timeline of
what AI coding agents (Claude Code, Codex, OpenCode, …) are doing on your machine — a
Bubble Tea TUI over an on-device capture engine. Everything runs on-device: no backend,
no accounts, no sync, no telemetry. A Tauri v2 desktop shell (`apps/tauri-desktop`) wraps
the same engine for non-terminal users.

## Commands

```sh
go test ./...                         # full suite (fast — keep it that way)
go test ./internal/adapters/codex     # single package
go test -run TestName ./internal/tui  # single test
go vet ./...
gofmt -l .                            # list unformatted files (must be empty)
go build ./cmd/firehose               # the CLI+TUI binary
go build ./cmd/firehosed              # the dedicated daemon binary (desktop sidecar)
```

Validation loop before marking work complete: `gofmt -l .` → `go vet ./...` → `go test ./...`.

Desktop app (`apps/tauri-desktop`, uses **pnpm**):

```sh
scripts/build-sidecar.sh                    # compile firehosed into the sidecar slot first
pnpm -C apps/tauri-desktop install
pnpm -C apps/tauri-desktop test             # vitest (frontend state/client)
pnpm -C apps/tauri-desktop build            # tsc + vite build
pnpm -C apps/tauri-desktop tauri dev        # run the shell
cargo test --manifest-path apps/tauri-desktop/src-tauri/Cargo.toml   # Rust side
```

If `pnpm`/`node`/`npx` misbehave in a non-interactive shell, they are shadowed by an nvm
shim — prefix with `PATH=/opt/homebrew/opt/node/bin:$PATH` or run `unfunction node npm npx`.

Running the tool live: `firehose install claude-code` merges hooks into
`~/.claude/settings.json`; captured events land in `~/.agentfirehose/spool/*.ndjson`; a
daemon on `127.0.0.1:4517` serves the live API.

## Architecture

Everything funnels through **one normalized envelope** (`internal/event`, `event.Event`).
Every capture source is mapped into it before display, persistence, or export. Start there
when learning the codebase.

Data flow:

```
sources ──adapters──▶ event.Event ──capture.Admit──▶ spool (NDJSON) ──▶ Projection ──▶ TUI / API
```

- **`internal/event`** — the `Event` envelope + `CurrentSchemaVersion` (currently 1). The
  frozen contract; new fields must be additive (see below).
- **`internal/adapters/*`** — one package per source, each mapping raw payloads into
  `Event`s. `claudecode` & `opencode` receive pushed payloads via `firehose emit`; `codex`
  *tails* `~/.codex/sessions` JSONL directly; `procwatch` polls the process list for known
  agent binaries; `generic` handles arbitrary NDJSON via `firehose ingest`.
- **`internal/capture`** — the sole Admission and lifecycle boundary: validate, enrich
  workspace identity, apply policy, append, immediately Project, and publish to bounded
  Live Subscriptions. It owns queries, export, reconciliation, and production Sources.
- **`internal/privacy`** — redaction semantics applied **before persistence** by Capture.
  Modes: `minimal` (values → `{sha256,len}`), `balanced` default (strings truncated to 240
  runes, `raw` dropped), `full`. The spool never holds more than the mode allows.
- **`internal/capture/internal/spool`** — sealed append-only NDJSON and reconciliation.
  Daily `O_APPEND` records remain the canonical source of truth.
- **`internal/capture/internal/projection`** — sealed disposable session, trace, file, and
  attention state rebuilt from the spool.
- **`internal/store`** — ring buffer, filters, and burst coalescing (`×N` rows) for the TUI.
- **`internal/daemon`** — the Capture Engine's local HTTP adapter (`net/http`
  `mux.HandleFunc`, Go 1.22+ routing). Routes: `/health`, `/config`, `/events`,
  `/events/stream` (SSE), `/emit`, `/sessions[/{id}]`, `/traces/{id}`, `/artifacts/files`,
  `/doctor`, `/install/{adapter}`, `/export`.
- **`internal/client`** — HTTP client the TUI/desktop use to consume the daemon.
- **`internal/tui`** — Bubble Tea model (`tui.go`) + rendering (`view.go`).
- **`internal/cli`** — testable subcommand implementations (config, doctor, install, status,
  emit, ingest, export). `cmd/firehose/main.go` is flag parsing + wiring only.

**Daemon-optional design (important):** capture NEVER depends on the daemon being up. When
a daemon is running, `firehose emit` and adapters route through it and the TUI consumes its
stream (`viewFeed` in `cmd/firehose/main.go` prefers the daemon). When it isn't, everything
falls back to One-shot Admission, while the TUI runs the same Capture Engine and production
Sources in process. Codex and process observations are persisted in both modes. A daemon the
user runs themselves always wins over the desktop sidecar. A crash-safe OS lock lets exactly
one engine process run durable Sources; concurrent viewers reconcile the spool and dynamically
inherit Source ownership after release. If a bounded live stream ends, clients bracket the
replacement subscription with durable snapshots and exact-ID dedupe.

## Hard rules (from CONTRIBUTING.md and the frozen contract)

- **TDD.** Every behavior change starts with a failing test. For adapters, use *real
  captured payloads* pasted from the source as fixtures — never invent shapes.
- **Local-first.** No network calls, no telemetry, no cloud dependencies.
- **Never break the agent.** Capture paths (hooks, plugins) must fail *silently* rather than
  interrupt a coding session — surface failures *in the timeline* as `meta`/`warn` events.
- **The five frozen surfaces** (`docs/contracts.md`): event envelope schema, privacy
  semantics, NDJSON spool format, export format, local API. Adding an optional field is fine
  and needs no version bump (consumers ignore unknown fields). **Removing/renaming/changing
  the meaning of a field, or changing privacy/spool/export/API semantics, requires a
  `schema_version` bump + a reader that understands both versions** — escalate.
- **Dependencies are minimal** (Bubble Tea + Lipgloss, std lib otherwise). Adding a Go dep is
  a deliberate choice — prefer the standard library.
- Merges to `main` are human-approved.

## Docs worth reading

`docs/contracts.md` (frozen surfaces), `docs/event.schema.json` (envelope JSON Schema),
`docs/adapters.md` (how each adapter works / how to add one),
`docs/agent-firehose-migration-plan.md` (daemon → desktop → optional cloud; status at top —
phases 0–3 done, 4–5 gated), `docs/compatibility.md`, `docs/release-runbook.md`,
`docs/plans/` (dated build plans).
