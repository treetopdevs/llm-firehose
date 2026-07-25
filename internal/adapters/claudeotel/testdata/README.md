# Claude Code OTLP fixtures

These OTLP/HTTP JSON envelopes were captured from the authorized local Claude
review run on 2026-07-25 using Claude Code 2.1.218 and a temporary loopback
receiver. Records unrelated to the fixture assertions were removed. Keys,
nesting, scalar types, and scope/resource structure are preserved; values were
sanitized after capture.

Identity, prompt, response, body, and resource values use `SECRET-*` markers.
Tests require those markers to disappear completely during normalization.
No content-bearing telemetry option was enabled.
