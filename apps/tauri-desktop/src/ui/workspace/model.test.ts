import { describe, expect, test } from "vitest";

import { buildMatrix, worstState } from "./model";
import type { FirehoseEvent, SessionSummary } from "../../api";

const now = Date.now();
const digest = "aa43f1ff4abc3b9ab1e0a477140f68ea761e0384110aa530c6de08642f762655";

function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: "claude-code",
    agent: "claude",
    cwd: "/home/me/dev/app",
    first_time: new Date(now - 600_000).toISOString(),
    last_time: new Date(now - 5_000).toISOString(),
    events: 3,
    state: "working",
    ...over,
  };
}

function ev(sessionId: string, ageMs: number): FirehoseEvent {
  return {
    id: `${sessionId}-${ageMs}`,
    time: new Date(now - ageMs).toISOString(),
    source: "claude-code",
    category: "tool",
    session_id: sessionId,
  } as FirehoseEvent;
}

describe("buildMatrix", () => {
  test("rows are workspaces by latest activity, columns are agents, cells fold their sessions", () => {
    const mx = buildMatrix(
      [
        summary({ id: "s1" }),
        summary({ id: "s1b", last_time: new Date(now - 30_000).toISOString() }),
        summary({ id: "s2", source: "codex", agent: "codex", state: "needs_input", state_since: new Date(now - 60_000).toISOString(), last_time: new Date(now - 60_000).toISOString() }),
        summary({ id: "s3", cwd: digest, last_time: new Date(now - 20_000).toISOString() }),
        summary({ id: "ghost", state: "needs_input", last_time: new Date(now - 48 * 3_600_000).toISOString() }),
      ],
      [ev("s1", 5_000), ev("s1", 40_000), ev("s1b", 30_000), ev("s2", 60_000)],
      now,
    );
    expect(mx.agents).toEqual(["claude", "codex"]);
    expect(mx.wheres.map((w) => w.label)).toEqual(["…/dev/app", "aa43f1ff"]);
    expect(mx.cells.map((c) => `${c.whereLabel}/${c.agent}`)).toEqual(["…/dev/app/claude", "…/dev/app/codex", "aa43f1ff/claude"]);
    const [app, codex, dig] = mx.cells;
    expect(app).toMatchObject({ sessions: 2, state: "working" });
    expect(app.buckets[9]).toBe(1);
    expect(app.buckets[8]).toBe(2);
    expect(codex).toMatchObject({ sessions: 1, state: "needs_input" });
    expect(dig.where).toBe(digest);
    expect(mx.at(digest, "codex")).toBeUndefined();
    expect(mx.at("/home/me/dev/app", "codex")).toBe(codex);
  });

  test("is empty when nothing is live", () => {
    expect(buildMatrix([], [], now).cells).toEqual([]);
  });
});

describe("worstState", () => {
  test("ranks needs over working over idle", () => {
    expect(worstState("idle", "working")).toBe("working");
    expect(worstState("working", "needs_input")).toBe("needs_input");
    expect(worstState("", "idle")).toBe("idle");
    expect(worstState("needs_input", "done")).toBe("needs_input");
  });
});
