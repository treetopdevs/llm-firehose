# Session Stratigraphy backend TDD

Worktree: branch codex/session-stratigraphy-prototype

1. Added projection query tests before implementation. `go test ./internal/capture/internal/projection -run TestErrorSessions -count=1` failed because Projection.ErrorSessions did not exist (corrected fixture privacy helper names first, then confirmed missing-method failure).
2. Implemented exact session aggregates alongside existing capped membership state and copied, sorted, paged query. Targeted projection tests passed, including >500 observations, duplicate IDs, reversed arrival order, earliest timestamp/ID sample tie, tie ordering, no-session exclusion, page bounds, mutation safety, real fixture + all privacy modes, and spool rebuild equivalence. Existing ErrorSignature tests remained green.
3. Added HTTP route test before implementing route/Engine passthrough. `go test ./internal/daemon -run TestErrorSessionsEndpoint -count=1` failed with 404 instead of 200.
4. Added Engine validation and aliases, GET /errors/sessions, no-store header and query parsing. Endpoint tests passed for encoded key, defaults/page metadata, empty pages, unknown key, invalid/missing/overflow paging input, and foreign-origin rejection. Engine tests additionally prove no spool read and error sentinel classifications.
5. Final targeted command passed: `go test ./internal/capture ./internal/capture/internal/projection ./internal/daemon -run 'TestErrorSessions|TestErrorSignature|TestErrorsEndpoint|TestBuild.*Equivalent' -count=1`.

Parent runs full mandated formatting/vet/tests and desktop gates. No commit or push performed by backend agent.

## Sonnet review remediation

- Added failing HTTP regressions for malformed percent encoding, semicolon query parsing, signed pagination, duplicated parameters, and reflected missing-key messages. All nine malformed/ambiguous requests incorrectly returned 200 before the fix; the 404 reflected the key. Red evidence: /tmp/firehose-strata-query-red.log.
- Switched this new route to url.ParseQuery; rejects parsing errors and duplicate key/offset/limit values. Pagination requires ASCII digits without signs, leading zeros allowed. Unknown-key HTTP response now uses fixed text. Contract/plan updated with that policy. Green evidence: /tmp/firehose-strata-query-green.log.
- Verified admission delegates to spool Writer.Append, which supplies IDs before projection; existing live and one-shot tests already assert generated IDs. Added public Engine proof: no-ID error admission yields retrievable sample ID, replay deduplicates, rebuilding retains it. No changes to frozen identity/dedupe semantics.
- Formatting and vet logs are empty: /tmp/firehose-strata-go-format.log and /tmp/firehose-strata-go-vet.log. Full suite log: /tmp/firehose-strata-go-full.log.
