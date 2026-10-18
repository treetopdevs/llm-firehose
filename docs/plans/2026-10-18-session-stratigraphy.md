# Session Stratigraphy v1

Status: implemented; remediation and final review in progress. Base: main `a5df67fc5cce0e66130f055e0d8a038f4ad42c17`, including merged PR #35.

## Outcome

Find earlier sessions with the same Error Signature, inspect an exact captured observation, then open that session in Loops or Score. A read-only desktop prototype, not automatic loop inference, causality, proof of a fix, or an effort metric. Selected next because it reuses authoritative signatures and makes historical evidence accessible without guessing intervention thresholds.

## Contract, before implementation

Add `GET /errors/sessions?key={encoded signature key}&offset=0&limit=50`.
- Required nonempty key; offset integer >= 0 (default 0); limit integer 1..100 (default 50). Pagination accepts ASCII decimal digits only (leading zeros allowed), without signs. Duplicate key/offset/limit parameters, malformed query encoding, or invalid values: 400 before querying; unknown key: 404 with a fixed error message.
- Return `{key, total, offset, limit, sessions:[{session_id, source, count, first_time, last_time, sample_event_id}]}`. `total` counts distinct nonempty session ids for this signature, independent of page. Empty page is `[]`. Sort by `last_time` descending then `session_id` ascending. Pagination is a fresh snapshot per request; arrivals can move rows between pages. UI labels snapshot semantics and offers refresh.
- Counts and times are exact per-signature/per-session aggregates over deduplicated Captured Events, independent of the existing 500-member sample cap. `sample_event_id` is the earliest (time,id) qualifying observation of that session. Errors with no session id contribute to the existing global signature summary but no session row. Existing `/errors`, its global count semantics and membership cap are unchanged.
- Keep per-session aggregate state in the disposable projection, update after existing id dedupe and qualification, rebuild from spool. No per-request spool scans, no history fanout, no new persisted data/dependencies. Return copied values. Existing host/origin restrictions apply.
- This new route is additive; do not change envelope, spool, privacy, export or existing API semantics. Minimal-mode identities remain exactly the already-admitted values. Keys remain the established Error Signature identity, including the pre-existing unescaped delimiter ambiguity; changing that identity requires a separate compatibility design.

## Desktop

- Add a navigation panel labelled `strata`, titled Session Stratigraphy. List signatures observed in >=2 sessions, filter by source/text, paginate signatures locally (<=50 at once). Label global counts as global; never infer a session's count from them.
- Selecting a signature calls only the paginated new endpoint. Display exact per-session counts and first/last error timestamps, with fixed-height chronological rows and a compact time-position/range strip. Range is first-to-last observed matching error, not session duration or productive effort; gaps mean no matching observation, not proof of capture completeness. Rows remain accessible as a list/table; never encode counts by unexplained area.
- Server-paginated sessions (50/page), explicit snapshot freshness/refresh, empty/error/loading states, and visible old-daemon compatibility notice when the new endpoint is unavailable. Page movement from live arrivals is documented; no promise of an immutable cursor.
- Each row offers full event evidence via `capturedEvent(sample_event_id)` only on explicit click, and callbacks to open Loops/Score scoped to row session/source. Own the detail region. Cancel superseded list/session/detail requests; version + selection checks prevent stale updates across signature/filter/page/refresh changes. Validate returned event id, session and source before rendering. Clear stale evidence when scope changes.
- No automatic alerts, persisted annotations, arbitrary command execution, adapter changes, new dependency, cloud service, or TUI changes.

## TDD seams and gates

Routine decisions delegated by the user. Seams: projection/Engine query and rebuild equivalence, HTTP request/response, API client URL/abort behavior, observable rendered panel interactions. Start with failing tests; real existing error fixtures for identity/shape, normalized fixtures for aggregate ordering/dedupe/caps. Cover >500 events, multiple sessions, missing sessions, tie order, duplicate/out-of-order admission, caller mutation, pagination bounds, unknown key, privacy, origin rejection, and rebuild equivalence. UI tests cover request count/no fanout, local/global labels, stale responses/cancellation, evidence failures/mismatch, filtering/paging, links and old daemon failures.

Validation: gofmt → go vet → go test; desktop full tests/build; build sidecar then Rust tests; interactive local browser using sanitized real fixtures and ideally isolated actual daemon fixture ingestion. Do not touch live spool, hooks or production settings.

Plan and final adversarial review: Argon 4 High via agy; fallback Claude Sonnet 5.5 High if unavailable/timed out. Fix findings test-first, review exact code commit, commit/push/open PR, inspect final-head CI and hosted review findings. Main merge remains human-approved for this new PR. Hosted Autofix previously failed for billing; recheck availability without purchasing or changing account billing. Keep running HTML decision log updated.
