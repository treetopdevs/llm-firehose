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

`activity_apply_patch_shapes.ndjson` holds twelve real Codex `apply_patch` records
taken from a copy of the real spool on 2026-10-16, sanitized the same way. Six
are calls: a rollout `custom_tool_call:apply_patch` with `*** Update File:` +
`*** Move to:`,
an untruncated one deleting two `/tmp` files (paths kept verbatim), a hook
`PostToolUse` with a relative `*** Update File:` header, a hook `PreToolUse`
whose second header was cut by balanced-mode truncation (recorded with raw
identities, here `/work/proj/.git` and `/work/proj`), a hook `PreToolUse`
whose only header was cut, and a hook `PostToolUse` whose patch was cut before
its second header while its `output` lists both files (its `transcript_path`
dropped). Each truncated text keeps its trailing `…`.

The other six are rollout `custom_tool_call_output:apply_patch` records, one per
`output` variant: plain text listing relative paths with its fourth line cut,
an untruncated JSON wrapper, a JSON wrapper cut inside `metadata`, a JSON
wrapper cut inside its `output` string, a plain `apply_patch verification
failed:` naming a path (its quoted code replaced with neutral lines), and a JSON
`command timed out` wrapper. Their original identities differed; all now carry
the `/work/proj` digests.

`fixture.session.json` and `fixture.errsig.json` are verbatim copies of the Session
Score fixtures in `apps/tauri-desktop/src/ui/score/` (a real 101-event balanced-mode
claude-code session, and real minimal-mode Error Signature records with digest-shaped
`error_class`). `TestTimelineViewKeepsExactlyTheAllowlist` reads them. Keep them in
sync with the desktop copies if those are ever regenerated.
