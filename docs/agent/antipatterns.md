# Anti-Pattern Registry
Each entry: symptom → detection → fix. Reviewer agents run the detection column mechanically (see review_rubric.md).

**AP-01 · Wire-schema drift.** Symptom: an op re-serialized on another runtime (or after an atom/binary change) hashes differently; `:post` vs "post". Detection: any encoding change without golden vectors; any new atom in op bodies without schema note. Fix: ADR 0001's caveats are the spec; W-01/ADR-P08 closes with positional CBOR + committed golden vectors + dual-encode equivalence tests. The *pinned* `term_to_binary` is not the defect — unpinned drift is.

**AP-02 · Map-order nondeterminism.** Symptom: fold over a bare map in reduce/merge/audit paths. Detection: `grep -rn "Enum\.\(map\|reduce\|each\)\|for .*<-" lib/lattice/{reduce,crdt,authority}*` and review any map-typed enumerable. Fix: iterate canonically-ordered structures (topo order, sorted keys). Property (c) is the alarm, not the excuse.

**AP-03 · Wall-clock in semantics.** Symptom: `System.system_time`, `DateTime`, `Process.sleep`-as-meaning in core paths. Detection: grep those tokens outside tests/demo narration. Fix: `Lattice.Clock`; ticks live in op bodies (invariant 5).

**AP-04 · Coordinator creep.** Symptom: a singleton all realms must reach for correctness. Detection: new globally-registered core process; correctness argument mentioning "the" server. Fix: per-replica or deps-decidable form; else escalate (I-04).

**AP-05 · Boundary erosion.** Symptom: "just for the demo" encryption/rotation/consensus. Detection: §3 list vs diff. Fix: question the requirement; status-doc the pressure; escalate.

**AP-06 · Test bent to code.** Symptom: behavior test edited in the same PR as the code it now passes. Detection: diff touches `test/lattice2/*` expectations + lib together without an ADR. Fix: tests are the spec; meaning-changes escalate.

**AP-07 · Second authority path.** Symptom: quarantine/holder logic outside `Authority.analyze/2`; a helper re-deriving holders. Detection: grep `holder\|quarantine\|revok` outside authority.ex/live.ex. Fix: one analysis pipeline; `Live.authorize/2` consults the same in-log revokes.

**AP-08 · Carrier bypass.** Symptom: carrier code sending to pids/registered names directly, or reading `Net` internals. Detection: spike rule — everything routes `Lattice.call/3` / Gateway; dist filter stays fail-closed. Fix: keep the seam; oracle run on every carrier PR.

**AP-09 · Improvised key rotation.** Symptom: rotation "sketched in" under deadline. Detection: any write path touching `Identity`/author semantics. Fix: D-01 is M3; write the pressure down.

**AP-10 · Per-call-site queue semantics.** Symptom: a non-holder mutating authoritative state via a bespoke path. Detection: authoritative writes not via holder command or inbox `:request`. Fix: behavior 6's pattern is the one rule.

**AP-11 · Pre-seeded-accumulator traversal.** Symptom: graph traversal seeds the visited set with the frontier and never explores its deps (the real `Dag.reachable/2` bug, caught by time travel). Detection: traversal code where init acc ⊇ start nodes. Fix: tests that start from non-trivial frontiers and assert slice sizes.

**AP-12 · Facade name-clash.** Symptom: rebinding v1 `Lattice.call/grant/cast` for 2.0 semantics. Detection: diff on the `Lattice` facade. Fix: 2.0 verbs via `Lattice.Registry` and the non-clashing facade names (`materialize`, `send_durable`, `await`, `state_at`, `go_dormant`, `tombstone`, `monitor`).
