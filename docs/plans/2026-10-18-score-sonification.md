# Score: opt-in local replay tones

Fresh main767f7cc after authorized PR51 merge. Follow-up to the explicitly deferred sonification in2026-10-16-session-score-and-activity-map.md. User delegates routine choices and public test seams.

## User outcome and limits
Sound off by default, no saved preference. Explicit Enable replay sound gesture creates/resumes a local Web Audio context. During playback, a short quiet sine tone represents the latest crossed observation's category (error severity takes priority). Tone legend is visible. At most one80ms cue per150ms of audio-clock time; intermediate events in dense playback may be skipped, never queued for later. Silence through captured gaps. No speech, external audio, inference, live capture monitoring, new dependency, persistence or network.

Category pitches: error220Hz, permission660, file440, tool330, shell392, prompt523, message587, session262, meta196; unknown category196. Fixed peak gain0.025 with a short envelope. Counts are not encoded; tones indicate observations, not success or agent state. Enabling itself is silent; user plays existing Score transport. No sounds for seeking/stepping, loading or paused changes. Sound disabled before a session switch, on navigation away and on document hiding; re-entry requires opt-in again. Pause/seek/end immediately stops active tone. Detached panels also stop/disable defensively.

## Architecture and tests
Small local audio controller owns context/voice lifecycle and async enable token. Explicit disable while resume is pending closes context and prevents late reactivation. Unsupported/blocked audio or oscillator errors fail to a visible unavailable status while replay remains usable. Close/resume rejection never escapes. No document listener until enabled; remove on disable. Use the existing sorted Score/eventAt seam: after tick advances from old to new time, cue only if latest event has timestamp in(old,new]; don't scan full history or replay skipped events.

Public test seams: audio controller through a fake Web Audio host (no real sound in automated tests), Score DOM/transport using captured fixture with labelled normalized timestamps/categories, shell navigation. Verify off default, enable/resume, disabled and blocked states, pitch/envelope/rate cap, cleanup and late promises, crossed events/gaps/seeks/pause/session reset/navigation. Existing frozen contracts unchanged. Run Go format/vet/full tests/CLI, frontend full tests/build, sidecar/Rust. Browser interaction proof with isolated daemon fixtures and audio-state UI; distinguish actual audible perception from API/interaction proof.

Requested Argon4 High if available; prior substantive quota exhausted, so Sonnet5.5 High plan/final fallback. Independent spec/standards reviews, fix findings, HTML journal, commit/open PR and close hosted checks/comments. No main merge without approval.
