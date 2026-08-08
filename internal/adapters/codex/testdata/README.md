# Codex rollout fixtures

`rollout_current_sanitized.jsonl` was captured from Codex Desktop 0.144.5 on
macOS arm64 on 2026-07-24 using an isolated `CODEX_HOME`. Transport: the
durable rollout JSONL session file Codex writes under
`$CODEX_HOME/sessions/`, read directly (not through the adapter under test).
Trigger: a short purpose-authored task — "Use the shell tool to run pwd, then
reply with exactly: fixture complete" — driven to completion in Codex Desktop.
It preserves the real record shapes, field names, IDs, and timestamps needed
by the adapter tests.

The capture was sanitized before check-in: session instructions and response
message records were removed, world-state values were replaced with boolean
changed-section markers, and the absolute personal working-directory path was
replaced consistently with `/tmp/agent-firehose-codex-fixture/work` in the
`session_meta` cwd, `turn_context` cwd, tool-call `workdir` input, and tool
output text. No record shape used by the parser was invented.

## Ordering caveat

Record ordering is preserved for the base session, with one documented
exception: the `tool_search_call`/`tool_search_output` records (timestamped
`14:05:53Z`) were transplanted from a later turn of the same captured session
and spliced in before `task_complete` (`13:25:05Z`) so the fixture stays a
single bounded excerpt. An append-only rollout file would not contain
out-of-order timestamps; positional ordering was deliberately not preserved
for those two records. Their shapes, IDs, and timestamps are otherwise
untouched.

## Retained message text

The `user_message` and `agent_message` strings are kept verbatim rather than
replaced with placeholders: they are purpose-authored capture-run text
("Use the shell tool to run pwd…", "fixture complete") written specifically
for the disposable capture session and contain no user content. This is a
deliberate, documented deviation from the blanket prompt/response replacement
step of the fixture protocol.

## Inline payloads in codex_test.go

Several mapped record types are exercised by inline payloads in
`codex_test.go` rather than by fixture files: `exec_command_end`,
`patch_apply_end`, `function_call`/`function_call_output`,
`mcp_tool_call_end`, `context_compacted`, `thread_settings_applied`, and
`error`. Their shapes (field names, `internal_chat_message_metadata_passthrough`,
`duration` as `{secs,nanos}`, the "Chunk ID"/"Process exited" output framing)
match records observed in the Codex 0.144.5 / macOS arm64 rollout capture
sessions of 2026-07-24 described above; inline payloads with 2026-05-07
timestamps carry shapes observed from an earlier Codex CLI 0.100.0 session.
Values (IDs, paths, prompt/command text) were replaced with sanitized markers
when the payloads were inlined. The standalone per-payload capture files were
not retained, so the rollout capture corpus is the provenance record for these
shapes; no shape was invented.
