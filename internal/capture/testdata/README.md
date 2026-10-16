# Capture testdata

`activity_real_shapes.ndjson` holds one real spool record for each file-category
event shape seen in a real capture on 2026-10-16 (claude-code `PreToolUse:Edit` /
`PostToolUse:Edit`, codex rollout `patch_apply_end`, `custom_tool_call:apply_patch`
and its output, the codex hook `PreToolUse` for `apply_patch`, and antigravity
`PostToolUse:view_file`). Records are verbatim apart from sanitizing: personal
paths are rewritten under `/work/proj`, patch and diff bodies are replaced with
short neutral text, times are moved onto 2026-10-16, and identities are the
SHA-256 digests of `/work/proj/.git` and `/work/proj` (the antigravity record was
recorded in full mode and keeps raw identities).
