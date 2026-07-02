# Contributing

Agent Firehose is a small, local-first Go project. Contributions that add
adapters, improve timeline readability, or harden capture paths are the most
valuable.

## Ground rules

- **TDD.** Every behavior change starts with a failing test. The test suite is
  fast (`go test ./...` runs in seconds) — keep it that way.
- **Local-first.** No network calls, no telemetry, no cloud dependencies.
- **Structured over verbose.** Every event needs a category, a one-line human
  summary, and enough payload to understand it in the detail pane.
- **Never break the agent.** Capture paths (hooks, plugins) must fail silently
  rather than interrupt someone's coding session. Surface failures in the
  timeline instead (`meta`/`warn` events).

## Development

```sh
go test ./...          # full suite
go vet ./...
go build ./cmd/firehose
```

Package layout:

- `internal/event` — the normalized envelope (start here)
- `internal/privacy` — capture-mode redaction
- `internal/spool` — NDJSON persistence + tailing
- `internal/adapters/*` — one package per source
- `internal/store` — ring buffer, filters, coalescing
- `internal/tui` — Bubble Tea model/view
- `internal/cli` — testable subcommand implementations
- `cmd/firehose` — flag parsing and wiring only

## Adding an adapter

See [docs/adapters.md](docs/adapters.md). Start from real captured payloads —
paste actual lines from the source into your parser tests as fixtures rather
than inventing shapes.

## Pull requests

Keep them focused. A PR that adds one adapter with tests and a doctor check is
ideal. Include a sample of the raw source payloads your parser handles.
