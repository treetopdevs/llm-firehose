import { describe, expect, test } from "vitest";
import type { FirehoseEvent, SessionSummary } from "../../api";
import {
  BODY_CAP,
  DESPAWN_MS,
  NEEDS_INPUT_DRIFT_MS,
  applyActivity,
  applyTransition,
  buildScene,
  urgencyRadius,
} from "./model";

function sess(partial: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: "claude-code",
    first_time: "2026-07-08T12:00:00Z",
    last_time: "2026-07-08T12:00:00Z",
    events: 10,
    state: "working",
    state_since: "2026-07-08T12:00:00Z",
    ...partial,
  };
}

const now = Date.parse("2026-07-08T12:05:00Z");

describe("urgencyRadius", () => {
  test("needs_input drifts to center over 5 minutes", () => {
    expect(urgencyRadius("needs_input", 0, 0.5)).toBe(1);
    expect(urgencyRadius("needs_input", NEEDS_INPUT_DRIFT_MS / 2, 0.5)).toBeCloseTo(0.5);
    expect(urgencyRadius("needs_input", NEEDS_INPUT_DRIFT_MS, 0.5)).toBe(0);
    expect(urgencyRadius("needs_input", NEEDS_INPUT_DRIFT_MS * 2, 0.5)).toBe(0);
  });

  test("working stays on the outer orbits", () => {
    const r = urgencyRadius("working", 0, 0.8);
    expect(r).toBeGreaterThanOrEqual(0.85);
    expect(r).toBeLessThanOrEqual(1);
  });

  test("idle sits mid-orbit", () => {
    expect(urgencyRadius("idle", 0, 0)).toBeCloseTo(0.55);
  });

  test("done drifts outward", () => {
    expect(urgencyRadius("done", 0, 0)).toBeGreaterThan(1);
  });
});

describe("buildScene", () => {
  test("hydrates the latest activity after reconnect", () => {
    const bodies = buildScene(
      [sess({ id: "a", last_summary: "checking tests", last_category: "message", last_time: "2026-07-08T12:04:59Z" })],
      now,
    );
    expect(bodies[0].lastSummary).toBe("checking tests");
    expect(bodies[0].lastCategory).toBe("message");
    expect(bodies[0].lastActivityAt).toBe("2026-07-08T12:04:59Z");
  });

  test("assigns stable sector by repo", () => {
    const bodies = buildScene(
      [
        sess({ id: "a", repo: "alpha" }),
        sess({ id: "b", repo: "alpha" }),
        sess({ id: "c", repo: "beta" }),
      ],
      now,
    );
    const a = bodies.find((b) => b.sessionId === "a")!;
    const b = bodies.find((b) => b.sessionId === "b")!;
    const c = bodies.find((b) => b.sessionId === "c")!;
    // same repo → same base sector (jitter is small)
    expect(Math.abs(a.sectorAngle - b.sectorAngle)).toBeLessThan(0.2);
    expect(Math.abs(a.sectorAngle - c.sectorAngle)).toBeGreaterThan(0.2);
  });

  test("needs_input is always labeled and urgent", () => {
    const since = new Date(now - 3 * 60_000).toISOString();
    const bodies = buildScene(
      [sess({ id: "n", state: "needs_input", state_since: since, state_reason: "perm" })],
      now,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0].labelAlways).toBe(true);
    expect(bodies[0].reason).toBe("perm");
    expect(bodies[0].urgencyRadius).toBeLessThan(0.5);
  });

  test("clusters when over BODY_CAP", () => {
    const many: SessionSummary[] = [];
    for (let i = 0; i < BODY_CAP + 5; i++) {
      many.push(
        sess({
          id: `s${i}`,
          repo: i < BODY_CAP ? `solo-${i}` : "crowded",
          state: i === 0 ? "needs_input" : "working",
          events: i === 0 ? 100 : 1,
        }),
      );
    }
    const bodies = buildScene(many, now);
    const sessions = bodies.filter((b) => b.kind === "session");
    const clusters = bodies.filter((b) => b.kind === "cluster");
    expect(sessions.length).toBeLessThanOrEqual(BODY_CAP);
    expect(clusters.length).toBeGreaterThan(0);
    expect(bodies.some((b) => b.sessionId === "s0")).toBe(true); // urgent kept
  });

  test("done bodies get despawnAt", () => {
    const bodies = buildScene(
      [sess({ id: "d", state: "done", state_since: new Date(now).toISOString() })],
      now,
    );
    expect(bodies[0].despawnAt).toBe(now + DESPAWN_MS);
  });
});

describe("applyActivity", () => {
  test("updates the latest line for a live message", () => {
    const bodies = buildScene([sess({ id: "s1" })], now);
    const next = applyActivity(bodies, {
      id: "m1",
      time: "2026-07-08T12:05:01Z",
      source: "codex",
      session_id: "s1",
      category: "message",
      summary: "I’m checking the daemon.",
    } as FirehoseEvent);
    expect(next[0].lastSummary).toBe("I’m checking the daemon.");
    expect(next[0].lastCategory).toBe("message");
  });
});

describe("applyTransition", () => {
  test("updates matching body from state.transition", () => {
    const bodies = buildScene([sess({ id: "s1", state: "working" })], now);
    const ev = {
      id: "t1",
      time: new Date(now).toISOString(),
      source: "firehose",
      category: "meta",
      name: "state.transition",
      session_id: "s1",
      payload: { state: "needs_input", reason: "waiting", has_error: false },
    } as FirehoseEvent;
    const next = applyTransition(bodies, ev, now);
    expect(next[0].state).toBe("needs_input");
    expect(next[0].reason).toBe("waiting");
    expect(next[0].labelAlways).toBe(true);
  });

  test("reviving a completed body clears despawnAt", () => {
    const bodies = buildScene(
      [sess({ id: "s1", state: "done", state_since: new Date(now - 1000).toISOString() })],
      now,
    );
    expect(bodies[0].despawnAt).toBe(now - 1000 + DESPAWN_MS);
    const ev = {
      id: "t2",
      time: new Date(now).toISOString(),
      source: "firehose",
      category: "meta",
      name: "state.transition",
      session_id: "s1",
      payload: { state: "working", reason: "", has_error: false },
    } as FirehoseEvent;
    const next = applyTransition(bodies, ev, now);
    expect(next[0].state).toBe("working");
    expect(next[0].despawnAt).toBeUndefined();
  });
});
