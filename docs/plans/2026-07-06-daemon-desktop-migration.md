# Daemon + Desktop Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement every remaining part of [docs/agent-firehose-migration-plan.md](../agent-firehose-migration-plan.md): complete the Phase 1 daemon API, add the Phase 2 derived index, ship the Phase 3 Tauri desktop shell with the Go daemon as a bundled sidecar, and produce the Phase 4/5 decision-gate documents.

**Architecture:** The Go engine stays the capture core (adapters → normalize → redact → NDJSON spool). The daemon (`internal/daemon`) is the single API boundary; clients (TUI, CLI, Tauri) consume `127.0.0.1:4517`. New: an in-memory derived index (rebuilt from spool at startup, updated incrementally from the live pipeline) accelerates session/trace/artifact queries; a Tauri v2 app (`apps/tauri-desktop`) renders live feed / sessions / detail / doctor / settings and spawns the daemon as a sidecar when none is running.

**Tech Stack:** Go 1.26 (stdlib only — no new Go deps), Tauri v2 + Rust (std only in shell code + tauri plugins), Vite + vanilla TypeScript frontend (vitest for logic tests), GitHub Actions for cross-platform packaging.

---

## Current state (verified 2026-07-06, `main` @ 7c4d1cf)

| Migration-plan part | Status |
|---|---|
| Phase 0 — contract freeze (`contracts.md`, `event.schema.json`, `schema_version`, `export_version`, privacy + adapter contracts) | **DONE** |
| Phase 1 — daemon + API (`/health /config /events /events/stream POST /events POST /emit /sessions /sessions/{id} /doctor POST /export`), CLI daemon routing, TUI daemon-first feed, `firehose status` | **DONE** |
| Phase 1 — remaining suggested API: `POST /config`, `GET /traces/{id}`, `GET /artifacts/files`, `POST /install/{adapter}`; dedicated daemon binary name | **TODO (Tasks 1–6)** |
| Immediate task 3 — stable trace identifiers | **TODO (Task 2)** |
| Phase 2 — derived index (sessions/traces/files/time-ranges), rebuild on startup | **TODO (Tasks 7–8)** |
| Phase 3 — Tauri shell, sidecar bundling, onboarding/settings/doctor UX, packaging | **TODO (Tasks 9–14)** |
| Phase 4 — keep/replace decision framework | **TODO (Task 15)** |
| Phase 5 — Phoenix cloud control plane | **Design doc only (Task 16)** — implementation is gated by the migration plan's own anti-goals ("Adding cloud sync before local desktop usage is solid") |
| Docs/README/contract updates | **TODO (Task 17)** |

## Planned deviations from the migration plan (with rationale)

1. **Repo strategy:** the plan sketches `apps/go-daemon`, `apps/go-cli`, `packages/…`. Moving `cmd/`+`internal/` would churn the Go module for zero functional gain (anti-goal: rewriting before desktop UX exists). We keep the Go layout, add `apps/tauri-desktop/`, and keep contract docs in `docs/`. The monorepo spirit is preserved.
2. **Index storage:** the plan allows bbolt/SQLite "only for desktop responsiveness". We start with an in-memory index rebuilt from the spool at startup (always-correct "rebuild if missing or corrupt" for free, zero new deps). Sessions/traces/artifacts summaries live in RAM; per-session event reads use the index's day-file time ranges so they no longer scan the whole spool. If real histories outgrow RAM, bbolt is the documented next step.
3. **Daemon binary:** plan suggests `firehosed`. We add `cmd/firehosed` as a thin main that runs the engine (same internals), used as the Tauri sidecar; `firehose daemon` remains for CLI users.
4. **Signing/notarization + updater keys** need human-held credentials. We deliver: unsigned local macOS bundle validation, a CI workflow for macOS/Windows/Linux artifacts, updater feed config documented in a release runbook, and the compatibility matrix. Actual cert enrollment is a human task (escalation noted in runbook).
5. **Phase 4 exit criteria** require *real beta usage*. Deliverable here is the written pain-review framework + measurement plan, ready to be filled after beta.

