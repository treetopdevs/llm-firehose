# Phase 5 — optional Phoenix cloud control plane (design, deferred)

**Status: design only. Implementation is deliberately deferred** by the
migration plan's anti-goals: *"Adding cloud sync before local desktop usage
is solid"* is an anti-goal, and Phase 5's own precondition is a solid desktop
beta (Phase 3) plus a measured engine decision (Phase 4). This document
freezes the intended shape so nothing built now paints us into a corner.

## Position in the architecture

The three-layer north star: **capture engine** (Go, local) → **desktop
shell** (Tauri) → **cloud control plane** (Phoenix, optional). Phoenix is a
*shared realtime system* — team dashboards, fleet aggregation, collaboration —
not a replacement for the local runtime. The local daemon stays the only
component that ever sees full-fidelity events.

## What Phoenix should do

- User/org auth.
- Device registration.
- Encrypted or privacy-aware sync of **allowed event subsets**.
- Team dashboards; multi-device / multi-user session aggregation.
- Long-term analytics; shared traces, search, alerts, collaboration.

## What Phoenix must not do (initially)

- Replace the local collector.
- Become required for the product to function.
- Break offline mode.

## Deployment modes

| Mode | Description |
|---|---|
| Local only | No cloud sync; all data stays on device. Default, forever first-class. |
| Personal sync | Optional backup/sync across one user's devices. |
| Team mode | Multiple users/devices sending approved metadata to cloud. |
| Enterprise self-hosted | Organization-hosted Phoenix control plane. |

## Data flow

1. Local daemon captures full-fidelity events (subject to the local privacy
   mode — redaction still happens before persistence).
2. **Local policy decides what may leave the machine.** Sync policy composes
   with, never overrides, the local privacy mode: the cloud can only ever
   see a further-reduced subset of what the spool holds.
3. Cloud receives the transformed subset per privacy mode + org policy.
4. Local export (`firehose export`, `POST /export`) remains available
   regardless of cloud status.

## Contract implications already honored today

- The envelope (`schema_version`) and export format are frozen contracts —
  Phoenix ingests the same NDJSON envelopes; no cloud-specific event shape.
- `trace_id` exists in the envelope now, so cross-device trace aggregation
  needs no future schema bump.
- The daemon's local API is the only integration point; a future sync agent
  is *a client of the daemon*, not a second reader of the spool.

## Exit criteria (from the migration plan)

- Local-only mode remains first-class.
- Sync can be disabled completely.
- Cloud features add value without increasing local complexity.

## Unblock conditions

Start Phase 5 implementation only when **all** hold:

1. Desktop beta shipped and stable (Phase 3 exit criteria met).
2. Phase 4 pain review completed with a written decision.
3. A concrete multi-user/team demand exists (not hypothetical).
4. Human sign-off on auth/identity design — identity work is an explicit
   escalation trigger in this repo.
