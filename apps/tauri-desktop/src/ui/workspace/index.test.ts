// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
vi.mock("../../api", () => ({ sessions: () => sessions() }));

import { createWorkspace } from "./index";
import type { FirehoseEvent, SessionSummary } from "../../api";
import type { CellScope } from "./model";

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
});

describe("workspace panel", () => {
  test("draws the matrix and opens a cell on click", async () => {
    sessions.mockResolvedValue([
      summary({ id: "s1" }),
      summary({ id: "s1b" }),
      summary({ id: "s2", source: "codex", agent: "codex", state: "needs_input", state_since: new Date(now - 60_000).toISOString(), last_time: new Date(now - 60_000).toISOString() }),
      summary({ id: "s3", cwd: "/home/me/dev/lib", last_time: new Date(now - 20_000).toISOString() }),
    ]);
    const opened: CellScope[] = [];
    const panel = createWorkspace(() => [ev("s1", 5_000)], (scope) => opened.push(scope));
    await panel.refresh();

    const heads = [...panel.root.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(heads).toEqual(["", "claude", "codex"]);
    const rowLabels = [...panel.root.querySelectorAll("tbody th")].map((th) => th.textContent);
    expect(rowLabels).toEqual(["…/dev/app", "…/dev/lib"]);
    const cells = [...panel.root.querySelectorAll<HTMLElement>("td.matrix-cell")];
    expect(cells).toHaveLength(3);
    expect(cells[0].querySelector(".spark")?.textContent).toMatch(/[▁▂▃▄▅▆▇█]/);
    expect(cells[0].querySelector(".glyph")?.textContent).toBe("●");
    expect(cells[0].querySelector(".count")?.textContent).toBe("2");
    expect(cells[1].querySelector(".glyph.needs")?.textContent).toBe("?");
    expect(cells[1].querySelector(".count")?.textContent).toBe("");
    expect(panel.root.querySelectorAll("td.empty")).toHaveLength(1);

    cells[1].click();
    expect(opened).toEqual([{ where: "/home/me/dev/app", agent: "codex", label: "…/dev/app · codex" }]);
  });

  test("says so when nothing is live", async () => {
    sessions.mockResolvedValue([]);
    const panel = createWorkspace(() => [], () => {});
    await panel.refresh();
    expect(panel.root.textContent).toContain("no live sessions");
  });
});
