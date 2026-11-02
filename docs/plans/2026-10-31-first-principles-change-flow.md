# First principles: the flow of changes across worktrees and projects

**Status:** Assessment, 2026-10-31. No code changed. Written after reading the
envelope, CONTEXT.md, the altitudes and workspace-graph plans, the ten concept
brainstorm, the desktop shell, and one full day of real captures.

## 1. The workload is the brief

One real day (`~/.agentfirehose/spool/2026-10-30.ndjson`):

| measure | value |
|---|---|
| events | 29,387 |
| `meta` events (token usage, `adapter.unknown_event`) | 20,637 (70%) |
| `tool` + `shell` | 7,367 |
| `file` events (actual edits) | 177 |
| `error` | 7 |
| repos with captured activity | 7, of which 4 carry nearly all of it (browser-life, lattice, lorain-data, cadence) |
| worktrees active | ~15, nearly all `<repo>/.claude/worktrees/<name>` |
| sessions per worktree | 2 to 7 |
| sources | claude-code (85%), codex (15%), procwatch, firehose |
| `git commit` / `git push` observed in shell events | 128 / 126 |
| `git worktree add` / `remove` | 6 / 5 |
| `gh pr create` / `gh pr merge` | 29 / 23 |

The git lifecycle rows are observable because this machine runs in `full`
privacy mode, so `raw` keeps the Bash command. In the default `balanced` mode
`raw` is dropped and the summary reads only "will run tool Bash", so those rows
would be invisible. Any design that leans on them must say which mode it needs,
or ask the Bash summary to carry the command verb (an additive summary change).

Three things follow directly.

1. **The signal is tiny and the noise is huge.** The thing the user cares about,
   changes to code, is 0.6% of the spool. Every view that renders "events" is
   rendering mostly meta. "What to project" is a first-principles question, not
   a filter checkbox.
2. **The real topology is shallow and bushy.** A few repos, each with a handful
   of short-lived forks. The graph spec designed for "25 unevenly distributed
   workspaces" in one repo; reality is 4 repos × 3–6 live forks each, and the
   forks are born and die daily. Cross-repo is the normal case, not an edge case.
3. **Worktrees are the unit of parallelism.** Sessions are how the user drives;
   worktrees are where work accumulates and where conflict and loss happen. A
   session is seconds to hours; a worktree is hours to days; a repo is forever.

## 2. The missing spine

The envelope is event-shaped. Projections are session, trace, file, attention.
The workspace graph knows revisions and which worktree sits on which revision.
Nothing models the unit the user actually thinks in: **a worktree's lifetime**.

```
Project (repo)
└─ Worktree lifetime      forked from X → work → landed on main | abandoned | still open
   └─ Session             one agent run inside the worktree
      └─ Change           a diff: uncommitted → committed → landed
         └─ Event         what we capture today
```

Every one of the ten concept views sits at Session or below. The altitudes plan
went workspace → session → call, where "workspace" is a (repo, agent) cell
keyed on the current cwd, so a fork and its parent repo are different rows with
no relationship between them. That is why "none of it connects": the only
shared coordinate across views is the session ID, and sessions are the wrong
grain for "flow of changes through time".

### What each rung needs and whether it is observable today

| rung | what it needs | observable today | source |
|---|---|---|---|
| Project | identity, default branch | yes | `repo_id`, graph roots, graph default-branch ref |
| Worktree birth | when it was forked, from what | exact in `full` mode: the `git worktree add` shell event, with its session. Otherwise proxy: first event carrying that `worktree_id`; fork point = merge base with main from `Comparison.MergeBases` | spool + graph |
| Worktree state | ahead of main / behind / dirty / landed / never diverged / gone | derivable: `SelectedOnly` non-empty ⇒ unlanded; empty ⇒ landed **or** never diverged, told apart only by a prior snapshot that showed commits; dirty from `changes.go`; gone when the scan no longer lists it | `internal/workspacegraph` + snapshot |
| Worktree death | pruned or merged | exact in `full` mode: `git worktree remove`. Otherwise proxy: disappears from scan; landed-then-gone vs abandoned-then-gone needs the state snapshot taken before it vanished | spool + persisted projection |
| Session → worktree | which sessions worked here | yes | `worktree_id` on events |
| Change (commit) | commits made during the lifetime, by which session | in `full` mode the `git commit` shell event gives intent, time, and session; the VCS reader confirms the resulting revision. In `balanced` mode only the VCS reader, and attribution to a session is a time join, labelled as such | spool + graph |
| Change (uncommitted) | files edited but not committed | yes: file events ∖ committed paths; `changes.go` already lists dirty files | spool + graph |
| Landing | merged into main, when, by what | "is merged" from the graph; "when" from the merge commit on main; in `full` mode `gh pr merge` and `git push` events add the PR and the session that landed it | graph + spool |

