// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
const sessionEvents = vi.fn();
const attention = vi.fn();
vi.mock("../api", () => ({
  sessions: () => sessions(),
  sessionEvents: (id: string) => sessionEvents(id),
  attention: () => attention(),
}));

import { createSessions } from "./sessions";
import type { AttentionEvidence, AttentionSession, FirehoseEvent, SessionSummary } from "../api";

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

function evidence(ageMs: number, over: Partial<AttentionEvidence> = {}): AttentionEvidence {
  const at = new Date(now - ageMs).toISOString();
  return { event_id: `e-${ageMs}`, source: "claude-code", kind: "activity", summary: "", time: at, observed_at: at, ...over };
}

function inbox(over: Partial<AttentionSession> & { id: string }): AttentionSession {
  return { source: "claude-code", events: 1, state: "working", last: evidence(5_000), ...over };
}

function attentionSays(entries: AttentionSession[]) {
  attention.mockResolvedValue({ gaps: [], sessions: entries, warnings: [] });
}

beforeEach(() => {
  sessions.mockReset();
  sessionEvents.mockReset();
  attention.mockReset();
  attentionSays([]);
});

describe("sessions band", () => {
  test("renders one band row per session, needs-you first, with sparkline, age, state, and reason", async () => {
    sessions.mockResolvedValue([
      summary({ id: "s1", last_summary: "edit view.go" }),
      summary({
        id: "s2",
        source: "codex",
        agent: "codex",
        state: "working",
        last_time: new Date(now - 60_000).toISOString(),
      }),
    ]);
    attentionSays([
      inbox({ id: "s1" }),
      inbox({ id: "s2", source: "codex", state: "needs_input", last: evidence(60_000), pending: evidence(60_000, { kind: "request", summary: "approve Bash" }) }),
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
    attentionSays([
      inbox({ id: "ghost", source: "codex", state: "needs_input", last: evidence(48 * 3_600_000), pending: evidence(48 * 3_600_000, { kind: "request" }) }),
      inbox({ id: "fresh" }),
    ]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();

    const rows = [...panel.root.querySelectorAll(".band-row")];
    expect(rows.map((r) => r.querySelector(".agent")?.textContent)).toEqual(["claude", "codex"]);
    expect(rows[1].querySelector(".state")?.textContent).toBe("needs_input");
    expect(rows[1].querySelector(".state.needs")).toBeNull();
  });

  test("a bare notification that /sessions calls needs_input does not say NEEDS YOU, matching the strip", async () => {
    sessions.mockResolvedValue([summary({ id: "n", state: "needs_input", state_reason: "notification", last_summary: "notification" })]);
    attentionSays([inbox({ id: "n", state: "unknown", uncertainty: "Notification captured; whether input is required is unknown." })]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const row = panel.root.querySelector<HTMLElement>(".band-row")!;
    expect(row.querySelector(".state")?.textContent).toBe("unknown");
    expect(row.querySelector(".state.needs")).toBeNull();
  });

  test("a session /attention does not know is never NEEDS YOU", async () => {
    sessions.mockResolvedValue([summary({ id: "legacy", state: "needs_input" })]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const row = panel.root.querySelector<HTMLElement>(".band-row")!;
    expect(row.querySelector(".state")?.textContent).toBe("unknown");
    expect(row.querySelector(".state.needs")).toBeNull();
  });

  test("a pending request from any source sharing the native id lights the aggregate row", async () => {
    sessions.mockResolvedValue([summary({ id: "same", source: "codex" }), summary({ id: "other", last_time: new Date(now - 1_000).toISOString() })]);
    attentionSays([
      inbox({ id: "same", source: "codex" }),
      inbox({ id: "same", source: "opencode", state: "needs_input", pending: evidence(30_000, { kind: "request", summary: "approve edit" }) }),
      inbox({ id: "other" }),
    ]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const rows = [...panel.root.querySelectorAll(".band-row")];
    expect(rows[0].querySelector(".state")?.textContent).toBe("NEEDS YOU");
    expect(rows[0].querySelector(".summary")?.textContent).toBe("approve edit");
  });

  test("a captured failure reads FAILED and leads", async () => {
    sessions.mockResolvedValue([summary({ id: "ok", last_time: new Date(now - 1_000).toISOString() }), summary({ id: "f" })]);
    attentionSays([inbox({ id: "ok" }), inbox({ id: "f", state: "failed", pending: evidence(20_000, { kind: "failure", summary: "StopFailure" }) })]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const first = panel.root.querySelector<HTMLElement>(".band-row")!;
    expect(first.querySelector(".state")?.textContent).toBe("FAILED");
    expect(first.querySelector(".state.needs")).not.toBeNull();
  });

  test("still lists sessions when /attention is unavailable, without asserting anyone needs you", async () => {
    sessions.mockResolvedValue([summary({ id: "s1", state: "needs_input" })]);
    attention.mockRejectedValue(new Error("down"));
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const row = panel.root.querySelector<HTMLElement>(".band-row")!;
    expect(row.querySelector(".state")?.textContent).toBe("unknown");
    expect(panel.root.querySelector(".error")).toBeNull();
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

describe("sessions scope", () => {
  test("narrows the list to one workspace × agent cell and clears it from the chip", async () => {
    sessions.mockResolvedValue([
      summary({ id: "s1", cwd: "/home/me/dev/app" }),
      summary({ id: "s2", cwd: "/home/me/dev/app", source: "codex", agent: "codex" }),
      summary({ id: "s3", cwd: "/home/me/dev/lib" }),
    ]);
    const panel = createSessions(() => {}, () => []);
    panel.setScope({ where: "/home/me/dev/app", agent: "claude", label: "…/dev/app · claude" });
    await panel.refresh();

    const ids = () => [...panel.root.querySelectorAll(".session-id")].map((n) => n.textContent);
    expect(ids()).toEqual(["s1"]);
    const chip = panel.root.querySelector<HTMLElement>(".sessions-scope")!;
    expect(chip.textContent).toContain("…/dev/app · claude");
    chip.querySelector("button")!.click();
    await vi.waitFor(() => expect(ids()).toEqual(["s1", "s2", "s3"]));
    expect(panel.root.querySelector(".sessions-scope")).toBeNull();
  });
});

test("attention history can restrict a shared native session ID to its source",async()=>{
 sessionEvents.mockResolvedValue([
  {id:"c1",source:"codex",session_id:"same",category:"prompt",time:new Date(now).toISOString(),summary:"codex evidence"},
  {id:"o1",source:"opencode",session_id:"same",category:"prompt",time:new Date(now).toISOString(),summary:"other evidence"},
 ]);
 const p=createSessions(()=>{},()=>[]);await p.openSession("same","codex");
 expect(p.root.textContent).toContain("codex evidence");expect(p.root.textContent).not.toContain("other evidence");
});


test.each(["success", "error"])("ignores stale history %s after selecting another source", async (outcome) => {
  let finish!: (events: FirehoseEvent[]) => void;
  let fail!: (reason: Error) => void;
  sessionEvents.mockImplementationOnce(() => new Promise<FirehoseEvent[]>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  }));
  sessionEvents.mockResolvedValueOnce([
    { ...ev("same", 0), source: "opencode", summary: "current source evidence" },
  ]);
  const panel = createSessions(() => {}, () => []);
  const previous = panel.openSession("same", "codex");
  await panel.openSession("same", "opencode");
  if (outcome === "success") {
    finish([{ ...ev("same", 1000), source: "codex", summary: "stale source evidence" }]);
  } else {
    fail(new Error("stale request failed"));
  }
  await previous;
  expect(panel.root.textContent).toContain("current source evidence");
  expect(panel.root.textContent).not.toContain("stale source evidence");
  expect(panel.root.textContent).not.toContain("stale request failed");
});


test("ordinary aggregate session rows retain history from every source", async () => {
  sessions.mockResolvedValue([summary({ id: "same", source: "codex", events: 2 })]);
  sessionEvents.mockResolvedValue([
    { ...ev("same", 1000), source: "codex", summary: "codex aggregate evidence" },
    { ...ev("same", 0), source: "opencode", summary: "opencode aggregate evidence" },
  ]);
  const panel = createSessions(() => {}, () => []);
  await panel.refresh();
  panel.root.querySelector<HTMLElement>(".session-item")!.click();
  await vi.waitFor(() => {
    expect(panel.root.textContent).toContain("codex aggregate evidence");
    expect(panel.root.textContent).toContain("opencode aggregate evidence");
  });
});
