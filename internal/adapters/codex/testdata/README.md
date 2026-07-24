# Codex rollout fixtures

`rollout_current_sanitized.jsonl` was captured from Codex Desktop 0.144.5 on
2026-07-24 using an isolated `CODEX_HOME`. It preserves the real record shapes,
field names, ordering, IDs, and timestamps needed by the adapter tests.

The capture was sanitized before check-in: session instructions and response
message records were removed, while world-state values were replaced with
boolean changed-section markers. No record shape used by the parser was
invented.
