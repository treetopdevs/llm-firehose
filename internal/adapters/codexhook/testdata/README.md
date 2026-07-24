# Codex hook fixtures

These five payloads were captured on 2026-07-24 from Codex 0.144.5 in a
disposable `CODEX_HOME`: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, and `Stop`. Paths and session identifiers were replaced
consistently after capture; field names and event-specific payload shapes are
unchanged.

The other documented lifecycle names do not fire deterministically in a short
disposable task. Their tests intentionally exercise only the common hook
envelope instead of claiming fabricated event-specific payloads as captures.
