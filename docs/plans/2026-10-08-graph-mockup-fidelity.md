# Workspace graph: mockup fidelity (layout and behavior)

Authority: [implementation specification](../specs/workspace-graph-and-hook-timeline.md)
(its hard rules win over the mockup), then this plan. Target:
`docs/specs/Agent Firehose Ancestry Graph Inspector.png` (in the main checkout).
Prior plan: [2026-10-04](2026-10-04-workspace-graph-timeline.md).

Scope (user decision): the Workspaces graph screen only: canvas, labels,
inspector, header/toolbar, legend/axis annotations. The app's global left nav,
every other view, and the Timeline tab's behavior are unchanged. Worktree:
`/Users/nicholas/develop/llm-firehose-graph-mockup`, branch
`feat/graph-mockup-fidelity`. No commits, pushes or PRs by builders.

## Hard rules (restated, each has a named test below)

1. Edges are real revision parents only; every present parent of every node is
   drawn (merge parents never dropped); no edge across omitted history.
2. Every workspace is reachable: a visible pill, a counted expandable cluster, or the
   "no revision" strip; also listed in the search results.
3. Never infer which workspace created another. The inspector says "unknown".
4. New API fields are additive, optional, documented in `docs/contracts.md`; no
   `schema_version` bump. Amended 2026-10-09: graph display data is readable in
   every privacy mode; `id` fields still follow the mode (see Amendment below).
5. No new dependencies: dependency-free SVG/DOM, Go standard library.
6. TDD: each behavior starts with a failing test.
7. Interactive with 50 workspace labels and 2,000 loaded revisions.
8. Daemon safety: never contact 127.0.0.1:4517 or run `firehose`/`firehosed`
   without an isolated `HOME` whose config sets a different `daemon_addr`.

## Findings: mockup vs current (verified in code, element by element)

Confirmed from the task's gap list: (1) `layoutGraph` ranks by depth from tips and
places nodes left to right in input order, no lanes, no crossing reduction, so one
trunk plus long curves. (2) Labels are 285x29 rects with a 43-char caption.
(3) One edge style; selection recolors ancestry but nothing dims. (4) No axis
annotations, ticks or footer; initial fit covers the whole graph. (5) Header is an
h2 + select + buttons, a tabs row, a controls row and a permanent left list.
(6) Inspector is plain paragraphs; `changed_files` is `string[]` of raw porcelain
(`"?? file"`, in minimal mode the whole entry is hashed), no stats. (7) The fixture
points worktrees at trunk commits with an empty tree, so no divergent branches and no
file content for diffs.

Additional gaps found:

- `refreshActivity()` and every selection change call `render()`, which rebuilds the
  whole SVG and re-lays-out; with agent attention updating every 500 ms this will not
  stay interactive at 2,000 nodes. Layout must be memoized; state changes must only
  toggle classes.
