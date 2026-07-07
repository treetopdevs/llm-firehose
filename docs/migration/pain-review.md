# Phase 4 — engine keep/replace pain review

Migration-plan Phase 4 requires that the "keep Go or port subsystems to
Rust" decision be **measured after real desktop beta usage, not speculated**.
This document is the framework; the results section stays empty until beta
telemetry exists. Do not fill it from intuition.

## Standing rule

> Do not rebuild the whole engine just because Tauri uses Rust. A sidecar
> architecture is acceptable for a long time. Rebuild only the subsystems
> that are actually painful.

Any proposal to port a subsystem must name the criterion below it trips,
with numbers.

## Keep Go if (all largely true)

| Criterion | Signal source | Beta threshold |
|---|---|---|
| Adapters stable, easy to maintain | issue tracker: adapter bugs/month | < 3/month after month one |
| Process watching + file tailing reliable cross-platform | crash/bug reports tagged `procwatch`/`tailer` per platform | no platform-specific chronic bug open > 30 days |
| Performance acceptable for local workloads | daemon CPU/RSS at p95 on beta machines; UI feed latency | < 2% CPU idle, < 150 MB RSS, event-to-screen < 500 ms |
| Remaining work is UI polish / packaging | ratio of engine PRs to UI PRs | engine PRs mostly maintenance |

## Consider selective Rust migration if (any chronically true)

| Trigger | Signal source |
|---|---|
| Tauri-side native integrations blocked by the sidecar model | features shelved with reason "needs in-process engine" |
| Sidecar packaging fragile | install failures / support tickets citing sidecar spawn, signing, AV quarantine |
| Cross-platform process/filesystem edge cases are a chronic burden | reopened-bug count on `procwatch`/`tailer` per platform |
| Rust-side ecosystem clearly reduces operational complexity | written comparison for the specific subsystem, not vibes |

## Measurement plan (wire before beta)

- **Install failures:** onboarding wizard reports success/failure of each
  step; count failures per 100 installs (release runbook §7 fresh-machine
  check is the manual fallback).
- **Crash reports:** daemon exit-with-error occurrences (stderr log capture)
  and macOS crash logs for the shell; counted per version.
- **Performance:** `firehose status` gains CPU/RSS sampling during beta, or
  collect manually via `ps` on beta machines at intervals.
- **Support load:** labels on issues — `install`, `sidecar`, `adapter`,
  `perf`, `ui` — reviewed monthly.

## Decision procedure

1. After ≥ 4 weeks of desktop beta with ≥ 10 active installs, fill §Results.
2. For each trip-wired trigger, scope the *smallest* subsystem port that
   addresses it (e.g. only the process watcher, only the tailer).
3. Write an ADR per proposed port; human sign-off required.
4. No trigger tripped → decision is **keep Go**, revisit next quarter.

## Results (fill after beta — leave empty until then)

| Date | Installs | Install failures | Crashes | p95 CPU/RSS | Open chronic bugs | Decision |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |
