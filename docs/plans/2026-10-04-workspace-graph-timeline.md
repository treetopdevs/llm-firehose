# Workspace graph and hook timeline implementation

Authority: [implementation specification](../specs/workspace-graph-and-hook-timeline.md).
The reference images guide presentation; only actual revision parents form edges.

## Delivery plan

1. Add a disposable, local graph service with separate Git and JJ readers. Prove
   discovery, shared anchors, merges, detached/unborn revisions, bounded history,
   stale scans, comparison, and privacy with real local VCS fixtures.
2. Integrate registered and explicitly observed roots into the host boundary.
   Expose additive graph, comparison, and scoped durable history APIs through
   existing origin restrictions. Preserve capture admission and historical identity.
3. Add desktop Graph and Timeline tabs with shared repository/workspace/session
   scope. Use the existing captured envelope, attention projection, reconnect
   mechanism, and detail renderer. Preserve selected events and viewport.
4. Exercise crowded layout, source-scoped sessions, pause/resume, replay,
   pagination, stale responses, and privacy transitions. Review subsystem seams
   independently, remediate findings, and run repository validation.
5. Commit the implementation on `codex/workspace-graph-timeline`.

## Ownership and review

Three implementation agents own disjoint areas: graph core, daemon integration,
and desktop. The primary agent owns this plan, integration verification, and
completion evidence. Once implementation lands, agents review another area.
Behavior changes begin with failing tests. No dependency or VCS operation may
fetch remote data or mutate a scanned checkout to obtain graph state.

## Required evidence

- Go: `gofmt -l .`, `go vet ./...`, `go test ./...`, CLI build.
- Desktop: sidecar build, frontend tests/build, Rust tests.
- Real Git and JJ 0.45.1 fixtures, including crowded and bounded history cases.
- Browser inspection of the rendered desktop graph and timeline.
- Exact final diff review and targeted regression tests for discovered defects.

The two pre-existing untracked reference PNGs in `docs/specs` are outside this
implementation commit. No merge to main or release is part of this task.

## Verification evidence

Implementation uses a dependency-free SVG graph and the existing captured event
detail/attention surfaces. Raw registration roots stay in a private host file;
graph snapshots remain disposable. Git identities retain their meaning; additive
JJ identities use a separate namespace and the same privacy hashing rules.

Verified locally with Git 2.56.0 and JJ 0.45.1:

- `gofmt -l .` produced no output; `go vet ./...`, `go test ./...`, and the CLI
  build passed.
- Targeted race suites passed for graph core, daemon/capture, workspace identity,
  and privacy.
- All 124 frontend tests and the TypeScript/Vite production build passed. The sidecar build
  and all three native Rust tests passed.
- Opt-in `FIREHOSE_GRAPH_PERF=1 go test ./internal/workspacegraph -run
  TestLargeGraphFixture -v`: 50 labels and 2,000 loaded revisions in approximately
  669 ms on this machine, then expansion to all 2,100 fixture revisions.
- Browser inspection of a second real local fixture confirmed 2,000 rendered
  revision nodes, all 50 selectable workspace labels, anchor navigation,
  separate uncommitted-file inspection, and revision comparison. An uncached
  HTTP scan of that fixture took 1.42 seconds. These are local observations,
  not universal performance guarantees.
- A 25-workspace fixture showed exactly the selected workspace's three captured
  events, with preserved Graph/Timeline scope and source-qualified session labels.
- Browser pause/resume verification kept the existing four event rows frozen,
  counted exactly one new scoped captured event, and displayed exactly five on
  resume. Internal attention-transition frames are excluded. Cross-tab workspace
  changes and Show in Graph restored the correct revision; selected event details
  remained inspectable after changing scope.

Independent cross-reviews found and resolved stale source-family attachment,
cross-tab revision selection, privacy cache/response races, registration
authority races, scroll loss while paused, offscreen graph navigation, and
misleading comparison failure handling. Real VCS tests also cover multiple
merge bases, disconnected history, shallow parent boundaries, JJ divergence,
stale working copies, and cancelled scans retaining a stale snapshot.

## Operational limits

JJ read-only scans inspect the last recorded working-copy revision and explicitly
warn that unsnapshotted filesystem changes are not included. They never invoke
snapshot/update operations. Metadata changes trigger a debounced portable poll;
30-second full reconciliation covers checkout-content-only changes. History
expansion preserves actual parent boundaries rather than inventing edges.

The browser checks use an isolated fixture daemon, never the user's running
capture daemon. Browser verification does not claim packaged native window or
installer testing; native evidence is the sidecar build and Rust test gate.