## Validation loop (run after every task)

```sh
gofmt -l .            # expect no output
go test ./...         # expect ok, 0 failures
```

Frontend tasks add: `pnpm -C apps/tauri-desktop test` and `pnpm -C apps/tauri-desktop build`.

---

## Part A — Complete the Phase 1 API surface

### Task 1: `POST /config` (persisted config updates)

**Files:**
- Modify: `internal/cli/cli.go` (add `SaveConfig`, config path helper)
- Modify: `internal/daemon/daemon.go` (route + handler, config mutex)
- Test: `internal/cli/cli_test.go`, `internal/daemon/daemon_test.go`

**Step 1: failing test — `SaveConfig` round-trips and validates privacy mode**

```go
func TestSaveConfigRoundTrip(t *testing.T) {
	home := t.TempDir()
	cfg, _ := LoadConfig(home)
	cfg.PrivacyMode = "minimal"
	if err := SaveConfig(home, cfg); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfig(home)
	if err != nil || got.PrivacyMode != "minimal" {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestSaveConfigRejectsBadMode(t *testing.T) {
	home := t.TempDir()
	cfg, _ := LoadConfig(home)
	cfg.PrivacyMode = "everything"
	if err := SaveConfig(home, cfg); err == nil {
		t.Fatal("want error for invalid privacy mode")
	}
}
```

**Step 2:** `go test ./internal/cli/` → FAIL (undefined `SaveConfig`).

**Step 3: implement.** `SaveConfig(home string, cfg Config) error`: validate `privacy.ParseMode(cfg.PrivacyMode)`, `os.MkdirAll(~/.agentfirehose, 0o755)`, write `config.json` (0o600, MarshalIndent).

**Step 4:** tests pass.

