# ADR-P09 — Carrier selection procedure (closes W-02)
## Status
PROPOSED.
## Context
Three candidates: (A) JS client over the existing WebSocket boundary; (B) AtomVM/Popcorn browser BEAM node; (C) filtered Erlang distribution (`tcp_filter_dist` seam from the spike). Spike evidence on record: the fail-closed filter works (hostile registered-name/pid/RPC/spawn shapes rejected pre-delivery; proof artifact written); Popcorn is not drop-in (dist not downstreamed; pinned Elixir 1.17.3/OTP 26 vs our OTP 28 toolchain); the JSON WebSocket layer is the production-facing surface today.
## Decision
Decide by **evidence against five criteria**, each a runnable check, in priority order: (1) conformance-oracle equivalence (real carrier ≡ `Lattice.Sim` final logs/state); (2) fail-closed authority (all v1 hostile-shape tests hold at the new boundary; no Gateway bypass); (3) `dump/restore` contract preserved on the client side (W-05); (4) toolchain coherence (no forked OTP/Elixir pins in the main tree); (5) reversibility (the losing candidates remain buildable spikes). **Standing lean:** A now (Vue 3.5 permitted for the client UI), C kept warm as the server↔server seam, B revisited when Popcorn's dist lands or its pin catches up.
## Alternatives considered
Pick by architecture taste — rejected by §5.2(1): every criterion above is falsifiable; taste is not. Wait for Popcorn — rejected by reversibility: A does not foreclose B.
## Consequences
M2 ships value on A while the seam (C) and the ambition (B) stay alive as isolated apps; `path_to_real.md` §1 updated with the verdict.
## Falsifying test
The five criteria run as a named CI target per candidate; the ADR is ratified by the first green run of criteria 1–3 on the chosen carrier.
## Escalation notes
Any candidate requiring a new runtime dep or an OTP pin change → human. Merging carrier code that skips criterion 1 → blocked by rubric item 15.
