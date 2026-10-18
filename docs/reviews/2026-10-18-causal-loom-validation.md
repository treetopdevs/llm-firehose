# Causal Loom validation

Base e007b2f; independent of open prototype PRs37–39. Browser exercised isolated production Engine.Admit and daemon.Handler with temporary spool, no adapters/live configuration.

## Local gates

- gofmt empty, go vet ./..., go test ./..., CLI build passed.
- Frontend35 files /515 tests passed serially after Rust compilation completed. Initial parallel and concurrent-Rust serial runs hit existing graph timeout and Score100k timing assertion; unchanged tests passed final full run. No thresholds weakened.
- Frontend TypeScript/Vite build passed.
- Sidecar built; Rust3 tests passed.
- Actual browser: explicit OpenCode scope load3 observations; tool call/message groups and native parent message reference;2 group members; explicit assistant full receipt; correct3-event Score drill-through; return preserved labelled snapshot and cleared receipt. Screenshot adjacent. Preview used normalized sanitized fixtures, not user history.
- Argon plan review timed out at180s; not approval. Immutable final review PASS on b43fd4d. Independent spec PASS; standards found P2 empty sidebar, fixed test-first in0702228 using renderDetail(null), re-review PASS. Final full515 tests/build passed. Argon4 High fix follow-up PASS on0702228; reviewer reran4 main tests. Browser repeated Score→Loom navigation and confirmed shared pane class closed; final screenshot replaced.

## Red/green seams

# Causal Loom additive correlation view TDD

Worktree: isolated codex/causal-loom-prototype worktree.
Owned changes: capture/history.go + correlation_view_test.go; daemon/endpoints.go + correlation_view_test.go; docs/contracts.md; desktop api.ts/api.test.ts; ui/loom/fixture.opencode.json and README.fixture.md.

1. Added capture CorrelationView tests before implementation. First focused run failed because CorrelationView was undefined. Log: /tmp/firehose-loom-go-red.log.
2. Implemented CorrelationView as TimelineView plus explicitly listed native identifiers, source/capture clocks, sequence, transport/version. Tests cover exact retained representation, dropped raw/body/path fields, privacy digests for minimal/balanced/full, zero-valued sequence presence, absent metadata, and no input payload-map mutation.
3. Produced frontend fixture by production OpenCode Parse + CorrelationView over three existing real raw captures. Test-only stable IDs and primary/capture clock pinning are documented in README.fixture.md. A committed test re-parses and compares serialized output with frontend fixture; early generation exposed parser primary-time nondeterminism and Go/JSON numeric types, resolved by documented timestamp pinning and canonical JSON comparison. Native IDs/source timestamps untouched.
4. Added HTTP test before route support. It failed 400 for view=correlation. Log: /tmp/firehose-loom-http-red.log. Handler then gained additive view support. Tests check default/full equality, unchanged timeline output, correlation equality/order/dedupe, cross-source same-session-ID scope, 404 unknown session and 400 invalid view.
5. Client request test confirms encoded correlation URL and AbortSignal; widened existing view argument union. Existing generic runtime URL builder already supports view strings; this type-only widening needed no runtime rewrite. Five API tests pass /tmp/firehose-loom-client-green.log.
6. Targeted Go tests passed: go test ./internal/capture ./internal/daemon -run 'TestCorrelation|TestTimelineView|TestSessionCorrelationView|TestSessionByIDTimelineView' -count=1. Log /tmp/firehose-loom-go-green.log. Go edited files formatted.

Contract documents unbounded existing session scan/response and absence of server context cancellation; client must filter exact source/session. No scope creep to those existing behaviors. Parent runs full gates/reviews. No commits.


# Causal Loom model TDD
Worktree: isolated codex/causal-loom-prototype worktree
Owned files: src/ui/loom/model.ts and model.test.ts only.

1. Added 5 pure-model tests over existing real Score fixture.errsig.json (Codex captured call/turn receipts), including minimal identity mutations for scope collisions, namespace separation, duplicates/conflicting IDs, invalid clocks, and generic unsupported joins.
   - RED: `pnpm -C apps/tauri-desktop exec vitest run src/ui/loom/model.test.ts --no-file-parallelism`: missing ./model.
   - Implemented deterministic dedupe, conservative conflict exclusion, exact scope, namespaced groups and one-hop seam. GREEN: 5 tests, 265ms run.
2. Added 5 native-parent tests over backend-generated real OpenCode fixture.opencode.json: actual message parent + terminal-only tool membership, missing message, multi-parent/self conflicts, multiple receipts, one-hop cycle boundary.
   - RED: 5 native-parent tests failed (no parent derivation); earlier 5 passed.
   - Implemented only OpenCode message.updated message_id+parent_id native semantics. GREEN: 10 tests, 295ms run.
3. Added regression coverage for foreign-scope missing parent, unsupported OpenCode tool parent, object-property-order duplicate equivalence, and 10k actual-shape tool receipts with exact counts and bounded one-hop neighborhood.
   - GREEN: 13 tests, 277ms total / 62ms tests. No fragile timing assertion.
4. `pnpm -C apps/tauri-desktop exec tsc --noEmit`: exit 2 because concurrently authored src/ui/loom/index.ts imports missing ./map. No model diagnostics; parent must rerun after integration settles.

Counts: duplicates is extra copies after first (includes conflicting ID extras); conflicts is number of captured IDs excluded entirely because canonical envelope metadata disagreed; omitted is exact-scope missing-ID records; invalidTimes is displayed unique observations with invalid primary clocks; unsupportedParents counts individual unsupported parent_id/upstream_event_id references. Parent-reference conflicts are conveyed on each LoomParent.status rather than conflated with captured-ID conflicts.


# Causal Loom UI TDD

Worktree isolated codex/causal-loom-prototype worktree.

First5 observable panel tests written before implementation (missing module red /tmp/firehose-loom-ui-red.log). Completed10 panel tests pass (/tmp/firehose-loom-ui-green.log), tsc --noEmit passes after parent model/map integration.

Coverage: choice refresh no history fanout; explicit correlation-only request and full receipt; exact source/session edits clear old scope, abort stale metadata; search/error filters before40-row paging; old-daemon error no fallback; mismatch and deactivation receipt guards; real adapter-normalized OpenCode native parent/member neighborhood; captured call fixture expanded to85 members with40-page reachability;45-child one-hop groups/references with20-page reachability; focus reveal and escaping; manual scope after choices failure and newer-choice race.

Panel createLoom returns root/refresh/deactivate. Metadata snapshots label exact loaded scope/time and underlying unbounded scan caveat. Missing-ID omissions, duplicate records, conflicting captured IDs excluded, unsupported references not joined and invalid clocks separately described; native parent conflict status distinct. Native group membership not causal arrow; native parent refs labelled with status. Full JSON only on explicit receipt lookup with id/source/session guard. Scoped drafts remain manual, no persistence/annotations. Group/member/focus/filter/page changes invalidate full receipts. No commits.


Map tests failed on absent implementation, then2 tests passed for20-group bound, safe text, callbacks, memberships and clipped native references.

Hosted review follow-up: corrected UI caption spacing, synchronized backlog rows, and replaced machine-specific worktree paths with branch descriptions. Text/documentation only; targeted Loom tests and typecheck passed.
