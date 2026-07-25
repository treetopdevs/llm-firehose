# Agent capture expansion — Claude Opus 5 adversarial review

Reviewed commit: `2b8c699`
Base commit: `80c61c0`
Reviewer model: `claude-opus-5`
Mode: read-only safe mode, high effort
Verdict: **NEEDS FIXES**

The reviewer ran `go test ./...` and reported the frozen event, privacy, spool,
export, and local API surfaces remained compatible. It found the following
actionable issues.

| Finding | Disposition |
|---|---|
| A new later-sorted durable file could be baselined after an earlier file advanced the save watermark | Fixed with an initialization-scoped discovery watermark and a lexical-order regression |
| One unreadable tracked file could abort the poll and starve every later file | Fixed with one bounded warning, fail-soft retry, and a later-file regression |
| Claude installation could change the matcher on an entry shared with user hooks | Fixed by adopting only a single-handler Firehose-owned entry; shared entries are left unchanged |
| Claude declared `WorktreeCreate` and `FileChanged` filtered while mapping them | Fixed: both now deliberately produce no event |
| Claude installed and advertised event families without real fixtures | Fixed: install/manifest/doctor coverage is limited to eight fixture-proven families |
| Non-tool Claude events received ignored matchers | Fixed: only `PreToolUse` and `PostToolUse` receive the all-tool regex |
| Cursor `postToolUseFailure` aliased to success | Fixed with an error-status regression |
| Typeless notification payloads lost needs-input attention | Fixed with the conservative permission default |
| Terminal permission events could leave attention stuck at needs-input | Fixed for `PermissionDenied` and `ElicitationResult` |
| An unevidenced hook timestamp could repartition spool events | Fixed by keeping the local capture clock until a real timestamp fixture exists |
| Every poll fingerprinted every tracked durable file | Fixed with observed size/mtime stamps; fingerprints run only after a file stamp changes |
| Missing filtered/unknown/corrupt/truncate/desktop-type coverage | Added focused regressions and the additive desktop doctor fields |

The reviewer suggested loosening `ClaudeHooksConfigured` so matcher or
`async` drift would not affect health. That recommendation was not applied:
the async observer flag and the fixture-backed matcher policy are part of the
fail-silent safety contract, so doctor continues to flag a configuration that
could put Firehose synchronously in Claude's path.

The review also noted that the implementation commit crossed the plan's
suggested PR boundaries. The reviewed commit was not rewritten because the
requested workflow required an implementation commit followed by a distinct
review-fix commit. The second commit contains the review dispositions and
additional real-fixture Claude OTel work.
