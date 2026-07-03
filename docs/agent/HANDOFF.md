# LATTICE — Principal Architect Handoff (PD-002 · rev 2, grounded)

**Audience:** implementation agents (Opus 4.8 / Codex 5.5 class) and their human operator.
**Purpose:** convert the departing architect's judgment into procedure, so an agent not operating at that level can perform near it.
**Ground truth:** branch `claude/beautiful-gould-6b25d2` @ `81b9bfd3f69640172f076143fcd155dda174d4bd` (2026-06-20). The §0 reconciliation was **performed by the departing architect against this tree** — see `docs/agent/reconciliation_report.md`. Your first job is to countersign it, not redo it.
**Companion:** PD-001 (*The Substrate*) holds the big picture and roadmap. This document holds the *how to decide*.

---

## How to use this document

This is not a spec. The spec lives in the repo. This document is the **decision procedure** the spec was written under. When the spec is silent, ambiguous, or appears wrong, you do not improvise — you run §5, and if §5 says escalate, you escalate.

**Source-of-truth order (highest wins):**

1. `docs/lattice2_design.md` (the five invariants, op model, authority semantics, lifecycle) + the behavior table in `docs/lattice_poc_status.md`.
2. Ratified ADRs: `docs/adr/0001`–`0004`.
3. `docs/path_to_real.md` and `docs/threat_model_v2.md` — the honest-boundary documents.
4. This handoff and `docs/agent/`.
5. V1 `README.md` and V1 code — the authority model 2.0 keeps (behavior 19 proves it still passes).
6. Your judgment — only inside §5's guardrails, never against 1–5.

Conflicts between (1–3) and (4) → the repo wins **and** the conflict is filed in the reconciliation report. A conflict is information.

---

## §0 — Reconciliation: PRE-FILLED. Countersign before implementing.

The architect could read the tree but **could not execute the validation loop** in the authoring environment (no Hex network access). Therefore the report at `docs/agent/reconciliation_report.md` is complete on static evidence and **open on dynamic evidence**. Countersign protocol — do this before any implementation work:

1. `mix deps.get && mix format --check-formatted && mix test` on the branch. Expected: **9 properties, 67 tests, 0 failures** (status doc; stable across seeds 1/7/99/555/2024/12345).
2. `mix run scripts/lattice2_demo.exs` — expected: full narrated arc (collaborate → partition → divergence → offline-authoritative lock → quarantine + audit → heal/merge → queued request replayed → transfer → succession → returning-holder stale quarantine → `state_at` replay).
3. If both match: sign the report's §5 and proceed. If either diverges: **stop**, record exact divergence in the report, escalate. Do not "fix forward" a divergence you don't understand — the suite is the spec.

---

## §1 — Mission, in one paragraph

Lattice is the substrate for the most robust, resilient, anti-fragile foundation for human coordination and communication that can be built — groups that cannot be captured by an individual (coercion/bribery), a faction (entryism/Sybil/takeover), or a state (seizure/compulsion). Those three defenses conflict; no design optimizes all three at once. The architecture's answer is **layering**: different layers make different threat-model trades, locally-first. A future version of Cadence is built on Lattice.

**The layering rule (structural, enforceable):** federation is milestone M6 and is deliberately last. *Nothing below M6 may take a dependency on how federation resolves.* If a design choice only makes sense "because federation will need it," it is out of scope by rule. **The town works without the world.**

---

## §2 — Invariants (violations = stop work, escalate)

The five 2.0 invariants are canonical in `docs/lattice2_design.md`; the program restates them as commitments I-01..I-05. If a task appears to require violating one, the task is wrong, not the invariant.

