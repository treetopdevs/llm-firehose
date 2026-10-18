# File activity by session

Base: latest main e007b2f, fresh worktree codex/file-session-activity. The combined prototypes remain unmerged. This independent slice advances the shared-file evidence required by Attention Airspace without importing its unmerged UI.

## Outcome

Files gains an explicit session-activity mode alongside its existing path summary. Users can find exact recorded paths observed in multiple source/session scopes, inspect the latest captured receipt per participant, and distinguish known workspace scopes from missing identity. Shared observations do not prove simultaneous execution, edits, physical-file identity, or write conflict.

## Contract and decisions

- Add GET /artifacts/file-sessions; preserve /artifacts/files byte-shape/meaning and all frozen surfaces. No schema bump, dependencies, runtime network or capture behavior changes. Serve a derived disposable projection rebuilt from spool.
- Each row is an exact tuple: recorded workspace-kind/value, recorded path, source, session_id. Select workspace scope in order worktree_id, jj_workspace_id, cwd, repo; use explicit kind tags to avoid collisions. CWD/repo are recorded scope labels, not verified physical workspace identity. Missing scope is explicit and never eligible for shared-scope grouping. Empty session IDs remain visible as unknown and never count toward shared-session badges.
- Reuse EventFilePaths, including its readable metadata and privacy-digest rules. No filesystem reads, path normalization, alias merging, contents inspection, successful-edit inference or hidden persistence. Exact path spellings are the unit; totals count captured observations, including attempts.
- Aggregate count, earliest/latest captured event time and deterministic latest event ID (time then ID tie-break). Existing projection duplicate admission semantics remain authoritative; no separate synthetic event source. Incremental Apply and Build must agree; return detached snapshots under lock.
- Shared groups require a nonempty workspace scope and at least two distinct nonempty (source, session_id) tuples for the same exact recorded path. Do not interpret overlapping first/last ranges as concurrent activity. Retain all participants and single/unknown-scope rows through filters and pagination.
- API array sorted by last_time descending then full tuple, empty returns []. Existing file summary remains default for compatibility. New Files mode loads only on explicit selection/refresh; no background polling or per-session fanout. Clearly disclose projection history scope and unknown identities.
- Page groups/rows at 40, participant rows at 40 if nested; provide stable accessible labels and exact counts. A simple accessible table/list is sufficient; no new map needed for this evidence slice.
- Explicit receipt inspection calls /events/{id}, verifies event ID/source/session matches the selected row, and uses a Files-local detail pane. Missing or mismatched receipt is unavailable, never substituted. Mode/scope/filter/page changes and refresh cancel/invalidate stale requests. Preserve keyboard focus on enabled controls or a labelled heading.
- Existing full artifact projection and response size remain unbounded; this slice bounds rendering, not history storage. Document the extra per-tuple aggregation memory. No claim of monitoring currently active processes.

## Public test seams and implementation order

User delegated routine decisions: use projection Apply/Build/response tests and observable Files DOM, not private helper tests. Start each behavior with a failing test. Fixtures come from captured session/adapter fixtures; label normalized contract mutations for workspace/session combinations.

1. Go projection tests: exact source/session/workspace separation, unknown scope, multiple path event/digest exclusion, duplicate handling, chronological tie-break, detached snapshots and rebuild equivalence. Implement additive aggregation and capture accessor.
2. HTTP contract tests through real daemon: empty, populated, old endpoint unchanged, additive endpoint origin policy. Document new endpoint.
3. Frontend DOM tests: explicit load, shared criteria, unknown scope handling, pagination reachability, receipt lookup guard/cancellation, errors/retry, stale refresh and focus. Implement mode in existing Files with no change to unrelated panels.
4. Actual isolated-daemon browser verification with real fixtures and labelled normalized mutations; no user spool/config/hooks. Test shared and unknown labels, paging and receipt details; save screenshot evidence.
5. Requested-model adversarial plan and final reviews; fix findings. Independent spec/standards reviews. Gates: gofmt empty, go vet, go test ./..., CLI build; frontend full suite/build; sidecar then cargo test. Commit, PR, hosted CI/comment fixes. Main merge remains human-approved.

## Follow-up boundary

Airspace can consume this exact scoped evidence in a later integration slice. This slice does not claim the Airspace overlay is delivered; it removes its data blocker and makes the evidence useful immediately in Files.
