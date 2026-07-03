# Reconciliation Report — 2026-07-01
Author: departing principal architect (Claude Fable 5) · Tree: `claude/beautiful-gould-6b25d2` @ `81b9bfd3f69640172f076143fcd155dda174d4bd`
Method: full static read (design doc, ADRs 0001–0004, status doc, path_to_real, threat_model_v2, lattice_core lib + tests, carrier spike). **Dynamic evidence not executed in the authoring environment (no Hex network) — countersign required (§5).**

## 1. Behavior map check
Repo numbering **MATCHES** the handoff's phase mapping and adds the authoritative table (status doc): 1 convergence · 2 delivery-order independence · 3 idempotent sync · 4 tamper rejection · 5 cap-gated append · 6 authoritative serialization (queue-through-holder) · 7 offline-authoritative · 8 stale-holder · 9 double-transfer anomaly · 10 revocation · 11 durable send · 12 promise across dormancy · 13 lifecycle/tombstone · 14 realm death + resurrection · 15 succession · 16 unified chain (keystone) · 17 time travel · 18 same-path equivalence · 19 v1 suite preserved. **All 19 reported green**; property suite (a–d) green across seeds 1/7/99/555/2024/12345.

## 2. ADR pack disposition
| Rev-1 ADR | Repo state | Action |
|---|---|---|
| P01 canonical encoding | ADR 0001: `term_to_binary [:deterministic, minor_version: 2]` over tagged tuple, sorted deps, sha256→url-b64; OTP 28-verified; CBOR deferred with honest caveats | **Superseded.** CBOR migration re-scoped as W-01 / ADR-P08 |
| P02 crypto pinning + agility | SHA-256 + Ed25519 pinned (ADR 0001, design §Op model, `Lattice.Identity`). Agility/PQC note (Dilithium/SPHINCS+, Addendum 01 requirement): **absent** (grep negative) | **Partially decided.** Open doc delta **D-A1** |
| P03 quarantine cascade | ADR 0003 two-clause honored-iff; cascade emergent via valid-holder-chain; verdict causal-only (total-order-independent) | **Superseded — stronger.** Adopt as house style |
| P04 clock/threshold | ADR 0004 + invariant 5: logical `Lattice.Clock`, ticks in op bodies, heartbeats advance `last_active`, `dormant_ticks` policy at genesis | **Superseded** |
| P05 succession race | ADR 0004 caveats + ADR 0003: heartbeat-unseen-by-successor → succession valid on its view; returning holder's later ops `:stale_holder`. Explicitly "intended, not a bug" | **Superseded** |
| P06 queue-through-holder | Design behavior 6: non-holder mutation quarantined; pattern = inbox `:request` processed by holder's materialization into a real command op | **Decided in design** — matches lean in substance |
| P07 durability boundary | Behavior 14 green via `Log.dump/restore`; browser/append upgrades named in path_to_real | **Decided.** Browser persistence = W-05 |
| Cap shape | `cap.ex` evolved (+`chain`/`replica`); `Authority.Delegation` with per-hop `links_attenuate?`; B16 green; `Live.revoke/4` defense-in-depth for direct `Gateway.call` | **Decided** |

## 3. Conflicts found (handoff vs repo)
- **Toolchain:** rev-1 said "OTP 27 line"; ADR 0001 verifies **OTP 28**. Repo wins; CLAUDE.md/AGENTS.md corrected.
- **AP-01 as written** ("term_to_binary near crypto = defect") contradicted ADR 0001's pinned-and-noted use. Revised: the defect is *unpinned/undocumented* encoding and wire-schema drift (atoms vs binaries), not the pinned POC choice.
- **P03 lean** (explicit descendant taint-set) is weaker than the shipped formulation. Handoff updated to teach ADR 0003, not compete with it.

## 4. Items the handoff missed (decisions already made, worth knowing)
- `Lattice.Sim` as the **conformance oracle** for any real carrier (path_to_real) — promoted to a first-class M2 gate.
- Carrier spike posture: fail-closed `tcp_filter_dist` allowlist; `BrowserGateway` routes through `Lattice.call/3`; hostile dist shapes rejected pre-delivery; proof artifact JSON. Popcorn finding: dist not downstreamed; pins Elixir 1.17.3/OTP 26.
- ADR 0003's deliberate availability trade (new holder over lagging holder's work; durable work → convergent state).
- v1 facade name-clash resolution (2.0 verbs via `Registry` + non-clashing facade names) — encoded as AP-12.
- Real bug class on record: `Dag.reachable/2` pre-seeded-accumulator (found by time-travel test) — encoded as AP-11.
- Stretch S-1/S-2 not done; S-1 effectively superseded by the carrier spike.

## 5. Cleared to implement: **CONDITIONALLY — pending countersign**
Static reconciliation complete. Successor must run: `mix deps.get && mix format --check-formatted && mix test` (expect 9 properties, 67 tests, 0 failures) and `mix run scripts/lattice2_demo.exs` (expect the full narrated arc), then sign below. Divergence → stop, record, escalate.

Countersigned by: ______________  date: ______  loop transcript ref: ______________
