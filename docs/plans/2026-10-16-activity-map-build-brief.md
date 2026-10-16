# Activity Map v1: build brief

**Status:** Ready to build, 2026-10-16. Source of decisions: section "Activity Map
(was Repository Weather)" of `docs/plans/2026-10-16-session-score-and-activity-map.md`.
Canonical terms (`CONTEXT.md`): **Activity Map** (one repository's path hierarchy
showing where Heat accumulated over a window; reports observed activity, never code
quality), **Heat** (count of file-category Captured Events touching one path within
one time bucket, counted equally across the repository's worktrees), **Error
Signature** (deferred; nothing here may claim an error belongs to a file).

## Base branch

The plan doc and Session Score v1 exist only on `claude/loving-villani-8aaf4c`
(not merged). Cut the build branch from that branch, or from `main` once it merges,
so you can (a) append a "Shipped" section to the plan doc and (b) reuse
`apps/tauri-desktop/src/ui/score/model.ts` exports (`clampView`, `stripControl`,
`digestLabel`). Do not copy those helpers.

## Scope

In: one additive daemon endpoint, one capture-engine aggregate, a third tab in the
desktop workspace-graph section, contract doc, tests, a real-data fixture.

Out (do not build): storm cells and anything error-related (wait for Error
Signature); attributing shell/tool activity to files; persisted positions; contour
or weather skins; a TUI view; a play/animate transport (brush only in v1); new
dependencies (Go or npm).

## Backend

### 1. Route

`GET /workspace-graph/activity`, registered next to the other graph routes in
`internal/daemon/daemon.go` (lines ~108-112) and wrapped in `s.graphResponse(...)`.
That wrapper gives the same loopback/browser-origin treatment as the graph routes
and holds the privacy-transition read lock, which the plan requires. Handler lives
in `internal/daemon/workspace_graph.go` beside `handleGraphTimeline`.

Query parameters:

| Param | Required | Meaning |
|---|---|---|
| `repo_id` | yes | Graph repository id (same as other graph routes). 422 if unknown. |
| `workspace_id` | no | Restrict to one worktree/workspace. Omitted = merge all. |
| `from`, `to` | no | RFC 3339. Default `to` = now, `from` = `to` − 24h. 400 if `from >= to` or window > 31 days. |
| `bucket` | no | Seconds, must be on the ladder 60, 300, 900, 3600, 10800, 21600, 86400. Omitted = smallest ladder step giving ≤ 240 buckets. 400 if the result exceeds 2000 buckets. |

Floor `from` to a multiple of `bucket` in UTC (and report the floored value) so a
live refresh never shifts columns. Window is `[from, to)`.

Response (`Cache-Control: no-store`):

```json
{
  "repo_id": "…",
  "workspace_id": "",
  "from": "2026-10-15T22:00:00Z",
  "to": "2026-10-16T08:13:00Z",
  "bucket_seconds": 900,
  "buckets": 41,
  "available": true,
  "unavailable_reason": "",
  "paths": [
    {"path": "internal/tui/view.go", "group": "", "total": 12, "heat": [[3, 2], [4, 10]]}
  ],
  "groups": [
    {"id": "", "label": "", "resolved": true},
    {"id": "<event worktree id>", "label": "Outside known worktrees", "resolved": false}
  ],
  "file_events": 140,
  "unreadable_file_events": 0,
  "truncated": false,
  "truncated_total": 0,
  "capture_gap": false
}
```

- `heat` is sparse `[bucket_index, count]`, ascending index; `total` is its sum.
- `paths` sorted by `group` then `path` (byte order), which is also the layout order.
- Resolved paths have `group: ""` and are repository-relative, slash-separated.
  Unresolved paths keep their raw absolute path and carry the `group` of the
  event's own worktree identity (its "own bucket" in the plan's wording).
- Cap: 2000 paths. Over the cap keep the 2000 highest `total` (ties by path),
  re-sort as above, set `truncated: true` and `truncated_total` to the dropped Heat.
- `unreadable_file_events`: file events in scope whose path could not be extracted
  (e.g. recorded in minimal mode, so the payload value is a `{sha256,len}` map).
- Minimal mode **now**: return `available: false, unavailable_reason: "minimal"`,
  empty `paths`, and do not scan. (Matches the plan: paths are digests on disk.)

### 2. Capture aggregate

New `internal/capture/activity.go`: `func (e *Engine) Activity(ctx, ActivityQuery) (ActivityResult, error)`,
modelled line for line on `Engine.Timeline` in `internal/capture/graph_history.go`:

1. Identity groups from `RepoID`+`RepoAliases` and `WorkspaceID`+`WorkspaceAliases`
   via `identityValues`; prefilter via `spool.IdentityNeedles`.
2. `e.projection.TimelineDays(groups, "")`, then keep only UTC days overlapping
   `[from, to)`.
