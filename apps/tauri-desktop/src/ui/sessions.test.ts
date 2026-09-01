// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
const sessionEvents = vi.fn();
vi.mock("../api", () => ({
  sessions: () => sessions(),
  sessionEvents: (id: string) => sessionEvents(id),
}));

import { createSessions } from "./sessions";
import type { FirehoseEvent, SessionSummary } from "../api";

const now = Date.now();

function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: "claude-code",
    agent: "claude",
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

beforeEach(() => {
  sessions.mockReset();
  sessionEvents.mockReset();
});

describe("sessions band", () => {
  test("renders one band row per session, needs-you first, with sparkline, age, state, and reason", async () => {
    sessions.mockResolvedValue([
      summary({ id: "s1", last_summary: "edit view.go" }),
      summary({
        id: "s2",
        source: "codex",
        agent: "codex",
        state: "needs_input",
        state_since: new Date(now - 60_000).toISOString(),
        state_reason: "approve Bash",
        last_time: new Date(now - 60_000).toISOString(),
      }),
    ]);
    const events = [ev("s1", 5_000), ev("s1", 40_000), ev("s2", 60_000)];
    const panel = createSessions(() => {}, () => events);
    await panel.refresh();

    const rows = [...panel.root.querySelectorAll(".band-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".agent")?.textContent).toBe("codex");
    expect(rows[0].querySelector(".state")?.textContent).toBe("NEEDS YOU");
    expect(rows[0].querySelector(".summary")?.textContent).toBe("approve Bash");
    expect(rows[0].querySelector(".age")?.textContent).toBe("1m");
    expect(rows[1].querySelector(".spark")?.textContent).toMatch(/[▁▂▃▄▅▆▇█]/);
    expect(rows[1].querySelector(".summary")?.textContent).toBe("edit view.go");
    expect(panel.root.querySelector(".badge")).toBeNull();
  });

  test("a needs-you state from days ago neither leads nor lights up", async () => {
    sessions.mockResolvedValue([
      summary({ id: "ghost", source: "codex", agent: "codex", state: "needs_input", last_time: new Date(now - 48 * 3_600_000).toISOString() }),
      summary({ id: "fresh", last_time: new Date(now - 5_000).toISOString() }),
    ]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();

    const rows = [...panel.root.querySelectorAll(".band-row")];
    expect(rows.map((r) => r.querySelector(".agent")?.textContent)).toEqual(["claude", "codex"]);
    expect(rows[1].querySelector(".state")?.textContent).toBe("needs_input");
    expect(rows[1].querySelector(".state.needs")).toBeNull();
  });

  test("flags errors inline and opens the session on click", async () => {
    sessions.mockResolvedValue([summary({ id: "s1", has_error: true })]);
    sessionEvents.mockResolvedValue([]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();

    const row = panel.root.querySelector<HTMLElement>(".band-row")!;
    expect(row.querySelector(".err")?.textContent).toBe("!");
    row.click();
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledWith("s1"));
  });
});
