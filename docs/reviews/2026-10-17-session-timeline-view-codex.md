# Session timeline view: Codex review and dispositions

Reviewed: [PR #33](https://github.com/treetopdevs/llm-firehose/pull/33)
(`GET /sessions/{id}?view=timeline` and the desktop Score's lazy full-detail
fetch), at `daacbf1`. Requirements: [session timeline view brief](../plans/2026-10-17-session-timeline-view.md).

Reviewer: Codex `gpt-6.1-sol`, reasoning effort xhigh, adversarial, read-only.
The findings below are as relayed by the coordinating session; the raw
transcript was not kept.

## Result

No backend, privacy, frozen-contract or timeline-allowlist findings. Two P2
desktop races, both in `apps/tauri-desktop/src/ui/score/index.ts`. Both are
fixed.

## Findings

### P2: late detail responses overwrite newer pane state

`fetchFull` guarded its result only by session version and current event id.
Start a detail fetch while paused, then either go to Live and select another
event, or close the detail pane (`.detail-close`). The fetch still completes,
passes both guards, and overwrites the newer selection or reopens the
dismissed pane. Codex reproduced both.

**Disposition: fixed.** A pane-selection token is captured when a render
starts its fetch. The result renders only if the token is unchanged, the
Score root is still in the document, and playback is paused. These bump the
token and abort the in-flight group:

- a new selection,
- the pane's close button, through a new `dismiss` argument to `onSelect` that
  `main.ts` calls from its close handler,
- `open()`,
- `refresh()`, which `main.ts` calls when the Score is shown again.

Late Error Signatures and pausing playback also re-render only while the Score
still owns the pane (not dismissed, not taken by another view since it was
last shown).

Tests in `score/index.test.ts`, each with a deferred `capturedEvent`:

- closing the pane drops the late result and aborts its request,
- leaving the Score drops it,
- leaving and coming back before it lands drops it,
- late signatures do not reopen a dismissed pane.

### P2: explicit navigation bypasses the playback guard

`highlight` fetched on `explicit || !playing`, so a "jump to next event"
during playback started full-detail requests without pausing, and their
results rendered while playing. Cached full envelopes also rendered through
`fuller()` during playback. Both break the brief's rule that playback shows
projected fields only.

**Disposition: fixed.** The `explicit` flag is gone. While playing, a
selection renders the projected event with projected call siblings and starts
no fetch. While paused, it renders cached envelopes and fetches the rest.
Pausing renders the current event's cached envelopes at once (previously
`fetchFull` returned early when everything was cached, leaving the projected
rendering) and fetches whatever is missing.

Tests:

- an explicit step during playback renders projected fields and calls
  `capturedEvent` zero times,
- revisiting a cached event during playback renders projected fields, and
  pausing on it renders the cached full event without a request.

## Test-harness change

The timeline-view tests now attach the Score to the document, as `main.ts`
does when it is the shown view, because a detached Score no longer renders
fetched results. The test that covers a detached Score pausing itself detaches
explicitly.
