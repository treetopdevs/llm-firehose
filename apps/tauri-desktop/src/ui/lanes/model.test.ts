import { describe, expect, test } from "vitest";
import { LANE_CAP, MAX_OPEN_SPAN_MS, SEP, axisTicks, buildLanes } from "./model";
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
    expect(lanes[0]).toMatchObject({ state: "needs_input", reason: "approve", label: "claude · s2" });
    expect(lanes[2].label).toBe("opencode · s4");
  });

  test("a captured title names the lane", () => {
    const lanes = buildLanes([ev("s2", 60_000)], [summary({ id: "s2", title: "Fix login bug", state: "working" })], now, 5 * MIN);
    expect(lanes[0].label).toBe("Fix login bug");
  });

  test("an unmatched start ends at the last report once the session stops working", () => {
    const events = [call("s1", 40_000, "c1", "start"), ev("s1", 30_000)];
    const at = (age: number) => new Date(now - age).toISOString();
    const done = buildLanes(events, [summary({ id: "s1", state: "done", last_time: at(30_000) })], now, MIN);
    expect(done[0].spans).toEqual([{ from: now - 40_000, to: now - 30_000, open: false }]);
    const working = buildLanes(events, [summary({ id: "s1", state: "working", last_time: at(30_000) })], now, MIN);
    expect(working[0].spans).toEqual([{ from: now - 40_000, to: now, open: true }]);
  });

  test("drops engine states that are no longer plausible", () => {
    const summaries = [
      summary({ id: "ghost-needs", state: "needs_input", last_time: new Date(now - 48 * 3_600_000).toISOString() }),
      summary({ id: "ghost-working", state: "working", last_time: new Date(now - 40 * MIN).toISOString() }),
      summary({ id: "waiting", state: "needs_input", last_time: new Date(now - 2 * 3_600_000).toISOString() }),
    ];
    expect(buildLanes([], summaries, now, 5 * MIN).map((l) => l.id)).toEqual(["waiting"]);
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

  test.each([
    ["2h", 2 * 3_600_000],
    ["8h", 8 * 3_600_000],
    ["24h", 24 * 3_600_000],
    ["7d", 7 * 24 * 3_600_000],
  ])("%s window: ticks are bounded and spaced", (_id, windowMs) => {
    const plot = 644;
    const ticks = axisTicks(now, windowMs, plot);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(plot / 80);
    const px = plot / windowMs;
    for (let i = 1; i < ticks.length; i++) expect((ticks[i]!.at - ticks[i - 1]!.at) * px).toBeGreaterThanOrEqual(80 - 1e-6);
  });

  test("windows over a day carry dates; shorter ones stay clock-only", () => {
    for (const ms of [24 * 3_600_000, 7 * 24 * 3_600_000]) {
      for (const t of axisTicks(now, ms, 644)) expect(t.label).toMatch(/^[A-Z][a-z]{2} \d{1,2}( \d{2}:\d{2})?$/);
    }
    for (const ms of [2 * 3_600_000, 8 * 3_600_000]) {
      for (const t of axisTicks(now, ms, 644)) expect(t.label).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  test("steps of a day or more align to local midnight", () => {
    for (const t of axisTicks(now, 7 * 24 * 3_600_000, 644)) {
      const d = new Date(t.at);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
    }
  });
});

describe("buildLanes names qualified sessions", () => {
  const native = "2385e3bc-1111-2222-3333-444444444444";
  test("a qualified summary is named from the decoded native id and source, never a slice of the key", () => {
    const id = `claude-code${SEP}${native}`;
    const [lane] = buildLanes([], [summary({ id, source: "claude-code", agent: "claude-code" })], now, 5 * MIN);
    expect(lane.id).toBe(id);
    expect(lane.label).toBe("claude-code · 2385e3bc");
    expect(lane.label).not.toContain("claude-c ");
  });
  test("a qualified summary with a title keeps its title and its composite key", () => {
    const id = `codex${SEP}${native}`;
    const [lane] = buildLanes([], [summary({ id, title: "Fix login bug" })], now, 5 * MIN);
    expect([lane.id, lane.label]).toEqual([id, "Fix login bug"]);
  });
  test("an event-only lane is named by the directory lookup when it knows the session", () => {
    const events = [ev(`codex${SEP}${native}`, 10_000)];
    const lookup = (ref: { id: string; source?: string }) => (ref.id === native && ref.source === "codex" ? { id: native, source: "codex", title: "Fix login bug" } : undefined);
    expect(buildLanes(events, [], now, 5 * MIN)[0].label).toBe("codex");
    expect(buildLanes(events, [], now, 5 * MIN, lookup)[0].label).toBe("Fix login bug");
  });
  test("lanes sharing a name carry source and short id; the grouping key stays composite", () => {
    const a = `codex${SEP}${native}`, b = `claude-code${SEP}bbbbbbbb-1111`;
    const lanes = buildLanes([], [summary({ id: a, title: "Fix login bug" }), summary({ id: b, source: "claude-code", title: "Fix login bug" })], now, 5 * MIN);
    expect(lanes.map((l) => l.label).sort()).toEqual(["Fix login bug · claude-code bbbbbbbb", "Fix login bug · codex 2385e3bc"]);
    expect(lanes.map((l) => l.id).sort()).toEqual([b, a].sort());
  });
});
