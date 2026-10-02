// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const attention = vi.fn();
vi.mock("../../api", () => ({ attention: () => attention() }));

import { createDwell } from "./index";
import type { AttentionEvidence, AttentionSession, AttentionSnapshot, FirehoseEvent } from "../../api";

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();

function evidence(at: number, over: Partial<AttentionEvidence> = {}): AttentionEvidence {
  return { event_id: `e-${at}`, source: "claude-code", kind: "activity", summary: "edit view.go", time: ago(at), observed_at: ago(at), ...over };
}

function session(over: Partial<AttentionSession> & { id: string }): AttentionSession {
  return { source: "claude-code", agent: "claude", cwd: "/home/me/dev/app", events: 3, state: "working", last: evidence(120_000), ...over };
}

function snapshot(sessions: AttentionSession[]): AttentionSnapshot {
  return { gaps: [], sessions, warnings: [] };
}

beforeEach(() => {
  attention.mockReset();
});

describe("dwell panel", () => {
  test("draws one bar per live session against the five-minute hairline and opens a session on click", async () => {
    attention.mockResolvedValue(
      snapshot([
        session({ id: "w" }),
        session({
          id: "n",
          source: "codex",
          agent: "codex",
          state: "needs_input",
          last: evidence(10_000),
          pending: evidence(7 * 60_000, { kind: "request", summary: "approve Bash", episode_id: "ep" }),
        }),
        session({ id: "ghost", state: "needs_input", last: evidence(48 * 3_600_000), pending: evidence(48 * 3_600_000, { kind: "request" }) }),
      ]),
    );
    const opened: [string, string | undefined][] = [];
    const panel = createDwell((id, source) => opened.push([id, source]), () => now);
    await panel.refresh();

    const rows = [...panel.root.querySelectorAll<HTMLElement>(".dwell-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".agent")?.textContent).toBe("codex");
    expect(rows[0].querySelector(".state")?.textContent).toBe("NEEDS YOU");
    expect(rows[0].querySelector(".state.needs")).not.toBeNull();
    expect(rows[0].querySelector<HTMLElement>(".dwell-bar")?.style.width).toBe("70%");
    expect(rows[0].querySelector(".dwell-label")?.textContent).toBe("7m");
    expect(rows[0].querySelector(".summary")?.textContent).toBe("approve Bash");
    expect(rows[1].querySelector<HTMLElement>(".dwell-bar")?.style.width).toBe("20%");
    expect(rows[1].querySelector(".dwell-label")?.textContent).toBe("2m");
    expect(panel.root.querySelectorAll(".dwell-hair")).toHaveLength(2);
    expect(panel.root.querySelector(".dwell-scale")?.textContent).toContain("5m");

    rows[0].click();
    expect(opened).toEqual([["n", "codex"]]);
  });

  test("a bare notification does not say NEEDS YOU, matching the attention strip", async () => {
    attention.mockResolvedValue(
      snapshot([session({ id: "u", last: evidence(5_000, { summary: "notification" }), uncertainty: "Notification captured; whether input is required is unknown." })]),
    );
    const panel = createDwell(() => {}, () => now);
    await panel.refresh();
    const row = panel.root.querySelector<HTMLElement>(".dwell-row")!;
    expect(row.querySelector(".state")?.textContent).toBe("working");
    expect(row.querySelector(".state.needs")).toBeNull();
  });

  test("captured session activity on the live stream triggers a refetch", async () => {
    attention.mockResolvedValue(snapshot([session({ id: "w" })]));
    const panel = createDwell(() => {}, () => now);
    await panel.refresh();
    attention.mockResolvedValue(
      snapshot([session({ id: "w", state: "needs_input", last: evidence(0), pending: evidence(0, { kind: "request", summary: "approve Edit" }) })]),
    );
    panel.onEvent({ id: "x1", time: ago(0), source: "claude-code", name: "Notification", category: "permission", session_id: "w" } as FirehoseEvent);
    await vi.waitFor(() => {
      const row = panel.root.querySelector<HTMLElement>(".dwell-row")!;
      expect(row.querySelector(".state")?.textContent).toBe("NEEDS YOU");
      expect(row.querySelector(".summary")?.textContent).toBe("approve Edit");
    });
  });

  test("coalesces a burst of stream events into one fetch at a time", async () => {
    attention.mockResolvedValue(snapshot([session({ id: "w" })]));
    const panel = createDwell(() => {}, () => now);
    await panel.refresh();
    attention.mockClear();
    let release!: (v: AttentionSnapshot) => void;
    attention.mockReturnValue(new Promise<AttentionSnapshot>((r) => (release = r)));
    for (let i = 0; i < 5; i++) {
      panel.onEvent({ id: `b${i}`, time: ago(0), source: "claude-code", name: "PostToolUse", category: "tool", session_id: "w" } as FirehoseEvent);
    }
    await vi.waitFor(() => expect(attention).toHaveBeenCalledTimes(1));
    release(snapshot([session({ id: "w" })]));
    // Events that arrived mid-flight earn exactly one follow-up fetch.
    await vi.waitFor(() => expect(attention).toHaveBeenCalledTimes(2));
  });

  test("ignores the engine's synthetic frames", async () => {
    attention.mockResolvedValue(snapshot([session({ id: "w" })]));
    const panel = createDwell(() => {}, () => now);
    await panel.refresh();
    attention.mockClear();
    panel.onEvent({ id: "t1", time: ago(0), source: "firehose", name: "state.transition", category: "meta", session_id: "w", payload: { state: "needs_input" } } as FirehoseEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(attention).not.toHaveBeenCalled();
  });

  test("opens from the keyboard and keeps focus across a redraw", async () => {
    attention.mockResolvedValue(snapshot([session({ id: "w" }), session({ id: "v" })]));
    const opened: string[] = [];
    const panel = createDwell((id) => opened.push(id), () => now);
    document.body.append(panel.root);
    await panel.refresh();
    const row = panel.root.querySelectorAll<HTMLElement>(".dwell-row")[1];
    expect(row.getAttribute("role")).toBe("button");
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened).toEqual(["w"]); // rows with equal activity sort by key, so v then w
    await panel.refresh();
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key")).toBe(JSON.stringify(["claude-code", "w"]));
    panel.root.remove();
  });

  test("says so when nothing is live", async () => {
    attention.mockResolvedValue(snapshot([]));
    const panel = createDwell(() => {});
    await panel.refresh();
    expect(panel.root.textContent).toContain("no live sessions");
  });
});
