# internal/tui testdata

- `liveness_cases.json` is copied verbatim to
  `apps/tauri-desktop/src/liveness.cases.json`. It pins the session-liveness
  rule for the Go TUI (`attentionFresh`) and the desktop (`stateFresh` composed
  with `lastReported`). `TestLivenessCasesDesktopCopyIsIdentical` enforces the
  copy. Edit the Go copy, then `cp` it over the desktop copy. A case where `go`
  differs from `ts` must carry a `known_divergence` note.