3. `e.scanDay` each day; per event: `identityMatches` on repo and workspace,
   `Category == file`, time in window, canonical-day dedupe via
   `e.projection.EventDay` plus the `seen` set (copy the Timeline logic exactly).
4. Paths from `projection.EventFilePaths(ev)` (already handles `file_path`, `path`,
   `file`, codex `changes` map). An event touching N paths adds 1 Heat to each.
   No paths → `unreadable_file_events++`.
5. Each `(event, path)` goes through `q.Resolve` (below) to `(group, path)`.
6. Honour `ctx` between and inside days; set `CaptureGap` exactly as Timeline does.

Capture stays graph-agnostic, as with Timeline: it never imports
`internal/workspacegraph`. The daemon passes aliases and a resolver function:

```go
type ActivityQuery struct {
    RepoID, WorkspaceID           string
    RepoAliases, WorkspaceAliases []string
    From, To                      time.Time
    Bucket                        time.Duration
    // Resolve maps one captured path to its display group and path.
    Resolve func(ev event.Event, path string) (group, rel string)
}
```

### 3. Root resolution (the workspace-graph join)

Build the resolver in the daemon from the graph snapshot, reusing the loop already
in `handleGraphTimeline` (`workspace_graph.go` ~287-294): for each
`snapshot.Workspaces`, `EventScope(repo, ws.ID)` returns `[rawIdentity, digest(rawIdentity)]`.
`rawIdentity` is the canonical worktree root for Git (`git.go:60`) and `"jj:" + root`
for JJ (`jj.go:46-48`); strip the `jj:` prefix. A JJ workspace with no root
(`rawIdentity` = `repo:name`) has no root. No new Service method is needed.

Map: alias (raw and digest) → root. Resolution order per path:

1. Clean it (`filepath.Clean`). Relative path: if the event's worktree
   (`WorktreeID`, else `JJWorkspaceID`) resolves, treat it as root-relative
   (reject results starting with `..`); otherwise unresolved.
2. Absolute path under the event's own worktree root → `filepath.Rel`, `ToSlash`.
3. Absolute path under another known root of the same repo (an agent in worktree A
   editing worktree B) → relative to that root. Longest root wins.
4. Otherwise unresolved: `group` = the event's worktree identity value (or `"unknown"`),
   path kept raw. This covers deleted worktrees, which the current snapshot no
   longer lists, and edits outside the repository.

With `workspace_id` set, merge nothing: only that worktree's events reach the
resolver anyway.

Balanced mode truncates payload strings at 240 runes, so a very long path arrives
ending in `…`. Count it as-is; the client shows it verbatim.

### 4. Contract

Add a subsection "Activity heat (additive)" under "Workspace graph and scoped
timeline (additive)" in `docs/contracts.md`, in the style of "Per-file change
statistics": route, params, bounds, response fields, minimal-mode behaviour,
the day-index read bound. No `schema_version` bump. Note that paths in this
response are display values (readable in balanced and full) like other graph labels.

## Desktop

All under `apps/tauri-desktop/src/`.

### 5. API and model

- `ui/graph/api.ts`: `ActivityResponse` type and `graphAPI.activity(params, signal)`
  via the existing `request` helper (path `/activity`).
- New `ui/activity/model.ts` (pure, no DOM):
  - `buildTree(resp)`: directory tree from `paths`; one top-level node per group;
    the unresolved groups go last under a node labelled "Outside known worktrees".
  - `layout(tree, width, height)`: **order-preserving split treemap**. Children
    stay in path order; recursively split the ordered list into two runs of
    roughly equal weight, along the longer side. Deterministic: same response and
    size give the same rectangles. Directory padding 2px, label strip when the
    rect is tall enough. Not squarified (that sorts by size and breaks path order).
  - **Invariant:** tile *size* = `total` over the whole loaded window; tile *colour*
    = Heat summed over the brushed bucket range. Brushing never moves a tile.
  - `rangeHeat(path, a, b)`, `histogram(resp)` (total Heat per bucket for the strip),
    `colour(heat, max)`: one sequential hue, sqrt scale, zero Heat = neutral fill.
    Use the existing CSS tokens; check both themes.
  - `hottest(resp, a, b, n = 20)` for the side list.

### 6. View and tab

