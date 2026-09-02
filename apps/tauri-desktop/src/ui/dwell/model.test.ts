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
});