**Step 5: failing test — daemon `POST /config`** updates privacy mode live (subsequent `GET /config` reflects it; a config file appears in the daemon's home).

**Step 6: implement.** `mux.HandleFunc("POST /config", s.handleConfigUpdate)`. Handler: decode partial `cli.Config`; only `privacy_mode` is applied live (guard `s.cfg` with a `sync.RWMutex`; all reads of `s.cfg` in handlers/Start go through accessor). Other fields are persisted but answered with `{"restart_required": [...]}`. Persist via `cli.SaveConfig(s.home, merged)`. Reject invalid modes with 400.

**Step 7:** `gofmt -l . && go test ./...` → commit `feat(daemon): POST /config with live privacy-mode update (Phase 1)`.

### Task 2: `trace_id` in the envelope (immediate task 3)

**Files:**
- Modify: `internal/event/event.go` (`TraceID string \`json:"trace_id,omitempty"\``)
- Modify: `docs/event.schema.json` (optional `trace_id` string)
- Modify: `internal/adapters/generic/generic.go` if envelope fields are explicitly copied (verify passthrough)
- Test: `internal/event/event_test.go`, `internal/event/schema_doc_test.go`, `internal/adapters/generic/generic_test.go`

Adding an optional field is allowed without a version bump (contracts.md evolution rules). Failing test: generic NDJSON input with `trace_id` survives Parse→marshal. Schema-doc test keeps schema and struct in sync (follow the existing pattern in `schema_doc_test.go`). Commit: `feat(event): optional trace_id in envelope (Phase 1, immediate task 3)`.

### Task 3: `GET /traces/{id}`

**Files:**
- Modify: `internal/daemon/endpoints.go`, `internal/daemon/daemon.go` (route)
- Test: `internal/daemon/endpoints_test.go`

Failing test: spool three events, two sharing `trace_id: "tr1"` → `GET /traces/tr1` returns exactly those two, oldest first; unknown id → 404. Implement like `handleSessionByID` but filter `ev.TraceID`. Commit: `feat(daemon): GET /traces/{id} (Phase 1)`.

### Task 4: `GET /artifacts/files`

**Files:**
- Modify: `internal/daemon/endpoints.go` (+route)
- Test: `internal/daemon/endpoints_test.go`

Shape: `[{"path": "...", "events": N, "sources": ["claude-code"], "first_time": ..., "last_time": ...}]`, most-recently-touched first. Derive from `category == "file"` events: path from `payload.file_path` (claude-code), else `payload.path`, else skip (codex `changes` is a map keyed by path — include those keys; verify against `internal/adapters/codex/codex.go:128-140` fixture shape while writing the test). Commit: `feat(daemon): GET /artifacts/files (Phase 1)`.

### Task 5: `POST /install/{adapter}`

**Files:**
- Modify: `internal/daemon/endpoints.go` (+route)
- Test: `internal/daemon/endpoints_test.go`

Failing test: `POST /install/claude-code` against a temp home writes hooks into `home/.claude/settings.json` and returns `{"ok": true, "detail": ...}`; unknown adapter → 404. Reuse `cli.InstallClaudeCode(home, bin)` / `cli.InstallOpenCode(home)`; bin path from `os.Executable()`. Commit: `feat(daemon): POST /install/{adapter} (Phase 1)`.

### Task 6: `cmd/firehosed` daemon binary

**Files:**
- Create: `cmd/firehosed/main.go`
- Test: build-level (`go build ./...`); reuse `runDaemon` logic by moving it into `internal/daemon` (`daemon.Run(cfg, home, version, addr)`) so both mains stay thin.

`firehosed` = flags `--addr`, runs engine until SIGINT/SIGTERM. `firehose daemon` unchanged behavior. Commit: `feat: firehosed dedicated daemon binary (Phase 1 target shape)`.

---

## Part B — Phase 2: derived index

### Task 7: `internal/index` package

**Files:**
- Create: `internal/index/index.go`, `internal/index/index_test.go`

API:

```go
type Index struct { ... } // all methods safe for concurrent use

func New() *Index
func (ix *Index) Apply(ev event.Event)            // incremental update
func Build(dir string) (*Index, error)            // full rebuild from spool dir
func (ix *Index) Sessions() []Session             // most recent first
func (ix *Index) Session(id string) (Session, bool)
func (ix *Index) SessionDays(id string) []string  // YYYY-MM-DD day files containing the session
func (ix *Index) Traces() []Trace
func (ix *Index) TraceDays(id string) []string
func (ix *Index) Files() []FileArtifact           // most recently touched first
```

`Session` mirrors the daemon's current struct; `Trace` is `{ID, FirstTime, LastTime, Events}`; `FileArtifact` as in Task 4. `Apply` is a pure fold over one event — reuse the aggregation logic currently in `sessionsFromEvents` (move it here; daemon imports index). Day tracking: `ev.Time.UTC().Format("2006-01-02")` appended per session/trace when new. TDD: build-from-spool equals fold-of-Apply for the same events (that's the rebuildability contract from contracts.md). Include a corrupt-line case: unparseable spool lines are skipped (spool reader already does this — assert Build tolerates them). Commit: `feat(index): derived in-memory index over spool (Phase 2)`.

### Task 8: daemon uses the index

**Files:**
- Modify: `internal/daemon/daemon.go` (build index in `Start`, before watchers; apply events from the pipeline)
- Modify: `internal/daemon/endpoints.go` (`/sessions`, `/sessions/{id}`, `/traces/{id}`, `/artifacts/files` consult index; per-id reads only read the indexed day files)
- Modify: `internal/spool/spool.go` (add `ReadDays(dir string, days []string) ([]event.Event, error)`) 
- Test: `internal/daemon/endpoints_test.go` (existing tests keep passing — behavior identical), `internal/spool/spool_test.go`

Wiring rule: only **spooled** events index durable state. The tailer already replays the spool from the pipeline; apply index updates there (skip `procwatch`/`codex` broadcast-only events for durable artifacts — they aren't in the spool, so a restart would "lose" them; that's correct because the index is *derived from the spool*). Exit criteria to assert in tests: `/sessions` no longer calls `ReadLastN(…, MaxInt)` (sessions served from memory); `/sessions/{id}` result identical to pre-index behavior. Commit: `feat(daemon): serve sessions/traces/artifacts from derived index (Phase 2)`.

