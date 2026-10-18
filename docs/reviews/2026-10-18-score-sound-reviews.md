# Score sound adversarial reviews

Claude Sonnet 5.5 High fallback: substantive Argon quota was exhausted earlier today. Static reviews, not runtime proof.

## Plan review (before implementation)

Review is done; the findings are below. I read the plan, `score/index.ts`, `score/model.ts` and the `show()` navigation in `main.ts`. I made no edits and ran no tests.

**Verdict: not PASS.** Items 1–5 need fixing in the plan before building.

**Blocking**

1. **Navigation away doesn't disable sound while paused.** `show()` in `main.ts:136-161` has no Score hook, unlike airspace, loom, ecosystem, replay and files.
   - The only detach handling is `frame()`'s `root.isConnected` check (`index.ts:187`), which runs only while playing.
   - A paused user with sound enabled who navigates away keeps the context open and the document listener attached. Returning shows sound still on, and the next Play is audible. That breaks "re-entry requires opt-in".
   - Fix: add `scorePanel.deactivate()` to `show()` and make it disable sound. Add a shell-level test for the paused-then-navigate case, not only the playing case.

2. **A cue exception freezes playback.**
   - `frame()` calls `tick()` and only then `requestAnimationFrame(frame)` (`index.ts:192-194`). A throw from the cue path, such as `oscillator.start`, `setValueAtTime`, or a NaN frequency, breaks the rAF chain with `playing` still true.
   - The plan says errors "fail to unavailable". Make that explicit: wrap the cue in try/catch, latch the unavailable state so a failure doesn't repeat every frame, and add a test that playback continues after a cue throws.

3. **The resume promise resolving doesn't mean audio is running.**
   - `resume()` can resolve while `state` is still `suspended` or `interrupted` (WKWebView, OS audio interruption).
   - A tone scheduled on a suspended context sounds later, when the context resumes. That is a surprise sound.
   - The plan should gate cues on `context.state === "running"`, listen for `statechange`, and treat the "enabling" status as silent. A `suspended` or `interrupted` state should move to a visible status and drop cues.
   - The audio-clock rate cap also freezes while suspended, which is harmless once cues are gated.

4. **Create the `AudioContext` and call `resume()` synchronously inside the click handler.** Don't call them after any `await`.
   - WKWebView, which Tauri uses on macOS, rejects `resume()` without live user activation.
   - Add a test asserting the constructor is called in the same task as the click, before any microtask.
   - Make the Enable control a real `<button aria-pressed>`. The Score root `keydown` handler (`index.ts:210-230`) only treats BUTTON and SELECT as controls. Space on an `input` checkbox or a `role=switch` div would also toggle playback.

5. **The final event's cue is ambiguous.** `tick()` runs `setPlayhead`, then `setPlaying(false)` when `done`. If the plan's "end stops the tone immediately" is applied in that order, the last event never sounds. If the order is reversed, the cue fires after pause. State which behaviour is intended and test it.

**Playback correctness**

6. **Only the latest event in (old, new] is considered, so an error can be silently skipped.**
   - At 60×, one frame spans roughly 1s of session time. An error followed by a message inside that window is silent.
   - Events sharing a timestamp collapse to the last one in sort order, because `eventAt` returns the last.
   - The "no full-history scan" worry doesn't apply here. A binary search for the index range, then a scan over that slice, totals O(n) across a whole playback. Either scan the slice for error priority, or document that tones are not an error detector.

7. **The first event never sounds.** The interval is (old, new], so an event exactly at `score.start` is excluded. Replay-from-start calls `setPlayhead(start, true)` from `play()` (`index.ts:199`). State this in the plan.

8. **Stopping a tone abruptly clicks.** On pause, seek or end, use a short release ramp of about 10ms and then stop. Don't hard `disconnect`.

9. **Seek paths need an explicit stop.** `setPlayhead(…, false)`, `select`, `jump`, chart-click and arrow keys don't go through `tick`. Each must stop the active tone. Add a test for seeking during an active tone.

10. **Hidden-document gap.**
    - After hiding, `frameStamp` stays stale, so the first frame back computes a huge `elapsed` and jumps the playhead (`index.ts:192`).
    - Sound is already disabled by then, so it is silent. But playback keeps "playing" with sound off, and the UI should show that.
    - Also listen for `pagehide`. Don't assume WebKitGTK or WebView2 fire `visibilitychange` on minimize.

11. **Look up pitch with `Object.hasOwn` or a `Map`, never `PITCH[ev.category]`.** Categories come from captured data, so `"constructor"` or `"__proto__"` returns a non-number and the cue throws or produces NaN. Add a hostile-category test.

