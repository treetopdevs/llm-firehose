# Handoff Subway v1

Status: implemented, locally validated, and adversarial review passed. PR #38; hosted checks tracked live. Base main `e007b2f26e61042a43f802c13844a761946e8e3a`. PR #37 (Evidence Court) remains open, green and awaiting human merge approval; this independent slice does not import its implementation.

## Outcome

Explore a directed map of explicit user annotations linking captured events in different sessions. Session/source pairs are transit lanes, event references are stations, and user-labelled edges are annotated transfers. Select a station to fetch its full captured receipt and open its session in Score. This makes cross-tool continuity inspectable without interpreting similar prompts, shared files or nearby times as proof of handoff or causality.

The native `parent_id` field can identify a record, message or session depending on source. Do not automatically join it to event IDs. Source-confirmed handoffs and inferred suggestions are deferred until adapter-specific contracts and real fixtures support them. Display all links as “User annotation — not source-confirmed”. Missing/unavailable receipts are visible gaps; absence of annotations does not prove absence of a transfer.

## Interaction

Add `handoffs` navigation, title Handoff Subway. Create a link with a manual label (1–500 chars), departure event and arrival event. Two endpoint fields accept exact captured IDs; each has explicit lookup and shows full JSON evidence before saving. Both verified endpoints must have nonempty session/source, must differ by (source,session), and cannot be the same event. Save only after both previews match the current input scope. Name both targets beside the Save action; direction is the user's annotation, not an inferred temporal or causal relation.

Provide an explicit “Browse recent observations” picker from the existing live FeedState callback, limited to its latest 100 session-bearing captured observations and paginated 20 rows. Each row shows source/session/time/summary and “Use as departure/arrival”; choosing only fills the ID and invalidates that endpoint preview, never silently fetches or saves. Manual IDs support older events beyond this limited buffer. No automatic history fanout.

List saved links with labels, endpoint identities, inspect buttons and target-named confirm/cancel removal. Paginate 10 links per page. Render a deterministic SVG map for those links only, max20 endpoint stations/lanes, with a parallel accessible HTML list. Lane identity is exact (source,session); reuse identical event stations. Directed edges have clear arrows, distinct endpoint controls and textual direction. Positions organize references, not time/duration/effort; disclose that the map shows the current page only. Escape all user/event text. No route navigation via arbitrary event content.

Inspecting a saved station re-fetches exact ID and verifies source/session. On failure show unavailable or conflicting identity; keep the saved annotation but never treat its availability as proof. Offer Score only for verified session identity. Own the evidence region. Abort/version guards cover endpoint changes, replacement lookups, saved-station selection, page changes, reload, removals and navigation refresh. Preserve unsaved label/endpoint fields across ordinary navigation; invalidate stale previews appropriately. Failed saves keep drafts/previews and previous persisted state. Explicit reload warns that it discards drafts.

## Host-private persistence

Use `firehose.handoff-subway.v1` localStorage, `{version:1,links:[{id,label,from:{id,source,session_id},to:{id,source,session_id}}]}`. Max50 links; IDs/source/session up to512 chars; all identity fields nonempty; unique link IDs and directed endpoint pairs; same event ID cannot have inconsistent source/session across links. Strict shape/bounds validation, copied reads, no save on load. Persist only manual labels and identities, never event payloads/summaries. No cloud/sync/export; current origin/profile only; dev/release separate; clearing app data loses notes. Best-effort optimistic raw-value conflict check before save; not transactional multi-window storage. Invalid/future data blocks saves with read-only raw recovery; no silent reset. Storage/quota/conflict/UUID failures visible and preserve prior state.

## Boundaries, tests and gates

No Go, capture, API, dependency or privacy contract changes. Existing FeedState and capturedEvent API are data boundaries. Seams delegated by user: persistence API and deterministic graph model; rendered panel/API interactions; bounded SVG/map accessibility. Red→green vertical slices. Existing captured fixtures for endpoint shapes. Cover exact lane grouping, shared stations, cross-source same-session-ID distinction, page bounds, duplicate/corrupt state, failed/conflicting writes, copy safety, explicit fetch/attach, stale responses, mismatch/unavailable references, failed-save retry, removal confirmation, limited recent-picker scope, safe text and navigation.

Run Go format/vet/full tests/build; full frontend tests/build; sidecar then Rust tests; isolated actual-daemon fixture browser check. Argon 4 High plan and final reviews via agy, fallback Gemini 3.1 High if available or Sonnet 5.5 High. Fix findings, independent standards/spec review, commit/open PR, handle CI/comments. No new main merge without human approval. Keep HTML coordination journal current while preserving records of pending PR #37.
