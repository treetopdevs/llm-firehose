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
    expect(rows[0].querySelector(".state")?.textContent).toBe("needs you");
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
    expect(rows[1].querySelector(".state")?.textContent).toBe("needs you");
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
    expect(rows[0].querySelector(".state")?.textContent).toBe("needs you");
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

  test("a captured failure reads failed and leads", async () => {
    sessions.mockResolvedValue([summary({ id: "ok", last_time: new Date(now - 1_000).toISOString() }), summary({ id: "f" })]);
    attentionSays([inbox({ id: "ok" }), inbox({ id: "f", state: "failed", pending: evidence(20_000, { kind: "failure", summary: "StopFailure" }) })]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const first = panel.root.querySelector<HTMLElement>(".band-row")!;
    expect(first.querySelector(".state")?.textContent).toBe("failed");
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
    expect(row.querySelector(".err")?.getAttribute("role")).toBe("img");
    expect(row.querySelector(".err")?.getAttribute("aria-label")).toBe("error captured");
    expect(row.querySelector(".err")?.getAttribute("title")).toBeTruthy();
    row.click();
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledWith("s1"));
  });
});

test("a row without an error carries no image role or label on its error cell", async () => {
  sessions.mockResolvedValue([summary({ id: "s1" })]);
  sessionEvents.mockResolvedValue([]);
  const panel = createSessions(() => {}, () => []);
  await panel.refresh();
  const err = panel.root.querySelector(".band-row .err")!;
  expect(err.hasAttribute("role")).toBe(false);
  expect(err.hasAttribute("aria-label")).toBe(false);
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
  expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("2ed4f8a3");
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
    const chip = panel.root.querySelector<HTMLElement>(".sessions-cell")!;
    expect(chip.textContent).toContain("…/dev/app · claude");
    chip.querySelector("button")!.click();
    await vi.waitFor(() => expect(ids()).toEqual(["s1", "s2", "s3"]));
    expect(panel.root.querySelector(".sessions-cell")).toBeNull();
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
  expect(btn.getAttribute("aria-label")).toBe("open score for claude · s1");
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
    panel.root.querySelector<HTMLElement>(".sessions-cell button")!.click();
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
    expect(panel.root.querySelector(".sessions-cell")?.textContent).toContain("app · claude");
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

  test("a fallback-only resolver scopes the worktree list", async () => {
    sessions.mockResolvedValue([
      summary({ id: "s1", source: "codex", agent: "codex" }),
      summary({ id: "s1", source: "claude-code" }),
      summary({ id: "s3" }),
    ]);
    const store = createScope();
    store.setFallbackResolver({ sessions: () => undefined, matcher: () => (r) => r.id === "s1" && r.source === "codex", labels: () => ({}) });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    store.narrow({ project: "repoA", worktree: "wt-open" });
    await panel.refresh();
    expect(ids(panel)).toEqual(["s1"]);
    expect(panel.root.textContent).toContain("active sessions in this scope");
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
    const baseline = empty.root.querySelector(".sessions-list")!.innerHTML;

    const noResolver = createScope();
    noResolver.narrow({ project: "repo-graph-id" });
    const a = createSessions(() => {}, () => [], undefined, undefined, noResolver);
    await a.refresh();
    expect(a.root.querySelector(".sessions-list")!.innerHTML).toBe(baseline);

    const undef = createScope();
    undef.setResolver(resolverOf(undefined));
    undef.narrow({ project: "repo-graph-id" });
    const b = createSessions(() => {}, () => [], undefined, undefined, undef);
    await b.refresh();
    expect(b.root.querySelector(".sessions-list")!.innerHTML).toBe(baseline);
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
    expect(panel.root.textContent).toContain("no sessions in this worktree");
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

  test("score and loops buttons and the row carry the session's source", async () => {
    sessions.mockResolvedValue([summary({ id: "dup", source: "codex" })]);
    attention.mockResolvedValue({ sessions: [] });
    const onScore = vi.fn();
    const onLoops = vi.fn();
    const panel = createSessions(() => {}, () => [], onScore, onLoops, createScope());
    await panel.refresh();
    const item = panel.root.querySelector<HTMLElement>(".session-item")!;
    expect(item.dataset.source).toBe("codex");
    panel.root.querySelector<HTMLElement>(".score-open")!.click();
    panel.root.querySelector<HTMLElement>(".loops-open")!.click();
    expect(onScore).toHaveBeenCalledWith("dup", "codex");
    expect(onLoops).toHaveBeenCalledWith("dup", "codex");
  });

  test("a partial scope membership is stated in the scope note", async () => {
    sessions.mockResolvedValue([summary({ id: "a" })]);
    attention.mockResolvedValue({ sessions: [] });
    const store = createScope();
    store.setFallbackResolver({ sessions: () => undefined, matcher: () => () => true, partial: () => ({ known: 200, total: 350 }), labels: () => ({}) });
    store.narrow({ project: "p" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-scope-note")!.textContent).toContain("200 of 350 sessions known");
  });
});

describe("sessions heading", () => {
  test("opens with an h2 equal to the nav label", () => {
    const p = createSessions(() => {}, () => []);
    expect(p.root.firstElementChild?.tagName).toBe("H2");
    expect(p.root.firstElementChild?.textContent).toBe("Worktree");
  });
});

describe("session directory", () => {
  const id = "2ed4f8a3-0bf0-47dc-8b7b-63aa59de602c";

  test("each refresh remembers the list and the inbox sessions", async () => {
    const { createSessionDirectory } = await import("../session-directory");
    const directory = createSessionDirectory();
    sessions.mockResolvedValue([summary({ id, title: "From list" })]);
    attentionSays([inbox({ id: "inbox-only", source: "codex", title: "From inbox" })]);
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), directory);
    await panel.refresh();
    expect(directory.lookup({ id, source: "claude-code" })?.title).toBe("From list");
    expect(directory.lookup({ id: "inbox-only", source: "codex" })?.title).toBe("From inbox");
  });

  test("the history heading uses the directory for a session the list does not hold", async () => {
    const { createSessionDirectory } = await import("../session-directory");
    const directory = createSessionDirectory();
    directory.remember([{ id, source: "codex", title: "Remembered title" }]);
    sessions.mockResolvedValue([]);
    sessionEvents.mockResolvedValue([]);
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), directory);
    await panel.openSession(id, "codex");
    expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("Remembered title");
  });
});