12. **Rapid enable and disable.** `close()` is async and WebKit caps concurrent contexts, so a new context constructor can throw while the old one is closing. Serialize the new-context creation after the pending close, or treat a constructor throw as a retryable "unavailable". Test double-click, and enable then disable then enable while a promise is pending.

**Smaller**

13. Specify the status UI. It should show off, enabling, on and unavailable states. It should use `aria-live` only for state changes, never per cue. The legend should be generated from the pitch table, with a test, so it can't drift.

14. Cues must be gated on the "enabled" state only, not "enabling". The user may press Play while the resume is pending.

15. `sound.test.ts` already exists untracked in the worktree (`apps/tauri-desktop/src/ui/score/sound.test.ts`). It stubs `AudioContext` globally rather than injecting a host as the plan says. It also doesn't cover items 2, 3, 4 or 12.

16. The plan file has missing spaces throughout, for example "main767f7cc", "error220Hz", "gain0.025" and "one80ms". Fix them before they go into the journal or PR text.

17. The plan's Codex-style reviewer line ("Argon4 High") conflicts with your standing instruction in `CLAUDE.md`. Reviews should use `gpt-6.1-sol` at high reasoning effort.

**Test plan additions**

- paused-then-navigate
- cue throws and playback continues
- `statechange` to suspended or interrupted
- constructor called synchronously in the click
- last-event cue at end
- tie-timestamp and error-priority in a dense window
- seek during an active tone
- hostile category
- enable, disable, enable churn with pending promises

The plan already says automated tests can't prove audibility, so keep that distinction in the final evidence.

## Implementation review (initial slice)

**Verdict: no blocking defects. One medium finding, plus a few low ones.** I did a static read of `767f7cc..HEAD` against the plan and its clarifications. I ran no tests, builds or network, made no edits and delegated nothing.

## Findings, most severe first

1. **Medium: seeks through `select()` don't stop an active tone.**
   - Only `setPlayhead` calls `sound.stop()` for non-playback moves (`ui/score/index.ts:265`). `select()` at `index.ts:283` doesn't.
   - `select()` is used by clicking a tick (`:593`), the next and previous buttons, and the track-row Enter/Space handler (`:540`).
   - If you seek by one of these while playing, the current tone, up to 80 ms at 0.025 gain, keeps ringing. The plan says "pause/seek/end immediately stops active tone."
   - No cue plays after the seek, because `select()` never cues.
   - Fix: call `sound.stop()` at the top of `select()`.
   - Why the tests miss it: the "jump to next event" step in `sonification.test.ts` runs while paused, and the sound module is mocked.

2. **Low-medium: the Score tests don't follow the plan's own test rule, and they leave gaps.**
   - The plan says tests substitute the global Web Audio host, not an internal spy. `sonification.test.ts` mocks `./sound` itself (`createReplaySound: () => sound`).
   - That test never checks that the first observation is silent, that dense events cue only the latest, or that error priority applies only to the latest crossed event. It also doesn't check that seeking stops sound, or that the rate cap holds through Score.
   - The `main.test.ts` addition is weak. The button label already flips at "enabling", so `await Promise.resolve()` doesn't prove the state reached "on".
   - I didn't check whether `main.test.ts` unstubs its `AudioContext` global afterwards.

3. **Low: UI and accessibility nits.**
   - The tone legend sits inside a collapsed `<details>`, so it's only visible once expanded. The plan says "legend visible."
   - The button swaps its label and also sets `aria-pressed`, which double-encodes state. During "enabling" it reads "Disable" with `aria-pressed=false`.
   - `enable()` returns silently if `document.hidden`, leaving the status at "off" with no explanation.

4. **Low, unverified: the new `isConnected` guard in `tick` (`index.ts:424`) changes behaviour for detached panels.** I didn't run the existing tests, and the detached-panel cases at roughly `index.test.ts:714-721` and `:750+` should be checked. They check "neither fetches nor writes", so they probably still pass, but I couldn't confirm.

## Checked and fine

- **Gesture:** `new AudioContext()` and `resume()` both run synchronously in the click handler, before the first `await`.
- **Silent enabling:** enabling itself makes no sound. State must be "running", and an `onstatechange` or cue-time check closes the context as unavailable.
- **Race cleanup:** the version token covers disable during a pending resume, disable-then-enable (the late first resolve is ignored), and a rejected resume after close. `close()` rejections are caught, and listeners are added only after enable starts and removed on disable.
- **Lifecycle:**
  - `pagehide` and `visibilitychange` both disable.
  - Opening another session disables via `open()`.
  - Leaving Score disables via the new `deactivate()` in `main.ts:137`, including paused departure. `deactivate()` also cancels detail without writing to the shared pane.
