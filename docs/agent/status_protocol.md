# Status-Doc Protocol (the falsifiability trail)
File: `docs/lattice_poc_status.md`. Append-only per merged change; never rewrite history.

Line format:
`YYYY-MM-DD · <milestone/phase> · behaviors: <ids or —> · tests: <added/changed files> · seeds: <new failing seeds or —> · ADRs: <refs or —> · note: <one clause>`

Rules:
1. Failing property seed → entry with the seed **and the shrunk counterexample**, committed *before* the fix lands.
2. Boundary pressure (§3 item looked necessary) → entry naming the pressure and the in-scope alternative chosen.
3. ADR ratification (proposed → docs/adr/NNNN) → entry linking the first depending test.
4. Countersign events (§0) → entry with loop transcript ref.
5. Milestone close-out → entry mirroring the gate checklist, item by item.
