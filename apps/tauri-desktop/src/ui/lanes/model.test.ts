import { describe, expect, test } from "vitest";
import { LANE_CAP, MAX_OPEN_SPAN_MS, axisTicks, buildLanes } from "./model";
import type { FirehoseEvent, SessionSummary } from "../../api";

const now = Date.parse("2026-07-02T10:10:00Z");
const MIN = 60_000;

function ev(sessionId: string, ageMs: number, over: Partial<FirehoseEvent> = {}): FirehoseEvent {
  return {
    id: `${sessionId}-${ageMs}-${Math.random()}`,
    time: new Date(now - ageMs).toISOString(),
    source: "codex",
    agent: "codex",
    category: "tool",
    session_id: sessionId,
    ...over,
  } as FirehoseEvent;
}

function call(sessionId: string, ageMs: number, callId: string, phase: string): FirehoseEvent {
  return ev(sessionId, ageMs, { call_id: callId, payload: { phase, tool_name: "Bash" } });
}

function transition(sessionId: string, ageMs: number, state: string): FirehoseEvent {
  return ev(sessionId, ageMs, {
    source: "firehose",
    category: "meta",
    name: "state.transition",
    payload: { state },
  });
}

function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: "codex",
    agent: "codex",
    first_time: new Date(now - 10 * MIN).toISOString(),
    last_time: new Date(now - MIN).toISOString(),
    events: 1,
    state: "working",
    ...over,
  };
}

describe("buildLanes", () => {
  test("pairs tool calls by call id, runs unfinished calls to now, and clips to the window", () => {
    const events = [
      call("s1", 30_000, "c1", "start"),
      call("s1", 20_000, "c1", "end"),
      call("s1", 10_000, "c2", "start"),
      call("s1", 90_000, "c9", "start"), // before the window
      call("s1", 50_000, "c9", "end"),
    ];
    const [lane] = buildLanes(events, [], now, MIN);
    expect(lane.id).toBe("s1");
    expect(lane.spans).toEqual([
      { from: now - 30_000, to: now - 20_000, open: false },
      { from: now - 10_000, to: now, open: true },
      { from: now - MIN, to: now - 50_000, open: false },
    ]);
    expect(lane.ticks.map((t) => t.at).sort()).toEqual(
      [50_000, 30_000, 20_000, 10_000].map((age) => now - age).sort(),
    );
  });

  test("marks errors and needs-you transitions, which are not activity", () => {
    const events = [ev("s1", 5_000, { severity: "error" }), transition("s1", 2_000, "needs_input")];
    const [lane] = buildLanes(events, [], now, MIN);
    expect(lane.ticks.map((t) => t.kind)).toEqual(["error", "needs"]);
  });

  test("caps an unfinished call at MAX_OPEN_SPAN_MS", () => {
    // The engine still says working, so the lane stays; the drawn span does not.
    const events = [call("s1", 2 * MAX_OPEN_SPAN_MS, "c", "start")];
    const [lane] = buildLanes(events, [summary({ id: "s1", state: "working" })], now, 4 * MAX_OPEN_SPAN_MS);
    expect(lane.spans[0]).toEqual({ from: now - 2 * MAX_OPEN_SPAN_MS, to: now - MAX_OPEN_SPAN_MS, open: true });
  });

  test("orders needs-you first, then most recent activity, labelled from summaries", () => {
    const events = [
      ev("s1", 5_000),
      ev("s2", 60_000, { source: "claude-code", agent: "claude" }),
      ev("s3", 20 * MIN), // quiet for too long
    ];
    const summaries = [
      summary({ id: "s2", source: "claude-code", agent: "claude", state: "needs_input", state_reason: "approve" }),
      summary({ id: "s4", source: "opencode", agent: undefined, state: "working" }),
    ];
    const lanes = buildLanes(events, summaries, now, 5 * MIN);
    expect(lanes.map((l) => l.id)).toEqual(["s2", "s1", "s4"]);
    expect(lanes[0]).toMatchObject({ state: "needs_input", reason: "approve", label: "claude" });
    expect(lanes[2].label).toBe("opencode");
  });

  test("caps the number of lanes", () => {
    const events = Array.from({ length: LANE_CAP + 5 }, (_, i) => ev(`s${i}`, i * 1000));
    expect(buildLanes(events, [], now, MIN)).toHaveLength(LANE_CAP);
  });
});

describe("axisTicks", () => {
  test("labels whole clock times inside the window, spaced for the width", () => {
    const ticks = axisTicks(now, 5 * MIN, 750); // 150px per minute → 1m step
    expect(ticks.map((t) => t.at)).toEqual([5, 4, 3, 2, 1].map((m) => now - m * MIN));
    expect(ticks[0].label).toMatch(/^\d{2}:\d{2}$/);

    const fine = axisTicks(now, MIN, 600); // 10px per second → 10s step
    expect(fine.map((t) => t.at)).toEqual([0, 10, 20, 30, 40, 50].map((s) => now - MIN + s * 1000));
    expect(fine[0].label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("widens the step when the window is narrow in pixels", () => {
    const ticks = axisTicks(now, 5 * MIN, 200); // 40px per minute is too tight → 5m step
    expect(ticks.map((t) => t.at)).toEqual([now - 5 * MIN]);
  });
});