test("score and loops buttons name the session by its title, not its id", async () => {
  sessions.mockResolvedValue([summary({ id: "2385e3bc-1111-2222", title: "Fix login bug" })]);
  const panel = createSessions(() => {}, () => [], () => {}, () => {});
  await panel.refresh();
  expect(panel.root.querySelector(".score-open")!.getAttribute("aria-label")).toBe("open score for Fix login bug");
  expect(panel.root.querySelector(".loops-open")!.getAttribute("aria-label")).toBe("open loops for Fix login bug");
});

describe("session cards are keyboard operable", () => {
  const press = (n: Element, key: string) => n.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const item = (panel: { root: HTMLElement }, id: string) => panel.root.querySelector<HTMLElement>(`.session-item[data-id='${id}']`)!;

  test.each(["click", "Enter", " "])("%s on a card selects the session, then opens its history exactly once", async (how) => {
    sessions.mockResolvedValue([summary({ id: "s1", source: "codex", agent: "codex" })]);
    sessionEvents.mockResolvedValue([]);
    const order: string[] = [];
    const onSelectSession = vi.fn(() => order.push("select"));
    sessionEvents.mockImplementation(async () => { order.push("history"); return []; });
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), undefined, onSelectSession);
    await panel.refresh();
    const card = item(panel, "s1");
    expect(card.getAttribute("role")).toBe("group");
    for (const c of ["score-open", "loops-open", "session-id"]) { const n = card.querySelector(`.${c}`); if (n) expect(n.closest('[role="button"]'), c).toBeNull(); }
    expect(card.getAttribute("aria-label")).toMatch(/^open .+/);
    if (how === "click") card.click();
    else press(card, how);
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledTimes(1));
    expect(onSelectSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).toHaveBeenCalledWith({ id: "s1", source: "codex" });
    expect(order).toEqual(["select", "history"]);
  });

  test("Enter on a nested score button or id chip does not select or open", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    sessionEvents.mockResolvedValue([]);
    const onSelectSession = vi.fn();
    const onOpenScore = vi.fn();
    const panel = createSessions(() => {}, () => [], onOpenScore, undefined, createScope(), undefined, onSelectSession);
    await panel.refresh();
    const score = panel.root.querySelector<HTMLElement>(".score-open")!;
    const chip = panel.root.querySelector<HTMLElement>(".session-id")!;
    for (const n of [score, chip]) {
      expect(press(n, "Enter") && true).toBe(true);
      expect(press(n, " ") && true).toBe(true);
    }
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(sessionEvents).not.toHaveBeenCalled();
  });
});