---

## Part C — Phase 3: Tauri desktop shell

### Task 9: scaffold `apps/tauri-desktop`

**Files:**
- Create: `apps/tauri-desktop/` (Vite vanilla-ts + Tauri v2: `pnpm create tauri-app` equivalent, checked in by hand: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/`, `src-tauri/{Cargo.toml,tauri.conf.json,capabilities/default.json,src/main.rs,src/lib.rs,build.rs,icons/}`)
- Create: `scripts/build-sidecar.sh` (builds `go build ./cmd/firehosed` into `apps/tauri-desktop/src-tauri/binaries/firehosed-<target-triple>`)
- Modify: `.gitignore` (`node_modules`, `dist`, `src-tauri/target`, `src-tauri/binaries/`)

Key config: `tauri.conf.json` → `productName: "Agent Firehose"`, `identifier: "dev.agentfirehose.desktop"`, `bundle.externalBin: ["binaries/firehosed"]`, CSP `connect-src http://127.0.0.1:4517 ipc: http://ipc.localhost`, window 1200×760. Node via `/opt/homebrew/opt/node/bin` (nvm shim is broken in non-interactive shells — export PATH in commands). Validation: `pnpm install && pnpm build` and `cargo check` in `src-tauri`. Commit: `feat(desktop): scaffold Tauri v2 shell with firehosed sidecar (Phase 3)`.

### Task 10: frontend API client + feed state (TDD with vitest)

**Files:**
- Create: `apps/tauri-desktop/src/api.ts` — typed client: `health()`, `recent(limit)`, `stream(onEvent)` (native `EventSource`), `sessions()`, `session(id)`, `traces(id)`, `files()`, `doctor()`, `install(adapter)`, `getConfig()`, `setConfig(partial)`, `exportUrl()`
- Create: `apps/tauri-desktop/src/state.ts` — pure feed logic: bounded buffer (cap 5000), pause with unread counter, category/source/text filters, burst coalescing (port of `store.Coalesce` semantics: same source+session+category+name within 2s window)
- Create: `apps/tauri-desktop/src/format.ts` — row formatting (time, source badge, category, summary, `×N`)
- Test: `apps/tauri-desktop/src/state.test.ts`, `src/format.test.ts` (vitest; jsdom not needed — pure logic)

Coalescing tests mirror `internal/store/store_test.go` cases so both clients agree on semantics. Commit: `feat(desktop): API client and feed state with tests (Phase 3)`.

### Task 11: UI — live feed, sessions, detail, doctor/install, settings, onboarding

**Files:**
- Create: `apps/tauri-desktop/src/main.ts`, `src/ui/{feed,sessions,detail,doctor,settings,onboarding}.ts`, `src/styles.css`
- Modify: `index.html`

Desktop UX priorities from the plan, PoC scope (immediate task 6): left nav (Live, Sessions, Doctor, Settings); Live = auto-scroll feed, space-to-pause, filter bar; row click → detail pane with full payload JSON; Sessions = list from `/sessions`, click → session events; Doctor = checks from `/doctor` with per-adapter Install buttons (`POST /install/{adapter}`); Settings = privacy mode radio (POST /config), spool dir + daemon addr display, export button (downloads `POST /export`); Onboarding = first-run overlay (no config file yet / health check failing): pick privacy mode → install adapters → doctor verify. Status bar: daemon health + `schema_version` compatibility check (mismatch → blocking banner; that's the plan's compatibility-matrix behavior). Commit: `feat(desktop): live feed, sessions, detail, doctor, settings, onboarding (Phase 3)`.

### Task 12: Rust shell — sidecar lifecycle

**Files:**
- Modify: `apps/tauri-desktop/src-tauri/src/lib.rs`
- Modify: `apps/tauri-desktop/src-tauri/capabilities/default.json` (shell sidecar execute permission)

Behavior: on setup, `TcpStream::connect_timeout("127.0.0.1:4517", 300ms)`; if closed, spawn sidecar `firehosed` via `tauri_plugin_shell` and poll until healthy (≤5s). Do **not** kill the daemon on app exit (plan exit criterion: daemon restarts independently of UI). `cargo check` + manual `tauri dev` smoke. Commit: `feat(desktop): spawn firehosed sidecar when no daemon is running (Phase 3)`.

### Task 13: packaging — macOS local validation + CI matrix + release runbook

**Files:**
- Create: `.github/workflows/desktop.yml` — matrix (macos-14, windows-2022, ubuntu-22.04): setup Go + Rust + pnpm → `scripts/build-sidecar.sh` (per-OS triple) → `tauri build` → upload artifacts
- Create: `docs/release-runbook.md` — signing (macOS Developer ID + notarization), Windows code signing, Linux AppImage/deb, updater feed metadata (tauri-plugin-updater endpoint + signing keys), all flagged as human-credential steps
- Modify: `scripts/build-sidecar.sh` for cross-OS use

Local validation (macOS): `pnpm tauri build --debug` produces a runnable unsigned `.app` containing the sidecar. Windows/Linux validation happens in CI (documented; cannot run locally). Commit: `feat(desktop): packaging pipeline for macOS/Windows/Linux (Phase 3)`.

### Task 14: daemon/UI compatibility matrix

**Files:**
- Create: `docs/compatibility.md` — matrix: app version ↔ daemon version ↔ `schema_version`; rule: client must check `GET /health` and refuse on major mismatch; updating the app never touches spool/config (assert: bundle contains no spool paths)
- Test: UI already blocks on mismatch (Task 11); add vitest case for the compat check function.

Commit: `docs: daemon/UI compatibility matrix (Phase 3)`.

---

## Part D — Phase 4/5 decision gates + closing docs

### Task 15: Phase 4 — engine keep/replace decision framework

**Files:**
- Create: `docs/migration/pain-review.md` — the plan's Phase 4 template: keep-Go criteria vs Rust-migration triggers as a scored checklist; measurement plan (install failures, crash reports, sidecar spawn failures, support load) with where each number comes from; explicit "do not rebuild wholesale" rule; empty results section to fill after beta.

Commit: `docs: Phase 4 pain-review framework and decision criteria`.

### Task 16: Phase 5 — cloud control plane design (implementation deferred)

**Files:**
- Create: `docs/architecture/cloud-control-plane.md` — Phoenix scope (should/should-not), four deployment modes table, data flow (local full-fidelity → policy filter → transformed subset), exit criteria; states explicitly that implementation is deferred until desktop usage is solid (anti-goals) and local-only stays first-class.

Commit: `docs: Phase 5 cloud control plane design (deferred)`.

### Task 17: contract + README + plan status updates; final validation

**Files:**
- Modify: `docs/contracts.md` (new endpoints: POST /config, /traces/{id}, /artifacts/files, POST /install/{adapter}; trace_id field note)
- Modify: `README.md` (desktop app section, firehosed, updated docs links)
- Modify: `docs/agent-firehose-migration-plan.md` (add a short "Status" block at top mapping phases → done/deferred with dates)

Final loop: `gofmt -l .` → `go test ./...` → `pnpm -C apps/tauri-desktop test && pnpm -C apps/tauri-desktop build` → `pnpm -C apps/tauri-desktop tauri build --debug` (macOS bundle) → commit `docs: contracts/README/migration status for daemon+desktop milestone`.

---

## Execution notes

- Branch: work on `feat/daemon-desktop-migration` off `main`; merge to `main` is human-approved (repo convention).
- TDD every Go task (failing test first, never edit expectations to fit code, no skips).
- Node: prefix frontend commands with `PATH="/opt/homebrew/opt/node/bin:$PATH"`; pnpm is at `/opt/homebrew/bin/pnpm`.
- If `tauri build` needs missing system deps, record exact error and fall back to `cargo check` + `pnpm build` + CI validation — do not weaken Go validation loop.
