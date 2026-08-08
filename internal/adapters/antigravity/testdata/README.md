# Antigravity CLI hook fixtures

Captured from live Antigravity CLI (`agy`) **1.1.10** headless runs on
**macOS arm64** on **2026-08-07**. Transport: the documented five-event hook
contract configured in `~/.gemini/config/hooks.json`; a temporary capture
hook (`cat >> file`, no stdout, exit 0) appended each event's raw stdin
payload to a per-event file *before* any Firehose code ran. Model:
`gemini-3-flash-agent`. Triggers: prompts exercising `list_dir`,
`run_command`, and `view_file` tools, including a shell command with a
nonzero exit and a `view_file` on an absent path.

Because per-event files were used, each fixture's event family is known from
its capture registration — the payloads themselves carry **no event-name
field**. Pre/Post pairs are otherwise distinguishable only by shape
(`toolCall`+`stepIdx` for tool events, `invocationNum`+`initialNumSteps` for
invocation events, `executionNum`/`terminationReason`/`fullyIdle` for Stop),
and Pre/PostInvocation shapes are identical. Any forwarder must therefore
tag the event name per registration.

Sanitization replaced values only: the conversation UUID became
`aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb` (also inside
`artifactDirectoryPath`/`transcriptPath`, preserving the real path
structure under a `/tmp/agent-firehose-agy-fixture` root), personal paths
became fixture paths, and `CommandLine`/`toolSummary` values use
`SECRET-*-MARKER`. `toolAction` (a generic action description), tool names,
`modelName`, step/invocation indices, and `WaitMsBeforeAsync` are real.
Keys, nesting, types, and optional-field presence are unchanged.

## Observed behaviors worth preserving

- `PostToolUse` args are enriched relative to `PreToolUse` with
  `toolAction` and `toolSummary`.
- A `view_file` on an absent path fired `PreToolUse` but **no**
  `PostToolUse`; a `run_command` with exit 1 fired `PostToolUse` with
  `error: ""` — the `error` field did not populate for either failure mode,
  so an error-populated `PostToolUse` remains uncaptured. Do not invent it.
- `Stop` carried `terminationReason: "NO_TOOL_CALL"`, `fullyIdle: true`,
  `error: ""`.
- Neutral-response proof: across three live runs, hooks that produced **no
  stdout** (exit 0) on all five events — including `Stop` — never blocked a
  tool, forced continuation, or hung termination.

## Known gaps

Error-populated `PostToolUse` and `Stop` variants with other
`terminationReason` values (user interrupt, error) were not triggerable;
their assertions remain blocked on future real captures.
