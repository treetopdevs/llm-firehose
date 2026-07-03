# Review Rubric — run on every PR
A reviewer agent answers each item YES/NO with evidence (file:line or transcript ref). Any NO without an ADR/escalation ref blocks merge.

## Mapping & spec
1. Commit/PR title names the behavior (`B__:`) or ADR (`ADR-___:`).
2. Behavior tests existed and failed first (test commit precedes/accompanies; no expectation edits per AP-06).
3. No numbered behavior's *meaning* changed without escalation ref.

## Mechanical greps (must be clean or justified)
4. `grep -rn "System\.system_time\|DateTime\.\|:os\.system_time" apps/lattice_core/lib/lattice` → none in semantics paths (AP-03).
5. `grep -rn "term_to_binary" apps` → only the ADR 0001 canonical-encoding site(s) (AP-01).
6. New `Enum`/`for` over map-typed enumerables in reduce/crdt/authority → canonically ordered (AP-02).
7. `git diff mix.exs package.json` → no new deps without escalation ref (§3 whitelist).
8. Holder/quarantine/revoke logic only in `authority.ex` (+`live.ex` consult) (AP-07).
9. `Lattice` facade unchanged or non-clashing (AP-12).

## Loop & trail
10. Full loop transcript attached: `mix format` clean · `mix test` 0 failures, **0 skipped/pending** · `mix run scripts/lattice2_demo.exs` narrates.
11. Property suite untouched or strengthened; generators not narrowed (V-04 guard; §5.3).
12. New failing seed? → status-doc entry with seed + shrunk case precedes the fix.
13. Status-doc line appended (`status_protocol.md` format).
14. Docs updated in-PR if design/threat-model/path_to_real invalidated.

## Carrier work only
15. Conformance-oracle run attached: real carrier final logs/state ≡ `Lattice.Sim` for the same op set (V-03 guard).
16. Dist filter remains fail-closed; hostile-shape tests still red-team green; no Gateway bypass (AP-08).
