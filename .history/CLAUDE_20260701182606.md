# CLAUDE.md — Lattice

Least-authority process plane on the BEAM (V1, proven) + durable self-certifying Replica substrate (2.0). Core thesis: zero implicit authority; the log is the truth; the connection is the cache.

**State:** branch `claude/beautiful-gould-6b25d2` — M1 (Lattice 2.0 core) is GREEN: all 19 behaviors, 9 properties/67 tests across seeds 1/7/99/555/2024/12345, demo narrates. Current work: M1 close-out (countersign, D-A1 agility note, merge proposal) and M2 (carrier) per `docs/agent/register.md` W-series.

**Before any work: read `docs/agent/HANDOFF.md`; confirm `docs/agent/reconciliation_report.md` §5 is countersigned for your tree.**

## Commands
```
mix deps.get
mix format --check-formatted
mix test                              # expect 0 failures, 0 skipped
mix run scripts/lattice2_demo.exs     # 2.0 narrated demo (also: elixir scripts/lattice2_demo.exs)
scripts/lattice_poc_demo.sh           # V1 demo
mix lattice.stress --tabs 500 --caps 2000 --calls 50000 --bridges 1000
npm install && npm run browser:e2e    # Playwright evidence
mix lattice.browser_carrier.proof     # carrier spike proof artifact
```
Validation loop (never weaken without human sign-off): `mix format` → `mix test` → `mix run scripts/lattice2_demo.exs`. Carrier work adds the conformance oracle: real carrier ≡ `Lattice.Sim` final logs/state for the same op set.

## Hard rules
- Toolchain: Elixir on **OTP 28** (ADR 0001 verifies `:deterministic` there). Core = plain OTP. Dep whitelist: `cowboy`, `jason` (boundary), `stream_data` (test), `@playwright/test` (e2e). **New dep = escalate.**
- DO NOT IMPLEMENT (full list HANDOFF §3): encryption, key rotation, recovery, ZKP/accumulators, consensus, receipt-freeness machinery, full compaction, PQC code, DID registries, federation. Seeming necessary → question the requirement, escalate.
- Canonical encoding is ADR 0001's pinned `term_to_binary [:deterministic, minor_version: 2]`; the CBOR migration is ADR-P08 — an ADR'd migration with golden vectors, never a hot swap.
- No wall clocks in semantics (`Lattice.Clock` only; ticks in op bodies — invariant 5). No folds over bare maps in reduce/merge/authority paths.
- All authority verdicts flow through `Authority.analyze/2`; `Live.authorize/2` consults the same in-log revokes. No second path.
- Non-holder writes to authoritative fields use the inbox `:request` pattern (behavior 6). Do not rebind v1 facade names (`Lattice.call/grant/cast`).
- Tests are the spec: failing test first; never edit expectations to match code; no `@tag :skip`/pending. Property generators are never narrowed.
- Every merge appends a status-doc line (`docs/agent/status_protocol.md`); failing seeds logged with shrunk case before the fix. Commits name the behavior/ADR (`B16: …` / `ADR-P08: …`). Merges to `main` are human-approved.

## Escalate to the human when
Crypto choices/deviations · new deps · reinterpreting a behavior's meaning · anything touching `author`/identity/rotation · coordinator-shaped singletons · a boundary item seeming necessary · weakening a property/generator · a seed-fix that would change a ratified ADR · two consecutive failed gate attempts · any merge/publish to `main`.

## Vocabulary
Use HANDOFF §10 verbatim (op, deps, Replica, materialization, reduction, holder, delegation, Cap, quarantine reasons, tick, heartbeat, frontier, oracle). No synonyms.