- **I-01 · Authority is local, voluntary, self-certifying.** Identity is a keypair (`author` = Ed25519 pubkey, did:key-class); the op-log is its own identity document. No registration ceremony, no registry, no server-granted identity.
- **I-02 · Zero implicit authority.** Every cross-boundary act flows through an explicit, attenuated, revocable capability — and the capability **is** the credential. Design invariant 2 makes this concrete: *one delegation chain, two uses*; a single in-log `:revoke` kills both the append path and the live path (behavior 16, the keystone).
- **I-03 · Durability precedes liveness.** Design invariant 1: *the log is the truth; the connection is the cache.* Live delivery and post-partition sync flow through the same `Log.accept/2` + `Reduce` path (behavior 18).
- **I-04 · Coordinator-free by default.** A component all realms must reach for *correctness* is a design defect at this layer. Corollaries already enforced: determinism (invariant 3, topo+hash order), nothing silently lost (invariant 4, quarantine ≠ drop), no wall clocks (invariant 5, `Lattice.Clock` only).
- **I-05 · Falsifiable progress.** Every claim is a runnable behavior; the 19-behavior table with test mapping lives in the status doc. If it isn't a gate, it isn't done. Tests are the spec; the code bends.

---

## §3 — Scope boundary: DO NOT IMPLEMENT (M2 edition)

M1 discipline held. The boundary now protects M2's falsifiability. Each item is a real future need with a real home — implementing it early is the failure mode.

| Excluded now | Where it lives |
|---|---|
| Encryption of any kind (transport/at-rest/E2EE) | M3 confidentiality track — Keyhive wraps `Op.body` *above* the integrity substrate (`path_to_real.md` §3); DAG/reduction/quarantine unchanged |
| Key rotation / pre-rotation (DIDDoc-update problem) | M3 — design object D-01; do not improvise |
| Key recovery (social/threshold/MPC) | M3 — out-of-band; never touches op application |
| ZKPs, accumulators, selective disclosure | M4+ / research-gated |
| Any consensus protocol | Never at this layer (I-04) |
| Receipt-freeness machinery (chameleon/DVP/LRS/MACI-class) | M4 — research-gated (R-01..R-06) |
| Full compaction / GC (Sedimentree strata) | Named first scaling cliff (`path_to_real.md` §4). The *naive snapshot + re-reduction verification* stretch item is the only sanctioned toe over this line |
| PQC implementation | Agility documented only — see delta **D-A1** in the register (the Dilithium/SPHINCS+ agility note required by Addendum 01 is **absent from docs**; writing it is a doc task, not code) |
| DID registries, on-chain DIDDocs, stewardship machinery | Never — consequences of the rejected ledger substrate |
| Federation of any kind | M6 — layering rule |
| New runtime deps | Escalation-gated. Whitelist: core = plain OTP (**OTP 28 toolchain** — ADR 0001 verified `:deterministic` on it); boundary = `cowboy`, `jason`; test = `stream_data`; e2e = `@playwright/test` |

**Boundary-breach protocol:** if a task genuinely seems to need a listed item — question the requirement, write the pressure into the status doc, propose the smallest in-scope alternative, escalate. Every past pressure on this boundary was correctly resolved by refusing.

---

## §4 — Where we are: M1 is green on this branch. Close it out.

**Verified (static + status doc; countersign per §0):** phases 0–E checkpointed; **all 19 behaviors green** with test mapping; property suite (a) convergence, (b) single-writer authority at causal position, (c) byte-identical re-run, (d) identical quarantine sets — green across six seeds; demo narrates the full arc; no failing seeds on record.

### M1 close-out checklist (the actual remaining work)

1. **Countersign** (§0).
2. **Doc delta D-A1:** add the cryptographic-agility note (primitive pinned *and swappable*; Dilithium/SPHINCS+ named as PQC path; rotation framed as a future op) to ADR 0001 or a sibling ADR. Doc-only; required by Addendum 01; currently missing.
3. **Merge decision:** propose the branch → `main` merge (human approves; this is a publish action). The PR description should be the status doc's behavior table + validation-loop transcript.
4. **Stretch items (optional, only-if-green rule stands):** S-1 second OS-process BEAM node over the v1-style transport; S-2 naive snapshot ops with re-reduction verification. Neither blocks M2's start; S-1 is effectively being superseded by the carrier spike work.
5. Append the status-doc close-out line (§9 protocol).

