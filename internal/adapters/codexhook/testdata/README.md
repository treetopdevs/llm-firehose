# Codex hook fixtures

These five payloads were captured on 2026-07-24 from Codex 0.144.5 on macOS
arm64 in a disposable `CODEX_HOME`: `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, and `Stop`. Transport: Codex lifecycle hook
commands (the JSON payloads Codex hands to its configured hook command, as
forwarded via `firehose hook-forward --source codex-hook`), captured before
passing through the adapter under test. Trigger: a short
purpose-authored task — "Use the shell tool to run pwd, then report the
path." — run to completion in the disposable session. Paths and session
identifiers were replaced consistently after capture; field names and
event-specific payload shapes are unchanged.

The prompt string in `user_prompt_submit.json` and the assistant message in
`stop.json` are retained verbatim as a deliberate, documented deviation from
the blanket prompt/response replacement step of the fixture protocol: both are
purpose-authored capture-run text written specifically for the disposable
session and contain no user content. Tests assert on that text.

The other documented lifecycle names do not fire deterministically in a short
disposable task. Their tests intentionally exercise only the common hook
envelope instead of claiming fabricated event-specific payloads as captures.
