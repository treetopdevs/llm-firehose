# ADR-P10 — Heartbeats derived from carrier liveness (closes W-03, ADR 0004 caveat)
## Status
PROPOSED.
## Context
ADR 0004: dormancy = absence of heartbeats, POC emits them explicitly for deterministic windows, and names the production fix — derive heartbeats from connection liveness on the carrier. The trap: importing wall-clock or connection state into reduction would break invariant 5.
## Decision
The **boundary authors ops; reduction stays pure.** The carrier (per ADR-P09) observes liveness (socket up, pings) and, on a policy cadence, authors ordinary `{:heartbeat, role, at_tick}` ops on the holder's behalf-of-itself (holder-signed at the client), with `at_tick` drawn from the same explicit logical clock ops already carry. Reduction/validation are untouched — a carrier-driven heartbeat is indistinguishable in-log from an explicit one (same ADR 0004 validity rule: authored by holder-at-its-deps). The deterministic suite keeps emitting explicit heartbeats; carrier tests assert only that liveness produces well-formed heartbeat ops at the boundary.
## Alternatives considered
Reduction consults carrier state — rejected: violates invariant 5 and destroys `state_at` exactness. Successor pings holder before succeeding — rejected: adds a liveness oracle and an interactive dependency (coordinator smell); ADR 0004 already resolves the partitioned-heartbeat case via ADR 0003.
## Consequences
Dormancy windows in production reflect real disconnection without new semantics; the "live-but-silent holder looks dormant" caveat narrows to "disconnected holder," which is the intended meaning.
## Falsifying test
Kill the holder's connection; assert no heartbeats are authored thereafter, succession validates at threshold on the logical clock, and the same op set replays byte-identically with `state_at` (invariant 5 preserved).
## Escalation notes
Any proposal to let reduction read liveness, or to auto-sign heartbeats server-side without the holder's key, → human immediately (touches author semantics).
