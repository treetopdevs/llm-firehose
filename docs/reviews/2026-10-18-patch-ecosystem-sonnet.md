# Sonnet 5.5 High adversarial review

Direct Claude CLI, exact model `claude-sonnet-5-5`, `--effort high`, static read-only review of e007b2f..26ff2a0. User-authorized fallback after Argon quota exhaustion.

**Verdict: no blocking defects, but I have 5 non-blocking findings (P2 to P3).**

Reviewed `e007b2f..26ff2a0` by reading with `git show` at the head SHA only. I edited nothing, ran no tests, made no network calls and delegated nothing. Model: Claude Sonnet 5.5 (`claude-sonnet-5-5`).

## What checked out

- **Path semantics:** `paths()` (`model.ts:27-38`) matches Go `EventFilePaths` and `isDigest` (`projection.go:433-459`). That covers the `file_path`/`path`/`file` precedence, the empty-string skip, the digest exclusion and the sorted `changes` keys. Digest objects are never stringified.
- **Scope and dedupe order:** The exact source, session and `file` category filter runs before dedupe (`model.ts:63`). Duplicate, conflict and missing-ID counters behave as documented, including the case where a conflict is flagged only once.
- **Replay:** `replayBeds` clamps NaN, negative, fractional and Infinity cursors, keeps every bed in place, and does not mutate its input.
- **Stale async handling:**
  - `load()` goes through `clearScope()` first, which bumps `loadVersion`, so a failed reload cannot show the old scope.
  - Receipts are guarded by both a token and the load version.
  - `deactivate()` cancels load, receipt and playback.
  - A receipt whose id, source or session doesn't match is rejected.
- **Classification on real data:** I checked it against `activity_real_shapes.ndjson` and the Score fixture. Claude `PostToolUseFailure` carries `status:"error"` with warn severity, so it classifies as failed. Codex `custom_tool_call` (`phase:start`, `status:completed`) classifies as attempt, which matches D42.
- **Scope and privacy:** No new API, no filesystem or Git reads, no automatic fanout. Rendering uses `textContent` throughout, with no `innerHTML`. The full receipt appears only after an explicit Inspect.

## Findings

**1. P2: Single-observation stem is green and contradicts the legend.**
- Where: `map.ts:18` (`visible.length>1?'#d7ab63':'#8ab897'`).
- The legend (`map.ts:7`) says green means reported completion, but `#8ab897` is the "complete" leaf colour (`map.ts:10`).
- Failure scenario: a bed with one failed, attempt or unknown observation draws a green stem over a red or gray leaf. That reads as a completion cue the evidence doesn't support.
- Fix: use a neutral colour for the one-observation stem. Add a map test for stem colour.

**2. P3: Read-only file tools are presented as "patch" activity, and rows hide the tool.**
- Where: `index.ts:23`, `index.ts:41`, `map.ts:15-21`.
- `category=file` includes non-edit tools. Antigravity `PostToolUse:view_file` is in `activity_real_shapes.ndjson` and is categorised file (`antigravity.go:218`).
- Failure scenario: a session that only reads files shows beds, "reported completions" and stems under "Patch Ecosystem". Neither the observation rows nor the map show `event.name` or `tool_name`. The user can only tell a read from an edit by opening the receipt.
- The "observations, not edits" disclaimer is present, but the evidence that would let the user verify it is hidden.
- Fix: show `event.name` or `payload.tool_name` in each row and in the bed `aria-label`. Optionally add a legend note that file observations include reads for some adapters.

**3. P3: `Date.parse` loses sub-millisecond order and is more lenient than "valid time".**
- Where: `model.ts:78`, `model.ts:82`.
- Real timestamps are microsecond RFC3339, for example `2026-10-15T19:32:30.960878Z` in the Score fixture. `Date.parse` truncates them to milliseconds.
- Failure scenario: two observations in the same millisecond but different microseconds are ordered by random captured ID, not by clock. A Pre/Post pair can replay as Post then Pre.
- Failure scenario: V8 also accepts non-RFC3339 strings such as `"1"`, `"10"` or `"Oct 5"` as valid dates. A malformed clock then enters the timed replay instead of the undated list.
- Fix: parse strict RFC3339 with fractional digits and compare the fraction as a tiebreak before ID. Add tests for same-ms ordering and a malformed non-ISO time. Neither exists today.

