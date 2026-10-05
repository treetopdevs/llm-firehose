# Firehose workspace graph and hook timeline

Status: implementation specification draft · October 4, 2026

## Goal and scope

Add a Workspace Graph view to Agent Firehose's existing Tauri desktop app. Show the literal Git or JJ revision ancestry for one selected local repository, with every discovered worktree/workspace attached to its current revision. Overlay captured agent status and let the user inspect Firehose activity for each workspace.

The user should immediately understand where parallel work diverged, what builds on what, where merges reconnect, and which agents are active at each checkout. Edges mean revision parenthood only; do not infer task dependencies or agent intent.

The graphical desktop experience has sibling Graph and Timeline tabs under Workspaces. The graph is the orientation surface; the timeline is the chronological captured-event surface. Reuse the underlying event data and detail components without depending on the current GUI timeline layout. This specification includes the companion timeline redesign, not a wholesale redesign of unrelated desktop views.

V1 is read-only. Exclude workspace creation/deletion, rebasing, merging, task management, remote collectors, PR integration, and historical workspace-position playback. Commit ancestry provides code history; it does not establish when a workspace was created or moved.

## Existing integration points

Repository documents inspected on October 4, 2026:

- [README](https://github.com/treetopdevs/llm-firehose/blob/main/README.md): Go capture engine, local daemon, Tauri desktop shell, workspace matrix, session lanes, and event detail views.
- [Platform contract](https://github.com/treetopdevs/llm-firehose/blob/main/docs/contracts.md): observable Git `repo_id` and `worktree_id`, session and attention projections, local HTTP/SSE interfaces, and privacy rules.
- [Event schema](https://github.com/treetopdevs/llm-firehose/blob/main/docs/event.schema.json): existing optional repository/worktree identity fields.

These are document-backed integration points, not an implementation audit. Locate concrete modules and supported CLI versions before coding. Reuse existing capture and attention behavior rather than building another hook pipeline.

## View behavior

1. Choose a repository from observed activity or explicitly register a local root. Discovery is scoped to registered repositories; no whole-disk scan.
2. Display a topological ancestry graph with shared ancestors drawn once, all merge parents retained, and disconnected histories shown separately. Layout follows parent relationships rather than timestamp order; dates are inspection metadata.
3. Attach a distinct label for every worktree/workspace at its current revision. Multiple labels may attach to one revision. Include branch/bookmark, privacy-safe workspace identifier, dirty or conflicted indicator, agent count, and attention badge.
4. Fit active workspace tips and their connecting history on initial load. Support pan, zoom, search, keyboard selection, and explicit expansion of collapsed ancestry. Always show every discovered workspace label; paginating history must not hide workspaces or invent direct parent edges across omitted revisions.
5. Selecting a revision shows identifiers, description, parents, and timestamp. Selecting a workspace opens its session list and captured Firehose feed. Selecting a session opens the existing session/detail experience. Show captured content only; do not imply every provider exposes full terminal output.
6. Refresh topology asynchronously on repository changes, window focus, and manual refresh. Debounce filesystem signals and use periodic reconciliation as a fallback. Keep selection and viewport stable. Agent activity updates through the existing feed independently of topology scans.
7. Missing CLI, inaccessible roots, locked/pruned worktrees, stale JJ workspaces, shallow history, and scan failures get explicit labels. Retain the last successful snapshot as stale; never present a failed scan as an empty repository.

## Crowded graph interaction

Design for 25 unevenly distributed workspaces, not a tidy set of parallel lanes. The principal fixture has seven checkouts anchored around a common revision and three additional branches diverging further along one lane, plus checkouts at other depths, shared revision anchors, merges, detached tips, and dirty files. These are revision relationships, not proof that one workspace created another.

Selecting a workspace highlights its current revision and ancestry while dimming unrelated context. Offer descendant highlighting separately. Preserve nearby siblings and visible workspace labels; label clustering must be expandable and show its count. Never sacrifice parent-edge accuracy to make the layout symmetrical.

The inspector compares the selected revision with an explicit target, defaulting to the observed local main/default-branch ref when available. If unavailable, require target selection. Show commits reachable only from the selected revision, commits reachable only from the target, merge base(s), and a changed-file summary. Display uncommitted checkout changes separately. Compare full revision identities, not commit messages or patch resemblance; rebased/cherry-picked equivalents are not automatically declared redundant. Comparison supports human consolidation decisions; V1 performs no consolidation.

## Companion hook timeline

Reference: [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery). Its README describes lifecycle logging, tool observations, permission events, and subagent events that inspired Firehose. Use it as a conceptual capture reference, not as a complete or current provider API contract or an exact UI to reproduce.

- Graph and Timeline share repository, selected workspace, and optional selected session. Switching tabs preserves filters, graph viewport, and selection. A workspace inspector action opens its scoped Timeline; each associated event has Show in Graph. Missing/deleted workspaces get an explicit unavailable result, not a guessed graph position.
- Timeline scope can be the selected workspace or the whole repository. Show time, source/agent, source-scoped session, native hook/event name, category, and privacy-safe summary. Provide source, session, category, search, and live/pause controls. Distinguish Claude hook names from Codex/OpenCode native events; do not fabricate cross-provider parity.
- Event detail uses the captured envelope and existing call request/response pairing. Show workspace association, available source/capture times, correlation identifiers, outcomes, and privacy-processed content. Permission observations direct the user to the agent's existing approval flow; no approval execution in this view.
- Parent/subagent relations are an optional session grouping only when explicit evidence exists. They never become revision parent links. A subagent may share its parent's workspace.
- Reuse durable history/live reconciliation and exact-ID deduplication. Paginate older events; make history limits and capture gaps visible. Order the feed using the existing compatible event time, with deterministic tie-breaking; expose source and observation times when available without claiming cross-source causal order.
- Default to newest events first with a clear Live indicator. Pausing stops visual autoscroll, not capture; count arrivals and reconcile when resuming. Keep selection stable as events arrive. A selected event must remain inspectable after it leaves the visible page.
- Preserve current privacy and attention semantics, including uncertain/stale activity. Display captured output only; hooks do not guarantee full conversation or terminal output.

## Graph service

Add a repository graph service in the existing Go host, exposed to the desktop through an additive local API. Proposed routes: `GET /workspace-graph/repos` and `GET /workspace-graph?repo_id=...&cursor=...`. Final naming should follow repository conventions. Preserve existing API, envelope, spool, and export compatibility.

Use separate Git and JJ readers behind a normalized graph interface:

- Git: enumerate linked worktrees through machine-readable CLI output; read HEADs, references, actual commit parents, and bounded checkout status. Include detached HEADs and checkouts with no commits. Dirty files are workspace state, not fictional commits.
- JJ: enumerate workspaces and their working-copy revisions through the supported CLI's structured/template output. Preserve both change IDs and commit IDs. Distinct divergent revisions sharing a change ID remain distinct nodes. Report stale workspaces without running update operations.
- For colocated repositories, use JJ as the ancestry authority when selected and deduplicate matching physical roots. Do not claim Git worktrees and JJ workspaces are interchangeable; verify enumeration behavior with fixtures.
- Execute CLIs using argument arrays, bounded execution time and output, and cancellable scans. Do not invoke shell interpolation, fetch remotes, change checkouts, or modify VCS state to obtain the graph.

Suggested response objects:

| Object | Required information |
|---|---|
| Repository | opaque ID, VCS kind, privacy-safe label, observation time, scan status |
| Revision | unique revision key, commit ID, optional JJ change ID, parent keys, description, timestamp, conflict state |
| Workspace | opaque ID, repository ID, current revision key or unborn state, refs, dirty/conflict state, availability |
| Session attachment | source + native session ID, workspace ID, last observed time, association evidence |
| Snapshot | generation ID, nodes, edges, workspaces, truncation boundaries, warnings, continuation cursor |

Bound initial history to 2,000 revisions, retaining all workspace anchors and marking omitted history. Expand on demand. Never silently truncate discovery. Performance target: interactive navigation with 50 workspace labels and a 2,000-node loaded graph; verify on a documented local fixture.

## Session matching and status

- Reuse explicit `repo_id` and `worktree_id` where available. For Git, group linked worktrees by canonical common-directory identity, not repository name or remote URL.
- Match privacy-redacted event identities using the same existing canonicalization and hashing rules. Do not reinterpret a digest as a filesystem path.
- Sessions are keyed by source plus native session ID. Attach multiple sessions to a workspace; never merge equal native IDs from different providers.
- Resolve JJ-only identity in a separate namespace. Any new event identity fields must be additive; do not change the established meaning of Git identity fields.
- Historical events retain their observed workspace association. A session's current attachment follows its latest explicit identity evidence; do not relocate old events after a session moves.
- When identity is missing or ambiguous, leave activity unassigned and explain why. Do not guess from directory basename, branch name, or apparent similarity.
- Reuse the existing attention projection, including its uncertainty, stale-state rules, and last-seen evidence. Aggregate badges as needs-attention first, then working, then other known states; retain individual states in the panel. Missing telemetry never implies completion.

## Privacy and storage

Preserve existing minimal/balanced/full semantics. Minimal and balanced modes hash `cwd`, `repo_id`, and `worktree_id`; full mode retains canonical paths. Apply equivalent protection to graph responses, cached labels, diagnostics, and any new persistence. Commit messages and branch/bookmark names may contain sensitive text: use digests in minimal mode, existing truncation semantics in balanced mode, and full values only in full mode.

Keep raw root paths needed for scanning inside the local host's configuration/runtime boundary, outside the event spool and redacted graph responses. Clear graph caches when privacy settings change. Keep graph snapshots disposable in V1; captured activity remains backed by the existing spool. Preserve loopback binding and desktop-origin restrictions.

## Acceptance and verification

- The 25-workspace fixture remains navigable without a tidy fixed-column assumption. Selection highlights true ancestry; unrelated context stays available; every workspace is reachable through visible labels or expandable counted clusters.
- Comparison reports revision-set differences and dirty changes separately, handles multiple merge bases and disconnected histories, and makes no unsupported safe-to-delete claim.
- Switching Graph/Timeline preserves workspace and session scope. Show in Graph restores the correct anchor without moving the user's context to an unrelated repository.
- Timeline filters isolate the correct workspace and source-scoped sessions. Duplicate replay, reconnect, late arrivals, paused rendering, unavailable workspaces, and truncated history have explicit regression coverage.

- A fixture with three sibling worktrees, a stacked change, and a merge renders correct parent relationships and all checkout labels.
- Two workspaces on one revision remain distinguishable; detached and unborn checkouts render without invented ancestry.
- JJ fixtures cover multiple workspaces, working-copy movement, divergent revisions with one change ID, stale workspaces, and colocation deduplication.
- Two agents in one workspace display separately; equal session IDs across providers do not collide; missing identity stays unassigned.
- Clicking a workspace reveals only its correctly associated captured events. Moving a session does not rewrite past event associations.
- Privacy tests cover paths, labels, commit descriptions, errors, cached responses, and transitions between modes.
- A changed HEAD moves its workspace label after refresh. Scan timeout or VCS failure preserves a visibly stale graph and leaves capture running.
- A shallow/truncated history marks boundaries; it never substitutes a fabricated parent link. Large graphs retain every workspace anchor and support expansion.
- Existing daemonless capture, stream reconciliation, session/attention behavior, and desktop navigation remain intact. Run the repository's relevant Go tests, frontend checks, and desktop build gates.

## Implementation sequence

1. Implement normalized graph contracts and Git discovery/ancestry fixtures.
2. Add the desktop graph, crowded-layout interaction, comparison inspector, privacy handling, and existing session/feed integration.
3. Implement and verify JJ reader and identity support; require both readers for the stated Git/JJ V1 scope.
4. Add the companion Timeline tab and cross-view navigation using existing event/attention projections.
5. Verify refresh races, bounded scans, large-graph navigation, timeline reconciliation, and repository gates.

## Visual references

Three conceptual wireframes were reviewed during design: an initial simple ancestry graph, a revised crowded graph with selection/comparison, and the companion hook timeline. The crowded graph and companion timeline are the intended direction. They contain fictional data and are not implementation evidence. The written requirements govern where imagery is ambiguous: revisions are nodes, workspace labels attach to revisions, all graph edges are actual parent links, and a numeric vertical axis is not required. Do not reproduce illustrative payloads, counts, or CLI commands as contracts.

Choose the rendering library after inspecting the existing frontend dependencies. Historical graph playback can be a later slice based on explicitly recorded snapshots; it must never claim complete pre-installation workspace history.
