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

`worktrees_full.ndjson` is a 94-record full-mode fixture for the worktree lifetime
projection: two repos, three worktrees, seven sessions, 41 signal and 53 meta
events (three meta records carry no worktree id). File records copy the real
claude-code `PostToolUse:Edit` / `PreToolUse:Edit` shape from
`activity_real_shapes.ndjson`. The shell records are **adapter-derived, not
spool-captured**: each `raw` is the full hook JSON shape of
`internal/adapters/claudecode/testdata/post_tool_use_bash.json` (with a scrubbed
`tool_response`, one multi-KB filler, and an `error` field on the failure record),
and `name`, `summary` and `category` are what the real claude-code adapter makes of
that raw (`TestWorktreeFixtureShellRecordsMatchAdapter` re-maps every one). Meta
records use the adapter's `PreCompact` mapping. Sanitising rules: only
`/work/alpha`, `/work/alpha-feat`, `/work/beta`, `/work/beta-fix` paths; repo ids
`/work/alpha/.git` and `/work/beta/.git`; sessions `sess-fixture-1..7`; no home
paths, emails, prompt bodies or secret markers; times on 2026-10-30. It includes
a heredoc commit, a pipeline push, a compound `cd && git commit -am "wip; git push"`,
a quoted `echo`, `ls`, `git status`, Pre events, a failure event, a path over 240
runes, a command over 240 runes, and a meta event before the first signal event.
It was produced by a throwaway deterministic generator (not committed); the test
caps it at 300 lines and 150 KB.
Ten shell summaries (all `ran`; `will run`, failed and interrupted carry none) carry the adapter's
lifecycle verb suffix, e.g. `ran shell tool: git commit`; they were refreshed with
a line-scoped edit of the `summary` value only (every other byte unchanged), using
what `claudecode.Parse` makes of each record's own `raw`. The suffix is what lets
worktree marks survive balanced privacy.

`worktrees_balanced.ndjson` is the production balanced redaction
(`privacy.Redact(ev, ModeBalanced)`) of every `worktrees_full.ndjson` record: no
`raw`, truncated strings, digested paths and ids. It is generated, not hand-edited:
`UPDATE_WORKTREE_FIXTURES=1 go test ./internal/capture -run TestWorktreeBalancedFixtureIsRedactFullFixture`
rewrites it, and the same test (without the variable) fails if it drifts from the
full fixture. If the full fixture changes, regenerate this one.
