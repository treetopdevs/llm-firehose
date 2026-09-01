import { describe, expect, test } from "vitest";
import { bucketCounts, formatAge, sessionHue, sparkline, stateFresh } from "./spark";
import type { FirehoseEvent } from "./api";

const now = Date.parse("2026-07-02T10:10:00Z");

function ev(sessionId: string, ageMs: number, over: Partial<FirehoseEvent> = {}): FirehoseEvent {
  return {
    id: `${sessionId}-${ageMs}`,
    time: new Date(now - ageMs).toISOString(),
    source: "codex",
    category: "tool",
    session_id: sessionId,
    ...over,
  } as FirehoseEvent;
}

describe("bucketCounts", () => {
  test("counts one session's events per 30s bucket, oldest first", () => {
    const events = [ev("s1", 40_000), ev("s1", 40_000), ev("s1", 10_000), ev("s2", 10_000), ev("s1", 20 * 60_000)];
    const counts = bucketCounts(events, "s1", now);
    expect(counts).toHaveLength(10);
    expect(counts[9]).toBe(1);
    expect(counts[8]).toBe(2);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  test("ignores transitions and unparseable times", () => {
    const events = [
      ev("s1", 1000, { source: "firehose", name: "state.transition" }),
      ev("s1", 1000, { time: "garbage" }),
    ];
    expect(bucketCounts(events, "s1", now).every((n) => n === 0)).toBe(true);
  });
});

describe("sparkline", () => {
  test("shares one scale and leaves zero blank", () => {
    expect(sparkline([0, 1, 2, 4], 4)).toBe(" ▂▄█");
    expect(sparkline([3], 3)).toBe("█");
    expect(sparkline([0, 0], 0)).toBe("  ");
  });
});

describe("formatAge", () => {
  test("uses a single unit", () => {
    expect(formatAge(-5)).toBe("0s");
    expect(formatAge(12_000)).toBe("12s");
    expect(formatAge(3 * 60_000)).toBe("3m");
    expect(formatAge(2 * 3_600_000)).toBe("2h");
    expect(formatAge(49 * 3_600_000)).toBe("2d");
  });
});

describe("sessionHue", () => {
  test("is stable and stays on the color wheel", () => {
    expect(sessionHue("abc")).toBe(sessionHue("abc"));
    expect(sessionHue("abc")).not.toBe(sessionHue("abd"));
    for (const id of ["a", "b", "session-123", ""]) {
      const h = sessionHue(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("stateFresh", () => {
  const H = 3_600_000;
  test("trusts engine states only while they are plausible", () => {
    expect(stateFresh("needs_input", now - 2 * H, now)).toBe(true);
    expect(stateFresh("needs_input", now - 48 * H, now)).toBe(false);
    expect(stateFresh("working", now - 20 * 60_000, now)).toBe(true);
    expect(stateFresh("working", now - 40 * 60_000, now)).toBe(false);
    expect(stateFresh("idle", now - 5 * 60_000, now)).toBe(true);
    expect(stateFresh(undefined, now - 15 * 60_000, now)).toBe(false);
    expect(stateFresh("needs_input", NaN, now)).toBe(false);
  });
});
