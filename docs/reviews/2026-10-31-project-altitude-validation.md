# Project altitude: real-data visual validation (2026-10-31)

## What was run

- Isolated `firehosed` built from this branch, on a scratch HOME holding a copy of the real spool (the live `~/.agentfirehose` and port 4517 were not touched).
- Vite dev server on port 1420 pointed at the isolated daemon, driven with Playwright.
- Screenshot: `2026-10-31-project-altitude-preview.png`.

## What rendered

- 66 repositories in the selector.
- The llm-firehose repository showed `main` plus 9 worktree lanes.
- 4 lanes open and idle, with ahead/behind badges.
- 4 open sibling worktrees.

## Defects found and fixed in this commit

1. Unlabeled lanes (and the footer breadcrumb project segment) read "/Users/n" in full privacy mode, because the id fallback cut raw paths to 8 characters. New `idLabel()` returns the last two path segments for path ids and the 8-char prefix for digests.
2. Left-truncated lane labels ended flush against the run start. Added a label gutter (`LABEL_PAD`, 8px) and derived the label character limit from it.
3. Right after daemon start every row is `unknown` / `graph_unavailable` and lanes were all hatched with no explanation. The panel now shows "States pending: N of M lanes not classified yet (graph_unavailable)"; the 15 s refresh clears it. `repo_unregistered` is a real state and gets no hint.

## Limits

- No `landed` state was observed in this data set.
- States classify asynchronously after daemon start, so an early capture shows the pending hint and hatched lanes.
