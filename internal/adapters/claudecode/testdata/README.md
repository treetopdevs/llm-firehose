# Claude Code hook fixtures

`user_prompt_submit.json`, `pre_tool_use.json`, and `post_tool_use.json` were
captured from Claude Code command hooks on macOS arm64 on 2026-07-23, before
passing through the Claude Code adapter. The locally installed binary reported
version 2.1.218 when those fixtures were prepared on 2026-07-25; hook payloads
do not carry the Claude Code version themselves.

`post_tool_use_failure.json` and `stop_failure.json` were captured directly
from isolated Claude Code 2.1.220 command-hook runs on macOS arm64 on
2026-07-25. The failing tool read a deliberately absent temporary path.
`StopFailure` was triggered with a deliberately invalid model name and incurred
no model cost. The capture settings were supplied only to the disposable
process and did not modify the installed Claude settings.

Sanitization replaced session, prompt, and tool-use IDs, personal paths, prompt
text, tool input/output strings, and free-form error text. Keys, nesting, JSON
types, optional-field presence, and event ordering were preserved.
