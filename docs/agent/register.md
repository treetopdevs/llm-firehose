# Question Register (living)
Statuses: OPEN · DECIDED(→ref) · VERIFIED · DELTA(doc) · RESEARCH(human). Update in the same PR as the change that moves a row.

## Q — M1 decide-now (rev-1) — ALL CLOSED
| ID | Question | Status |
|---|---|---|
| Q-01 | Canonical encoding | DECIDED → ADR 0001 (CBOR = W-01) |
| Q-02 | Hash/sig pinning + agility | DECIDED (SHA-256/Ed25519) + DELTA D-A1 (agility note missing) |
| Q-03 | Quarantine cascade | DECIDED → ADR 0003 |
| Q-04 | Clock & threshold | DECIDED → ADR 0004 |
| Q-05 | Succession race | DECIDED → ADR 0004 caveats + ADR 0003 |
| Q-06 | Queue-through-holder | DECIDED → design behavior 6 (inbox `:request` pattern) |
| Q-07 | Unified Cap shape | DECIDED → cap chain + `links_attenuate?`, B16 |
| Q-08 | Durability boundary | DECIDED → behavior 14 `Log.dump/restore` |

## V — verification tripwires
| ID | Claim | Status |
|---|---|---|
| V-01 | One authority-analysis path | VERIFIED (all verdicts via `Authority.analyze/2`; `Live.authorize/2` consults same revokes). Guard: no second path |
| V-02 | No map-order nondeterminism | VERIFIED dynamically (property c, six seeds). Guard: AP-02 on new folds |
| V-03 | `Net` is the only locality seam | VERIFIED (path_to_real; spike outside it, fail-closed). Guard: conformance oracle on every carrier PR |
| V-04 | Generators cover authority churn in partitions | VERIFIED (transfer authored from every self-believed holder). Guard: never narrow (§5.3) |

## D — deltas & deferred
| ID | Item | Status |
|---|---|---|
| D-A1 | Cryptographic-agility note (pinned+swappable; Dilithium/SPHINCS+; rotation-as-op) in ADR 0001 or sibling | OPEN — doc-only, M1 close-out |
| D-01 | Key rotation (DIDDoc-update problem) | DEFERRED → M3 |
| D-02 | Recovery / encryption / ZKP / consensus / PQC impl / DID registries | DEFERRED per §3 |
| D-03 | Full compaction (Sedimentree) | DEFERRED; S-2 naive snapshot = only sanctioned toe |
| S-1 | Second OS-process BEAM node | OPTIONAL — effectively superseded by carrier spike |
| S-2 | Naive snapshot + re-reduction verification | OPTIONAL (only-if-green) |

## W — M2 open questions
| ID | Question | Lean | Status |
|---|---|---|---|
| W-01 | Canonical CBOR wire schema (ops + delegations); atoms-vs-binaries pinned | ADR-P08 | OPEN |
| W-02 | Carrier selection (JS client / AtomVM–Popcorn / filtered dist) | ADR-P09; evidence-decided | OPEN |
| W-03 | Heartbeats from carrier liveness (closes ADR 0004 caveat) | ADR-P10 | OPEN |
| W-04 | Frontier-diff sync (Beelay-style) | oracle-gated optimization; after W-01 | OPEN |
| W-05 | Browser log persistence | `dump/restore` contract onto browser storage; verify-on-restore | OPEN |

## R — research-gated (human-owned; must not block engineering)
| ID | Question | Feeds |
|---|---|---|
| R-01 | Coordinator-free receipt-freeness: entropy role (threshold veil / ZK nullifier / equivocation) | M4 |
| R-02 | Strict-JCJ survival of local trapdoors (key surrender · over-the-shoulder · forced abstention) | M4 entry gate |
| R-03 | Composition: chameleon + DVP + LRS without interference | M4 |
| R-04 | Sybil vs anonymity tension (admission design) | M4/M5 |
| R-05 | Cardinality leaks at town scale (padding needed?) | M5 |
| R-06 | Federation seam composes or leaks (Kiayias–Yung; DVP non-transferability) | M6 |