describe("session list focus survives the periodic refresh", () => {
  const mount = async (ids: string[]) => {
    sessions.mockResolvedValue(ids.map((id) => summary({ id })));
    sessionEvents.mockResolvedValue([]);
    const panel = createSessions(() => {}, () => [], () => {});
    document.body.append(panel.root);
    await panel.refresh();
    return panel;
  };
  const q = (panel: { root: HTMLElement }, sel: string) => panel.root.querySelector<HTMLElement>(sel)!;

  test("a focused card is the same session's card after a refresh", async () => {
    const panel = await mount(["s1", "s2"]);
    q(panel, ".session-item[data-id='s2']").focus();
    expect(document.activeElement?.getAttribute("data-id")).toBe("s2");
    await panel.refresh();
    expect(document.activeElement).toBe(q(panel, ".session-item[data-id='s2']"));
    panel.root.remove();
  });

  test("a focused nested control stays on the same session's control", async () => {
    const panel = await mount(["s1", "s2"]);
    q(panel, ".session-item[data-id='s2'] .score-open").focus();
    await panel.refresh();
    expect(document.activeElement).toBe(q(panel, ".session-item[data-id='s2'] .score-open"));
    q(panel, ".session-item[data-id='s1'] .session-id").focus();
    await panel.refresh();
    expect(document.activeElement).toBe(q(panel, ".session-item[data-id='s1'] .session-id"));
    panel.root.remove();
  });

  test("a removed focused session hands focus to the nearest survivor, then the list, never body", async () => {
    const panel = await mount(["s1", "s2", "s3"]);
    const order = [...panel.root.querySelectorAll(".session-item")].map((n) => n.getAttribute("data-id"));
    const mid = order[1]!;
    q(panel, `.session-item[data-id='${mid}']`).focus();
    sessions.mockResolvedValue(order.filter((id) => id !== mid).map((id) => summary({ id: id! })));
    await panel.refresh();
    expect(document.activeElement).toBe(q(panel, `.session-item[data-id='${order[2]}']`));
    q(panel, `.session-item[data-id='${order[2]}']`).focus();
    sessions.mockResolvedValue([summary({ id: "other" })]);
    await panel.refresh();
    // Nothing focused survives: the list container, not body.
    expect(document.activeElement).toBe(q(panel, ".sessions-list"));
    q(panel, ".session-item[data-id='other']").focus();
    sessions.mockResolvedValue([]);
    await panel.refresh();
    expect(document.activeElement).toBe(q(panel, ".sessions-list"));
    expect(document.activeElement).not.toBe(document.body);
    panel.root.remove();
  });
});

