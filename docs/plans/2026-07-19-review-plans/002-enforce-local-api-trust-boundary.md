# Plan 002: Enforce the daemon's localhost-only trust boundary

> **Executor instructions**: Follow every step and verification gate. Stop on
> any condition listed below; do not broaden the API or invent authentication.
> When complete, update this plan's row in `plans/README.md` unless a reviewer
> owns the index.
>
> **Drift check (run first)**:
> `git diff --stat 9801acf..HEAD -- internal/cli/cli.go internal/cli/cli_test.go internal/cli/status.go internal/cli/daemonroute_test.go internal/daemon/daemon.go internal/daemon/daemon_test.go docs/contracts.md`
> Material drift in these paths is a STOP condition until reconciled.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9801acf`, 2026-07-19

## Why this matters

The documented API is localhost-only and tokenless. Today the daemon can bind
to wildcard/non-loopback addresses, emitters accept arbitrary daemon addresses,
and the CORS middleware merely withholds response headers while still executing
requests from hostile browser origins. A website can issue simple mutating
POSTs, and a bad config can transmit raw source payloads before privacy
redaction. This plan restores the written trust boundary without adding a
network service, account, token, or cloud dependency.

## Current state

- `docs/contracts.md:87-91` says the API is localhost-only and must be hardened
  before binding beyond loopback.
- `internal/daemon/daemon.go:80-95` calls the handler even when `Origin` is
  nonempty and not allowlisted.
- `internal/daemon/daemon.go:122-127` passes any address directly to
  `net.Listen`.
- `internal/cli/cli.go:55-66` accepts any configured `daemon_addr`.
- `internal/cli/cli.go:97-109` reads raw input and posts it to that address
  before normalization/privacy fallback.
- `internal/daemon/daemon_test.go:84-109` checks only that a hostile origin gets
  no `Access-Control-Allow-Origin`; it does not require rejection or prove a
  mutating handler was not invoked.
- The project uses the standard library and table-driven/direct Go tests; add no
  dependency. Capture paths must fall back locally rather than break an agent.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Focused security tests | `go test ./internal/cli ./internal/daemon` | exit 0 |
| Race check | `go test -race ./internal/cli ./internal/daemon` | exit 0 |
| Format check | `gofmt -l .` | no output |
| Vet | `go vet ./...` | exit 0 |
| Full suite | `go test ./...` | all pass |

## Scope

**In scope**:

- `internal/cli/cli.go`
- `internal/cli/cli_test.go`
- `internal/cli/status.go`
- `internal/cli/daemonroute_test.go`
- `internal/daemon/daemon.go`
- `internal/daemon/daemon_test.go`
- `docs/contracts.md`

**Out of scope**:

- Do not add bearer tokens, users, TLS, remote access, or a proxy mode.
- Do not add general request-size/rate/subscriber limits; those are separately
  audited.
- Do not change endpoint JSON bodies, event schemas, or privacy modes.
- Do not change the desktop's fixed endpoint-discovery architecture.
- Do not touch the dirty Orbit files.

## Git workflow

- Suggested branch: `advisor/002-local-api-trust-boundary`
- Prefer a test commit followed by one security-fix commit, using the repo's
  conventional style.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Characterize loopback-only addresses with failing tests

Add a single standard-library helper in `internal/cli` that parses a daemon
`host:port` and reports whether its host is an IP literal for which
`net.IP.IsLoopback()` is true. Require a numeric port accepted by
`net.SplitHostPort`. Test these cases:

- accept `127.0.0.1:4517`, another `127/8` address, and `[::1]:4517`;
- reject `0.0.0.0:4517`, `[::]:4517`, `:4517`, private/LAN and public IPs;
- reject DNS names, including `localhost`, to avoid DNS/hosts-file ambiguity;
- treat empty address only as "do not proxy" for capture clients; it is not a
  valid daemon listen address.

Add failing tests that `SaveConfig` rejects a nonempty non-loopback
`daemon_addr` and does not write it.

**Verify**: `go test ./internal/cli` → new tests fail before implementation.

### Step 2: Prevent raw emit egress while preserving local fallback

Before constructing an HTTP client in `cli.Emit`, validate `DaemonAddr`. If it
is empty or invalid, skip the network attempt and call `EmitLocal` with the raw
payload. Do not return an address-validation error from this capture path: the
agent must continue and the event must stay local.

Make `SaveConfig` reject nonempty invalid addresses. For an already-existing
bad config file, `LoadConfig` must not enable egress or make hook capture fail.
Use the safe default loopback address at runtime (without silently rewriting
the file) and cover this migration behavior with a test. Add a doctor/config
detail only if it can be done within existing return shapes; do not widen scope.

Validate `daemon_addr` explicitly in `handleConfigUpdate` before acquiring the
config lock, and return HTTP 400 for an invalid patch. Do not let the generic
`SaveConfig` error path turn this caller error into HTTP 500.

Update `Status` so it never probes a non-loopback configured host. Add a test
server bound to a loopback ephemeral port for the accepted route and a custom
HTTP server/counter proving an invalid address is never contacted.

**Verify**: `go test ./internal/cli` → all config, emit fallback, and status
tests pass; the invalid-address server receives zero requests.

### Step 3: Refuse non-loopback daemon listeners

Validate the requested address before `net.Listen` and before `Server.Start`
launches capture goroutines. `Server.Serve` must also defend itself because
tests and callers use it directly. Return a clear error naming the rejected
address without binding any socket.

Add tests for wildcard, LAN, and IPv6-any rejection plus loopback ephemeral-port
success. Keep `127.0.0.1:0` available for tests. Do not resolve hostnames.

**Verify**: `go test ./internal/daemon -run 'Test(Run|Serve).*Loopback'` → all
new listener tests pass and no rejected listener is created.

### Step 4: Reject hostile browser origins before dispatch

Change the CORS wrapper so:

- requests with no `Origin` remain available to Go CLI/TUI and local tools;
- allowlisted Tauri/Vite origins retain GET, POST, and preflight behavior;
- any nonempty origin outside the allowlist receives HTTP 403 and the wrapped
  handler is never called, for both simple requests and preflights;
- `Vary: Origin` is set consistently for origin-bearing requests.

Strengthen `TestCORSAllowsDesktopShellOnly`: expect 403, not merely absent ACAO.
Add a hostile `POST /config` or `POST /install/claude-code` test using a
temporary home and prove the target file/config remains unchanged. Also retain
a no-Origin POST test to protect non-browser clients.

**Verify**: `go test ./internal/daemon -run CORS` → allowed origins work,
hostile origins are 403, and mutation assertions pass.

### Step 5: Document this as enforcement of the existing frozen contract

Update `docs/contracts.md` to state explicitly:

- daemon listeners and configured daemon clients accept loopback IP literals
  only;
- no-Origin local native clients are accepted;
- nonempty non-allowlisted browser origins are rejected with 403 before route
  handling.

This is a correction to match the existing localhost-only contract, not a new
remote-auth feature. Do not bump `schema_version`. If a supported documented
client is found to require remote binding or another origin, stop instead.

**Verify**: `rg -n "loopback|403|non-allowlisted" docs/contracts.md` → the three
rules are present.

### Step 6: Run security and repository gates

**Verify**:

```sh
gofmt -l .
go vet ./...
go test -race ./internal/cli ./internal/daemon
go test ./...
git status --short
```

Expected: formatting output is empty, all commands exit 0, and no new file
outside scope is modified.

## Test plan

- Address validator matrix for IPv4/IPv6 loopback and all rejection classes.
- Existing invalid config never causes HTTP egress and still spools locally.
- Save/config endpoint rejects new invalid addresses.
- `Serve`/`Run` reject wildcard/non-loopback before starting.
- Hostile-origin GET and mutating POST receive 403; wrapped side effects do not
  occur.
- Allowlisted webviews and no-Origin native clients remain green.

## Done criteria

- [ ] Raw adapter input can only be posted to a loopback IP literal.
- [ ] Invalid existing configuration falls back safely without losing capture.
- [ ] The daemon cannot bind wildcard, LAN, or public interfaces.
- [ ] Disallowed browser origins receive 403 before route handling.
- [ ] Existing Tauri/Vite origins and no-Origin clients still work.
- [ ] No auth, cloud, TLS, or third-party dependency is introduced.
- [ ] Go format, vet, race, and full test gates pass.
- [ ] The index status row is updated.

## STOP conditions

- A documented/supported production mode intentionally binds beyond loopback.
- A supported desktop webview uses an origin not present in the current
  allowlist; report the exact runtime origin before changing the list.
- Safe migration of an existing invalid config would require hook commands to
  exit nonzero or drop the event.
- The change appears to alter an existing valid client's response shape or
  requires a frozen API/schema migration.

## Maintenance notes

Keep the address validator at every egress/listen boundary even after config
validation; config files are user-editable and programmatic callers can build a
`Config` directly. Any future remote-access feature requires a separate threat
model and authentication design, not a relaxation of this helper.
