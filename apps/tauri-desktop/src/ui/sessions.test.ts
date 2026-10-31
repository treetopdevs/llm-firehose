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
import { createScope } from "../scope";
import type { Scope } from "../scope";
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
    const last = (row: Element) => row.closest(".session-item")!.querySelector(".session-last")?.textContent;
    // No title captured and no checkout: the agent and a short id, never the UUID alone.
    expect(rows[0].querySelector(".name")?.textContent).toBe("codex · s2");
    expect(rows[0].querySelector(".state")?.textContent).toBe("NEEDS YOU");
    expect(last(rows[0])).toBe("approve Bash");
    expect(rows[0].querySelector(".age")?.textContent).toBe("1m");
    expect(rows[1].querySelector(".spark")?.textContent).toMatch(/[▁▂▃▄▅▆▇█]/);
    expect(last(rows[1])).toBe("edit view.go");
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
    expect(rows.map((r) => r.querySelector(".name")?.textContent)).toEqual(["claude · fresh", "codex · ghost"]);
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
    expect(rows[0].closest(".session-item")!.querySelector(".session-last")?.textContent).toBe("approve edit");
  });

  test("a captured title is the row's name; the checkout, start time and id are the details", async () => {
    sessions.mockResolvedValue([
      summary({ id: "2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c", title: "Redesign the Workflow section", cwd: "/Users/me/dev/app/.claude/worktrees/redesign-027da0", events: 51 }),
      summary({ id: "s2", cwd: "/Users/me/dev/app" }),
    ]);
    attentionSays([]);
    sessionEvents.mockResolvedValue([]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const items = [...panel.root.querySelectorAll<HTMLElement>(".session-item")];
    expect(items[0].querySelector(".name")?.textContent).toBe("Redesign the Workflow section");
    expect(items[0].querySelector(".session-facts")?.textContent).toMatch(/^claude · redesign-027da0 · started \d{2}:\d{2}:\d{2} · 51 events$/);
    expect(items[0].querySelector(".session-facts")?.getAttribute("title")).toBe("/Users/me/dev/app/.claude/worktrees/redesign-027da0");
    expect(items[0].querySelector(".session-id")?.textContent).toBe("2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c");
    expect(items[1].querySelector(".name")?.textContent).toBe("claude in app");
    items[0].click();
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledWith("2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c"));
    await vi.waitFor(() => expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("Redesign the Workflow section"));
    expect(panel.root.querySelector(".session-heading .session-id")?.textContent).toBe("2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c");
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

test("a session opened from another panel before the list loaded is still headed by its name", async () => {
  sessions.mockResolvedValue([summary({ id: "2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c", title: "Redesign the Workflow section", cwd: "/Users/me/dev/app" })]);
  attentionSays([]);
  sessionEvents.mockResolvedValue([]);
  const panel = createSessions(() => {}, () => []);
  await panel.openSession("2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c");
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("Redesign the Workflow section");
  expect(panel.root.querySelector(".session-heading .session-sub")?.textContent).toContain("claude-code · app · started");
});

test("a title that arrives on a later refresh updates the open history's heading", async () => {
  const id = "2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c";
  sessions.mockResolvedValue([summary({ id, cwd: "/Users/me/dev/app" })]);
  attentionSays([]);
  sessionEvents.mockResolvedValue([]);
  const panel = createSessions(() => {}, () => []);
  await panel.refresh();
  await panel.openSession(id);
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("claude in app");
  sessions.mockResolvedValue([summary({ id, cwd: "/Users/me/dev/app", title: "New title" })]);
  await panel.refresh();
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("New title");
  expect(panel.root.querySelector(".session-events-list")).not.toBeNull();
});

test("a source-qualified open is headed by that source's own title, not the aggregated row's", async () => {
  sessions.mockResolvedValue([summary({ id: "same", source: "codex", agent: "codex", title: "Codex task", cwd: "/Users/me/dev/app" })]);
  attentionSays([
    inbox({ id: "same", source: "codex", title: "Codex task" }),
    inbox({ id: "same", source: "opencode", title: "OpenCode task" }),
  ]);
  sessionEvents.mockResolvedValue([]);
  const panel = createSessions(() => {}, () => []);
  await panel.refresh();
  await panel.openSession("same", "opencode");
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("OpenCode task");
  expect(panel.root.querySelector(".session-heading .session-sub")?.textContent).toContain("opencode");
  await panel.openSession("same", "codex");
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("Codex task");
});

test("an unknown session id is headed by a short id, never the bare UUID", async () => {
  sessions.mockResolvedValue([]);
  attentionSays([]);
  sessionEvents.mockResolvedValue([]);
  const panel = createSessions(() => {}, () => []);
  await panel.openSession("2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c");
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("session 2ed4f8a3");
  expect(panel.root.querySelector(".session-heading .session-id")?.textContent).toBe("2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c");
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


test("a session row offers to open its score without opening the event list", async () => {
  sessions.mockResolvedValue([summary({ id: "s1" })]);
  const scored: string[] = [];
  const panel = createSessions(() => {}, () => [], (id) => scored.push(id));
  await panel.refresh();
  const btn = panel.root.querySelector<HTMLButtonElement>(".session-item .score-open")!;
  expect(btn.getAttribute("aria-label")).toBe("open score for session s1");
  btn.click();
  expect(scored).toEqual(["s1"]);
  expect(sessionEvents).not.toHaveBeenCalled();
});

test("without a score callback the row has no score button", async () => {
  sessions.mockResolvedValue([summary({ id: "s1" })]);
  const panel = createSessions(() => {}, () => []);
  await panel.refresh();
  expect(panel.root.querySelector(".score-open")).toBeNull();
});


describe("sessions panel reads the shared scope", () => {
  const CELL = { where: "/home/me/dev/app", agent: "claude", label: "app · claude" };
  const three = () => [
    summary({ id: "s1", cwd: "/home/me/dev/app" }),
    summary({ id: "s2", cwd: "/home/me/dev/app", source: "codex", agent: "codex" }),
    summary({ id: "s3", cwd: "/home/me/dev/lib" }),
  ];
  const ids = (panel: { root: HTMLElement }) => [...panel.root.querySelectorAll(".session-item")].map((n) => n.getAttribute("data-id"));
  const resolverOf = (members: ReadonlySet<string> | undefined) => {
    const calls: Scope[] = [];
    return { calls, sessions: (sc: Scope) => (calls.push(sc), members), labels: () => ({}) };
  };

  test("setScope(cell) writes store.cell; chip x narrows the store and refreshes", async () => {
    sessions.mockResolvedValue(three());
    const store = createScope();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    panel.setScope(CELL);
    expect(store.get().cell).toEqual(CELL);
    await panel.refresh();
    expect(ids(panel)).toEqual(["s1"]);
    const narrow = vi.spyOn(store, "narrow");
    panel.root.querySelector<HTMLElement>(".sessions-scope button")!.click();
    expect(narrow).toHaveBeenCalledWith({ cell: undefined });
    await vi.waitFor(() => expect(ids(panel)).toEqual(["s1", "s2", "s3"]));
    expect(store.get().cell).toBeUndefined();
    panel.setScope(CELL);
    panel.setScope(null);
    expect(store.get().cell).toBeUndefined();
  });

  test("a cell narrowed externally is honoured on the next refresh", async () => {
    sessions.mockResolvedValue(three());
    const store = createScope();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(ids(panel)).toEqual(["s1", "s2", "s3"]);
    store.narrow({ cell: CELL });
    await panel.refresh();
    expect(ids(panel)).toEqual(["s1"]);
    expect(panel.root.querySelector(".sessions-scope")?.textContent).toContain("app · claude");
  });

  test("resolver members filter the list for worktree and project scopes (event ids differ from graph ids)", async () => {
    sessions.mockResolvedValue(three());
    const store = createScope();
    const r = resolverOf(new Set(["s1"]));
    store.setResolver(r);
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    store.narrow({ project: "repo-graph-id", worktree: "ws-graph-id" });
    await panel.refresh();
    expect(ids(panel)).toEqual(["s1"]);
    store.narrow({ worktree: undefined });
    r.sessions = () => new Set(["s2", "s3"]);
    await panel.refresh();
    expect(ids(panel).sort()).toEqual(["s2", "s3"]);
    expect(r.calls[0].worktree).toBe("ws-graph-id");
  });

  test("a scoped refresh asks the resolver to re-read membership before filtering", async () => {
    sessions.mockResolvedValue(three());
    const store = createScope();
    let members = new Set(["s1"]);
    const refresh = vi.fn(async () => { members = new Set(["s1", "s3"]); });
    store.setResolver({ sessions: () => members, refresh, labels: () => ({}) });
    store.narrow({ worktree: "w" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(ids(panel)).toEqual(["s1", "s3"]);
  });

  test("source-qualified membership keeps only the matching (id, source)", async () => {
    sessions.mockResolvedValue([
      summary({ id: "dup", source: "codex", agent: "codex", cwd: "/a" }),
      summary({ id: "dup", source: "claude-code", cwd: "/b" }),
    ]);
    const store = createScope();
    store.setResolver({ sessions: () => new Set(["dup"]), matcher: () => (r) => r.source === "codex", labels: () => ({}) });
    store.narrow({ worktree: "w" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(panel.root.querySelectorAll(".session-item")).toHaveLength(1);
    expect(panel.root.textContent).toContain("codex");
  });

  test("project scope with no resolver, or an undefined answer, lists exactly what the empty scope lists", async () => {
    sessions.mockResolvedValue(three());
    const empty = createSessions(() => {}, () => [], undefined, undefined, createScope());
    await empty.refresh();
    const baseline = empty.root.innerHTML;

    const noResolver = createScope();
    noResolver.narrow({ project: "repo-graph-id" });
    const a = createSessions(() => {}, () => [], undefined, undefined, noResolver);
    await a.refresh();
    expect(a.root.innerHTML).toBe(baseline);

    const undef = createScope();
    undef.setResolver(resolverOf(undefined));
    undef.narrow({ project: "repo-graph-id" });
    const b = createSessions(() => {}, () => [], undefined, undefined, undef);
    await b.refresh();
    expect(b.root.innerHTML).toBe(baseline);
  });

  test("empty scope never consults the resolver, and scope.session alone does not filter", async () => {
    sessions.mockResolvedValue(three());
    const store = createScope();
    const r = resolverOf(new Set(["s1"]));
    store.setResolver(r);
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(r.calls).toHaveLength(0);
    expect(ids(panel)).toEqual(["s1", "s2", "s3"]);
    store.narrow({ session: { id: "s3" } });
    await panel.refresh();
    expect(ids(panel)).toEqual(["s1", "s2", "s3"]);
    expect(r.calls).toHaveLength(0);
  });

  test("empty text distinguishes a narrowed scope from a cell", async () => {
    sessions.mockResolvedValue(three());
    const store = createScope();
    store.setResolver(resolverOf(new Set(["nope"])));
    store.narrow({ worktree: "w" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(panel.root.textContent).toContain("no sessions in this scope");
    store.setResolver(resolverOf(new Set(["s1"])));
    await panel.refresh();
    expect(panel.root.textContent).toContain("active sessions in this scope");
    store.setResolver(resolverOf(new Set(["nope"])));
    store.narrow({ cell: { where: "/nowhere", agent: "claude", label: "x" } });
    store.setResolver(null);
    store.narrow({ worktree: undefined });
    await panel.refresh();
    expect(panel.root.textContent).toContain("no sessions in this cell");
    expect(panel.root.textContent).not.toContain("no sessions in this scope");
  });

  test("scope changed during an in-flight refresh is read after the awaits", async () => {
    let release!: (v: SessionSummary[]) => void;
    sessions.mockImplementationOnce(() => new Promise<SessionSummary[]>((r) => (release = r)));
    const store = createScope();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    const pending = panel.refresh();
    store.narrow({ cell: CELL });
    release(three());
    await pending;
    expect(ids(panel)).toEqual(["s1"]);
  });

  test("row click does not narrow session itself and does not call onSelect", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    sessionEvents.mockResolvedValue([]);
    const store = createScope();
    const narrow = vi.spyOn(store, "narrow");
    const onSelect = vi.fn();
    const panel = createSessions(onSelect, () => [], undefined, undefined, store);
    await panel.refresh();
    panel.root.querySelector<HTMLElement>(".band-row")!.click();
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledWith("s1"));
    expect(narrow).not.toHaveBeenCalled();
    expect(store.get().session).toBeUndefined();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("sessions history is invalidated by scope (F5)", () => {
  const A = { id: "A", source: "codex" };
  const deferred = () => {
    let resolve!: (e: FirehoseEvent[]) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<FirehoseEvent[]>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };

  test.each(["ascend", "narrow-undefined"])("late %s result for a dismissed session leaves history empty", async (how) => {
    for (const outcome of ["success", "failure"]) {
      sessionEvents.mockReset();
      const d = deferred();
      sessionEvents.mockImplementationOnce(() => d.promise);
      const store = createScope();
      store.narrow({ session: A });
      const panel = createSessions(() => {}, () => [], undefined, undefined, store);
      const open = panel.openSession("A", "codex");
      if (how === "ascend") expect(store.ascend()).toBe("fleet");
      else store.narrow({ session: undefined });
      expect(panel.root.querySelector(".sessions-events")?.textContent).toBe("");
      if (outcome === "success") d.resolve([{ ...ev("A", 0), source: "codex", summary: "late evidence" }]);
      else d.reject(new Error("late boom"));
      await open;
      expect(panel.root.querySelector(".sessions-events")?.textContent).toBe("");
      expect(panel.root.querySelector(".error")).toBeNull();
    }
  });

  test("history for the scoped session is kept when the store names the same (id,source)", async () => {
    sessionEvents.mockResolvedValue([{ ...ev("A", 0), source: "codex", summary: "kept evidence" }]);
    const store = createScope();
    store.narrow({ session: A });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.openSession("A", "codex");
    store.narrow({ window: { from: 1, to: 2 } });
    expect(panel.root.textContent).toContain("kept evidence");
  });

  test("a different (id,source) in scope clears the history and invalidates a pending load", async () => {
    sessionEvents.mockResolvedValue([{ ...ev("A", 0), source: "codex", summary: "A evidence" }]);
    const store = createScope();
    store.narrow({ session: A });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.openSession("A", "codex");
    expect(panel.root.textContent).toContain("A evidence");
    store.narrow({ session: { id: "A", source: "opencode" } });
    expect(panel.root.querySelector(".sessions-events")?.textContent).toBe("");

    const d = deferred();
    sessionEvents.mockImplementationOnce(() => d.promise);
    const pending = panel.openSession("A", "opencode");
    store.narrow({ session: { id: "B" } });
    d.resolve([{ ...ev("A", 0), source: "opencode", summary: "stale open" }]);
    await pending;
    expect(panel.root.textContent).not.toContain("stale open");
  });

  test("opening another cell clears loaded history", async () => {
    sessionEvents.mockResolvedValue([{ ...ev("A", 0), source: "codex", summary: "A evidence" }]);
    const store = createScope();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.openSession("A", "codex");
    expect(panel.root.textContent).toContain("A evidence");
    panel.setScope({ where: "/x", agent: "claude", label: "x · claude" });
    expect(panel.root.querySelector(".sessions-events")?.textContent).toBe("");
  });
});