**4. P3: Re-clicking the Ecosystem nav button destroys playback and receipt state.**
- Where: `main.ts:125` (`panels[name].refresh()` on every `show`) and `index.ts:105` (`pause(); cancelReceipt();` at the top of `refresh`).
- The plan says return "refreshes choices only".
- Failure scenario: while playing, or with a receipt open, clicking the Ecosystem nav button stops playback and discards the receipt. Only the choice list should change.
- Fix: drop `pause()` and `cancelReceipt()` from `refresh()`, since `deactivate()` already handles leaving. Add a test that playback survives `refresh()`.

**5. P3: The map legend counts the page slice, not the filtered set.**
- Where: `map.ts:7`, with the caller at `index.ts:38`.
- `index.ts` passes the 20-bed page, so the legend always reads "N of N file beds" and never states truncation against the full set. The plan says the map states exact counts and truncation.
- The `<h3>` at `index.ts:38` does carry the real totals, so this is cosmetic. The `map.test.ts` assertion `20 of 22` only passes because the test feeds 22 beds directly.
- Fix: pass `total` and `filtered` counts into the map, or reword the legend as "page of ≤20".

**Test gaps (no finding):**
- No test for a stale receipt after a scope change or `deactivate()`, or for `deactivate()` during an in-flight load.
- No test for stem or leaf colour semantics.
- `replayStatus` is a `role="status"` region rewritten every 250 ms during playback (`index.ts:9`, `index.ts:31`), which may flood screen-reader announcements. I did not test this, so treat it as a risk.

## Gate status

Both external final reviews failed on quota, and the validation doc says so (`docs/reviews/...-argon-final-unavailable.txt` and `...-sonnet-final-unavailable.txt`). The plan's "Argon4 High final" gate is therefore unmet, and the PR should stay draft. This read-only review does not satisfy that gate.

The validation doc's own caveat applies too: the screenshot predates the playback-notice fix, and native packaged interaction is untested.

## Remediation

All five findings addressed: neutral single stem, recorded tool labels, strict RFC3339 fractional ordering, nondestructive choice refresh, full filtered/page totals. Four regression tests failed first, then all 516 frontend tests and production build passed. Follow-up pending. The reviewer process note about fallback approval is superseded by the user's explicit fallback authorization.

## Follow-up on c222755

**PASS.** All five findings are addressed and I found no blocking regressions. This is a static read of `26ff2a0..HEAD`. I ran no tests and made no edits, so the "516 tests passed" claim in the review doc is unverified.

| # | Finding | Status |
|---|---|---|
| 1 | Single-observation stem was green | Fixed. `map.ts` now draws the one-observation stem in neutral `#a0a6b3`, and a map test covers it. |
| 2 | Tool hidden, reads shown as patches | Fixed. Rows show `tool: event.name`, the bed `aria-label` lists recorded tools, and the legend adds "File observations may include reads." Claude Code and Antigravity set `Name` to `PostToolUse:<tool>`, so `event.name` does carry the tool. |
| 3 | `Date.parse` lost sub-millisecond order | Fixed. `clock()` in `model.ts` is a strict RFC3339 parser that checks the calendar by round-trip and the zone range. Offset sign and seconds arithmetic are correct, and the fraction is zero-padded to equal length before comparing. Nothing else in the ecosystem code uses `Date.parse`. |
| 4 | Nav re-click destroyed playback and receipt | Fixed. `refresh()` no longer calls `pause()` or `cancelReceipt()`. `deactivate()` and `clearScope()` still cancel both, so leaving the panel or changing scope still stops playback. |
| 5 | Legend counted the page, not the filtered set | Fixed. The legend now reads "21–40 of 45 filtered / 45 total file beds". The empty case renders "0–0". |

The new tests are sound. Fake timers are reset by the file's `afterEach`, and the 4 new tests match the "four regression tests" claim.

Non-blocking nits:
1. **P3:** The neutral stem colour `#a0a6b3` is the same as the "gray: unknown" leaf colour. A single completed observation now shows a gray stem under a green leaf. A distinct neutral would avoid any "unknown" reading.
2. **P3:** `docs/reviews/2026-10-18-patch-ecosystem-validation.md:5` still says "512 tests". It also still lists the Sonnet review as quota-blocked and doesn't mention this remediation. The Argon final gate remains unmet, so the PR should stay draft.
3. **P3:** The `clock()` tests don't cover a space separator, a lowercase `t`/`z`, or a zone offset out of range (like `+24:00`). The code rejects them, but nothing pins that behaviour.

Final nits: distinct neutral stem and strict syntax boundary regression added. User-authorized Sonnet fallback satisfies requested external review; Argon quota is not an additional gate. Historical validation below is superseded by the latest validation addendum.
