# Plan 003: Enforce balanced privacy recursively without mutating events

> **Executor instructions**: Run the drift check and every verification gate.
> Do not change minimal/full semantics or adapter payload shapes. Update the
> status row in `plans/README.md` when complete unless a reviewer owns it.
>
> **Drift check (run first)**:
> `git diff --stat 9801acf..HEAD -- internal/privacy/privacy.go internal/privacy/privacy_test.go docs/contracts.md README.md`
> Reconcile any material mismatch before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security / bug
- **Planned at**: commit `9801acf`, 2026-07-19

## Why this matters

Balanced mode is the default and promises bounded string payloads before
persistence or broadcast. Its implementation truncates only top-level strings;
nested Claude `tool_input`/`tool_response`, OpenCode properties, and generic
arrays/maps remain verbatim. This can retain secrets and large content while
the user believes balanced privacy is active. The fix must recursively copy and
truncate JSON-compatible containers while leaving the original event untouched.

## Current state

- `internal/privacy/privacy.go:38-53` allocates a new top-level payload map.
- `internal/privacy/privacy.go:56-65` returns any non-string value unchanged:

  ```go
  func truncateValue(v any) any {
      s, ok := v.(string)
      if !ok {
          return v
      }
      // truncate to balancedMaxRunes
  }
  ```

- `internal/adapters/claudecode/claudecode.go:80-83` places nested maps/response
  values under `tool_input` and `tool_response`.
- `internal/adapters/opencode/opencode.go:33-49` stores the entire decoded
  `properties` map as payload.
- `docs/contracts.md:35-44` freezes privacy-before-persistence and balanced
  truncation at 240 runes plus an ellipsis.
- Existing tests at `internal/privacy/privacy_test.go:47-99` cover only a
  top-level string and shallow non-mutation.
- Payloads at this boundary are JSON-compatible: `map[string]any`, `[]any`,
  strings, numbers, booleans, and nil. Prefer explicit type switches over
  reflection or a new dependency.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused tests | `go test ./internal/privacy` | exit 0 |
| Capture integration | `go test ./internal/cli ./internal/daemon` | exit 0 |
| Race check | `go test -race ./internal/privacy ./internal/cli ./internal/daemon` | exit 0 |
| Format check | `gofmt -l .` | no output |
| Vet | `go vet ./...` | exit 0 |
| Full suite | `go test ./...` | all pass |

## Scope

**In scope**:

- `internal/privacy/privacy.go`
- `internal/privacy/privacy_test.go`
- `docs/contracts.md`
- `README.md`

**Out of scope**:

- Do not change `minimal` digest structure or solve minimal-mode artifact
  semantics in this plan.
- Do not truncate metadata fields such as `summary`, `cwd`, IDs, or repo.
- Do not change adapters; redaction belongs at the engine boundary.
- Do not introduce schema/export/spool version changes.
- Do not touch dirty Orbit files.

## Git workflow

- Suggested branch: `advisor/003-recursive-balanced-privacy`
- Use a failing-test commit followed by a focused privacy fix/docs commit.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add nested regression tests first

Extend `privacy_test.go` with a balanced payload containing:

- a long string inside nested `map[string]any` values;
- a long string inside an `[]any`, including a map nested inside that array;
- short strings, numbers, booleans, and nil;
- the same map or slice referenced from the original event for mutation checks;
- Unicode content longer than 240 runes to prove rune, not byte, truncation.

Assert every nested long string becomes exactly 240 original runes plus `…`,
all other JSON scalar values retain type/value, and no map/slice in the original
event changes. Also assert the redacted nested maps/slices do not alias the
original by modifying the result after `Redact` and rechecking the input.

Retain explicit tests proving full mode remains verbatim and minimal mode keeps
its existing top-level digest contract.

**Verify**: `go test ./internal/privacy` → new nested balanced tests fail before
implementation.

### Step 2: Recursively copy JSON-compatible values in balanced mode

Replace the shallow `truncateValue` behavior with a helper that returns:

- truncated copies for strings longer than `balancedMaxRunes`;
- newly allocated maps whose values are recursively processed;
- newly allocated slices whose elements are recursively processed;
- unchanged scalar values for numbers, booleans, and nil.

Do not truncate map keys: they are payload field names. Do not mutate or reuse
nested container storage from the input. Keep the existing ellipsis and rune
limit. Handle nil maps/slices without turning them into surprising non-nil
values when feasible.

Only JSON-compatible container forms produced by `encoding/json` are required.
Do not use reflection to recursively traverse arbitrary structs/pointers, and
do not marshal/unmarshal as a cloning shortcut.

**Verify**: `go test ./internal/privacy` → all privacy tests pass.

### Step 3: Prove both persistence paths use the corrected boundary

Existing `cli.EmitLocal` and daemon Codex broadcast tests already call
`privacy.Redact`. Add the smallest integration assertion necessary—prefer
extending an existing CLI or daemon test—to pass one nested payload through an
actual balanced capture boundary and verify no persisted/broadcast nested
string exceeds 241 runes including ellipsis.

Do not add invented adapter fixture shapes. If using an adapter fixture, use an
existing real captured Claude/OpenCode payload from its current tests; otherwise
use the generic event envelope path.

**Verify**: `go test ./internal/cli ./internal/daemon` → integration assertion
and all existing tests pass.

### Step 4: Clarify the existing privacy contract

Update the balanced row in `docs/contracts.md` and the README privacy summary to
state that string values are truncated recursively at any payload depth. This
is enforcement of the existing bounded-payload intent. Do not bump
`schema_version` or change the other modes.

**Verify**: `rg -n "recurs|any depth|nested" docs/contracts.md README.md` → both
user-facing documents make the depth rule unambiguous.

### Step 5: Run the complete gate

**Verify**:

```sh
gofmt -l .
go vet ./...
go test -race ./internal/privacy ./internal/cli ./internal/daemon
go test ./...
git status --short
```

Expected: no formatting output, all commands exit 0, and only scoped files plus
pre-existing user changes appear.

## Test plan

- Nested map, array, map-in-array, Unicode, nil, and short-scalar cases.
- Deep non-aliasing: changing result containers cannot change the input.
- Existing full/minimal behavior remains exact.
- One actual capture-boundary test proves nested content is bounded before
  persistence or direct Codex broadcast.

## Done criteria

- [ ] No balanced-mode string at any JSON payload depth exceeds 241 runes,
      including the ellipsis.
- [ ] Balanced redaction deep-copies maps and arrays and never mutates input.
- [ ] Full and minimal behavior remains unchanged.
- [ ] Adapter code and envelope schema remain untouched.
- [ ] Contract and README explain recursive behavior.
- [ ] Format, vet, race, focused, and full tests pass.
- [ ] The index status row is updated.

## STOP conditions

- A live adapter places non-JSON cyclic structures in `Payload`; report the
  exact type/path rather than adding reflection or cycle detection casually.
- Maintainer evidence says nested strings were intentionally exempt from the
  frozen balanced privacy contract. That would require an explicit contract
  decision before changing semantics.
- Correctness requires changing minimal/full modes, metadata fields, or an
  event/spool/export version.

## Maintenance notes

Every future adapter should continue to emit full-fidelity structured payloads;
privacy remains centralized here. Review new container types at this boundary:
if an adapter starts inserting typed slices/maps rather than JSON-compatible
values, add an explicit conversion or test instead of silently bypassing
redaction.

