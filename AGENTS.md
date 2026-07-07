# AGENTS.md — Agent Firehose

Local-first Go tool: a live, structured timeline of what AI coding agents (Claude Code,
Codex, OpenCode, …) do on your machine — a Bubble Tea TUI over an on-device capture engine,
plus a Tauri v2 desktop shell (`apps/tauri-desktop`). Everything runs on-device: no backend,
no accounts, no sync, no telemetry.

For full architecture and package-by-package detail, read **[CLAUDE.md](CLAUDE.md)**. This
file is the short version.

## Commands

```sh
go test ./...          # full suite (fast — keep it that way)
go vet ./...
gofmt -l .             # must print nothing
go build ./cmd/firehose
```

Validation loop before completing work: `gofmt -l .` → `go vet ./...` → `go test ./...`.
Desktop app uses pnpm (`pnpm -C apps/tauri-desktop test|build`) + `cargo test` in
`src-tauri`; run `scripts/build-sidecar.sh` first.

## Architecture in one line

`sources ──adapters──▶ event.Event ──privacy.Redact──▶ spool (NDJSON) ──▶ store/index ──▶ TUI / API`

Everything funnels through one normalized envelope (`internal/event`). The spool
(`~/.agentfirehose/spool/*.ndjson`) is the canonical, append-only source of truth; every
derived store rebuilds from it. Capture never depends on the daemon being up.

## Hard rules

- **TDD.** Behavior changes start with a failing test; adapters use *real captured payloads*
  as fixtures, never invented shapes.
- **Local-first.** No network calls, telemetry, or cloud dependencies.
- **Never break the agent.** Capture paths fail *silently* — surface failures in the timeline
  as `meta`/`warn` events, never interrupt a coding session.
- **Five frozen surfaces** (`docs/contracts.md`): event envelope, privacy semantics, spool
  format, export format, local API. Additive fields are free; removing/renaming/changing
  meaning or semantics needs a `schema_version` bump + dual-version reader — escalate.
- Dependencies stay minimal (Bubble Tea + Lipgloss; std lib otherwise). Merges to `main` are
  human-approved.
