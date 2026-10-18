# Sonnet 5.5 High adversarial review

Direct Claude CLI, exact `claude-sonnet-5-5`, `--effort high`; static read-only e007b2f..265e1dd. User-authorized fallback after Argon quota exhaustion.

**Verdict: no blocking defects.** There are two Medium findings and several Low ones. Nothing breaks the plan's core contract.

This was a static read of `e007b2f..265e1dd` at head. I ran no tests, made no edits and delegated nothing.

## What I checked and found sound

- **Canonical signature parity:** `projection.ErrorObservationKey` (`errsig.go:138`) reuses `isErrorObservation`, `errorClass` and `errorSignatureKey`, the same functions `foldErrorSignature` uses. The qualification predicate and key cannot drift from the projection's.
- **Heat unchanged:**
  - Non-file errors return before `FileEvents`, `UnreadableFileEvents` and the Heat map are touched (`activity.go:~156`).
  - File-category errors take the same Heat path as before.
  - The `paths` reassignment for errors uses the same `activityPaths` extractor, so file-category Heat paths are identical.
  - Heat truncation and ordering are untouched.
- **Alias dedupe:** the per-event `resolved` set stops two aliases that resolve to one path from double-counting one observation, and a regression test covers it.
- **Caps and omissions:**
  - Paths are ordered by total descending, then group, then path. Signatures are ordered by total descending, then key.
  - The caps are 2000 paths and 20 signatures per path.
  - `omitted_error_paths` and `omitted_signatures` are computed correctly, and `total` includes omitted signatures as `contracts.md` says.
  - The result is deterministic, and the cap test checks that.
- **Privacy and compatibility:** the minimal-mode early return still happens before any scan, and `error_paths` is always a non-nil `[]`. The client treats an absent field as "unavailable" rather than zero errors, and `contracts.md` is additive-only.
- **Brush scope:** `errorRange` uses `[a,b)` over bucket indices. `render()` rebuilds the overlay and the list on every brush change, so both stay in step with the Heat tiles.
- **Tile identity:** the key is `[group, path]`, and `node.group` and `node.path` for file leaves equal the API `group` and `path`.

## Findings

**1. Medium — `activity.go:127-130`: the dedupe set now holds every in-window event.**
- The original code returned early for non-file events, so `seen` only held file-event IDs. The category gate was removed, so `seen[ev.ID]` and `EventDay` now run for every repo/workspace-scoped event in the window: tool, shell, session and so on.
- Aggregation memory therefore grows with all matching history, not just file and error history, even for callers that only want Heat.
- That quietly widens the "memory proportional to matching history" claim. `contracts.md` says Heat behaviour and scan cost are unchanged, and that is no longer strictly true.
- Fix: run the dedupe only for events that are file-category or qualify as errors, which is a cheap pre-check before `seen`. Alternatively, state the larger footprint explicitly.

**2. Medium — `activity.go:135-139`: error path extraction is wider than the canonical `EventFilePaths`.**
- The code sets `pathEvent.Category = CategoryFile`, which bypasses the category gate at `projection.go:434`. Any `severity=error` event, whatever its category, now yields paths from `payload.file_path`, `path`, `file` or `changes`, and from the apply_patch text fallback.
- The projection's `foldErrorSignature` uses plain `EventFilePaths(ev)`, so `ErrorSignature.Paths` for the same event is empty. The overlay attributes a path that `/errors` signatures do not. That departs from the "same-event, canonical" framing.
- A shell or tool error with a directory-valued `path` would be drawn as a file-error tile. A failed `apply_patch` attributes the paths in its attempted patch.
- I checked the real adapters. The Claude Code adapter only writes `file_path` for file tools. Its `PostToolUseFailure` events are `warn`, so they do not qualify. In practice this path is hit by category=error events that carry a path, and by codex or opencode `severity=error` events. The practical blast radius is small.
- The plan permits "existing path extraction" and `contracts.md` discloses the apply-patch behaviour, but neither documents the category bypass.
- Fix: either restrict the extraction to explicit keys plus `changes`, matching `EventFilePaths` semantics, or add a negative test (tool or shell category with severity error and `path`) and document the widening in `contracts.md`.

