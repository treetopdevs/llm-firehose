// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
vi.mock("../../api", () => ({ sessions: () => sessions() }));

import { createLanes } from "./index";
import type { FirehoseEvent, SessionSummary } from "../../api";

const now = Date.now();

function summary(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: "codex",
    agent: "codex",
    first_time: new Date(now - 600_000).toISOString(),
    last_time: new Date(now - 5_000).toISOString(),
    events: 3,
    state: "working",
    ...over,
  };
}

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

beforeEach(() => {
  sessions.mockReset();
});

describe("lanes panel", () => {
  test("draws one lane per live session with spans and ticks, and opens a session on click", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    const events = [
      ev("s1", 30_000, { call_id: "c1", payload: { phase: "start", tool_name: "Bash" } }),
      ev("s1", 10_000, { call_id: "c1", payload: { phase: "end", tool_name: "Bash" } }),
      ev("s1", 5_000, { severity: "error" }),
    ];
    const open = vi.fn();
    const panel = createLanes(() => events, open);
    await panel.refresh();

    const svg = panel.root.querySelector("svg")!;
    expect(svg.querySelectorAll(".lane-row")).toHaveLength(1);
    expect(svg.querySelectorAll(".lane-span")).toHaveLength(1);
    expect(svg.querySelectorAll(".lane-tick.error")).toHaveLength(1);
    expect(svg.querySelectorAll(".lane-axis text").length).toBeGreaterThan(0);

    svg.querySelector(".lane-row")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(open).toHaveBeenCalledWith("s1");
  });

  test("window buttons change the axis span", async () => {
    sessions.mockResolvedValue([]);
    const panel = createLanes(() => [], () => {});
    await panel.refresh();

    const btn = [...panel.root.querySelectorAll("button")].find((b) => b.textContent === "15m")!;
    btn.click();
    expect(btn.classList.contains("active")).toBe(true);
    // 15m across the fallback width takes a 5m step: exactly three labels.
    expect(panel.root.querySelectorAll(".lane-axis text")).toHaveLength(3);
  });
});
