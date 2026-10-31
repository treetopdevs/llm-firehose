# Fleet altitude real-data validation (2026-10-31)

## Setup
- Scratch home `/tmp/fh-home.iHvm` (copy of the real spool, daemon_addr 127.0.0.1:4599); `firehosed` built from this branch, run with `HOME=/tmp/fh-home.iHvm -addr 127.0.0.1:4599`.
- `VITE_DAEMON_URL=http://127.0.0.1:4599 pnpm exec vite --port 1420`; Playwright at 1440x900, `firehose-onboarded=1`. The real daemon on 4517 and `~/.agentfirehose` were not touched.

## What rendered
- Map: 60 rows, one compact line each (label, `open● idle…` counts, glyph strip, sparkline, needs-you unit). Body height 2202px (was ~7400px). browser-life shows 12 glyphs and `+154`; counts `46● 41…` and `1?`. No absolute paths in row text (tooltip/aria-label only). Screenshot: `2026-10-31-fleet-altitude-map.png`.
- Matrix: repository / open / idle / needs you / gone (7d) / last activity; browser-life 46 / 41 / 1 / 22 / 1h; digest-only rows (e.g. `cc8b129c`) dimmed. Screenshot: `2026-10-31-fleet-altitude-matrix.png`.
- Fork glyph click lands on Sessions narrowed to that worktree: `2026-10-31-fleet-altitude-sessions.png`.
- No console errors.

## Defects fixed in this pass
1. Compact rows: glyph strip, max 12, order open+idle, open, landed, never_diverged, unknown, gone; old (>7d) gone forks behind `+N`; per-row expand/collapse kept across refresh; labels (last path segment) only for open forks.
2. Counts now come from forks (open, idle) and needs, not session states.
3. Fork glyph click goes to Sessions with project+worktree, session/cell cleared, window kept.
4. Matrix is a real matrix; needs cell opens Score for the longest wait; row label opens Project.
5. `/.git` stripped for display only (ids untouched); digest-only repos show an 8-hex prefix, dim, tooltip says "unregistered".
6. Root cause of the missing needs unit: the attention strip counts every `pending` session, but Fleet dropped pending sessions failing the liveness freshness rule. The one real pending session (repo_id `/Users/nicholas/develop/browser-life/.git`, matches a /worktrees row) is from 2026-10-27, so it was stale and vanished. Stale pending requests are now shown (dashed, tooltip "stale"), counted, and included in the n/N/Space queue. Unmatched repo ids get their own fog row; empty repo_id goes to "No repo id".
7. n/N/Space with an empty queue show "no sessions need you" (role=status, clears after 2.5 s).

## Remaining limits
- The same repository recorded under a digest id and a raw id appears as two rows (no merge across id forms).
- A spool snapshot has no live sessions, so working/idle session states and fresh needs could not be exercised on real data; they are covered by fixtures.
- The status-bar breadcrumb still shows `browser-life/.git` (outside Fleet).
- Rows with hundreds of forks draw only 12 glyphs by default, so a needs-bearing fork may sit behind `+N` (its unit still shows in the queue).
