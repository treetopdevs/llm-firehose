# OpenCode correlation fixture

`fixture.opencode.json` is normalized from three existing real, sanitized OpenCode 1.18.10 bus captures in `internal/adapters/opencode/testdata/`, in this order:

1. `message_updated_user.json` → captured ID `loom-user`
2. `message_updated_assistant_started.json` → captured ID `loom-assistant`
3. `tool_completed_glob.json` → captured ID `loom-tool`

Generation uses the production `opencode.Parse`, then `capture.CorrelationView`. Source-provided IDs, timestamps, shape and values are not invented. Test-only captured IDs replace random admission IDs; `schema_version` is set to 1, and capture_time and primary time are pinned to each real source timestamp for reproducibility (not evidence of actual capture timing). The adapter normally stamps primary time at parsing; the test pin is deliberate and documented, not a change to adapter semantics. Raw content, paths and non-allowlisted payloads are excluded by CorrelationView. The source fixture README documents real capture provenance and sanitization.

`TestCorrelationOpenCodeFixture` in `internal/capture/correlation_view_test.go` re-parses all three source fixtures and compares this file against production output, preventing drift. These fixtures prove native message membership and OpenCode parent-message references, not causality or cross-agent transfers. The tool is a terminal update only: absence of a start event must not be interpreted as loss or running state.
