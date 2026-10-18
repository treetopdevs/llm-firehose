# Argon 4 High adversarial review

Model gemini-4-argon-high, high effort. Read-only review completed with exit0.

**Verdict:** **PASS** (0 findings across P0–P3)

### Explicit Scope Reviewed
- **Commit range:** `e007b2f..79a0cec` (`79a0cec feat(desktop): add Attention Airspace observation bands`)
- **Plan & docs:** [2026-10-18-attention-airspace.md](../../docs/plans/2026-10-18-attention-airspace.md), [attention.md](../../docs/attention.md), [CONTEXT.md](../../CONTEXT.md)
- **Implementation & tests:**
  - [model.ts](../../apps/tauri-desktop/src/ui/airspace/model.ts) & [model.test.ts](../../apps/tauri-desktop/src/ui/airspace/model.test.ts)
  - [map.ts](../../apps/tauri-desktop/src/ui/airspace/map.ts) & [map.test.ts](../../apps/tauri-desktop/src/ui/airspace/map.test.ts)
  - [index.ts](../../apps/tauri-desktop/src/ui/airspace/index.ts) & [index.test.ts](../../apps/tauri-desktop/src/ui/airspace/index.test.ts)
  - [main.ts](../../apps/tauri-desktop/src/main.ts) & [styles.css](../../apps/tauri-desktop/src/styles.css)

---

### Verification Summary by Focus Area

1. **Concrete Correctness & `/attention` Semantics (`deriveAirspace`)**
   - Uses only `GET /attention` (`attention(signal)`) and `GET /attention/event?id=...` (`capturedEvent(id, signal)`), without joining legacy `/sessions`.
   - Band classification in [`deriveAirspace`](../../apps/tauri-desktop/src/ui/airspace/model.ts#L55-L65) strictly implements the precedence rules: `pending.kind === 'failure'` $\to$ `failure`; any other `pending` $\to$ `request` (regardless of age); otherwise `state === 'failed'` $\to$ `failure`, `state === 'done'` $\to$ `completion`, `state === 'working'` with finite non-future `eventAgeMs <= windowMs` $\to$ `recent`, and all other states/clocks $\to$ `quiet`.
   - Recency uses `source_time ?? time` without falling back to `time` or `last_observed_at` when `source_time` is invalid or in the future ([`clock`](../../apps/tauri-desktop/src/ui/airspace/model.ts#L26-L35)).
   - Ordering is total and deterministic: band order $\to$ pending before state-only within `failure` $\to$ valid timestamps before `null` (unknown/future) $\to$ oldest-first for pending / newest-first for non-pending $\to$ lexical `(source, id)` tie-breaker ([`model.ts`](../../apps/tauri-desktop/src/ui/airspace/model.ts#L71-L83)).
   - Filtering occurs prior to pagination; band totals reflect the full filtered set while map markers and the ordered list render the 20-item page slice.

2. **Races & Request Lifecycle (`createAirspace`, `main.ts`)**
   - Snapshot fetches (`refresh`) and receipt lookups (`inspect`) maintain separate monotonic tokens (`snapshotToken`, `receiptToken`) and `AbortController` instances (`snapshotAbort`, `receiptAbort`).
   - Navigating away from `airspace` in [`show`](../../apps/tauri-desktop/src/main.ts#L118-L131) calls `airspacePanel.deactivate()`, aborting in-flight snapshot and receipt requests and clearing selection/receipt state; entering `airspace` clears the shared `detailPane` and triggers a single `activate()` fetch.
   - Selecting a row or inspecting a receipt on a retained board while a refresh is in flight is cleanly invalidated (`cancelReceipt()`) when the refresh settles (both on success and failure).
   - Local filter, window, search, and pagination changes cancel active receipt inspection and re-evaluate ages against `now()` without issuing network requests.

3. **Stale / Offline State**
   - `setConnected(false)` aborts in-flight requests, clears selection/receipt, retains any previously loaded `snapshot`, and marks the status banner `Disconnected — snapshot stale.` with `.stale` styling.
   - `setConnected(true)` transitions to `Snapshot stale.` without auto-fetching until an explicit `refresh()` or `activate()`, and is idempotent when already connected (`if (connected === value) return`).
   - First-load failure (`!snapshot && !loading`) renders `"No snapshot available. Refresh to retry."`, distinct from both initial loading (`"Waiting for first snapshot…"`) and empty filtered results (`"No sessions match this snapshot and filters."`).

4. **Identity Scoping**
   - Session identity is scoped by `JSON.stringify([session.source, session.id])`, preventing collisions across sources sharing native session IDs.
   - Select option values encode strings with `JSON.stringify(item)` against unquoted `"all"` ([`index.ts`](../../apps/tauri-desktop/src/ui/airspace/index.ts#L18-L21)), keeping the sentinel `"All"` filter distinct from both empty (`""` / `"Unknown"`) and literal `"all"` source/workspace values.
   - [`inspect`](../../apps/tauri-desktop/src/ui/airspace/index.ts#L98-L99) verifies `event.id === item.event_id && event.source === row.session.source && event.session_id === row.session.id` before rendering the receipt, and `Open Score` passes both `(row.session.id, row.session.source)`.

5. **Evidence Claims & Diagnostics**
   - Copy throughout the header, map caption, notice bar, selection detail, and receipt pane explicitly frames bands as captured observations rather than live process status, notes that `done` can reflect turn completion rather than session termination, distinguishes `Latest observation` from `Pending observation (age is not waiting duration)`, and labels source event time vs. event envelope time vs. capture observation time.
   - Warnings and capture gaps show exact snapshot totals while bounding rendered list items to 10, and explicitly note when `gaps` is empty that `"No recorded capture gaps; this does not establish complete coverage."`

6. **Accessibility & DOM Safety**
   - All DOM nodes are constructed via `el(...)` text nodes and attributes (`textContent`), neutralizing HTML/script injection in summaries, IDs, and errors.
   - Map markers are native `<button type="button">` elements with full `aria-label` (`Inspect <band>: <source> / <id>`), paired with a parallel `<ol class="airspace-list">` containing full text equivalents.
   - Selecting a session moves focus to the `Selected session` section (`tabindex="-1"`), status/error transitions use `role="status"` and `role="alert"`, and `.airspace` interactive controls have explicit `:focus-visible` outlines.