Nothing above needs a new envelope field. It is one new projection (Worktree
lifetime) joining spool-derived facts to graph-derived facts, exposed as an
additive API. The frozen surfaces are untouched.

## 3. Why the desktop does not connect

`apps/tauri-desktop/src/main.ts` registers 19 panels in a flat object. The
`show()` function hand-codes eight panels' activate/deactivate/refresh pairs.
There is no scope object. The only cross-panel coordinate is `CellScope`,
passed one way from the workspace matrix into the sessions list. Every other
hop is a callback that opens Score for a session ID.

Audit of the 19 panels against the ladder:

| rung | panels | verdict |
|---|---|---|
| Project | workspace (the revision graph, `createWorkspaceGraph`) | the only project-level surface; isolated |
| Worktree | (none) | **the gap**: the graph labels worktrees on revisions but has no notion of their lifetime |
| Fleet of sessions | live, attention, dwell, matrix (the repo × agent cell grid), lanes, airspace, sessions | seven panels answering one question: "who needs me, who is working" |
| One session | score, loops, loom, replay, handoffs, court | six lenses on one session ID |
| Files | files, ecosystem, strata | path-keyed, no worktree or landing awareness |
| Housekeeping | doctor, settings | fine |

Seven fleet panels and six session lenses is the symptom. They were built as
siblings because there was no spine to hang them on. With a shared scope they
collapse: the fleet panels become one surface with encodings (the altitudes
plan already did this for lanes: `l` is a strip encoding, not a screen). The
session lenses become tabs inside the Session altitude.

## 4. Navigation: extend the altitude grammar upward, do not add siblings

One **scope** object, held once, that every panel reads and may narrow:

```
scope = { project?, worktree?, session?, window: [t0, t1] | live }
```

Altitudes, each one `enter` down and `esc` up, each with a few encodings:

```
Fleet       all projects · one row per project · forks as branches off the row ·
            needs-you count, dwell, landed/unlanded per fork, last activity
  │
Project     one repo · the fork/land graph through the time window ·
            each worktree a lane leaving main and (maybe) returning ·
            sessions as beads on the lane · commits as ticks
  │
Worktree    one fork · its lifetime left to right · sessions stacked ·
            changes accumulating (uncommitted → committed → landed) ·
            diff against main at any scrub point
  │
Session     existing: score / lanes / loops / loom / replay / receipts as tabs
  │
Call        existing
```

Rules:

- **Time is one axis everywhere.** The same window and the same scrubber on
  every altitude. Score already has a transport; it becomes the app's transport.
- **Descending narrows scope; it never changes view type.** Ascending keeps the
  child selected as highlight so you can see where you came from.
- **Panels become lenses.** The sidebar lists altitudes, not fifteen concepts.
  Concepts that survive are encodings within an altitude.
- **Cut, do not port:** airspace, dwell, matrix, lanes fold into Fleet.
  Ecosystem and strata fold into Project (path/time lenses). Handoffs and court
  remain as annotation tabs on Session; they are notebooks, not views.

## 5. A video game mentality, tied to what is actually captured

The user asked for control, not only visibility. Game HUDs solve the same
problem: many autonomous units, one human, limited attention, state that
matters is state that changes.

| game device | Firehose equivalent | data it needs | have it |
|---|---|---|---|
| **Minimap** | Fleet altitude, always visible as a strip: projects as regions, forks as dots, needs-you dots pulsing | attention projection, worktree state | yes |
| **Units with state** | sessions: working / waiting / idle / done, with dwell as the unit's "health bar" | attention + dwell | yes |
| **Fog of war** | regions with no capture: a worktree with no hooks installed, a Codex fork we never tailed, the 70% meta we discard. Draw absence as absence, not as empty | adapter capabilities + gaps in `source_time` | partly |
| **Tech tree / build order** | Project altitude's fork/land graph: what forked from what, what landed, what is still open and how far behind main | graph comparison | yes |
| **Alerts with a position** | needs-you is not a count in a header, it is a unit on the map you click to jump to | attention | yes |
| **Control groups** | hotkeys 1–9 bound to worktrees; `tab` cycles needs-you units; `space` jumps to the longest-waiting one | scope object | missing |
| **Replay** | scrub any altitude's window; Score's transport generalised | time axis | partly |
| **Idle worker alert** | a fork that is ahead of main, has no live session, and has not moved in N hours. This is the "forgot about it" signal the dwell bar tried to give for sessions, moved to the rung where it matters | worktree projection | missing |

