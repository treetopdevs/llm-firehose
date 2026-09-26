import { describe, expect, test } from "vitest";

import { DWELL_CAP, DWELL_MAX_MS, applyTransition, buildDwell } from "./model";
import type { FirehoseEvent, SessionSummary } from "../../api";

const now = Date.now();

function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: "claude-code",
    agent: "claude",
    cwd: "/home/me/dev/app",
    first_time: new Date(now - 600_000).toISOString(),
    last_time: new Date(now - 5_000).toISOString(),
    events: 3,
    state: "working",
    state_since: new Date(now - 120_000).toISOString(),
    last_summary: "edit view.go",
    ...over,
  };
}

describe("buildDwell", () => {
  test("measures time in state against a ten-minute bar, needs-you first and longest wait first", () => {
    const { rows, more } = buildDwell(
      [
        summary({ id: "w" }),
        summary({ id: "n2", state: "needs_input", state_since: new Date(now - 60_000).toISOString(), state_reason: "approve Edit" }),
        summary({ id: "n1", source: "codex", agent: "codex", state: "needs_input", state_since: new Date(now - 7 * 60_000).toISOString(), state_reason: "approve Bash" }),
      ],
      now,
    );
    expect(more).toBe(0);
    expect(rows.map((r) => r.id)).toEqual(["n1", "n2", "w"]);
    expect(rows[0]).toMatchObject({ label: "codex", where: "…/dev/app", needs: true, text: "approve Bash" });
    expect(rows[0].fraction).toBeCloseTo(0.7, 2);
    expect(rows[2]).toMatchObject({ needs: false, text: "edit view.go" });
    expect(rows[2].fraction).toBeCloseTo(0.2, 2);
  });

  test("clamps the bar at the maximum and drops states that are no longer plausible", () => {
    const { rows } = buildDwell(
      [
        summary({ id: "long", state: "needs_input", state_since: new Date(now - 3 * 3_600_000).toISOString(), last_time: new Date(now - 3 * 3_600_000).toISOString() }),
        summary({ id: "ghost", state: "needs_input", state_since: new Date(now - 48 * 3_600_000).toISOString(), last_time: new Date(now - 48 * 3_600_000).toISOString() }),
        summary({ id: "stuck", state: "working", state_since: new Date(now - 40 * 60_000).toISOString(), last_time: new Date(now - 40 * 60_000).toISOString() }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["long"]);
    expect(rows[0].fraction).toBe(1);
    expect(rows[0].dwellMs).toBeGreaterThan(DWELL_MAX_MS);
  });

  test("an idle stamp from a daemon restart is not evidence of life", () => {
    const { rows } = buildDwell(
      [
        summary({ id: "restarted", state: "idle", state_since: new Date(now - 30_000).toISOString(), last_time: new Date(now - 2 * 3_600_000).toISOString() }),
        summary({ id: "quiet", state: "idle", state_since: new Date(now - 30_000).toISOString(), last_time: new Date(now - 60_000).toISOString() }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["quiet"]);
  });

  test("caps the chart and counts the rest", () => {
    const many = Array.from({ length: DWELL_CAP + 3 }, (_, i) => summary({ id: `s${i}` }));
    const { rows, more } = buildDwell(many, now);
    expect(rows).toHaveLength(DWELL_CAP);
    expect(more).toBe(3);
  });
});

describe("applyTransition", () => {
  test("restarts a session's dwell from a live state.transition", () => {
    const before = [summary({ id: "w" })];
    const ev = {
      id: "t1",
      time: new Date(now).toISOString(),
      source: "firehose",
      name: "state.transition",
      category: "meta",
      session_id: "w",
      payload: { state: "needs_input", reason: "approve Bash" },
    } as FirehoseEvent;
    const after = applyTransition(before, ev);
    expect(after[0]).toMatchObject({ state: "needs_input", state_since: ev.time, state_reason: "approve Bash" });
    expect(before[0].state).toBe("working");
    expect(applyTransition(before, { ...ev, session_id: "unknown" })).toBe(before);
    expect(applyTransition(before, { ...ev, source: "codex" })).toBe(before);
  });

  // Regression test for Codex review finding F2: the backend's state.transition
  // payload carries "since" — the state's own honest start time — separately
  // from the event's own "time" (when the transition was published). An
  // error-only transition (has_error flips, primary state and since
  // unchanged) must not restart the dwell clock by falling back to ev.time.
  test("uses the payload's since over the event's own time when present", () => {
    const before = [summary({ id: "w", state: "needs_input", state_since: new Date(now - 600_000).toISOString() })];
    const sinceIso = new Date(now - 600_000).toISOString();
    const errOnly = {
      id: "t2",
      time: new Date(now).toISOString(),
      source: "firehose",
      name: "state.transition",
      category: "meta",
      session_id: "w",
      payload: { state: "needs_input", reason: "approve Bash", has_error: true, since: sinceIso },
    } as FirehoseEvent;
    const after = applyTransition(before, errOnly);
    expect(after[0]).toMatchObject({ state: "needs_input", state_since: sinceIso, state_reason: "approve Bash" });
  });

  test("falls back to the event's own time when the payload carries no since", () => {
    const before = [summary({ id: "w" })];
    const ev = {
      id: "t1",
      time: new Date(now).toISOString(),
      source: "firehose",
      name: "state.transition",
      category: "meta",
      session_id: "w",
      payload: { state: "needs_input", reason: "approve Bash" },
    } as FirehoseEvent;
    const after = applyTransition(before, ev);
    expect(after[0].state_since).toBe(ev.time);
  });

  // Regression test for Codex review finding F3: a daemon old enough to
  // predate the "since" payload key (wave 3) carries none at all, so
  // applyTransition falls back to the event's own time. That fallback is
  // correct for a genuine state change (the test above), but wrong for an
  // error-only transition -- same state, same reason, only has_error
  // flipping -- where ev.time is the error's own arrival, not the state's
  // start. When since is absent and state and reason are unchanged from the
  // prior summary, the prior state_since must be kept.
  test("keeps the prior state_since for an error-only transition from an older daemon with no since", () => {
    const firstSinceIso = new Date(now - 600_000).toISOString();
    const before = [
      summary({ id: "w", state: "needs_input", state_since: firstSinceIso, state_reason: "approve Bash" }),
    ];
    const errOnly = {
      id: "t2",
      time: new Date(now).toISOString(),
      source: "firehose",
      name: "state.transition",
      category: "meta",
      session_id: "w",
      payload: { state: "needs_input", reason: "approve Bash", has_error: true },
    } as FirehoseEvent;
    const after = applyTransition(before, errOnly);
    expect(after[0]).toMatchObject({ state: "needs_input", state_since: firstSinceIso, state_reason: "approve Bash" });
  });
});