describe("Worktree rung", () => {
  const WT = "wt-abcdefghij";

  test("p.sessions-scope names the scope, never a raw path or .git", () => {
    const store = createScope();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    const line = () => panel.root.querySelector<HTMLElement>("p.sessions-scope")!;
    expect(line().textContent).toBe("Sessions in all worktrees");
    store.narrow({ worktree: WT });
    expect(line().textContent).toBe("wt-abcde");
    expect(line().title).toBe(WT);
    store.setResolver({ sessions: () => undefined, labels: () => ({ worktree: "/Users/n/develop/browser-life/.git/worktrees/foo" }) });
    store.touchResolver();
    expect(line().textContent).toBe("foo");
    expect(line().textContent).not.toContain(".git");
    expect(line().textContent).not.toContain("/");
  });

  test("Needs you toggle swaps the list for the inbox without touching scope", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    const store = createScope();
    store.narrow({ project: "p" });
    const before = store.get();
    const inboxRoot = document.createElement("section");
    inboxRoot.className = "attention-inbox";
    const refreshInbox = vi.fn(async () => {});
    const panel = createSessions(() => {}, () => [], undefined, undefined, store, undefined, undefined, { inbox: { root: inboxRoot, refresh: refreshInbox, count: () => 2 } });
    await panel.refresh();
    const btn = panel.root.querySelector<HTMLButtonElement>("button.sessions-needs")!;
    const list = panel.root.querySelector<HTMLElement>(".sessions-list")!;
    expect(btn.textContent).toContain("Needs you");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(inboxRoot.closest<HTMLElement>(".sessions-inbox")!.hidden).toBe(true);
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(list.hidden).toBe(true);
    expect(inboxRoot.closest<HTMLElement>(".sessions-inbox")!.hidden).toBe(false);
    expect(panel.root.querySelector(".sessions-inbox-caption")?.textContent).toBe("Needs you, across all projects");
    expect(panel.root.querySelector(".sessions-needs-count")?.textContent).toBe(" (2)");
    expect(store.get()).toBe(before);
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(list.hidden).toBe(false);
  });

  test("the Needs you count follows the attention count on refresh", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    let n = 3;
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), undefined, undefined, { inbox: { root: document.createElement("section"), refresh: async () => {}, count: () => n } });
    await panel.refresh();
    const badge = () => panel.root.querySelector(".sessions-needs-count")?.textContent;
    expect(badge()).toBe(" (3)");
    n = 0;
    await panel.refresh();
    expect(badge()).toBe(" (0)");
  });

  test("the periodic poll skips while a request is pending, so a slow response still renders", async () => {
    vi.useFakeTimers();
    try {
      sessions.mockImplementation(() => new Promise((r) => setTimeout(() => r([summary({ id: "slow" })]), 6000)));
      attention.mockResolvedValue({ sessions: [], warnings: [] });
      const panel = createSessions(() => {}, () => []);
      document.body.append(panel.root);
      void panel.refresh();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sessions).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(panel.root.querySelectorAll(".session-item")).toHaveLength(1);
      panel.root.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  test("the Needs you badge updates synchronously when the inbox count changes", async () => {
    let n = 1;
    let fire: () => void = () => {};
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), undefined, undefined, { inbox: { root: document.createElement("section"), refresh: async () => {}, count: () => n, onCount: (fn) => { fire = fn; } } });
    const badge = () => panel.root.querySelector(".sessions-needs-count")?.textContent;
    fire();
    expect(badge()).toBe(" (1)");
    n = 0;
    fire();
    expect(badge()).toBe(" (0)");
  });

  test("activate({needsOnly}) sets the state and refreshes the inbox once; activate() keeps it", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    const refreshInbox = vi.fn(async () => {});
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), undefined, undefined, { inbox: { root: document.createElement("section"), refresh: refreshInbox } });
    await panel.activate({ needsOnly: true });
    expect(panel.needsOnly()).toBe(true);
    expect(refreshInbox).toHaveBeenCalledTimes(1);
    await panel.activate();
    expect(panel.needsOnly()).toBe(true);
    panel.setNeedsOnly(false);
    expect(panel.needsOnly()).toBe(false);
    expect(panel.root.querySelector<HTMLElement>(".sessions-list")!.hidden).toBe(false);
    await panel.activate();
    expect(panel.needsOnly()).toBe(false);
  });

  test("a late refresh never overwrites a newer one", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    let releaseA!: (v: unknown) => void;
    attention.mockImplementationOnce(() => new Promise((r) => { releaseA = r; }));
    const panel = createSessions(() => {}, () => []);
    const a = panel.refresh();
    attentionSays([inbox({ id: "s1", state: "needs_input", pending: evidence(1000, { kind: "request", summary: "need" }) })]);
    await panel.refresh();
    const resolved = panel.root.querySelector(".sessions-list")!.innerHTML;
    expect(resolved).toContain("needs");
    releaseA({ gaps: [], sessions: [], warnings: [] });
    await a;
    expect(panel.root.querySelector(".sessions-list")!.innerHTML).toBe(resolved);
  });

  test("450 sessions render 200 rows and page through Show more; a scope change resets the cap", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => summary({ id: `s${String(i).padStart(3, "0")}`, last_time: new Date(now - 5_000 - i * 1000).toISOString() }));
    sessions.mockResolvedValue(rows);
    attentionSays([inbox({ id: "s449", state: "needs_input", pending: evidence(1000, { kind: "request", summary: "need" }) })]);
    const store = createScope();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    const count = () => panel.root.querySelectorAll(".session-item").length;
    expect(count()).toBe(200);
    expect(panel.root.querySelector(".session-item")!.getAttribute("data-id")).toBe("s449");
    const more = () => panel.root.querySelector<HTMLButtonElement>("button.sessions-more");
    expect(more()!.textContent).toBe("Show 250 more");
    more()!.click();
    await vi.waitFor(() => expect(count()).toBe(400));
    more()!.click();
    await vi.waitFor(() => expect(count()).toBe(450));
    expect(more()).toBeNull();
    store.narrow({ project: "p" });
    store.narrow({ project: undefined });
    await panel.refresh();
    expect(count()).toBe(200);
  });
});

test("the Worktree rung keeps its header above the list, so the toggle is never a column beside it", () => {
  const panel = createSessions(() => {}, () => []);
  const [h2, head, body] = [...panel.root.children];
  expect(h2.tagName).toBe("H2");
  expect(head.classList.contains("sessions-head")).toBe(true);
  expect(body.classList.contains("sessions-body")).toBe(true);
  expect(head.querySelector(".sessions-needs")).not.toBeNull();
  expect(body.querySelector(".sessions-list")).not.toBeNull();
  expect(body.querySelector(".sessions-inbox")).not.toBeNull();
  expect(body.querySelector(".sessions-needs")).toBeNull();
});
