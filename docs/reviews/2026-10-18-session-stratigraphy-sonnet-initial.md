# Claude Sonnet 5.5 High — initial adversarial review

Argon 4 High timed out after 180 seconds without a verdict. Requested fallback reviewed plan and working implementation read-only. Findings below are the original review, not final disposition.

I'll start by locating the files under review.
## Review: Session Stratigraphy

I read the working files and edited nothing. I did not run tests, did not open the new test files beyond their test names, and did not run the UI. The verdict is **not a clean PASS**. I found no blockers, but there is one medium contract bug and several lows.

### Findings by priority

**1. Medium: malformed query strings can silently default instead of returning 400.**
- Where: [endpoints.go `handleErrorSessions`](internal/daemon/endpoints.go#L166-L194), which reads `r.URL.Query()`.
- `Query()` swallows parse errors and drops the bad pairs. `offset=%zz` or `offset=1;limit=5` is dropped, so `q.Has` is false and the handler uses the default, returning 200.
- [contracts.md](docs/contracts.md) says "malformed values → 400", and the plan at line 12 says invalid values are rejected with 400.
- Fix: call `url.ParseQuery(r.URL.RawQuery)` and return 400 on error.
- The same dropped-pair behaviour can turn a mangled `key` into "empty key" (400), which is acceptable.

**2. Low: `strconv.Atoi` is looser than "nonnegative integer".**
- It accepts `+5`, `-0` and `007`. That is cosmetic, but the contract wording is stricter.
- Duplicate `offset` or `limit` parameters silently use the first value.
- Fix: tighten the check or document the leniency.

**3. Low: the 404 body reflects the signature key.**
- Where: [history.go `ErrorSessions`](internal/capture/history.go#L207-L222) wraps `%q` of the key, and the handler echoes `err.Error()`.
- [`handleEventByID`](internal/daemon/endpoints.go#L148-L163) deliberately uses fixed messages.
- `http.Error` sets text/plain and nosniff, so this is not an XSS risk, and the caller supplied the key. It is still inconsistent. Use a fixed body such as "error signature not found".

**4. Low: events with an empty `ev.ID` bypass the dedupe.**
- Where: [projection.go:184-190](internal/capture/internal/projection/projection.go#L184-L190).
- Such events would be counted again and could produce `sample_event_id: ""`. The UI then fails the evidence fetch.
- Admission probably guarantees IDs, but the "exact deduplicated" claim depends on that. Either assert it in a test or skip the session aggregate when `ev.ID == ""`.

**5. Low: the signature key can be ambiguous.**
- The key is `source|category|name|class`, and `name` and `class` can contain `|`. This is pre-existing in [errsig.go](internal/capture/internal/projection/errsig.go).
- The new endpoint makes the key an exact lookup, so a collision would silently merge two signatures. Note it in the contract as a known limit.

**6. Low: a refresh from a panel switch loses the user's place.**
- Where: [index.ts:106-108](apps/tauri-desktop/src/ui/strata/index.ts#L106-L108), because `main.ts` `show()` calls `refresh()` on every navigation.
- Clicking "Open Loops" or "Open Score" and coming back clears the selected signature, the page and the evidence.
- `refresh()` also does not abort in-flight session or detail requests when the panel is hidden. Stale writes are guarded by version checks, so this is a UX and lifecycle gap, not a correctness bug.

**7. Low: the old-daemon notice cannot be told apart from an unknown key.**
- Where: [index.ts:103](apps/tauri-desktop/src/ui/strata/index.ts#L103).
- An old daemon returns 404 for the unknown route, and a new daemon returns 404 for an unknown key (for example after the projection is rebuilt). The message is generic enough to cover both, but the plan promises a "visible old-daemon compatibility notice". Status-specific text would meet that.

**8. Low: nested pager markup.**
- Where: [index.ts:35 and 48](apps/tauri-desktop/src/ui/strata/index.ts#L35).
- `pager()` appends a `.strata-pager` div into `signaturePager`, which is already a `.strata-pager`. The flex gap and margin are applied twice.

### Areas I checked with no issue found

- **Exact counts beyond the cap:** the per-session aggregate in [errsig.go:181-193](internal/capture/internal/projection/errsig.go#L181-L193) is independent of the 500-member cap. It is order-independent (the earliest `(time,id)` is the sample, and min/max times are tracked). `Source` is stable because the key includes it.
- **`total` vs `sessions`:** `total = len(entry.sessions)` equals `len(e.members)`, so it agrees with the existing `sessions` field and the UI's `>= 2` filter.
- **Pagination:** the sort in [error_sessions.go](internal/capture/internal/projection/error_sessions.go#L44-L49) is total, because session IDs are unique. Rows are copied under the read lock and sorted after it is released. Out-of-range offsets give `[]`. Bounds are validated twice (HTTP and Engine).
- **Existing contracts:** `/errors` is unchanged, the new route is additive with no pattern conflict, and `cors(mux)` wraps it so origin restrictions apply.
- **Privacy:** minimal-mode keys and identities are already-admitted values, and nothing new is persisted.
- **UI evidence and rendering:**
  - Evidence is fetched on click only. The event id, session and source are validated before rendering.
  - Responses are checked for key, offset and limit against the request.
  - Version and abort guards cover the list, session and detail requests.
  - Rendering uses `el()` and `textContent`, and `JSON.stringify` goes into `pre`.
  - The inline `style` attribute is allowed by the CSP (`style-src 'unsafe-inline'`).
- **Performance:**
  - Each page request is O(S log S) in the sessions for that signature and does not scan the spool. That is fine for a local tool.
  - The extra per-session map roughly doubles the per-signature membership memory. It is unbounded, but so is the existing `seen` map.
  - Evidence fetches use the existing day-scoped scan.

### Limits of this review

- I did not read the test bodies, so I cannot say whether the plan's coverage list is met. That list covers more than 500 events, duplicate and out-of-order admission, tie order, and rebuild equivalence.
- I did not check `index.test.ts` or the CSS beyond the strata rules.
- I did not verify that `api.ts` request-abort behaviour matches `getJSON`.
- I did not touch the HTML decision log or the CI and hosted-review steps in the plan.

Fix #1 first, test-first, since it is the only item that deviates from the stated contract. Items #3, #4 and #7 are cheap to fix alongside it.
