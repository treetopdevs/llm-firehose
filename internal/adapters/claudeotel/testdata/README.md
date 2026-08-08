# Claude Code OTLP fixtures

These OTLP/HTTP JSON envelopes were captured from the authorized local Claude
review run on 2026-07-25 using Claude Code 2.1.218 on macOS arm64 and a
temporary loopback receiver. Trigger: an ordinary interactive review turn
(prompt, API request, tool result) with only metrics/events telemetry enabled. Records unrelated to the fixture assertions were removed. Keys,
nesting, scalar types, and scope/resource structure are preserved; values were
sanitized after capture.

Identity, prompt, response, body, and resource values use `SECRET-*` markers.
Tests require those markers to disappear completely during normalization.
No content-bearing telemetry option was enabled.

## Awaiting capture

Only the records retained here are fixture-proven: `user_prompt`,
`api_request`, and `tool_result` log events plus the
`claude_code.token.usage` and `claude_code.cost.usage` metrics, and only
these appear in the adapter manifest. Further native names were observed in
the same capture run — `assistant_response`, `hook_execution_start`,
`hook_execution_complete`, `hook_registered`, `mcp_server_connection`,
`plugin_loaded`, `tool_decision`, `claude_code.active_time.total`, and
`claude_code.session.count` — but their records were removed during
sanitization and no evidence was retained. They stay out of the manifest
(surfacing as bounded unknown-event drift warnings at runtime) until a
sanitized record for each is captured and checked in with a test.
