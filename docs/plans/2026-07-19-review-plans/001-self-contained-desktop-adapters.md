# Plan 001: Make desktop-installed adapters execute the bundled capture binary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update this plan's status row in
> `plans/README.md`, unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9801acf..HEAD -- cmd/firehosed/main.go cmd/firehose/main.go internal/adapters/opencode/plugin.go internal/adapters/opencode/opencode_test.go internal/cli/install.go internal/cli/doctor.go internal/cli/cli_test.go internal/daemon/endpoints.go internal/daemon/endpoints_test.go docs/adapters.md docs/contracts.md`
> If an in-scope file changed, compare the excerpts below with live code. A
> material mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / dx
- **Planned at**: commit `9801acf`, 2026-07-19

## Why this matters

The desktop bundles only `firehosed`, but its one-click Claude Code installer
writes `<firehosed> emit --source claude-code`; `firehosed` does not implement
`emit`. The OpenCode installer writes a plugin that invokes a separate
`firehose` binary from `PATH`, which a desktop-only user need not have. Both
installers can therefore report success while capturing no events. After this
plan, one stable bundled executable supports daemon and emit modes, and both
installed adapters use its absolute path without requiring shell `PATH` setup.

## Current state

- `apps/tauri-desktop/src-tauri/tauri.conf.json:36` bundles only
  `binaries/firehosed`.
- `internal/daemon/endpoints.go:91-103` passes `os.Executable()` to the Claude
  installer, but calls `InstallOpenCode` without an executable path.
- `cmd/firehosed/main.go:31-47` parses daemon flags only; `emit` is treated as an
  unexpected positional argument.
- `internal/adapters/opencode/plugin.go:17-25` contains:

  ```go
  const pluginJS = `...
        const proc = Bun.spawn(["firehose", "emit", "--source", "opencode"], {
  ...`
  ```

- `internal/cli/install.go:43` constructs Claude's command as
  `binPath + " emit --source claude-code"`; paths containing spaces are not
  quoted.
- `internal/cli/cli.go:94-142` is the canonical, testable `Emit` implementation.
  It routes to a reachable daemon and otherwise appends locally; reuse it.
- Command packages are intentionally thin. Follow `cmd/firehose/main.go:73-77`
  for flag parsing and delegate behavior to `internal/cli`.
- Tests use `t.TempDir`, table-free direct assertions, and real filesystem
  output; follow `internal/cli/cli_test.go:110-167`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused Go tests | `go test ./cmd/firehosed ./internal/adapters/opencode ./internal/cli ./internal/daemon` | exit 0 |
| Sidecar build | `scripts/build-sidecar.sh` | builds `apps/tauri-desktop/src-tauri/binaries/firehosed-<triple>` |
| Format check | `gofmt -l .` | no output |
| Vet | `go vet ./...` | exit 0 |
| Full tests | `go test ./...` | all packages pass |
| Binary build | `go build ./cmd/firehose ./cmd/firehosed` | exit 0 |

Do not install packages or run a live installer against the executor's real
home directory. Every install test must use `t.TempDir()`.

## Scope

**In scope** (the only files to modify):

- `cmd/firehosed/main.go`
- `cmd/firehosed/main_test.go` (create)
- `cmd/firehose/main.go`
- `internal/adapters/opencode/plugin.go`
- `internal/adapters/opencode/opencode_test.go`
- `internal/cli/install.go`
- `internal/cli/doctor.go`
- `internal/cli/cli_test.go`
- `internal/daemon/endpoints.go`
- `internal/daemon/endpoints_test.go`
- `docs/adapters.md`
- `docs/contracts.md`

**Out of scope**:

- Do not bundle a second `firehose` sidecar or change Tauri packaging.
- Do not optimize the OpenCode process-per-event behavior; that is a separate
  audited finding.
- Do not change event, spool, export, privacy, or HTTP JSON shapes.
- Do not touch `apps/tauri-desktop/src/orbit/**`, `src/styles.css`, or
  `src/ui/orbit.ts`; they contain pre-existing user work.

## Git workflow

- Suggested branch: `advisor/001-self-contained-desktop-adapters`
- Use logical conventional commits, matching history such as
  `feat(desktop): ...` and `test(daemon): ...`.
- Do not push or open a PR unless instructed by the operator.

## Steps

### Step 1: Add failing executable-path contract tests

Update the OpenCode plugin tests to require `WritePlugin` to accept an explicit
capture executable path. Use a path containing spaces and assert the generated
JavaScript passes an argv array equivalent to:

```text
[<exact path>, "emit", "--source", "opencode"]
```

The test must also cover backslashes/quotes via JSON-safe rendering; do not
interpolate an executable into JavaScript source manually. Update CLI installer
tests so both Claude and OpenCode preserve an explicit executable path and
remain idempotent.

Add a failing `cmd/firehosed/main_test.go` test around a small testable emit
dispatcher. Configure a temporary home with `daemon_addr` set to an unused
loopback port, feed one generic event on stdin, invoke the equivalent of
`firehosed emit --source generic`, and assert exactly one normalized event is
written to that temporary spool.

**Verify**: `go test ./cmd/firehosed ./internal/adapters/opencode ./internal/cli` →
the new tests fail for the missing behavior, while unrelated tests still pass.

### Step 2: Render the OpenCode plugin from an explicit executable

Change `opencode.WritePlugin` to accept `binPath string`. Render the Bun argv
array with `encoding/json` so spaces, quotes, and Windows backslashes remain one
argument. Propagate the new argument through `cli.InstallOpenCode(home,
binPath)`. Preserve the plugin's silent `try/catch` behavior and do not add a
dependency.

Also make Claude's shell command quote an absolute executable path as one
argument. Use a small platform-specific stdlib helper: POSIX shells should use
single-quote escaping (including the standard close/escaped-quote/reopen form
for an embedded apostrophe), while Windows should use a double-quoted executable
path and reject an impossible embedded quote instead of generating an unsafe
command. Keep a bare command such as the exceptional `firehose` fallback bare.
Make the quoting helper testable for both platform families without changing
the process-wide `runtime.GOOS` in tests.

Update `cmd/firehose` to pass its own `os.Executable()` result when installing
OpenCode, matching its Claude path. A failure to resolve the path may fall back
to the literal `firehose` command for the standalone CLI only.

**Verify**: `go test ./internal/adapters/opencode ./internal/cli` → all pass,
including exact-path, cross-platform quoting, and idempotency assertions.

### Step 3: Give `firehosed` a tested emit mode

Before daemon flag parsing, recognize the `emit` subcommand and parse the same
`--source` flag/default as `cmd/firehose`. Delegate to `cli.Emit`; do not copy
normalization or spool logic. Factor only enough dispatch into a helper that a
unit test can invoke with a supplied home, args, and reader. Normal daemon and
`--version` behavior must remain unchanged.

The capture path must retain the existing daemon-optional behavior: if the
daemon is down, `cli.Emit` writes locally. Do not introduce network access
beyond the configured local daemon.

**Verify**: `go test ./cmd/firehosed` → emit-mode test passes and writes exactly
one event.

### Step 4: Install both desktop adapters against the daemon executable

In `handleInstall`, resolve the running executable once and pass the same path
to `InstallClaudeCode` and `InstallOpenCode`. Keep the existing fallback only
for the exceptional `os.Executable` error. Strengthen endpoint tests to inspect
both generated files and assert that neither desktop-installed adapter contains
a bare `firehose` PATH dependency.

Where production-path injection is needed for deterministic endpoint tests,
add a small unexported executable-path field or resolver on `Server`; initialize
it in `New`, and override it only from same-package tests. Do not add a public
API solely for testing.

**Verify**: `go test ./internal/daemon` → install endpoint tests pass for Claude,
OpenCode, unknown adapters, and an executable path containing spaces.

### Step 5: Make doctor and documentation verify the real contract

Keep doctor read-only. Strengthen its adapter checks so a file's mere existence
does not count as healthy: Claude must contain an `emit --source claude-code`
command and OpenCode must contain an argv-based `emit --source opencode`
forwarder. Do not execute hooks or plugins from doctor.

Update `docs/adapters.md` and the source-adapter rows in `docs/contracts.md` to
say that desktop installation targets its bundled capture executable, while
standalone CLI installation targets the installed `firehose` executable. Remove
the statement that desktop OpenCode requires `firehose` on `PATH`.

**Verify**: `go test ./internal/cli && rg -n "needs.*firehose.*PATH|binary must be on OpenCode's PATH" docs` → tests pass and the search returns no stale desktop requirement.

### Step 6: Run the full repository gate

Run the commands in the required order. The sidecar build is a packaging smoke
test; do not add its generated binary to git.

**Verify**:

```sh
gofmt -l .
go vet ./...
go test ./...
go build ./cmd/firehose ./cmd/firehosed
scripts/build-sidecar.sh
git status --short
```

Expected: the first command prints nothing; all commands exit 0; status contains
only the scoped source/docs files plus any pre-existing Orbit changes, and no
sidecar binary is staged.

## Test plan

- `cmd/firehosed/main_test.go`: emit subcommand parses `--source`, calls the
  canonical emit path, and falls back to a temporary local spool.
- `internal/adapters/opencode/opencode_test.go`: exact executable argv survives
  spaces and escaping.
- `internal/cli/cli_test.go`: both installers are idempotent and preserve the
  selected executable.
- `internal/daemon/endpoints_test.go`: desktop endpoint-generated Claude and
  OpenCode configurations reference the same injected executable.
- Existing daemon, CLI, adapter, sidecar, and full Go gates remain green.

## Done criteria

- [ ] The bundled `firehosed` accepts `emit --source <source>`.
- [ ] Desktop-installed Claude and OpenCode configurations use the running
      sidecar's absolute path.
- [ ] An OpenCode desktop install has no bare `firehose` PATH dependency.
- [ ] Paths with spaces/backslashes are represented safely.
- [ ] Doctor rejects malformed placeholder wiring without executing it.
- [ ] No second sidecar binary or dependency is added.
- [ ] `gofmt -l .`, `go vet ./...`, `go test ./...`, and both Go builds pass.
- [ ] No files outside scope are newly modified.
- [ ] The row in `plans/README.md` is updated.

## STOP conditions

- The packaged sidecar's `os.Executable()` is not a stable path after app exit
  on any supported OS; report the platform evidence before designing a copy.
- Claude Code's supported hook command format cannot safely invoke a quoted
  absolute path on a supported OS; do not invent platform-specific quoting.
- OpenCode/Bun no longer accepts an argv array for `Bun.spawn`; capture a real
  current plugin payload/API example and report it.
- Correctness appears to require adding a second bundled executable or changing
  a frozen event/API shape.
- Any step requires touching the dirty Orbit files.

## Maintenance notes

Reviewers should test both standalone CLI installation and desktop endpoint
installation: they intentionally select different binaries but share one emit
contract. If a future adapter is installed by the daemon, its generated command
must likewise receive the daemon's explicit executable path rather than assume
`PATH`.