The tension to state plainly: Firehose is read-only and "never break the agent"
is a hard rule. Control therefore means **the user's own actions**, routed from
the map: open this worktree in a terminal, open its diff against main, copy the
resume command for this session, prune this landed fork, register this root.
It does not mean steering agents. Steering can come later through the agents'
own channels, if ever; the map must be good first.

What game UIs teach about rendering that the current views ignore:

- **Persistence of position.** Units stay where they were; the eye finds them
  by place. The feed scrolls everything; the matrix re-sorts by latest activity
  so a row jumps every refresh. Fleet rows should be stable per project.
- **Change is motion, state is colour.** Only transitions animate. A session
  that has been working for ten minutes should be still, not pulsing.
- **One glyph vocabulary.** The altitudes plan started this (`?` `●` `·`).
  Extend it to worktree state: ahead, behind, dirty, landed, gone.
- **Everything selectable is a target.** Click a dot on the minimap, you are
  there. Today a session row opens Score through a callback and the sidebar
  does not know it happened.

## 6. Recommended first slice

Build the Worktree rung and nothing else. It is the only rung that is both
missing and derivable from what exists.

> Status (2026-10-31): slice 1 implemented on `feat/worktree-lifetime`: projection, `GET /worktrees[/{id}]`, contracts documented; not yet merged.

1. **Projection: worktree lifetime.** In `internal/capture/internal/projection`,
   per `(repo_id, worktree_id)`: first seen, last seen, sessions, file paths
   touched, signal event counts (meta counted separately), and in `full` mode
   the `git worktree add|remove`, `git commit`, `git push`, and `gh pr merge`
   shell events as exact lifecycle marks. The projection stays spool-only:
   `internal/capture` does not import `internal/workspacegraph`, so the join
   with `workspacegraph.Compare` (ahead/behind/landed/dirty against the default
   branch) happens in the daemon's graph host, which already owns registered
   roots and `EventScope`. Persist a small host-private snapshot (same location
   and mode rules as `graph-roots.json`) so "gone" can be classified as
   landed-then-gone, abandoned, or never diverged. Additive `GET /worktrees` and
   `GET /worktrees/{id}`. TDD against a scrubbed, bounded fixture derived from
   the real spool day above (same sanitising rules as
   `internal/capture/testdata/README.md`) plus a real git fixture with one
   landed fork, one open fork, one abandoned fork.
2. **Desktop: a `scope` module** holding project / worktree / session / window,
   with every existing panel reading it instead of its own filters. This is
   plumbing, no new pixels, and it is what lets the panel count fall later.
3. **Desktop: Project altitude.** One repo, lanes leaving and rejoining main,
   sessions as beads, commits as ticks, the existing transport as scrubber.
   Replace nothing yet; add it as the landing view. Then fold Fleet from the
   eight fleet panels in a following slice.

What this does not do, by design: infer handoffs, infer causality, attribute a
commit to a session with any certainty beyond a time join (label it as such),
or act on agents.

## Decisions (2026-10-31)

The three questions above were open at assessment time. They are closed here
with the maintainer's instruction to take reasonable defaults; the numbered
entries live in `docs/plans/2026-10-18-backlog-coordination.html` (D94–D98).

- **D94 Worktree birth in every mode: yes, by summary verb.** The Claude Code
  Bash summary will carry the command verb for an allowlist of lifecycle
  commands (`git worktree add|remove`, `git commit`, `git push`, `gh pr
  create|merge`) so they are visible in `balanced` mode. Additive summary
  change; no new hook, no `WorktreeCreate`, no git hook install. Shipped as its
  own slice after the projection; until then the projection uses the proxy
  (first/last `worktree_id`) in `balanced` and exact marks in `full`.
- **D95 Meta is a cost lens, not a view input.** The worktree projection and
  the Fleet/Project altitudes count signal events only (`file`, `tool`,
  `shell`, `prompt`, `session`, `error`, `permission`); `meta` is tallied
  separately as `meta_events` and surfaced only in a cost lens.
- **D96 Desktop owns the map.** The TUI stays at the session altitude. The
  fleet strip is revisited after the desktop Project altitude ships.
- **D97 Layering.** Projection is spool-only; the graph join lives in the
  daemon. Commit-to-session attribution is a time join and is labelled
  `attribution: "time_join"` in the API.
- **D98 Review model.** Adversarial reviews use Codex `gpt-6.1-sol` at
  `model_reasoning_effort=xhigh` for this backlog (maintainer instruction,
  2026-10-31, supersedes the standing `high`).

### Slice order

1. Worktree lifetime projection + additive `/worktrees` API (this document, §6.1).
2. Desktop `scope` module (§6.2).
3. Desktop Project altitude as landing view (§6.3).
4. Bash summary carries lifecycle verb (D94).
5. Fold fleet panels into a Fleet altitude (§4).
