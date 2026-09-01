# Orbit view — fleet-supervision visualization (design)

**Date:** 2026-07-08
**Status:** Implemented — the attention state machine ships in
`internal/capture/internal/projection` and the desktop view in
`apps/tauri-desktop/src/ui/orbit/`.
**Decisions made via brainstorm:** fleet supervision as the job · blocked/waiting
agents as the primary signal · attention gravity well as the metaphor ·
click-to-detail as v1 interaction.

## Problem

Every current surface (TUI feed, desktop feed/sessions/files) is a 1D scrolling
list. Lists are worst at exactly the thing multi-agent work needs most: seeing
several concurrent sessions at once and spotting, without reading, **which agent
needs the human right now**. An agent parked on a permission prompt or a
finished-and-unnoticed session is pure wasted wall-clock.

## Design summary

A 3D "attention gravity well" view in the Tauri desktop app. The user is the
center; each live session is a body in orbit. **Orbit radius encodes urgency**:
working agents cruise the outer orbits; a session that needs input stops, turns
amber, pulses, and drifts inward over dwell time — blocked for five minutes
means it is literally at screen center. Space itself answers "who needs me?"

## Part 1 — Data layer: derived attention state

New per-session state machine in `internal/capture/internal/projection`
(sealed derived layer, never the spool):

```text
working → needs_input → working → … → done      (idle / error as overlays)
```

Derivation rules from events already captured:

- `permission`-category event or Claude Code `Notification` hook payload
  (permission request / waiting-for-input) → `needs_input`, `reason` from the
  event summary.
- Any subsequent tool/message/file event on the session → `working`.
- Session end / `Stop` → `done`.
- `error`-severity event → sticky `error` overlay until next activity.
- No events for N seconds on an open session → `idle` (tunable; procwatch
  liveness may later disambiguate thinking-hard from abandoned).

Exposure — **strictly additive, no `schema_version` bump**:

- `/sessions` objects gain `state`, `state_since`, `state_reason`.
- State transitions are emitted on `/events/stream` as synthetic frames
  (`source: "firehose"`, `name: "state.transition"`) so clients animate on
  push. Stream-only: never spooled, never exported.

The state is renderer-agnostic: the TUI gains a "NEEDS YOU" indicator and the
desktop feed gains badges from the same fields.

## Part 2 — Scene encoding

Tilted orbital view (camera slightly above the plane) — deliberately
*mostly planar* 3D so urgency reads along one unambiguous axis; depth provides
parallax, glow, and presence, not information hiding.

| Channel | Encodes |
|---|---|
| Center | The user (quiet core, no avatar) |
| Body | One live session |
| Hue | Agent family (claude-code, codex, opencode, …) |
| Size | Rolling activity volume |
| Orbit radius | Attention need; `needs_input` drifts inward as dwell time grows |
| Angular sector | Repo — same-repo sessions cluster, so convergence/collision is visible adjacency |
| Particles off a body | Event texture (tool calls, file writes, shell as distinct sparks) |
| Amber + beacon pulse + stopped orbit | `needs_input` (always labeled with reason) |
| Sticky red halo | `error` |
| Dim + slow | `idle` |
| Outward drift → ember → despawn | `done` |

Labels appear on hover/focus only, except `needs_input` which is always
labeled. Legibility cap ~20 bodies; beyond that, cluster by repo. Click a body
→ existing session detail view. Hover → summary card.

## Part 3 — Client architecture

- **Home:** new `Orbit` view in `apps/tauri-desktop`, one more `ui/` module
  beside feed/sessions/files. No new app or process.
- **Dependency:** three.js, frontend-only (Go engine's minimal-deps rule
  untouched).
- **Split — pure brain, dumb renderer:**
  - `orbit/model.ts`: pure functions, zero GPU. Consumes the session list +
    SSE events the app already receives; produces a declarative scene
    description per body: `{sessionId, family, repo, state, urgencyRadius,
    sectorAngle, activityRate, reason}`. All layout math (drift as a function
    of `state_since` and now, sector assignment, despawn timing) lives here.
  - `orbit/scene.ts`: three.js; tweens toward the model's targets, spawns
    particles on events. Contains no decisions.
- Rendering pauses when the window is hidden.
- v1.1: detachable always-on-top mini orbit window (Tauri multi-window).
- Later freebie: the same bundle served by the daemon at `/ui/orbit` (it is
  just another SSE client).

## Part 4 — Guardrails and testing

Frozen contracts (docs/contracts.md) are respected: envelope, spool, privacy,
and export untouched; attention state is derived, so the spool remains the
sole source of truth and states recompute identically on rebuild. API changes
are additive only. Capture paths are not touched ("never break the agent" is
trivially safe). The scene renders only post-redaction summaries.

Testing:

- **Go:** table-driven TDD for the state machine against real captured
  payloads (Claude Code `Notification` hooks, permission events, stop events);
  a determinism test replays a spool file and asserts identical states.
- **TS:** vitest for `orbit/model.ts` (drift curves, sector assignment,
  despawn timing), same style as `state.test.ts`.
- **Demo mode:** a script that `firehose emit`s a synthetic fleet — the visual
  test harness and the screen-recordable demo asset in one.

## Roadmap unlocked

1. **v1** — Orbit view + TUI "NEEDS YOU" from the same fields.
2. **v1.1** — always-on-top mini orbit window.
3. **Territory zoom** — click a repo sector → CodeCity-style terrain of that
   repo, agents as workers on files. The second metaphor becomes a zoom level:
   overview (orbit) → zoom (territory) → detail (session).
4. **Time canyon replay** — scrub traces in 3D for forensics.
5. **Summon-the-terminal** — click → focus the agent's window, once procwatch
   tracks pid/tty.
6. **Act-from-scene** — approve/deny from the visualization; gated on a
   deliberate contract expansion (two-way channel into agent CLIs).
