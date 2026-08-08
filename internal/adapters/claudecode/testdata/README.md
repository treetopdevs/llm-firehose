# Claude Code hook fixtures

Two real capture batches feed these fixtures; both preserve keys, nesting,
scalar types, optional-field presence, and event ordering, sanitizing values
only. Fixtures for hook events not observed locally are intentionally not
invented.

## Batch 1 — full-privacy spool captures (SECRET markers)

`user_prompt_submit.json`, `pre_tool_use_bash.json`, `post_tool_use_bash.json`,
`pre_tool_use_edit.json`, `notification.json`, `session_start.json`,
`session_end.json`, `stop.json`, and `subagent_stop.json` were captured from
Claude Code 2.1.218 on macOS 15 through Firehose's pre-existing full-privacy
spool before the expanded parser was written. Capture date: 2026-07-25.
Transport: Claude Code command hooks.

Prompts, responses, tool bodies, file contents, identities, and absolute
personal paths use conspicuous `SECRET-*` markers so privacy-negative tests
prove they do not enter the safe payload.

## Batch 2 — direct hook captures (bracketed sanitization)

`user_prompt_submit_bypass.json`, `pre_tool_use.json`, and
`post_tool_use.json` were captured from Claude Code command hooks on macOS
arm64 on 2026-07-23, before passing through the Claude Code adapter. The
locally installed binary reported version 2.1.218 when those fixtures were
prepared on 2026-07-25; hook payloads do not carry the Claude Code version
themselves. `user_prompt_submit_bypass.json` additionally exercises
`permission_mode: bypassPermissions`.

`post_tool_use_failure.json` and `stop_failure.json` were captured directly
from isolated Claude Code 2.1.220 command-hook runs on macOS arm64 on
2026-07-25. The failing tool read a deliberately absent temporary path.
`StopFailure` was triggered with a deliberately invalid model name and incurred
no model cost. The capture settings were supplied only to the disposable
process and did not modify the installed Claude settings.

Sanitization replaced session, prompt, and tool-use IDs, personal paths, prompt
text, tool input/output strings, and free-form error text with bracketed
`[sanitized …]` placeholders.

## Known gap

`PreCompact` is mapped by the parser (inherited from the daemon-desktop
branch) but has no captured fixture yet; capture one before extending its
payload beyond the current metadata-only mapping.