- New `ui/activity/index.ts`: `createActivityMap(...)` returning `{ root, update(repo, workspaces, privacyMode) }`.
  - Header: window presets (2h, 8h, 24h, 7d) plus a Live toggle (window ends at
    now, refetched on the graph's existing poll), worktree select seeded from
    `snapshot.workspaces` ("All worktrees" default).
  - SVG treemap. Hover: `<title>` with path, Heat in range, window total.
    Click a directory: zoom into it with a breadcrumb back. Click a file: no
    navigation in v1 (Timeline's `search` matches summary/name, not paths).
  - Scrubber under the map: the per-bucket histogram plus a draggable brush
    `[a, b]`, default the whole window. Keyboard: arrows move the brush one
    bucket, shift+arrows resize, Home/End jump. Axis labels in local time.
  - Side list "Hottest in range" (top 20, path + count): the accessible
    equivalent of the map.
  - Notices: minimal mode ("Paths are stored as digests in minimal mode; the
    Activity Map is unavailable."), empty window, `capture_gap`, `truncated`
    (with `truncated_total`), `unreadable_file_events > 0`.
  - Abort the in-flight request on any parameter change (as Timeline's `historyRequest`).
  - Strip control characters from every rendered path with `stripControl`.
- Third tab "Map". Every site of the `"graph" | "timeline"` union must change:
  `ui/graph/index.ts:85` (state), the `setTab` handler (~313), `render()`
  (~523-552, add the map branch and an `is-map` class), the history/timeline
  guards (~474, 916, 924, 1083, 1142, 1162), and `ui/graph/toolbar.ts:63, 67,
  210-216, 302`. The map shares `repo` with Graph and Timeline; switching repo
  resets it.
- Styles in `styles.css` next to the graph rules.

## Tests (TDD: each lands red first)

Go, using real payload shapes (the claude-code `pre_tool_use_edit.json` fixture
for absolute `file_path`, the sanitized codex rollout for a `changes` map). Before
writing the resolver, check a **copy** of the real spool for what opencode,
antigravity and codex-hook actually put in `file_path` (their fixtures are
sanitized markers) and pin each real shape (absolute or relative) with a test.

- `capture/activity_test.go`: `TestActivityCountsFileEventsPerPathPerBucket`,
  `TestActivityIgnoresNonFileCategories`, `TestActivityWindowIsHalfOpen`,
  `TestActivityFloorsFromToBucket`, `TestActivityMultiPathEventCountsEachPath`,
  `TestActivityDedupesReplayedIDAcrossDays`, `TestActivityReadsOnlyWindowDays`
  (seam-count the scanned days), `TestActivityCountsUnreadableMinimalPayloads`,
  `TestActivityHonoursCancel`, `TestActivityCapsPathsAndReportsTruncated`.
- `daemon/workspace_graph_test.go` (or a new `activity_test.go`):
  `TestActivityMergesWorktreesByRelativePath` (two real git worktrees, balanced mode),
  `TestActivityWorkspaceFilter`, `TestActivityCrossWorktreeEditResolvesToOtherRoot`,
  `TestActivityUnknownWorktreeFallsBackToRawGroup`, `TestActivityJJRootStripsPrefix`
  (skip if `jj` missing, like existing JJ tests), `TestActivityFullModeMatchesRawIdentity`,
  `TestActivityMinimalModeUnavailableWithoutScan`, `TestActivityRejectsBadWindowAndBucket`,
  `TestActivityOriginRestricted`, plus a scale test beside
  `graph_history_scale_test.go` showing cost is bounded by window days.
- Desktop (vitest): `activity/model.test.ts` — tree grouping, split-treemap
  determinism and path order, size from total / colour from range (tile rects
  identical across two brush ranges), histogram, hottest. `activity/index.test.ts` —
  notices for each flag, brush keyboard, directory zoom, request abort, repo
  reset. `graph/index.test.ts` / toolbar tests — third tab switching.
- Fixture: `ui/activity/fixture.activity.json`, a real `/workspace-graph/activity`
  response from a **temporary** daemon (non-default `daemon_addr`, temp HOME seeded
  with a copy of real spool days) over a real repo, personal paths rewritten, same
  discipline as `score/fixture.session.json`. Never point tests or smoke runs at the
  live daemon on 4517.

## Order of work

1. Resolver + capture aggregate (tests 2-3).
2. Route, bounds, minimal gate, contract doc (1, 4).
3. Client API + model (5).
4. View + tab wiring + styles (6).
5. Live check: temporary daemon, `pnpm -C apps/tauri-desktop tauri dev` or vite on
   port 1420 (daemon CORS allowlist), `firehose-onboarded` set in localStorage;
   screenshot an overnight window, a live window, a filtered worktree, minimal mode.
6. Append "Shipped" to the plan doc with what landed and real-capture quirks seen.

## Validation

```sh
gofmt -l .            # must print nothing
go vet ./...
go test ./...
pnpm -C apps/tauri-desktop test
pnpm -C apps/tauri-desktop build
```

If node/pnpm misbehave in a non-interactive shell, they are shadowed by an nvm
shim: prefix `PATH=$HOME/.nvm/versions/node/v24.2.0/bin:$PATH`.

## Known characteristic to keep visible

Heat counts events, as defined. Claude Code emits a `pre_tool_use` and a
`post_tool_use` file event per edit (only edit tools are file-category; Read is
not), so one edit is 2 Heat, while sources that emit one event per change are 1.
Relative heat within one agent is right; a repo worked by mixed agents is skewed
toward Claude Code. Changing this (e.g. one per `call_id`) changes the CONTEXT.md
definition and is not part of this build unless decided first.
