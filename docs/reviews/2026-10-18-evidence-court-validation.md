# Evidence Court validation

Base main e007b2f, after explicitly authorized PR #36 merge. No capture/Go/API behavior changes.

- Shared detail action TDD: added explicit handoff test, observed missing button failure, implemented optional callback; 8 detail tests pass.
- Notebook and UI red/green evidence recorded alongside this report.
- Go formatting empty, vet/full tests/CLI build passed.
- 531 frontend tests across 34 files passed; TypeScript/Vite production build passed.
- Sidecar build and 3 Rust tests passed.
- Actual-daemon browser preview uses 112 existing sanitized fixtures in an isolated temporary spool with no live sources, hooks or user settings. Preview harness built during preceding slice; backend unchanged in this slice. Verified live detail → Court handoff, manual claim and two requirements, exact captured test-failure preview, explicit attach, browser reload persistence, one attached/not-verified vs one missing gap, reopening full receipt, correct source/session navigation to Score, and Score detail handoff back to Court.
- Preview notes are synthetic manual text; no real user notebook was present. Saved references only; no captured payload copied into notebook.

Browser evidence is not an interactive packaged-native test or release proof. Optimistic localStorage comparison is best effort, not atomic multi-window locking. Clearing app data loses notes; no export/sync implemented.

Initial Sonnet findings remediated test-first: no requirement preselection on reload/handoff, named saved target, explicit removal confirmation and remove-before-replace, preserved drafts/failed-save previews, mismatch-specific errors, visible UUID failures and read-only recovery text. Browser recheck confirmed no preselection, target-named removal, cancel retaining receipt and re-fetch of the exact saved evidence.
