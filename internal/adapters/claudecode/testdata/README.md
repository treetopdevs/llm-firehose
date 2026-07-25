# Claude Code hook fixtures

These fixtures were captured from Claude Code 2.1.218 on macOS 15 through
Firehose's pre-existing full-privacy spool before the expanded parser was
written. Capture date: 2026-07-25. Transport: Claude Code command hooks.

Only values were sanitized. Keys, nesting, scalar types, optional-field
presence, and event ordering are preserved. Prompts, responses, tool bodies,
file contents, identities, and absolute personal paths use conspicuous
`SECRET-*` markers so privacy-negative tests prove they do not enter the safe
payload. Fixtures for hook events not observed locally are intentionally not
invented.