- 2,000 revision circles each get `tabindex=0` and their own listeners. Replace with one
  delegated handler and roving focus (labels tabbable, nodes reached by click and the
  inspector's parent buttons).
- Mockup draws merge commits as squares, conflicted revisions with a red ring, tips
  with a state-colored ring, chains of active workspaces purple and dormant history
  gray. None exist today.
- `Snapshot.default_target` is a bare commit ID; "Compare with main" needs the ref
  name (new `default_target_ref`).
- `Workspace.changed_files` has no per-file counts/status; uncommitted `+42 -11 M`
  rows need a new field. Comparison has the same gap.
- Repository and workspace labels were digests outside full mode (hashed paths). Since
  2026-10-09 graph labels are readable in every mode, so the mockup's `llm-firehose` /
  `wt-07-fix` style names always show (see Display names).
- Existing tests reference old DOM (`Fit` meaning "fit all", `.workspace-label`,
  `[data-key]`, `.graph-inspector code`). The stable hooks below keep them valid.
- The second toolbar control in the mockup is garbled ("Eit"); it is interpreted below.

## Decision checklist

Implement unless marked DEVIATE.

Header and toolbar
1. Repository picker: icon + name + chevron (styled native select). Shows the root's basename (parent directory added on collisions); a digest label from an older daemon shows as `repo ab12cd34`.
2. "N worktrees" count (`workspaces` for JJ).
3. Search with `⌘K` hint and a results listbox (workspaces, refs, commit IDs, descriptions). Replaces the "Find workspace" select. Empty focus lists all workspaces, so every workspace stays keyboard reachable.
4. `Fit` = active tips + connecting history. `All` = whole loaded graph. (Interpretation of the garbled mockup control.)
5. Graph/Timeline tabs stay, restyled as a segmented control in the header. Not in mockup; required by spec.
6. Register local root / Refresh stay, moved into a "More" menu. Not in mockup; required.
7. DEVIATE: no +/- zoom buttons. Zoom by wheel, `+`/`-`/`0` keys. Spec requires zoom, not buttons.
8. DEVIATE: "Concept - fictional data" tag omitted (mockup-only).
9. The permanent left workspace list is removed (replaced by labels, clusters, search results).
10. Global nav inside the mockup frame is out of scope (app nav unchanged).

Canvas
11. Lane layout: trunk bottom-centre, branches fan left and right, newer upward.
12. Crossing reduction (barycentric refinement) and smooth S-curve edges.
13. Solid parent edges and dotted merge edges (non-first parents), legend footer.
14. Merge commits drawn as squares; conflicted revisions red ring; tip nodes ringed by agent state; active chains purple, dormant gray.
15. Compact pill: short name + agent-state dot; separate amber `dirty` / red `conflict` badges; leader stub when displaced.
16. Label placement beside tips, collision-free against pills, badges and nodes.
17. Expandable counted cluster when more than 3 labels share a revision (3 or fewer stack).
18. Selection: teal glow ancestry, everything unrelated dimmed (never hidden or unclickable); descendants highlight is a separate toggle.
19. DEVIATE (wording): axis annotations read "Newer commits ↑ (descendants)" / "Older commits ↓ (ancestors)". The mockup's "more recent / earlier in history" implies time; layout follows parents.
20. Depth gridlines with numeric ticks, honest: tick = revision depth in the loaded history (longest parent path from a loaded root), captioned "Depth in loaded history, not time". Pinned to the left edge in screen space.
21. Footer: legend (solid parent link, dotted merge) and an honest status: "All N workspaces labelled · M in view · History expandable" (expand action only when `next_cursor`). DEVIATE: not "visible" when some are off-screen.
22. Initial and `Fit` view = bounding box of active tips + connecting history, with a readable minimum scale of 0.4 anchored on the newest tips. Active = workspaces with a fresh working/needs-attention session; none active means all.
23. Pan (drag on background), wheel zoom about the cursor, arrows pan, arrows between focused labels move focus to the nearest label in that direction, Enter selects, `Esc` clears selection, `⌘K`/`/` focuses search.
24. Omitted-parent boundary marker kept ("older history not loaded").
25. Stale/warning banner kept as an overlay inside the canvas (`.graph-status`).
26. Workspaces with no resolvable revision (unborn) go in a labelled strip below the roots; no ancestry drawn.
27. Disconnected histories are laid out side by side, bottom aligned.

Inspector
28. Status dot + name; Branch row with copy button (`Detached HEAD abc1234` when detached).
29. Agent rows: `● Codex • Working` per associated session (two agents display separately, source-qualified), each opens its session; "Filter Timeline" per session.
30. `Compare with <default ref> ▾`: default branch, other workspaces' revisions, and "Custom revision…" (commit-ID input). Compares automatically; the Compare button is gone.
31. Stats rows: unique commits (selected-only count), uncommitted files, shared ancestors loaded (client-computed from loaded nodes; label says "loaded").
32. `Changes (N files)`: uncommitted checkout files with `+adds -dels` and a status letter (new `changes`). Committed comparison files shown separately under "Inspect changes".
33. "Captured activity": latest 3 scoped events with relative times, plus "Open scoped Timeline".
34. DEVIATE (honesty): "Origin workspace: unknown (?)" is always unknown; help text says Firehose does not infer or record which workspace created another.
35. Primary "Highlight ancestry" (re-applies ancestry highlight and fits to it); secondary "Inspect changes" (toggles the comparison detail: commit lists, merge bases, committed files).
36. Revision inspector (identifiers, description, parents as buttons, timestamp, JJ change ID) kept for a selected revision with no workspace; required by spec.

Backend, fixture, docs
37. Additive fields (see contract): `Workspace.changes`, `changes_truncated`, `Comparison.changes`, `changes_truncated`, `Snapshot.default_target_ref`. `changed_files` is unchanged.
38. Mockup-shaped fixture (`--shape mockup`), self-checking.
39. `docs/contracts.md` documents the fields and privacy behavior.
40. Existing Timeline tab behavior and its tests stay green.

## Layout algorithm (`layout.ts`, pure, deterministic)

Output is independent of input order (keys sorted for every tie); no randomness or clocks.

1. Index. Present parents only; absent parents mark `boundary`. Components by union-find, ordered: the one containing `trunkTip` first, then by size desc, then smallest key.
2. Rank. Kahn from roots (no present parent); `rank = 1 + max(rank of present parents)`; roots 0. Iterative, O(n+e). `y = (maxRank - rank) * rowH`, so roots sit at the bottom and children above, always `child.y < parent.y`. `rowH = clamp(1360 / maxRank, 14, 34)`.
3. Chains. Primary parent = first present parent. In the primary-parent forest compute subtree sizes; heavy child = trunk-line child (first-parent line from `trunkTip`) first, then largest subtree, then smallest key. A chain is a heavy path; the root chain of each component is its trunk (lane 0).
4. Lanes. Chains in priority order (trunk, then length desc, fork rank asc, key). Each chain takes the nearest lane to its parent chain on the side with the smaller distance (tie: lighter side by node count, then alternate starting right) whose per-lane sorted rank intervals are free for: the chain's span, a 2-rank "drift ramp" after the fork (the first K=min(3, len-1) nodes interpolate x from the parent lane to their own lane with smoothstep, reserving the lanes crossed), and the outward label reservation (`ceil(labelWidth / laneW)` lanes, ranks around the tip). `laneW = 44`.
5. Refine. 4 sweeps (`refineSweeps`, 0 disables): per non-trunk chain, barycenter x of its non-chain neighbours (fork, attached child forks, merge-edge endpoints); move to the nearest free lane on the same side if the sum of |dx| of adjacent edges strictly decreases. Deterministic order alternates top-down / bottom-up.
6. Edges. One per (child, present parent) in node order then parent order. `kind = "merge"` for parent index >= 1, else `"parent"`. Cubic S-curve with vertical tangents: `M cx cy C cx cy+h px py-h px py`, `h = clamp(0.55*|dy|, 10, 120)`.
7. Components x. Each component centred on its own origin; next starts after the previous extent plus labels plus 120 px.
8. Labels. Group by revision. Group size <= `maxStack` (3): stacked pills (28 px pitch). More: one collapsed chip "N workspaces" (every member listed in `clusterOf`); when the revision is in `expanded`, a header chip plus all pills stacked. Pill size from `estimateLabelWidth` (`28 + 6.7*chars`, clamp 60..180, height 24); badges are separate pills (`14 + 6*chars`, height 22) after the pill's outer edge. Placement, top-first: preferred side = outward (lane > 0 right, < 0 left, 0 right), then the other side, then vertical shifts +-1..6 x 14 px, then horizontal rings; each candidate tested against a 64 px spatial hash of placed pills, badges, chips and node squares (own node excluded). A leader stub is emitted when displaced. Search is capped at 200 candidates, then the last candidate wins (never drops a label).
9. Axis. `step` = smallest of 1,2,5,10,20,50,100,200,500,1000 with `step*rowH >= 70`; ticks at rank multiples of step.
10. Fit. `fitBounds(layout, focusIds)`: with focus tips T (<=50, bitset masks propagated child to parent), fork nodes are nodes with two or more children whose masks are non-empty (or a tip that has masked children); `floorRank` = min rank of fork nodes, or `max(0, minTipRank - 4)` when there are none; rect = bbox of nodes with non-empty mask and `rank >= floorRank` plus focus labels, padded 40 px. No resolvable focus returns the full bounds.

Complexity: O(n log n) overall (sorting; lane search is bounded to 64 lanes per chain; label search is O(1) per candidate via the hash). Budget: 2,000 nodes + 50 labels in under 250 ms (test allows 400 ms).

## Contract between packages

TypeScript, module `apps/tauri-desktop/src/ui/graph/layout.ts` (owned by `layout`,
consumed by `view`). `GraphNode`, `Anchor`, `Point`, `relatives`, `TimelineState`,
`eventWorkspace` stay exported from `model.ts` unchanged.

```ts
import type { GraphNode, Point } from "./model";
export interface Rect { x: number; y: number; w: number; h: number }
export interface LayoutWorkspace {
  id: string;
  revision_key?: string;      // missing/unknown => "unattached"
  name: string;               // short display name (view truncates to 24 chars)
  badges?: string[];          // e.g. ["dirty"], ["conflict"], one pill each
}
export interface LayoutOptions {
  trunkTip?: string;                    // default-branch tip revision key
  expanded?: ReadonlySet<string>;       // revision keys whose cluster is expanded
  maxStack?: number;                    // default 3
  refineSweeps?: number;                // default 4
}
export interface LaidNode {
  key: string; x: number; y: number; rank: number; lane: number; chain: number;
  component: number; boundary: boolean; merge: boolean;   // merge: >= 2 present parents
  anchors: number;                                         // workspaces attached here
  chainActive: boolean;                                    // chain carries >= 1 workspace anchor
}
export interface LaidEdge {
  child: string; parent: string; kind: "parent" | "merge"; d: string; chain: number;
}
export interface LaidBadge { text: string; x: number; y: number; w: number; h: number }
export interface LaidLabel {
  id: string; revision_key: string; x: number; y: number; w: number; h: number; // top-left of pill
  side: "left" | "right"; badges: LaidBadge[];
  leader?: { x1: number; y1: number; x2: number; y2: number };
}
export interface LaidCluster {
  revision_key: string; x: number; y: number; w: number; h: number;
  count: number; members: string[]; expanded: boolean;
}
export interface Tick { rank: number; y: number; label: string }
export interface GraphLayout {
  nodes: Map<string, LaidNode>;
  edges: LaidEdge[];
  labels: Map<string, LaidLabel>;          // workspaces drawn as individual pills
  clusters: LaidCluster[];
  clusterOf: Map<string, string>;          // workspace id -> revision_key of the COLLAPSED cluster hiding it
  unattached: string[];                    // workspace ids with no resolvable revision
  unattachedBox?: Rect;                    // strip holding their pills; those pills are also in `labels`
  boundaries: string[];                    // node keys with an absent parent
  components: { x: number; w: number; nodes: number }[];
  ticks: Tick[];
  bounds: Rect;                            // everything incl. labels, excl. axis
  rowH: number; maxRank: number;
}
export function layoutWorkspaceGraph(
  nodes: GraphNode[], workspaces: LayoutWorkspace[], options?: LayoutOptions): GraphLayout;
export function fitBounds(layout: GraphLayout, focus?: string[]): Rect;   // workspace ids
export function focusPoint(layout: GraphLayout, workspaceId: string): Point | undefined; // pill, else cluster chip, else its node
export function neighborLabel(layout: GraphLayout, fromId: string,
  dir: "up" | "down" | "left" | "right"): string | undefined;
export function estimateLabelWidth(name: string, badges?: string[]): number;
export function countCrossings(layout: GraphLayout): number;               // test/diagnostic helper
// model.ts
export function sharedAncestorCount(nodes: GraphNode[], a: string, b: string): number; // |anc(a) ∩ anc(b)|, loaded nodes only
```

Invariants the view may rely on: exactly one `labels` entry, one `clusterOf` entry
or one `unattached` entry per workspace (clustered members have no `labels` entry
until expanded); world coordinates, y grows downward, `child.y < parent.y`; paths in
`LaidEdge.d` are absolute world coordinates.

Stable DOM hooks the view must keep (existing tests rely on them): `.workspace-label`
with `data-key="workspace:<id>"`, `.selected`, `.muted`; `data-key="revision:<key>"`
with `.revision-node` and `.selected`; `.graph-canvas > g` is the pan/zoom group
(`transform="translate(x y) scale(s)"`); `.graph-status` (role=status);
`.graph-inspector` with the selected revision's full commit ID in a `<code>`;
`.graph-timeline`, `.graph-events`, `.graph-event-detail`; button texts `Graph`,
`Timeline`, `Fit`, `Open scoped Timeline`, `Show in Graph`, `● Live · pause`.

### API (backend produces, view consumes; all optional, `omitempty`)

```jsonc
// GET /workspace-graph  -> Snapshot
"default_target_ref": "main",            // name of the ref behind default_target
// Snapshot.workspaces[]
"changes": [{ "path": "session.go", "status": "M", "additions": 42, "deletions": 11 }],
"changes_truncated": true,               // present only when more than 200 files
// GET /workspace-graph/compare -> Comparison
"changes": [{ "path": "graph.go", "status": "A", "additions": 18, "deletions": 0 }],
"changes_truncated": true
```

`FileChange`: `path` string; `status` one of `M A D R C T U ?` (`?` untracked,
`U` unmerged, working-tree letter wins over index letter); `additions`/`deletions`
integers, omitted for untracked and binary files; `binary: true` only when binary.
Go: `Additions, Deletions *int`; the structs live in `types.go`.

Privacy (amended 2026-10-09): `path` and `default_target_ref` are returned verbatim
in every mode, like `changed_files`, refs and descriptions; graph responses are local
display data. `status`, `additions`, `deletions`, `binary` are structural metadata
retained in all modes (same class as `dirty`, parent keys). `changes` is omitted when a workspace is
clean or details are unavailable (JJ counts may be omitted; path and status are
required for JJ). Existing `changed_files` and every existing field keep their
meaning. Bound: 200 entries, then `changes_truncated`. Collection runs read-only
inside the existing shadow git dir (`--no-ext-diff --no-textconv`, `-z`), only for
dirty workspaces; JJ uses `jj diff --summary`/`--stat` with the existing
`--ignore-working-copy` runner. Untracked files have no counts.

TypeScript mirror in `api.ts` (view): `FileChange`, `Workspace.changes?`,
`Workspace.changes_truncated?`, `Comparison.changes?`, `Comparison.changes_truncated?`,
`Snapshot.default_target_ref?`.

### Display names (view, `names.ts`)

Workspace pill name (amended 2026-10-09, labels are readable in every mode): JJ
label (workspace name) as is; Git the basename of the worktree path, full path in the
tooltip and inspector. Repository name: basename of the root path, with the parent
directory added when two repositories share a basename. Labels that are still digests
(older daemons) fall back to the first 8 hex chars (`repo` + 8 hex for repositories).
Source names: `codex` Codex, `claude-code`/`claude` Claude
Code, `opencode` OpenCode, else as given. Agent state dot: needs attention amber,
working teal-green, other observed purple, none gray; tooltip and `aria-label`
carry the words. State uses `pendingNow`/`stateFresh` as the current code does.

## Package split (disjoint file ownership)

### layout (pure logic)
Files: `apps/tauri-desktop/src/ui/graph/layout.ts`, `layout.test.ts`,
`layout.fixtures.ts` (seeded random DAG, mockup-shaped DAG builder), `model.ts`,
`model.test.ts`.

Tasks, in order (T1 lands first so view can import types):
- L1. Create `layout.ts` with the exported types/signatures above and a naive but valid implementation (typed, shape-correct) so the view can import it immediately.
- L2. Ranks, components, boundaries, edges (kind, path) with tests; migrate the two legacy layout tests to the new API.
- L3. Chains + lane packing + drift; trunk lane 0; both sides used.
- L4. Refinement sweeps and `countCrossings`.
- L5. Labels: stacking, clusters, placement/collision, leaders, unattached strip.
- L6. Ticks, `fitBounds`, `focusPoint`, `neighborLabel`.
- L7. `sharedAncestorCount` in `model.ts`; performance test.
- L8. Delete legacy `layoutGraph` and its tests only when `grep -rn layoutGraph apps/tauri-desktop/src` shows only `model.ts`/`model.test.ts` (the view has switched).

Tests (vitest): edges equal the set of present (child,parent) pairs including both merge parents and none across omitted parents; `child.y < parent.y`; every workspace in exactly one of labels/clusterOf/unattached; 25 workspaces on one revision -> one cluster with count 25 and expanded view shows 25 non-overlapping pills; no two label/badge/cluster rects overlap each other or any node square (seeded random DAGs and the mockup graph); sibling branches fan to both sides of the trunk (lane < 0 and > 0); a pure tree has zero crossings; refinement never increases `countCrossings` versus `refineSweeps: 0` on the mockup graph; output deep-equal after shuffling inputs; disconnected components have disjoint x-ranges; `fitBounds` covers focus tips and the fork floor but not an unrelated deep lane; `focusPoint` for clustered members returns the chip; `neighborLabel` moves in the requested direction; depth ticks monotonic with at most 40 entries; 2,000-node chain and 2,000-node branching graph with 50 labels each complete under 400 ms.

### backend (Go, docs, fixture)
Files: `internal/workspacegraph/{types.go,git.go,jj.go,compare.go,shadow.go,service.go,service_test.go}`, new `internal/workspacegraph/{changes.go,changes_test.go,fixture_test.go}`, `internal/daemon/workspace_graph.go` and `internal/daemon/workspace_graph_test.go` (only if needed), `docs/contracts.md`, `scripts/workspace-graph-fixture.py`.

Tasks:
- B1. Failing tests then `FileChange` types, `Workspace.changes` for Git (porcelain status + `git diff --numstat -z HEAD` in the shadow env; untracked and binary handling; unborn HEAD skips numstat; 200 cap), clone() deep-copies.
- B2. `Comparison.changes` (`--raw -z` + `--numstat -z`, same bound), Git and JJ.
- B3. JJ `changes` (path and status required, counts best effort); never snapshot the working copy.
- B4. `Snapshot.default_target_ref` (git main/master, jj bookmark) through `content()`.
- B5. `docs/contracts.md`: fields, privacy, omission rules, caps.
- B6. Fixture `--shape mockup` plus `--check`; `fixture_test.go` runs it with `python3 -I`.

Tests (Go): `TestGitUncommittedChangeStats` (modified, staged add, delete, rename, untracked, binary, 201 files truncated); `TestChangeStatsPrivacy` (minimal and balanced JSON contain no raw path; balanced truncates at 240 runes; full verbatim; status and counts present in all modes); `TestChangedFilesUnchanged` (legacy field identical); `TestCompareChangeStats` (Git and JJ, including multiple merge bases); `TestDefaultTargetRefPrivacy`; `TestJJChangesReadOnly`; daemon JSON test that a clean workspace omits `changes` and field names match the contract; `TestMockupFixtureShape` (skips without python3/git): 25 workspaces, >= 100 nodes, >= 2 merge commits (two parents), 1 detached, >= 6 dirty with non-empty `changes`, max depth >= 25, a revision hosting >= 2 worktrees.

Fixture shape (`--shape mockup`, 25 workspaces, `--revisions` ignored; default shape stays `linear` so the documented 50 x 2000 performance command is unchanged): real blobs and trees (`session.go`, `graph.go`, `graph_test.go`, `README.md` mutated per commit) so diffs have counts. Main trunk M0..M12 with main tip at M12 (the root sits at the bottom). Branch lanes with their own commits at varied depths (2 to 18); two worktrees on a shared trunk revision; an anchor revision A (child of M9) with seven worktrees around it: two on A itself, one on the lane tip, and three branches forking further along the same lane (at L3, L5, L6) with 1 to 3 commits each; a deep left lane (18 commits) with three short forks; two merge commits (one merging another branch's lane, one merging main into a feature branch); one detached worktree at an interior commit; at least 6 dirty worktrees (modified tracked file with +/-, staged new file, deleted file, untracked file, rename, one binary); the selected-demo worktree `wt-07-fix` with exactly three changed files. Prints the temp root; writes `fixture.json` with `shape`, workspace paths and expected counts.

### view (DOM, CSS, interactions)
Files: `apps/tauri-desktop/src/ui/graph/{index.ts,api.ts,index.test.ts}`, new `canvas.ts`, `canvas.test.ts`, `inspector.ts`, `inspector.test.ts`, `toolbar.ts`, `names.ts`, `names.test.ts`, optional `timeline.ts` (move the existing Timeline code unchanged), and the graph block of `apps/tauri-desktop/src/styles.css` (between the `/* workspace graph */` markers; nothing else in that file).

Tasks:
- V1. `api.ts` types per the contract; `names.ts` (display names, agent state, relative age via `formatAge`).
- V2. `toolbar.ts`/header: tabs, repo picker, count, search + results listbox, Fit/All, More menu; remove the left list and controls row.
- V3. `canvas.ts`: build SVG once per layout (memoized on `generation` + workspace signature + expanded set); delegated click/keydown; classes-only `applyState`; pills with dot + badges; clusters; merge squares; dotted merge edges; boundary markers; unattached strip; gridlines/ticks in a screen-space axis layer; axis annotations; footer legend; dimming/descendant toggle; search match/mute; pan, wheel zoom, keyboard.
- V4. `inspector.ts`: workspace and revision inspectors per checklist 28-36; compare select with default ref, custom revision disclosure, epoch-guarded requests; copy button with try/catch fallback.
- V5. Wire `index.ts`: initial/Fit/All view, viewport and selection stable across refreshes, `refreshActivity` updates dots and the inspector without rebuilding the SVG, Show in Graph and cluster auto-expand for the selected workspace, Timeline tab unchanged.
- V6. CSS: dark graph theme scoped under `.workspace-graph` (tokens `--g-bg #0b121b`, `--g-panel #0e1621`, `--g-line #233245`, `--g-teal #2de2d0`, `--g-purple #7a5cf0`, `--g-amber #f0b429`, `--g-green #34d399`, `--g-gray #7d8aa0`), teal glow on selected edges, 340 px inspector, canvas flex fill, minimum canvas width 480 px.
- V7. Update existing tests for the new Fit/All semantics, then add the new ones.

Tests: header shows repo, `N worktrees`, search with `⌘K`; no permanent workspace list; label is a pill with short name, state dot, separate `dirty` badge; more than 3 labels on a revision show a counted cluster that expands on click and auto-expands for the selected workspace; selecting a workspace marks ancestry `selected` and dims unrelated nodes/edges/labels while they stay clickable; descendants toggle; dotted class on merge edges and one drawn edge per parent edge; selecting does not recreate the `svg` element, and an attention refresh does not either (identity check) yet recolors the dot; inspector shows branch + copy, agent rows (two agents separately, equal IDs across sources distinct), compare select default `main`, stats, `Changes (3 files)` with `+42`/`-11`/`M`, captured activity (3 newest scoped, relative age), `Origin workspace unknown` with no inferred value; buttons Highlight ancestry and Inspect changes; minimal-mode digests render without leaking; axis annotations and ticks; footer text honesty (`M in view`); initial scale >= 0.4 and anchored on tips; `All` goes below 0.1 for a 2,000 chain; search `⌘K` focus and result selection centres the label; arrow keys move focus between labels; Esc clears selection; 2,000 revisions + 50 labels render without per-node listeners and selection toggles in under 100 ms of script time (measured with `performance.now` in the test, generous bound); Timeline tab tests unchanged.

## Integration and review (orchestrator, after builders finish)

Order: layout L1 first, then backend/view/layout concurrently, then integration.

1. Gates: `(cd /Users/nicholas/develop/llm-firehose-graph-mockup && gofmt -l . && go vet ./... && go test ./...)`; `PATH=/opt/homebrew/opt/node/bin:/opt/homebrew/bin:$PATH pnpm -C apps/tauri-desktop test`; same PATH with `pnpm -C apps/tauri-desktop build`.
2. Optional perf: `FIREHOSE_GRAPH_PERF=1 go test ./internal/workspacegraph -run TestLargeGraphFixture -v`.
3. Cross-review (a different builder reviews each package): hard-rule audit (edges vs parents, merge parents, no origin inference, privacy of new fields, additive-only contract, no dependency added), selection/viewport stability, stale handling, unavailable `changes`.
4. Visual verification (isolated; never port 4517):
   - Fixture: `python3 -I /Users/nicholas/develop/llm-firehose-graph-mockup/scripts/workspace-graph-fixture.py --shape mockup --workspaces 25` (set `TMPDIR` to the scratchpad when running).
   - Temp `HOME` whose `config.json` sets `daemon_addr` to `127.0.0.1:45517` and `privacy_mode` to `full`; build `go build -o <scratch>/firehosed ./cmd/firehosed`; run `HOME=<tmp> <scratch>/firehosed -addr 127.0.0.1:45517`; register the fixture root with `curl -X POST 127.0.0.1:45517/workspace-graph/repos -d '{"root":"<fixture>/main","vcs":"git"}'`.
   - Vite on port 1420 (daemon CORS) with `VITE_DAEMON_URL=http://127.0.0.1:45517`, using a temporary launch entry with an absolute `-C` path; set localStorage `firehose-onboarded` = `1`; open Workspaces; resize to 1536 x 1024.
   - Compare to the mockup point by point: trunk bottom-centre with lanes both sides; pills with dots and amber `dirty` badges; dotted merge links; wt-07 family cluster readable; selected `wt-07-fix` shows teal ancestry, dimmed rest; axis arrows, depth ticks, footer legend; inspector sections and both buttons. Repeat with `--workspaces 50 --revisions 2000 --shape linear` for the performance check (pan, zoom, select stay smooth).
   - Stop the daemon and vite, revert the launch entry, remove temp data.
5. Append the verification evidence to this plan (screenshots described, gate output, timings) and note deviations that remain.

## Acceptance criteria

Tests: all gates above green; every named test exists, failed first, and passes;
`gofmt -l .` empty; contracts documented; fixture self-check passes.

Visual (at 1536 x 1024 on the mockup fixture): header matches (repo picker, count,
search with `⌘K`, Fit/All); tree grows upward from the trunk with branches fanning
left and right and no label overlapping another label or node; solid and dotted
edges with legend; compact pills with state dots and separate dirty badges; selection
turns ancestry teal and dims the rest; axis annotations, depth gridlines and footer
present; inspector shows all sections with real data and the honest "unknown" origin;
Graph/Timeline both work.

Behavioral: selection and viewport survive a refresh; attention updates do not
rebuild the canvas; all workspaces reachable by label, cluster or search; 50 labels
and 2,000 revisions stay interactive; privacy modes verified for new fields.

Remaining deviations (accepted): no +/- buttons; axis wording and "depth" ticks
instead of time; footer says "labelled"; origin always "unknown"; mockup-only
"fictional data" tag omitted. (Names no longer follow the privacy mode; see Amendment.)

## Integration and verification evidence (2026-10-08)

Isolated run: `firehosed` built from this worktree with a scratch `HOME` whose config
set `daemon_addr` to `127.0.0.1:45517` (and `45518` for the minimal and balanced
privacy checks); vite on port 1420 with `VITE_DAEMON_URL` pointing at it. Nothing
contacted `127.0.0.1:4517`. Fixture: `--shape mockup --workspaces 25` (105 revisions,
2 merges, 1 detached, 7 dirty).

Reconciliation: the view consumes `layout.ts` (`layoutWorkspaceGraph`, `fitBounds`,
`neighborLabel`) and `sharedAncestorCount`; no `layoutGraph` reference remains. The
view reads `Snapshot.default_target_ref`, `Workspace.changes` and
`Comparison.changes` exactly as the backend emits them (verified over real HTTP:
`wt-07-fix` returned `graph.go +18 -6 M`, `graph_test.go +120 -4 M`,
`session.go +42 -11 M`; `default_target_ref` was `main`).

Fixed during integration:

- Layout width. The layout reserved each chain tip's full label width in lanes, so the
  mockup fixture laid out 1,960 px wide (about 41 lane spans for 14 occupied lanes) and
  Fit landed at scale 0.47 with 5 px text at 1536 x 1024. Tips now reserve only the
  adjacent outward lane (`TIP_LABEL_LANES`); a wider label spills into free space or
  takes a leader stub. Result: 1,212 px wide, initial scale 0.745, 2 short leaders
  (31 px, 14 px), 2 crossings (unchanged). Trade-off on random merge-heavy DAGs with 50
  labels: 7 to 15 percent narrower, a few more leaders, crossings up about 15 percent.
  Tests: `compactness` describe in `layout.test.ts` (failed first at scale 0.62).
- Axis. Depth tick numbers overprinted the "Newer/Older commits" annotations at the
  left edge. Tick labels now step aside (gridline stays). Test: `canvas.test.ts`
  "depth tick labels step aside for the axis annotations" (failed first).
- `layout.test.ts` "refinement pulls merge-linked chains together" asserted a strictly
  narrower refined layout, which encoded the wide layout (refinement has no slack in a
  tightly packed one). It now asserts no wider and no more crossings, and a new test
  asserts refinement never lengthens merge links and shortens them for some seeds.

Visual comparison at 1536 x 1024 against the mockup (all present): header with
repository picker, `25 worktrees`, search with a command-K hint, Fit/All, Graph/Timeline
and More; trunk bottom-centre with branches fanning both sides and no label overlapping
a label or node; compact pills with agent-state dots and separate amber `dirty`
badges; dotted merge links and square merge commits; a selected `wt-07-fix` turns its
ancestry teal and dims everything else (still clickable); axis arrows, depth ticks and
the "Depth in loaded history, not time" caption; footer legend and "All 25 workspaces
labelled"; inspector with status dot, branch and copy, Claude Code agent row, compare
select defaulting to `main`, stats, `Changes (3 files)` with counts and `M`, three
captured-activity rows with relative ages, `Origin workspace unknown`, Highlight
ancestry, Inspect changes. Timeline tab and Show in Graph work.

Privacy: with the same fixture, a minimal daemon returned `default_target_ref` as a
64-hex digest and digest paths in `changes`, a balanced daemon returned `main` and short
relative paths, and neither response contained the raw root.

Performance (50 workspaces, 2,000 revisions, linear fixture): backend scan 1.7 s
(`FIREHOSE_GRAPH_PERF=1 go test ./internal/workspacegraph -run TestLargeGraphFixture`);
in the browser 43 pills plus one counted cluster of 7, 2,000 nodes, workspace
selection 9 to 30 ms, 20 wheel-zoom events 135 ms, All 12 ms.

Remaining deviations (accepted, in addition to the list above): the lane model has no
mid-chain lane switches, so strictly planar nesting still needs one lane per
concurrently alive subtree; edges are not part of label collision testing, so an
interior-anchored label can sit over a fork curve; `timeline.ts` extraction was not
done (Timeline code is unchanged); no pinch zoom on touch devices; a repository whose
primary checkout folder is called `main` shows `main` in the picker.

## Review round: fixes and verification evidence (2026-10-08)

Three independent reviews (visual parity, Codex Sol 6.1 High, correctness/spec) raised
32 findings; four were reported twice (compare target, strip overlap, cluster focus, draft
loss), leaving 28 distinct issues. Each was checked against the code
before acting; every fix below started with a failing test.

Fixed (blockers and majors first):

- Inspect changes did nothing visible. The comparison detail was appended below the
  pinned buttons, off screen. It now opens directly under Stats/Changes, scrolls into
  view (`scrollIntoView({block: "nearest"})`, `scroll-margin-bottom` clears the pinned
  bar) and its sections have spacing.
- Focus ring on displaced labels. The generic `[tabindex]:focus-visible` outline beat
  `outline: none` and boxed the whole group including the leader; labels, clusters and
  revision nodes now use only their stroke as the focus indicator.
- Unreadable large graphs. `READABLE_SCALE` 0.4 to 0.75 (12 px text is 9 px); below 0.5
  the labels are hidden (`labels-far`) and an on-canvas hint says "Zoomed out: labels are
  hidden. Zoom in, or search". Cropped views get four edge buttons ("3 more ▸",
  "▾ 49 more") that count workspaces beyond each edge and pan a screenful toward them.
- Compare target mismatch (Codex major, correctness major, same defect). The remembered
  target is reset when its option disappears (selecting the compared workspace, or one
  that vanished in a refresh), so the select and the request always agree.
- Unattached strip overlapped placed labels. The strip now sits below the root floor and
  below every placed pill, badge and cluster.
- Focus lost on cluster expand/collapse. `rebuild` records the focused `data-key` and
  refocuses its successor (a member pill that disappears falls back to its chip).
- Availability (locked, pruned, inaccessible) was no longer shown. It is a separate badge
  on the pill (and in its accessible name) and a `Checkout` row in the inspector
  (availability, unborn, uncommitted changes, conflicted), restoring spec item 7.
- Viewport jumped on topology refresh. A rebuild now keeps the selected revision (else the
  node nearest the view centre) at the same screen position; while the automatic Fit is
  still in charge it re-fits instead. A cluster toggle pins its own anchor as before.
- Revision nodes were unreachable by keyboard and unnamed. Every node is
  `role=button` with an `aria-label` (short commit ID and description); one roving tab
  stop; arrows walk the real parent edges (down older, up newer, sideways along the row),
  Enter selects. Still no per-node listeners.
- Stepping to a parent dropped focus. Parent buttons use an index-based `data-action`, with
  a fallback to the first parent link or Highlight ancestry.
- Custom revision draft was lost on redraw; the pane also rebuilt on every scan because
  `snapshot.generation` was in its signature. The draft is saved on input and restored with
  its selection; the generation was dropped from the signature and a refreshed comparison
  that did not change is not redrawn.
- Pill text overran the state dot (and chip text ignored the arrow glyph). Pill chrome
  now reserves the dot (`36 + 6.7 * chars`, clamp 60..200), cluster chip width is measured
  on the exact text including the arrow, and text is clipped by a nested viewport.
- First render was gated on `/attention`. The request now runs in parallel with the scan
  and the first draw waits at most 1.5 s; if sessions arrive late the automatic Fit is
  redone onto the active tips.
- `.graph-status` floated over the Timeline filters. The Timeline tab renders it in the
  flow (`.graph-main.is-timeline`).
- Git `changes` collapsed an untracked directory into one entry (Codex minor): a second
  `status --untracked-files=all` runs only when a directory is folded, so 201 untracked
  files report 200 plus `changes_truncated`. `changed_files` is unchanged; documented in
  `docs/contracts.md`.
- Minors: edges over badges (solid badge fills, pill text and axis text get a paint-order
  halo); axis now has a vertical rule with arrowheads and notes beside it; purple versus
  gray history now means something (purple is the ancestry of workspaces whose agent is
  working or needs attention, gray otherwise, recomputed only when that set changes);
  descendants toggle reads "Hide descendants" and says "No descendants loaded for this
  revision"; search ranks workspace names and refs above commit IDs above descriptions;
  wheel zoom is about 13 percent per notch (capped, line-mode aware), `0` is the Fit
  button's view, Esc clears the selection from anywhere in the graph except fields and the
  More menu; the inspector's revision block is labelled; the header stays on one row at
  1180 px (search shrinks, "Repository" label hides under 1320 px).
- Tests that asserted too little: a refresh now appends commits and asserts the selected
  node's screen position; added tests for focus after cluster toggle and parent step,
  compare select versus request, strip versus expanded cluster, availability badges,
  Esc, search ranking, a hung attention endpoint and late sessions.

Skipped (with reasons):

- Branch connector steepness and main-at-root placement (visual minor): lane and drift
  parameters are tuned by the compactness and crossing tests; changing them risks the
  planarity guarantees for a subjective gain. Recorded as a known gap.
- Expanded cluster leaders drawn as one bracket (visual minor): each displaced pill needs its
  own leader to stay tied to its revision; the stack is collision-free and readable.
- Shorter "No explicitly associated session" copy: spec rule "Missing telemetry never
  implies completion" requires the visible sentence; a tooltip is not accessible.
- Copyable short SHA and a pinned action bar: the bar is already sticky; the 40-character ID
  stays first in a `<code>` element because tests and the spec rely on it.
- Inspector bottom padding at 1180 px: the sticky bar only overlaps content that is still
  below the fold; at scroll end nothing is covered.
- Selection replacing the ancestry highlight with descendants: kept as a documented toggle
  (now labelled and with an empty-state hint) rather than a combined two-tone highlight.
- `LaidNode.chainActive` is no longer used for colour (agent-based history replaced it); it
  stays in the layout contract as a structural flag.

Gates (all green): `gofmt -l .` empty; `go vet ./...` clean; `go test ./...` 23 packages ok
(including `TestGitChangesEnumerateUntrackedDirectories`, failed first); `pnpm test` 298
passed in 22 files (35 new tests, each failed first, except regression guards that already
held: 0 key, refresh stability at the index level, focus after cluster toggle, parent step,
compare target at the index level); `pnpm build` ok.

Visual verification (isolated: daemon on 127.0.0.1:4599 from a scratch `HOME` whose
config set `daemon_addr` and, so pill names match the mockup, `privacy_mode: full`; vite on
1420 with `VITE_DAEMON_URL`; nothing contacted 4517; both processes stopped by PID and
both ports confirmed free). Fixture `--shape mockup --workspaces 25`, plus three sessions
seeded by piping real captured Claude Code payloads (`pre_tool_use.json`,
`notification.json`) with `cwd` rewritten, through `firehose emit`: wt-07-fix and wt-19
working, wt-18 needs attention. Screenshots in `/Users/nicholas/develop/llm-firehose/.playwright-mcp/`:

- `final-01-initial-fit.png` (1536 x 1024): Fit frames the active tips and joining history
  at scale 0.996; 20 of 25 workspaces in view with "3 more ▸" and "▴ 2 more" edge buttons;
  trunk bottom-centre, branches fan both sides, solid and dotted (merge) links with square
  merge commits, compact pills with state dots (amber wt-18, green wt-07-fix and wt-19),
  separate amber `dirty` badges, purple ancestry for the three agents and gray history
  elsewhere, axis arrows and rule with the "Newer/Older commits" notes, depth ticks,
  footer legend and "All 25 workspaces labelled · 20 in view".
- `final-02-selected-wt-07-fix.png`: crowded wt-07 neighbourhood; selected ancestry teal
  with a glow, everything else dimmed but clickable; inspector with status dot, Branch and
  copy, Checkout, `Claude Code • Working` agent row, Revision block, Compare with `main`,
  `6 unique commits`, `3 uncommitted files`, `10 shared ancestors loaded`,
  `Changes (3 files)` with `+18 -6`, `+120 -4`, `+42 -11` and `M`, Captured activity, honest
  `Origin workspace: unknown`, Highlight ancestry and Inspect changes.
- `final-03-inspect-changes.png`: after Inspect changes the comparison (Only on selected /
  target, Merge bases, Committed changed files) is on screen with spacing above the pinned
  buttons.
- `final-04-narrow-1180.png`: header on one row at 1180 x 760; the whole graph now fits at
  scale below 0.5, so labels are hidden and the zoom hint shows.
- `final-05-perf-2000-initial.png` and `final-06-perf-2000-all.png` (50 workspaces, 2,000
  revisions): initial view at scale 0.75 with one readable pill and "▾ 49 more"; All at
  scale 0.028 with labels hidden and the hint. Timings in the browser: 2,000 nodes, 43 pills
  and one counted cluster of 7; 20 wheel events 10 ms; All 2 ms; workspace selection 16 ms.

Remaining deviations and known gaps against the mockup: no +/- buttons; "Newer/Older commits"
wording and depth ticks instead of time; footer says "labelled"; origin always "unknown";
the mockup-only "fictional data" tag is omitted; pill names followed the privacy mode
(resolved 2026-10-09: readable in every mode); Fit
deliberately frames only active tips, so some workspaces start off screen (now flagged by the
edge buttons); on very deep histories the initial view shows one or two readable pills (the
rest are reached by the edge buttons, search or zoom) because labels do not counter-scale;
branch connectors are flatter than the mockup's compact canopy and the fixture's main sits
mid-height; edges are still not part of label collision; a cold repository registered a
moment before the page loads answers 422 until its first scan completes (existing behaviour,
not changed here).

## Amendment (2026-10-09): real-data fixes and privacy stance

Running the branch in the real Tauri shell against the maintainer's 2.2 GB spool exposed
problems the small fixtures could not. The graph itself scanned real Git and JJ repositories
correctly, but:

1. `GET /workspace-graph/timeline` re-parsed the entire spool on every request and ignored
   cancellation (25.3 s and 4.2 GB RSS for one idle request on `main`), and the view re-requested
   it on every live-event burst and refresh without cancelling. Pending requests used up the
   browser's ~6 connections per host, so after a repository switch the snapshot request never
   went out. Pre-existing on `main`; the graph view made it fatal.
2. In balanced mode the picker showed `repo 093e11ec`-style digests.
3. Outside full mode `graph-roots.json` was never written, so the repository list was empty after
   every daemon restart until an agent emitted an event in each repository.

Maintainer decision: Firehose is local, loopback-only and open source, so where privacy and
usefulness conflict on the user's own machine it favors usefulness. Privacy modes govern
captured history (spool, live stream, export); graph display data and host-private state do
not follow them. See `docs/contracts.md` and the revised spec section "Privacy and storage".

Changes:

- Capture: the Projection indexes identity value → spool days (Git and JJ repo/workspace ids);
  `Timeline(ctx, q)` reads only matching days, newest first, stops at `limit`+1, prefilters
  records by raw bytes, and stops when the request is abandoned. Results are equivalent to the
  old full scan (reference test over 13 query shapes, cursor chains and a corrupt record).
- View: live events never fetch history; history loads only for the Timeline tab or, on the
  Graph tab, as one scoped page of 20 for the selected workspace; one request in flight, earlier
  ones aborted; repository and privacy-mode switches abort history and show a loading header.
- Daemon: roots, registered or learned from observed activity (after a successful scan), are
  persisted in every mode and loaded at startup.
- Graph display values (labels, refs, descriptions, file paths) are readable and untruncated in
  every mode; `id` fields still follow the mode so sessions keep associating.
- Names: picker shows the root basename (parent directory added on collisions), pills the
  worktree directory basename, full paths in tooltips and new inspector Path/Repository rows.

Verification on an APFS clone of the real spool (isolated daemon on 127.0.0.1:4599, balanced
mode, real `llm-firehose` Git and `browser-life` JJ repositories registered):

| Check | Before (`main`) | After |
|---|---|---|
| One timeline request, idle daemon | 25.3 s, 4.2 GB RSS | 0.51 s cold, 41 ms warm, same 260,236-byte page |
| Repository switch JJ → Git | canvas empty, requests starved | 4 worktrees and 201 revisions render; 0 timeline requests with no selection |
| Selecting a workspace | full 250-event page per event burst | one `limit=20` scoped request (82 ms) |
| Repository names | `repo 093e11ec` | `llm-firehose`, `browser-life`; full path on hover |
| Daemon restart | empty list until agent activity | both repositories listed immediately, rescanned to `ready` |

Gates: `gofmt -l .` empty, `go vet ./...` clean, `go test ./...` all ok (race-clean on capture,
projection, spool, daemon and workspacegraph); 333 vitest tests and the Vite build pass.

Known follow-ups: projection rebuild still loads the whole spool into memory once at daemon
start (about 3 GB RSS on the 2.2 GB spool; pre-existing); persisted roots of deleted worktrees
stay listed as unavailable (no prune); `attention()` polling has no in-flight guard; pills clip
at 24 characters (full name in the tooltip and inspector); the TUI still prints workspace
digests because it reads privacy-processed events.
