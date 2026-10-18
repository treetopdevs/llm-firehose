# Agent Firehose

Language for observing AI coding-agent activity locally while preserving privacy and durable history.

## Language

**Observation**:
A source-reported occurrence of agent activity before Firehose applies its privacy and durability semantics.
_Avoid_: Raw event, telemetry

**Admission**:
The ordered attempt to turn a normalized Observation into a Captured Event; it succeeds only after durable recording.
_Avoid_: Append, emit

**One-shot Admission**:
Admission performed by a short-lived process without running Source Adapters or Projections; a running Capture Engine reconciles the resulting Captured Event.
_Avoid_: Fallback pipeline, direct append

**Source Adapter**:
A source-specific module that maps native activity into zero or more normalized Observations and reports source-schema drift.
_Avoid_: Collector, integration

**Captured Event**:
A privacy-processed observation recorded in the canonical append-only history and available to views.
_Avoid_: Raw event, log line

**Projection**:
The idempotent application of a Captured Event to disposable derived state and live views after durable recording.
_Avoid_: Persistence, capture

**Live Subscription**:
A bounded, ordered view of Projections. After an interruption it is reconciled from durable history together with the session Projection.
_Avoid_: Source of truth, event queue

**Capture Warning**:
A diagnostic notice that an observation could not become a Captured Event; it never substitutes for the missing event.
_Avoid_: Fallback event, captured event

**Capture Engine**:
The local module that admits observations and maintains captured events in both long-running and daemonless operation.
_Avoid_: Daemon, collector

**Capture Policy**:
The active local privacy rule that determines what an Observation may retain when it becomes a Captured Event.
_Avoid_: Adapter policy, display filter

**Daemonless Mode**:
Operation without a long-running daemon, with the same capture guarantees under a different host.
_Avoid_: Direct-tail mode

**Activity Map**:
A view of one repository's path hierarchy showing where Heat accumulated over a chosen time window; it reports observed activity, never code quality.
_Avoid_: Repository Weather, heatmap of quality

**Heat**:
The count of file-category Captured Events touching one path within one time bucket, counted equally across the repository's worktrees.
_Avoid_: Activity score, churn, hotness

**Session Score**:
A view of one session's Captured Events laid out as time-aligned tracks, one per event category, with real gaps preserved.
_Avoid_: Agent Score, grade, rating

**Error Signature**:
A normalized identity under which recurring error observations are recognised as the same error; the basis for any claim that an error repeated or belongs to a file.
_Avoid_: Error fingerprint, storm cell, motif

**Loop Observatory**:
A session-local view of recurring Error Signatures and the captured activity between consecutive observations; recurrence does not prove an independent retry or a repeated strategy.
_Avoid_: Loop detector, retry count, proof of a fix

**Session Stratigraphy**:
A historical view of the sessions in which an Error Signature was observed, with exact per-session counts, first/last matching observations and a captured evidence sample.
_Avoid_: Session duration, effort score, causal history, proof of resolution

**Evidence Court**:
A manual host-private notebook linking user-written claims and evidence requirements to Captured Event receipts; an attached receipt is an association, not a verified claim.
_Avoid_: Truth score, automatic verdict, proof of correctness
**Handoff Subway**:
A map of explicit user annotations linking Captured Event receipts across session/source pairs; annotated transfers are not source-confirmed handoffs or causal proof.
_Avoid_: Inferred handoff, automatic causality, complete context transfer
**Attention Airspace**:
A source/session-scoped snapshot board grouping captured requests, failures, activity and completion evidence; quiet and stale observations never prove process status.
_Avoid_: Running agents, session ended, time blocked, collision prediction
**Causal Loom**:
An exact-source/session explorer of native identifier groups and supported parent-message references. Membership is association; parent references are source-reported, not inferred root cause. Full receipts load only on explicit inspection.
**Patch Ecosystem**:
Replay of captured file observations grouped by exact stored path and workspace label within one source/session. Growth counts observations, not changed lines or quality; reported completion is not verified final file content.