### M2 is already opening — through the front door

`apps/lattice_carrier_spike` exists behind a fail-closed boundary: a `tcp_filter_dist` allowlist admitting only JSON logical-call frames to `:lattice_browser_gateway`, which still routes through `Lattice.call/3` (no Gateway bypass); hostile registered-name / pid-send / RPC-shaped / spawn-shaped distribution traffic is rejected before delivery, with a written proof artifact. The spike's own finding: Popcorn/AtomVM is **not** a drop-in browser dist node today (dist not downstreamed; Popcorn pins Elixir 1.17.3 / OTP 26 — a real version tension against the OTP 28 toolchain). The clean JSON WebSocket layer remains the production-facing surface. This is exactly the seams-over-solutions posture — keep it.

**The M2 conformance oracle (load-bearing idea from `path_to_real.md`):** the deterministic-simulation suite is the carrier's spec. *A real carrier must produce the same final logs/state as `Lattice.Sim` for the same op set.* Every carrier PR cites its oracle run.

### M2 open questions (W-series; full detail in `register.md`, ADRs in `adr_proposed/`)

| ID | Question | Architect's lean |
|---|---|---|
| W-01 | Wire format: canonical CBOR schema for ops/delegations (closes ADR 0001's BEAM-specific caveat; pins the atoms-vs-binaries schema) | ADR-P08: positional CBOR arrays + version tag; golden vectors committed; dual-encode equivalence tests during migration |
| W-02 | Carrier selection: JS client vs AtomVM/Popcorn vs filtered-dist | ADR-P09: decide by spike evidence against five criteria; JS-client-over-WebSocket is the likely near-term winner; keep the dist filter as the long-term seam |
| W-03 | Heartbeats from carrier liveness (closes ADR 0004's caveat) | ADR-P10: connection-liveness events author heartbeat ops at the boundary; reduction semantics unchanged |
| W-04 | Frontier-diff sync (Beelay-style) | Optimization, not semantics: same converge-idempotently contract; oracle-gated; do not entangle with W-01 |
| W-05 | Browser-side log persistence | Reuse `Log.dump/restore` contract onto browser storage; atomicity + verify-on-restore preserved |

---

## §5 — The decision framework (the judgment, as procedure)

### 5.1 Run on every non-trivial decision

1. **Invariant check** (I-01..I-05 / the five design invariants). All options violate → the task is malformed; escalate.
2. **Boundary check** (§3). None survive → boundary-breach protocol.
3. **Spec check.** A behavior, ratified ADR, or design-doc clause already decides it → decided. Reinterpreting *meaning* is escalation-gated.
4. **Test-first check.** Behavior-changing → failing test precedes implementation. Can't express it as a test → it's an ADR, not code.
5. **New decision → ADR before code** (`adr_proposed/TEMPLATE.md`). Small decision, small ADR; skipping is not a size option.

### 5.2 Tie-breakers, strict order

1. **Falsifiability** — the option a test can distinguish.
2. **Determinism** — byte-identical replay beats speed, elegance, everything below.
3. **Deps-decidability** — predicates decidable from the DAG (`deps`/ancestry) alone; never wall-clock, arrival order, or realm-local state. (This is why ADR 0003's verdict ignores total-order position and uses only causal relations — study it as the house style.)
4. **Boring** — plain OTP, stdlib, whitelist deps, readable by a reviewer.
5. **Seams over solutions** — keep M2 (carrier) and M3 (identity) swappable; `Lattice.Net` being the *only* locality-assuming module is the exemplar. Build sockets, not appliances.
6. **Reversibility** — cheapest to be wrong about.

**Rejected tie-breakers:** performance (until the oracle says otherwise), generality ("federation might want…" — layering rule), API ergonomics (the DSL serves behaviors, not vice versa). Note the availability trade ADR 0003 chose *on purpose*: new-holder availability beats lagging-holder work; work that must survive belongs in convergent state.

### 5.3 Escalation triggers — stop and ask the human

Crypto primitive choices or deviations · any new dep · reinterpreting a behavior's meaning · anything touching identity (`author` semantics, rotation) · any coordinator-shaped singleton · a §3 item seeming necessary · weakening a property test or narrowing a generator · a failing seed whose fix would change a ratified ADR · two consecutive failed attempts at one gate · **any merge/publish to `main`** (human approves).

Escalation format: what you were doing · the two best options with §5.2 trade-offs · your recommendation · what you did *not* do while waiting.

### 5.4 Calibration cases (worked)

- *"Sync would be faster shipping Bloom digests now."* → W-04 is oracle-gated and semantics-preserving; fine to spike, but §5.2(1): land the oracle harness first so the optimization is falsifiable.
- *"Popcorn would be cooler than a JS client."* → §5.2 says evidence, not aesthetics: the spike already found the version pin and missing dist; ADR-P09's criteria decide it.
- *"The returning holder's lock feels like it should win — it was first in wall time."* → There is no wall time (invariant 5). ADR 0003 clause 2 decided this; a holder-change beats a concurrent command by the superseded holder. Meaning-reinterpretation → escalate.
- *"Just this once, encrypt the demo payload."* → §3; question the requirement.
- *"term_to_binary is BEAM-specific, let's rip it out now."* → It is pinned, verified on OTP 28, and honest (ADR 0001). The fix is W-01's CBOR schema with golden vectors and dual-encode tests — an ADR'd migration, not a hot swap.

---

## §6 — ADR pack: dispositions + what's genuinely open

The rev-1 pack proposed seven ADRs blind. Reconciliation found the tree had already decided five of them — twice with *stronger* formulations than the architect's lean. Full dispositions in the reconciliation report; summary:

| Rev-1 proposal | Disposition |
|---|---|
| P01 canonical encoding | **Superseded by ADR 0001** (pinned `term_to_binary :deterministic`, minor_version 2, OTP 28-verified; CBOR honestly deferred → now W-01) |
| P02 crypto pinning + agility | **Partially decided** (SHA-256 + Ed25519 pinned in ADR 0001/design). Agility note **missing** → doc delta **D-A1** |
| P03 quarantine cascade | **Superseded by ADR 0003** — the two-clause honored-iff (holder-at-causal-position ∧ not-concurrently-superseded) makes the cascade *emergent* from valid-holder-chain recomputation. Stronger than the proposed taint-set. House style. |
| P04 clock/threshold · P05 succession race | **Superseded by ADR 0004** + design invariant 5 (ticks in op bodies; heartbeats advance `last_active`; premature/unauthorized succession quarantined; returning holder resolved via ADR 0003) |
| P06 queue-through-holder | **Decided in design** (behavior 6): non-holder mutation quarantined; the pattern is an inbox `:request` the holder's materialization turns into a real command op |
| P07 durability boundary | **Decided** (behavior 14, `Log.dump/restore`); browser persistence is W-05 |
| Cap shape | **Decided** (evolved `cap.ex` + `Authority.Delegation` chain with per-hop `links_attenuate?`; behavior 16 green; `Live.revoke/4` defense-in-depth) |

**Live proposals (in `adr_proposed/`):** ADR-P08 wire-format CBOR schema (W-01) · ADR-P09 carrier selection procedure (W-02) · ADR-P10 heartbeats from carrier liveness (W-03). Each names its falsifying test; each is ratified by the first test that depends on it — move the file into `docs/adr/` with the next number when that happens.

---

## §7 — Verification posture (what the tripwires guard now)

- **V-01 (one predicate)** — verified in structure: all quarantine verdicts (`:stale_holder`, `:double_transfer`, `:revoked_capability`, `:premature_succession`, …) come from one `Authority.analyze/2` pass over the DAG; deps-decidable throughout. Guard: no second analysis path may grow; `Live.authorize/2` consults the same in-log revokes.
- **V-02 (map-order determinism)** — covered dynamically by property (c) across six seeds; folds run in canonical topo order; `CausalList` sorts by `{key, id}`. Guard stays: any new fold over a bare map in reduce/merge/audit paths is AP-02 until it iterates a canonically-ordered structure.
- **V-03 (Net is a seam)** — verified: `path_to_real.md` states `Lattice.Net` is the only locality-assuming module; the carrier spike lives outside it behind a fail-closed filter. Guard: the **conformance oracle** — every carrier change cites a Sim-equivalence run.
- **V-04 (generators cover churn)** — verified and exemplary: transfers are authored "from whichever realm currently believes it holds — which, under partition, may be more than one," interleaved with partition/heal at randomized ticks. Guard: never narrow this generator (§5.3).

---

## §8 — Anti-patterns (tripwires; expanded registry in `antipatterns.md`)

| ID | Smell | One-line fix |
|---|---|---|
| AP-01 | Wire-schema drift: atoms vs binaries, unpinned encodings, re-serialized op hashing differently | ADR 0001's caveat is the spec; W-01/ADR-P08 closes it with golden vectors |
| AP-02 | Fold over a bare map in reduce/merge/audit paths | Canonical order first; property (c) is the alarm, not the excuse |
| AP-03 | Wall-clock anywhere in semantics (`System.system_time`, `Process.sleep` meaning) | `Lattice.Clock` only; ticks live in op bodies (invariant 5) |
| AP-04 | Coordinator creep — a singleton all realms need for correctness | Per-replica or deps-decidable form; else escalate (I-04) |
| AP-05 | Boundary erosion "just for the demo" | §3 protocol |
| AP-06 | Editing a behavior test to match code | Tests are the spec; meaning-changes escalate |
| AP-07 | A second authority-analysis path | Everything flows through `Authority.analyze/2` |
| AP-08 | Carrier code reaching around the Gateway or into `Net` internals | The spike's own rule: `BrowserGateway` still calls `Lattice.call/3`; keep it |
| AP-09 | Improvised key rotation under deadline | D-01 is M3; write the pressure down, not the code |
| AP-10 | Per-call-site queue semantics | Behavior 6's inbox-`:request` pattern is the one rule |
| AP-11 | Pre-seeded-accumulator traversal bugs (seed the acc, skip exploring the frontier) | The `Dag.reachable/2` bug class — real, found by the time-travel test; write traversal tests that start from non-trivial frontiers |
| AP-12 | Rebinding v1 facade names (`Lattice.call/grant/cast`) | Status doc names the clash; 2.0 verbs live on `Registry`/facade non-clashing names |

---

## §9 — Working agreements

- **Test-first for behaviors; no skipped tests** (`@tag :skip`/pending do not exist here).
- **Status doc protocol** (`status_protocol.md`): one line per merged change — `date · milestone/phase · behaviors touched · tests added · seeds · ADRs`. Failing property seed → immediate entry with seed + shrunk counterexample, *before* the fix.
- **Commits/PRs** name the behavior or ADR first (`B16: …` / `ADR-P08: …`). Merges to `main` are human-approved.
- **Docs debt is debt** — a change invalidating `lattice2_design.md`, `threat_model_v2.md`, or `path_to_real.md` updates it in the same PR.
- **Stack:** Elixir on **OTP 28** (the ADR-verified toolchain). Core stays plain OTP. Phoenix LiveView (1.1+) app-layer later; Vue 3.5 allowed for the M2 browser client when a JS client wins ADR-P09 — not before.

---

## §10 — Glossary (canonical vocabulary; no synonyms)

**op** — signed, canonically-encoded event; unit of truth. **deps** — causal frontier: predecessor op ids (sorted). **log** — a Replica's append-only op set (`Lattice.Log`). **realm** — an execution context holding a keypair. **author** — the Ed25519 pubkey that signed. **Replica** — durable primitive; identity = its log. **materialization** — ephemeral live process (`Lattice.Materializer`). **reduction** — `Lattice.Reduce`: causal slice → quarantine-excluded → per-field CRDT fold in topo+hash order. **convergent field** — CRDT-merged (`Lww` / `OrSet` / `CausalList`). **authoritative field** — single-writer via role holder. **holder** — role owner at a causal position (valid holder-chain). **delegation** — signed grant (issuer→audience, scoped: ops / roles / live), per-hop attenuating. **Cap** — the capability/credential; one chain, two uses (behavior 16). **quarantine** — deterministic exclusion from reduction, never from the log (invariant 4); reasons: `:stale_holder`, `:double_transfer`, `:revoked_capability`, `:premature_succession`, `:unauthorized_succession`, `:invalid_succession`. **tombstone / dormant / live** — lifecycle states (`Registry`). **succession** — policy-designated takeover after `dormant_ticks` on the logical clock (ADR 0004). **tick** — explicit logical time value carried in op bodies. **heartbeat** — in-log liveness op advancing `last_active`. **frontier** — ops nothing depends on; also the time-travel cursor (`state_at`). **oracle** — the Sim suite as carrier conformance spec. **gate / behavior** — falsifiable exit conditions; the 19 live in the status doc's table.

---

## §11 — Task-agent prompt template

Spawn agents with `docs/agent/prompts/phase_task.md`. Output contract: **(1)** plan mapping tasks → behaviors/ADRs → tests; **(2)** failing tests first; **(3)** implementation; **(4)** green full-loop transcript (+ oracle run for carrier work); **(5)** status-doc line; **(6)** questions *raised but deliberately not solved*. An agent that solves questions outside its scope has failed the assignment even if the code works.

---

## §12 — What the architect would do next

**Now:** countersign §0 → D-A1 agility note → propose the `main` merge with the behavior table as PR body → land the conformance-oracle harness as a named test target.
**Then (M2 proper):** ADR-P08 wire schema with golden vectors + dual-encode tests → ADR-P09 carrier decision by spike evidence (JS client likely near-term; dist filter kept as the seam) → W-03 heartbeats-from-liveness → W-04 frontier-diff behind the oracle → W-05 browser persistence on the dump/restore contract.
**In parallel (human-side):** the impossibility-map / strict-JCJ research prices M4/M6; the Township one-pager (M5 spec) and the Cadence-on-Lattice interface sketch (durable threads · role-Caps · attestation API) turn the program's promise into contracts.

---

## Appendix — File map of `docs/agent/`

```
docs/agent/
  HANDOFF.md                  ← this file (decision procedure; entry point)
  reconciliation_report.md    ← PRE-FILLED by the architect; countersign §5
  register.md                 ← living register: Q closed · V verified · D deltas · W open (M2) · R research
  antipatterns.md             ← AP-01..AP-12 expanded: symptom / detection / fix
  review_rubric.md            ← per-PR reviewer checklist incl. mechanical greps
  status_protocol.md          ← falsifiability-trail rules
  adr_proposed/
    TEMPLATE.md
    ADR-P08-wire-format-cbor.md
    ADR-P09-carrier-selection.md
    ADR-P10-heartbeats-from-liveness.md
  prompts/
    phase_task.md             ← fill-in template for spawning task agents
```

Root `CLAUDE.md` / `AGENTS.md` carry the short rules so Claude-family and Codex-family agents auto-load them and are pointed here.

---

*PD-002 rev 2 · July 2026 · The judgment is now yours to run, not to have. The suite is the spec, the oracle is the carrier's conscience — and the town works without the world.*