- **Cue rules:** `crossed.at > previous && !step.done` gives silence at the initial cursor, the end, gaps and seeks.
  - Only the latest crossed event is used, with `severity === "error"` overriding its category.
  - `Object.hasOwn` guards the pitch lookup against prototype keys.
- **Rate cap:** it uses the audio clock, and the skipped cue is dropped rather than queued. The envelope is 0.01 s up to 0.025, then down to 0 at 0.08 s.
- **Immediate silence:** `stop()` disconnects the oscillator straight away, with no ramp. That may click faintly, but at 0.025 gain it matches your "lifecycle stop prioritizes immediate silence" instruction.
- **No accidental sound:** `refresh()` doesn't call `open()`, so there's no accidental disable. Nothing in the diff persists or sends anything.

None of this proves audibility or loudness on a real device. Only a human listening can settle that.

## Fix follow-up through cb561f8

**PASS.** I found no blocking defects in `a810ec0..HEAD`. This was a read-only code read: I ran no tests and no browser, and I did not test loudness.

**Verified**
- **Seek finding fixed.** Every cursor-move path now stops the active voice.
  - Transport buttons and arrow keys go through `jump` → `select`, which calls `sound.stop()` (`index.ts:285`).
  - The chart-click and drag path goes through `setPlayhead` with `fromPlayback` false, which stops sound (`:267`).
  - Playback's own moves (`tick`, and the rewind in `play()` at `:216`) are the only ones that skip the stop, as intended.
  - `open` calls `sound.disable()` and `deactivate` does too.
- **Real audio controller in tests.** `sonification.test.ts` no longer mocks `./sound`. It stubs `globalThis.AudioContext` and checks real oscillator frequencies and `disconnect` calls.
  - The "stepping during playback" test asserts the voice is disconnected and no new voice is created. That fails if `select()` loses its `stop()`.
- **Detached paused tick.** `tick` and `frame` now check `isConnected` before the `playing` guard (`:203`, `:425`). A paused, detached panel therefore reaches `deactivate` → `sound.disable`. The test asserts `close` is called once.
- **Disclosure keyboard.** `target.closest("summary")` returns before the Space handling (`:230`), so Space on the summary toggles the details element natively and does not start playback. Before the fix, Space on the summary fell through to `play()`, so the test would have failed.
- **Dense events.** `eventAt(step.at)` with `crossed.at > previous` yields only the latest crossed observation. The 2600 ms test expects a single 587 Hz message voice and no earlier 220 Hz error cue, which matches. I traced the other test timings by hand (pitches, 150 ms throttle, end-of-playback silence, `close` counts) and they hold.
- **Pressed state.** Treating `enabling` as pressed matches the click handler, which disables in both `enabling` and `on`. The status text still distinguishes readiness.
- **Shell navigation.** `main.ts:137` calls `scorePanel.deactivate()` when leaving the Score view. The test also asserts the "Replay sound on" status text.

**Nits, not blocking**
1. The `closest("summary")` guard drops all keys, so ←/→ do nothing while the summary has focus, though they step when a button has focus. Narrowing it to `e.key === " "` would keep arrow stepping consistent.
2. The sound button changes its label between "Enable replay sound" and "Disable replay sound" and also sets `aria-pressed` (`:105-107`). Screen readers may announce "Disable replay sound, pressed". A fixed label with `aria-pressed` is the usual pattern, though the tests and plan currently depend on the changing label.
3. The `AudioContext` fakes never fire `onended`, so a voice that ends naturally and then gets stopped is untested. `sound.test.ts` may cover that.

I did not exercise the browser, so the claims about the UI and context state come from reading the code and tests, not from a live run.

## Dispositions

Plan blockers addressed with synchronous gesture setup, running-state checks, contained failures, explicit initial/final silence and shell deactivation. Latest-only dense semantics are disclosed; tones are not an error detector. Immediate low-gain lifecycle silence is intentional. The claimed CLAUDE.md reviewer mandate was not found in the actual file; the user explicitly requested Sonnet fallback.

Implementation findings fixed: select() stops active tones; DOM tests exercise the real controller through a fake global AudioContext; shell test verifies on status before departure; paused detached ticks disable sound. Additional failing-first tests caught summary Space starting playback and cover latest-event-only dense windows.

Final follow-up PASS. Nonblocking notes retained: summary focus intentionally does not control transport; action labels and pressed opt-in state coexist; natural onended cleanup is statically reviewed, not separately simulated. Independent specification and standards reviewers both passed fixes through cb561f8 after initially identifying test-boundary and paused-detach gaps.
