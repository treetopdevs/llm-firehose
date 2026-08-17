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
A bounded, ordered view of Projections that reconciles from durable history after interruption.
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
