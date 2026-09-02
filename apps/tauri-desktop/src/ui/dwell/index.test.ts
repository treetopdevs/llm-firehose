// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
vi.mock("../../api", () => ({ sessions: () => sessions() }));

import { createDwell } from "./index";
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

beforeEach(() => {
  sessions.mockReset();
});

describe("dwell panel", () => {
  test("draws one bar per live session against the five-minute hairline and opens a session on click", async () => {
    sessions.mockResolvedValue([
      summary({ id: "w" }),
      summary({
        id: "n",
        source: "codex",
        agent: "codex",
        state: "needs_input",
        state_since: new Date(now - 7 * 60_000).toISOString(),
        state_reason: "approve Bash",
        has_error: true,
      }),
      summary({ id: "ghost", state: "needs_input", state_since: new Date(now - 48 * 3_600_000).toISOString(), last_time: new Date(now - 48 * 3_600_000).toISOString() }),
    ]);
    const opened: string[] = [];
    const panel = createDwell((id) => opened.push(id), () => now);
    await panel.refresh();

    const rows = [...panel.root.querySelectorAll<HTMLElement>(".dwell-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".agent")?.textContent).toBe("codex");
    expect(rows[0].querySelector(".state")?.textContent).toBe("NEEDS YOU");
    expect(rows[0].querySelector(".state.needs")).not.toBeNull();
    expect(rows[0].querySelector<HTMLElement>(".dwell-bar")?.style.width).toBe("70%");
    expect(rows[0].querySelector(".dwell-label")?.textContent).toBe("7m");
    expect(rows[0].querySelector(".summary")?.textContent).toBe("approve Bash");
    expect(rows[0].querySelector(".err")?.textContent).toBe("!");
    expect(rows[1].querySelector<HTMLElement>(".dwell-bar")?.style.width).toBe("20%");
    expect(rows[1].querySelector(".dwell-label")?.textContent).toBe("2m");
    expect(panel.root.querySelectorAll(".dwell-hair")).toHaveLength(2);
    expect(panel.root.querySelector(".dwell-scale")?.textContent).toContain("5m");

    rows[0].click();
    expect(opened).toEqual(["n"]);
  });

  test("a live transition restarts the bar before the next fetch", async () => {
    sessions.mockResolvedValue([summary({ id: "w" })]);
    const panel = createDwell(() => {}, () => now);
    await panel.refresh();
    panel.onEvent({
      id: "t1",
      time: new Date(now).toISOString(),
      source: "firehose",
      name: "state.transition",
      category: "meta",
      session_id: "w",
      payload: { state: "needs_input", reason: "approve Edit" },
    } as FirehoseEvent);
    await vi.waitFor(() => {
      const row = panel.root.querySelector<HTMLElement>(".dwell-row")!;
      expect(row.querySelector(".state")?.textContent).toBe("NEEDS YOU");
      expect(row.querySelector(".summary")?.textContent).toBe("approve Edit");
      expect(parseFloat(row.querySelector<HTMLElement>(".dwell-bar")!.style.width)).toBeLessThan(1);
    });
  });

  test("keeps every transition delivered inside one frame", async () => {
    sessions.mockResolvedValue([summary({ id: "a" }), summary({ id: "b" })]);
    const panel = createDwell(() => {}, () => now);
    await panel.refresh();
    for (const id of ["a", "b"]) {
      panel.onEvent({
        id: `t-${id}`,
        time: new Date(now).toISOString(),
        source: "firehose",
        name: "state.transition",
        category: "meta",
        session_id: id,
        payload: { state: "needs_input", reason: `approve ${id}` },
      } as FirehoseEvent);
    }
    await vi.waitFor(() => {
      const states = [...panel.root.querySelectorAll(".dwell-row .state")].map((n) => n.textContent);
      expect(states).toEqual(["NEEDS YOU", "NEEDS YOU"]);
    });
  });

  test("opens from the keyboard and keeps focus across a redraw", async () => {
    sessions.mockResolvedValue([summary({ id: "w" }), summary({ id: "v" })]);
    const opened: string[] = [];
    const panel = createDwell((id) => opened.push(id), () => now);
    document.body.append(panel.root);
    await panel.refresh();
    const row = panel.root.querySelectorAll<HTMLElement>(".dwell-row")[1];
    expect(row.getAttribute("role")).toBe("button");
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual(["w"]); // rows with equal activity sort by id, so v then w
    await panel.refresh();
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key")).toBe("w");
    panel.root.remove();
  });

  test("says so when nothing is live", async () => {
    sessions.mockResolvedValue([]);
    const panel = createDwell(() => {});
    await panel.refresh();
    expect(panel.root.textContent).toContain("no live sessions");
  });
});