**3. Low — `workspace_graph.go:447` with `errors.ts:25`: error-only paths in unresolved groups are shown by raw group ID.**
- `resp.Groups` is built only from `result.Paths` (Heat). An error-only path whose group has no Heat has no `groups` entry.
- The list prints `stripControl(p.group)`, which is the raw worktree identity. In balanced mode that is a long digest. The Heat map instead shows `digestLabel(...)` or "Outside known worktrees".
- The literal group `"unknown"` also appears raw.
- Fix: include error-path groups in the group set, and format the group in the list the same way as the map (`digestLabel` or the group label).

**4. Low (accessibility) — `errors.ts:34`: pagination destroys the focused control.**
- `draw()` calls `clear(root)` and rebuilds the buttons. Activating "Next error paths" removes the focused button, so keyboard focus drops to `<body>`. This code path does not use `keepFocus`, and there is no `aria-live` region announcing the new page.
- The page also resets to 0 on any re-render, including brush drags, zoom and live refresh, so a keyboard user loses their place.
- Fix: refocus the same button after redraw, or the heading. Add `role="status"` to the "Showing a–b of n" line. Persist `page` across `render()`, clamped to the new length.

**5. Low — `errors.ts:13`: rows with zero in-range count are still listed.**
- The filter `p.count>0||p.omitted>0` keeps a path that has only omitted signatures and nothing retained in range. It renders as "0 retained error observations".
- The plan says the list "shows all retained file paths with errors in range", and this row may have none in range. The disclosure text mitigates it, but the row can mislead.
- Fix: label it explicitly ("no retained observations in range; N signatures omitted"), or exclude it and rely on the aggregate omission notice.

**6. Low — test gaps against the plan's TDD list (`activity_errors_test.go`).**
- The duplicate-ID test uses `b,b` in the same day file. Nothing exercises the cross-day canonical replay branch (`EventDay != day`) on the error path.
- There is no workspace-scope mutation. Only repo and window are mutated, although the plan asks for "scope".
- There is no negative test for a non-error, non-file event carrying a path (it should produce nothing), and none for severity-error events in non-file, non-error categories (see finding 2).
- `TestActivityErrorCapsAreDeterministic` tests the helper in isolation, not through `Activity`. The daemon test covers only the happy path: two errors, one path.
- The frontend test checks only that `.map-storm` appears once. It does not assert that the list ordering matches the API ordering, or that the old-daemon notice appears when `error_paths` is absent in a non-empty map.

**7. Nit — docs.**
- `docs/reviews/2026-10-18-activity-error-overlay-validation.md` pins code `4ba6787` and says the Sonnet 5.5 High review is still pending. That is stale once this review lands, so update it with the outcome. `Truncated` language also still describes only Heat caps.
- `contracts.md` says "at most2000" and "at least2" in several places (missing spaces).

## Recommendation

Fix 1 and 2 before un-drafting. Finding 3 is also cheap to fix. Findings 4 to 6 can follow in the same branch. Everything else matches the plan, including the canonical key, same-event attribution, exact sparse counts, deterministic caps, brush `[a,b)` scope, the paginated accessible list with error-only paths, and the old-daemon "unavailable" disclosure.

## Remediation

Unrelated events excluded before dedupe; any-category same-event explicit path attribution documented and tested (paths can be directories or attempted patch targets). Error-only groups included; readable group labels, retained pagination/focus and status announcements, explicit omission-only wording. Added workspace/non-file negatives and cross-day canonical replay tests, plus old-daemon nonempty-map coverage. Prior caps helper test remains the deterministic cap contract gate. Independent spec and standards follow-ups PASS; full Go/CLI/sidecar/Rust gates and 493 frontend tests/build passed before final coverage additions; focused added coverage passes. Sonnet follow-up pending.
