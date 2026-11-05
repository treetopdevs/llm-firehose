// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
const sessionEvents = vi.fn();
const attention = vi.fn();
vi.mock("../api", () => ({
  sessions: (signal?: AbortSignal) => sessions(signal),
  sessionEvents: (id: string) => sessionEvents(id),
  attention: (signal?: AbortSignal) => attention(signal),
}));

import { createScope } from "../scope";
import type { ScopeResolver, SessionRef } from "../scope";
import type { AttentionSession, FirehoseEvent, SessionSummary, WorktreeLifetimeView } from "../api";
import { row } from "./project/model.fixtures";
import { createSessions } from "./sessions";
import type { SessionDirectory } from "../session-directory";

const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();
const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, source: "codex", first_time: ago(600_000), last_time: ago(5_000), events: 3, ...over });
const ref = (session_id: string, source = "codex") => ({ source, session_id, first_time: ago(600_000), last_time: ago(5_000), events: 2 });
const wt = (worktree_id: string, over: Partial<WorktreeLifetimeView> = {}) => row({ repo_id: "repoA", worktree_id, label: `/w/${worktree_id}`, last_time: ago(60_000), ...over });

/** A resolver over lifetime rows, as Project's: complete membership per worktree, the project's rows from lifetimes. */
function resolverOf(rows: () => readonly WorktreeLifetimeView[], over: Partial<ScopeResolver> = {}): ScopeResolver {
  return {
    sessions: () => undefined,
    matcher(sc) {
      if (!sc.worktree) return undefined;
      const hit = rows().find((r) => r.worktree_id === sc.worktree);
      return hit ? (r: SessionRef) => hit.sessions.some((s) => s.session_id === r.id && s.source === r.source) : undefined;
    },
    lifetimes(sc) {
      const inRepo = rows().filter((r) => r.repo_id === sc.project);
      return inRepo.length ? inRepo : undefined;
    },
    refresh: vi.fn(async () => {}),
    labels: () => ({}),
    ...over,
  };
}

function panelOver(rows: readonly WorktreeLifetimeView[], opts: { over?: Partial<ScopeResolver>; inbox?: Parameters<typeof createSessions>[7]["inbox"] } = {}) {
  const store = createScope();
  const resolver = resolverOf(() => rows, opts.over);
  store.setResolver(resolver);
  store.narrow({ project: "repoA" });
  const panel = createSessions(() => {}, () => [], undefined, undefined, store, undefined, undefined, opts.inbox ? { inbox: opts.inbox } : {});
  document.body.append(panel.root);
  return { panel, store, resolver };
}

const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".worktree-item")];
const sessionIds = (root: HTMLElement) => [...root.querySelectorAll(".session-item")].map((n) => n.getAttribute("data-id"));
const sessionKeys = (root: HTMLElement) => [...root.querySelectorAll(".session-item")].map((n) => `${n.getAttribute("data-source")}/${n.getAttribute("data-id")}`);
const key = (k: string) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });

beforeEach(() => {
  document.body.innerHTML = "";
  sessions.mockReset().mockResolvedValue([summary("s1"), summary("s2")]);
  sessionEvents.mockReset().mockResolvedValue([]);
  attention.mockReset().mockResolvedValue({ gaps: [], sessions: [], warnings: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe("the list at the Worktree rung", () => {
  const three = [
    wt("old", { last_time: ago(7_200_000), state: "landed", outcome: "landed", sessions_total: 1 }),
    wt("new", { last_time: ago(1_800_000), state: "open", sessions_total: 5, ahead: 2 }),
    wt("mid", { last_time: ago(3_600_000), state: "gone", outcome: "abandoned", sessions_total: 0 }),
    wt("other", { repo_id: "repoB" }),
  ];

  test("a project with no worktree selected lists its worktrees, newest first, instead of sessions", async () => {
    const { panel } = panelOver(three);
    await panel.refresh();
    expect(items(panel.root).map((n) => n.getAttribute("data-wt"))).toEqual(["new", "mid", "old"]);
    expect(panel.root.querySelectorAll(".session-item")).toHaveLength(0);
    const first = items(panel.root)[0];
    expect(first.querySelector(".name")?.textContent).toBe("new");
    expect(first.querySelector(".age")?.textContent).toBe("30m");
    expect(first.querySelector(".state")?.textContent).toBe("open");
    expect(first.textContent).toContain("5 sessions captured");
    expect(first.getAttribute("title")).toBe("/w/new");
  });

  test("says how many worktrees it lists, uncapped", async () => {
    const many = Array.from({ length: 450 }, (_, i) => wt(`w${i}`));
    const { panel } = panelOver(many);
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-count")?.textContent).toBe("450 worktrees");
    expect(items(panel.root)).toHaveLength(450);
    expect(panel.root.querySelector("button.sessions-more")).toBeNull();
  });

  test("states are the API's: a landed row has no time beyond last activity, a gone row its outcome", async () => {
    const { panel } = panelOver(three);
    await panel.refresh();
    const by = (id: string) => items(panel.root).find((n) => n.getAttribute("data-wt") === id)!;
    expect(by("old").querySelector(".state")?.textContent).toBe("landed");
    expect(by("old").textContent).not.toMatch(/landed at|landed \?|\d{4}-\d{2}-\d{2}/);
    expect(by("mid").querySelector(".state")?.textContent).toBe("gone · abandoned");
  });

  test.each([
    ["click", (n: HTMLElement) => n.click()],
    ["Enter", (n: HTMLElement) => n.dispatchEvent(key("Enter"))],
    ["Space", (n: HTMLElement) => n.dispatchEvent(key(" "))],
  ])("%s on a row narrows to that worktree and clears the cell", async (_name, act) => {
    const { panel, store } = panelOver(three);
    await panel.refresh();
    const n = items(panel.root)[0];
    expect(n.getAttribute("tabindex")).toBe("0");
    expect(n.getAttribute("role")).toBe("button");
    act(n);
    expect(store.get()).toMatchObject({ project: "repoA", worktree: "new" });
    expect(store.get().cell).toBeUndefined();
  });

  test("activating a row shows only that worktree's sessions, with a way back", async () => {
    const { panel } = panelOver([wt("w1", { sessions: [ref("s1")], sessions_total: 1 }), wt("w2", { sessions: [ref("s2")], sessions_total: 1 })]);
    await panel.refresh();
    items(panel.root).find((n) => n.getAttribute("data-wt") === "w1")!.click();
    await vi.waitFor(() => expect(sessionIds(panel.root)).toEqual(["s1"]));
    expect(items(panel.root)).toHaveLength(0);
    expect(panel.root.querySelector("button.sessions-back")?.textContent).toBe("All worktrees");
  });

  test("a worktree with no sessions still offers the way back", async () => {
    const { panel, store } = panelOver([wt("w1")]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-list")?.textContent).toContain("no sessions in this scope");
    expect(panel.root.querySelector("button.sessions-back")).not.toBeNull();
  });

  test("All worktrees widens, marks the row it came from and focuses it, and the mark survives a poll", async () => {
    const { panel, store } = panelOver([wt("w1", { sessions: [ref("s1")], sessions_total: 1 }), wt("w2")]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    const back = panel.root.querySelector<HTMLElement>("button.sessions-back")!;
    back.focus();
    back.click();
    expect(store.get().worktree).toBeUndefined();
    await vi.waitFor(() => expect(items(panel.root)).toHaveLength(2));
    const w1 = () => items(panel.root).find((n) => n.getAttribute("data-wt") === "w1")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(w1()));
    expect(w1().classList.contains("selected")).toBe(true);
    expect(w1().getAttribute("aria-current")).toBe("true");
    await panel.refresh();
    expect(w1().classList.contains("selected")).toBe(true);
    expect(document.activeElement).toBe(w1());
  });

  test("widening with focus on a session row returns focus to the worktree, not the list container", async () => {
    const { panel, store } = panelOver([wt("w1", { sessions: [ref("s1")], sessions_total: 1 })]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    panel.root.querySelector<HTMLElement>(".session-item")!.focus();
    store.narrow({ worktree: undefined });
    await panel.refresh();
    expect(document.activeElement).toBe(items(panel.root)[0]);
  });

  test("keyboard activation moves focus to the first session row, or the way back when there is none, never the list container", async () => {
    const { panel, store } = panelOver([wt("w1", { sessions: [ref("s1")], sessions_total: 1 }), wt("w2", { last_time: ago(90_000) })]);
    await panel.refresh();
    const row = (id: string) => items(panel.root).find((n) => n.getAttribute("data-wt") === id)!;
    row("w1").focus();
    row("w1").dispatchEvent(key("Enter"));
    await vi.waitFor(() => expect(sessionIds(panel.root)).toEqual(["s1"]));
    await vi.waitFor(() => expect(document.activeElement).toBe(panel.root.querySelector(".session-item")));
    store.narrow({ worktree: undefined });
    await panel.refresh();
    row("w2").focus();
    row("w2").dispatchEvent(key("Enter"));
    await vi.waitFor(() => expect(document.activeElement).toBe(panel.root.querySelector(".sessions-back")));
  });

  test("a delayed widening leaves focus where the user moved it inside the panel", async () => {
    const { panel, store } = panelOver([wt("w1", { sessions: [ref("s1")], sessions_total: 1 })]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    let release!: (v: SessionSummary[]) => void;
    sessions.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const back = panel.root.querySelector<HTMLElement>("button.sessions-back")!;
    back.focus();
    back.click();
    const needs = panel.root.querySelector<HTMLElement>("button.sessions-needs")!;
    needs.focus();
    release([]);
    await vi.waitFor(() => expect(items(panel.root)).toHaveLength(1));
    expect(document.activeElement).toBe(needs);
    expect(items(panel.root)[0].classList.contains("selected")).toBe(true);
  });

  test("widening never takes focus from outside the panel", async () => {
    const { panel, store } = panelOver([wt("w1")]);
    const outside = document.createElement("button");
    document.body.append(outside);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    outside.focus();
    store.narrow({ worktree: undefined });
    await panel.refresh();
    expect(document.activeElement).toBe(outside);
  });

  test("a poll keeps focus on the same row; a row that left gives it to its neighbour, never the body", async () => {
    const rows = [wt("a", { last_time: ago(1000) }), wt("b", { last_time: ago(2000) }), wt("c", { last_time: ago(3000) })];
    let live = rows;
    const store = createScope();
    store.setResolver(resolverOf(() => live));
    store.narrow({ project: "repoA" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    document.body.append(panel.root);
    await panel.refresh();
    items(panel.root)[1].focus();
    await panel.refresh();
    expect((document.activeElement as HTMLElement).getAttribute("data-wt")).toBe("b");
    live = [rows[0], rows[2]];
    await panel.refresh();
    expect((document.activeElement as HTMLElement).getAttribute("data-wt")).toBe("c");
  });

  test("the list reads rows after the refresh, and asks the resolver once", async () => {
    let live: WorktreeLifetimeView[] = [];
    const refresh = vi.fn(async () => { live = [wt("late")]; });
    const store = createScope();
    store.setResolver(resolverOf(() => live, { refresh }));
    store.narrow({ project: "repoA" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(items(panel.root).map((n) => n.getAttribute("data-wt"))).toEqual(["late"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a hung resolver refresh ends at the deadline with the rows it holds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { panel } = panelOver([wt("held")], { over: { refresh: () => new Promise<void>(() => {}) } });
    void panel.refresh();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(items(panel.root).map((n) => n.getAttribute("data-wt"))).toEqual(["held"]);
  });

  test("the list does not depend on /sessions", async () => {
    sessions.mockRejectedValue(new Error("sessions down"));
    const { panel } = panelOver([wt("w1")]);
    await panel.refresh();
    expect(items(panel.root)).toHaveLength(1);
    expect(panel.root.querySelector(".error")).toBeNull();
  });

  test("the list still feeds the session directory", async () => {
    const store = createScope();
    store.setResolver(resolverOf(() => [wt("w1")]));
    store.narrow({ project: "repoA" });
    const remember = vi.fn();
    const panel = createSessions(() => {}, () => [], undefined, undefined, store, { remember, lookup: () => undefined } as unknown as SessionDirectory);
    await panel.refresh();
    expect(items(panel.root)).toHaveLength(1);
    expect(remember).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "s1" })]));
  });

  test("a late response never overwrites a newer refresh", async () => {
    let release!: (v: SessionSummary[]) => void;
    sessions.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    let live = [wt("first")];
    const store = createScope();
    store.setResolver(resolverOf(() => live));
    store.narrow({ project: "repoA" });
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    const slow = panel.refresh();
    live = [wt("second")];
    await panel.refresh();
    live = [wt("stale")];
    release([]);
    await slow;
    expect(items(panel.root).map((n) => n.getAttribute("data-wt"))).toEqual(["second"]);
  });

  test("the Needs you toggle swaps in the inbox over the list and leaves scope alone", async () => {
    const inboxRoot = document.createElement("section");
    const { panel, store } = panelOver([wt("w1")], { inbox: { root: inboxRoot, refresh: async () => {}, count: () => 1 } });
    await panel.refresh();
    const before = store.get();
    panel.root.querySelector<HTMLButtonElement>("button.sessions-needs")!.click();
    expect(panel.root.querySelector<HTMLElement>(".sessions-list")!.hidden).toBe(true);
    expect(panel.root.querySelector<HTMLElement>(".sessions-inbox")!.hidden).toBe(false);
    expect(panel.root.querySelector(".sessions-inbox-caption")?.textContent).toBe("Needs you, across all projects");
    expect(store.get()).toBe(before);
  });

  test("the strip's count can exceed the lit rows: Needs you stays a toggle", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex" })]);
    attention.mockResolvedValue({ gaps: [], warnings: [], sessions: [{ id: "same", source: "opencode", events: 1, state: "needs_input", last: {}, pending: { kind: "request", summary: "x", time: ago(1000), observed_at: ago(1000), event_id: "e", source: "opencode" } } as unknown as AttentionSession] });
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), undefined, undefined, { inbox: { root: document.createElement("section"), refresh: async () => {}, count: () => 1 } });
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-needs-count")?.textContent).toBe(" (1)");
    expect(panel.root.querySelectorAll(".state.needs")).toHaveLength(0);
  });
});

describe("a history open over the list", () => {
  test("polling the list still moves a new title into the heading", async () => {
    const { panel } = panelOver([wt("w1")]);
    sessions.mockResolvedValue([summary("s1", { title: "old title" })]);
    await panel.refresh();
    sessionEvents.mockResolvedValue([]);
    await panel.openSession("s1");
    await vi.waitFor(() => expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("old title"));
    sessions.mockResolvedValue([summary("s1", { title: "new title" })]);
    await panel.refresh();
    expect(panel.root.querySelector(".session-heading h3")?.textContent).toBe("new title");
    expect(items(panel.root)).toHaveLength(1);
  });
});

describe("hasWorktreeList is the list's own predicate", () => {
  test("true only for a project, no worktree, no cell and at least one row", async () => {
    const { panel, store } = panelOver([wt("w1")]);
    expect(panel.hasWorktreeList()).toBe(true);
    store.narrow({ worktree: "w1" });
    expect(panel.hasWorktreeList()).toBe(false);
    store.narrow({ worktree: undefined, cell: { where: "w", agent: "a", label: "l" } });
    expect(panel.hasWorktreeList()).toBe(false);
    await panel.refresh();
    expect(items(panel.root)).toHaveLength(0);
    store.narrow({ cell: undefined, project: "nobody" });
    expect(panel.hasWorktreeList()).toBe(false);
  });
});

describe("no list to show", () => {
  test("no project in scope: the session list across all worktrees, said plainly", async () => {
    const store = createScope();
    store.setResolver(resolverOf(() => [wt("w1")]));
    const panel = createSessions(() => {}, () => [], undefined, undefined, store);
    await panel.refresh();
    expect(items(panel.root)).toHaveLength(0);
    expect(sessionIds(panel.root)).toEqual(["s1", "s2"]);
    expect(panel.root.querySelector(".sessions-scope")?.textContent).toBe("Sessions in all worktrees");
    expect(panel.root.querySelector(".sessions-scope-note")).toBeNull();
  });

  test("a project without rows or membership says the sessions are not scoped to it", async () => {
    const { panel, store } = panelOver([wt("w1")]);
    store.narrow({ project: "nobody" });
    await panel.refresh();
    expect(items(panel.root)).toHaveLength(0);
    expect(sessionIds(panel.root)).toEqual(["s1", "s2"]);
    expect(panel.root.querySelector(".sessions-scope-note")?.textContent).toBe("No worktree rows for this project, so its membership is unknown: showing sessions from all projects.");
  });

  test("a worktree the resolver does not know says the same", async () => {
    const { panel, store } = panelOver([wt("w1")]);
    store.narrow({ worktree: "ghost" });
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-scope-note")?.textContent).toBe("This worktree's membership is unknown: showing sessions from all projects.");
  });

  test("a project the graph scopes without lifetime rows keeps its scoped session list", async () => {
    const { panel } = panelOver([], { over: { matcher: () => (r: SessionRef) => r.id === "s1" } });
    await panel.refresh();
    expect(sessionIds(panel.root)).toEqual(["s1"]);
    expect(panel.root.querySelector(".sessions-scope-note")?.textContent).toBe("active sessions in this scope");
    expect(panel.root.querySelector("button.sessions-back")).toBeNull();
  });
});

describe("a partial lane", () => {
  test("the row counts all captured sessions and the narrowed list explains why it shows fewer", async () => {
    const rows = [wt("w1", { sessions: [ref("s1")], sessions_total: 5 })];
    const { panel, store } = panelOver(rows, { over: { partial: (sc) => (sc.worktree ? { known: 1, total: 5 } : undefined) } });
    await panel.refresh();
    expect(items(panel.root)[0].textContent).toContain("5 sessions captured");
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-scope-note")?.textContent).toContain("partial: 1 of 5 sessions known");
  });
});

describe("source identity in a selected worktree", () => {
  const twoAgents = [
    wt("w1", { sessions: [ref("same", "codex")], sessions_total: 1 }),
    wt("w2", { sessions: [ref("same", "opencode")], sessions_total: 1 }),
  ];

  test("a member whose /sessions row belongs to another source still has its own row", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex" })]);
    const { panel, store } = panelOver(twoAgents);
    store.narrow({ worktree: "w2" });
    await panel.refresh();
    expect(sessionKeys(panel.root)).toEqual(["opencode/same"]);
    expect(panel.root.querySelector(".band-row .state")?.textContent).toBe("unknown");
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(sessionKeys(panel.root)).toEqual(["codex/same"]);
  });

  test("that row joins its own source's attention and takes its title", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex", title: "codex title" })]);
    attention.mockResolvedValue({ gaps: [], warnings: [], sessions: [{ id: "same", source: "opencode", title: "opencode title", events: 1, state: "working", last: { time: ago(1000), observed_at: ago(1000) } } as unknown as AttentionSession] });
    const { panel, store } = panelOver(twoAgents);
    store.narrow({ worktree: "w2" });
    await panel.refresh();
    expect(panel.root.querySelector(".band-row .name")?.textContent).toBe("opencode title");
    expect(panel.root.querySelector(".band-row .state")?.textContent).toBe("working");
  });

  test("a shared id's rows carry only their own source's facts, not the aggregate's", async () => {
    const old = ago(86_400_000);
    sessions.mockResolvedValue([summary("same", { source: "codex", title: "codex title", events: 101, has_error: true, last_summary: "opencode said this", last_time: ago(1000) })]);
    const { panel, store } = panelOver([wt("w1", { sessions: [{ ...ref("same", "codex"), events: 1, first_time: old, last_time: old }, { ...ref("same", "opencode"), events: 100, last_time: ago(1000) }], sessions_total: 2 })]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(sessionKeys(panel.root)).toEqual(["opencode/same", "codex/same"]);
    const codex = panel.root.querySelector<HTMLElement>('.session-item[data-source="codex"]')!;
    expect(codex.querySelector(".name")?.textContent).toBe("codex title");
    expect(codex.querySelector(".session-facts")?.textContent).toContain("1 events");
    expect(codex.querySelector(".age")?.textContent).toBe("1d");
    expect(codex.textContent).not.toContain("opencode said this");
    expect(codex.querySelector('[aria-label="error captured"]')).toBeNull();
  });

  test("a shared id's row takes its place and agent only from its own attention entry", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex", agent: "their-agent", cwd: "/w/theirs" })]);
    const rows = [wt("w1", { sessions: [ref("same", "codex"), ref("same", "opencode")], sessions_total: 2 })];
    const { panel, store } = panelOver(rows);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    const codex = () => panel.root.querySelector('.session-item[data-source="codex"] .session-facts')?.textContent;
    expect(codex()).not.toContain("theirs");
    expect(codex()).not.toContain("their-agent");
    attention.mockResolvedValue({ gaps: [], warnings: [], sessions: [{ id: "same", source: "codex", agent: "own-agent", cwd: "/w/ours", events: 1, state: "working", last: { time: ago(1000), observed_at: ago(1000) } } as unknown as AttentionSession] });
    await panel.refresh();
    expect(codex()).toContain("ours");
    expect(codex()).toContain("own-agent");
  });

  test("an attention entry from another source also marks the id as shared", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex", last_summary: "maybe theirs" })]);
    attention.mockResolvedValue({ gaps: [], warnings: [], sessions: [{ id: "same", source: "opencode", events: 1, state: "working", last: { time: ago(1000), observed_at: ago(1000) } } as unknown as AttentionSession] });
    const { panel, store } = panelOver([wt("w1", { sessions: [ref("same", "codex")], sessions_total: 1 })]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(panel.root.querySelector(".session-item")?.textContent).not.toContain("maybe theirs");
  });

  test("a row no other source shares keeps its summary and event count", async () => {
    sessions.mockResolvedValue([summary("solo", { source: "codex", events: 9, last_summary: "own work" })]);
    const { panel, store } = panelOver([wt("w1", { sessions: [{ ...ref("solo", "codex"), events: 7 }], sessions_total: 1 })]);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(panel.root.querySelector(".session-last")?.textContent).toBe("own work");
    expect(panel.root.querySelector(".session-facts")?.textContent).toContain("9 events");
  });

  test("no row is invented when the member already has one, or at no selected worktree", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex" }), summary("x", { source: "codex" })]);
    const { panel, store } = panelOver(twoAgents);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    expect(sessionKeys(panel.root)).toEqual(["codex/same"]);
  });

  test("activating a row opens only its own source's events", async () => {
    sessions.mockResolvedValue([summary("same", { source: "codex" })]);
    const evs = ["codex", "opencode"].map((source) => ({ id: source, time: ago(1000), source, category: "tool", session_id: "same", summary: `from ${source}` })) as unknown as FirehoseEvent[];
    sessionEvents.mockResolvedValue(evs);
    const { panel, store } = panelOver(twoAgents);
    store.narrow({ worktree: "w1" });
    await panel.refresh();
    panel.root.querySelector<HTMLElement>(".session-item")!.click();
    await vi.waitFor(() => expect(panel.root.querySelector(".session-heading")).not.toBeNull());
    expect(panel.root.querySelector(".session-heading")?.textContent).toContain("1 events");
    expect(panel.root.querySelector(".sessions-events")?.textContent).toContain("from codex");
    expect(panel.root.querySelector(".sessions-events")?.textContent).not.toContain("from opencode");
  });

  test("a row with no source cannot qualify its history, so it opens all of it", async () => {
    sessions.mockResolvedValue([summary("bare", { source: "" })]);
    sessionEvents.mockResolvedValue([{ id: "a", time: ago(1000), source: "codex", category: "tool", session_id: "bare" }, { id: "b", time: ago(1000), source: "opencode", category: "tool", session_id: "bare" }]);
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    panel.root.querySelector<HTMLElement>(".session-item")!.click();
    await vi.waitFor(() => expect(panel.root.querySelector(".session-heading")?.textContent).toContain("2 events"));
  });
});

describe("the session list never truncates silently", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => summary(`s${String(i).padStart(3, "0")}`, { last_time: ago(5_000 + i * 1000) }));

  test("says how many it shows, and the button adds what it advertises", async () => {
    sessions.mockResolvedValue(rows(450));
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    const line = () => panel.root.querySelector(".sessions-count")?.textContent;
    const more = () => panel.root.querySelector<HTMLButtonElement>("button.sessions-more");
    expect(line()).toBe("Showing 200 of 450 sessions");
    expect(more()!.textContent).toBe("Show 200 more");
    more()!.click();
    await vi.waitFor(() => expect(panel.root.querySelectorAll(".session-item")).toHaveLength(400));
    expect(line()).toBe("Showing 400 of 450 sessions");
    expect(more()!.textContent).toBe("Show 50 more");
    more()!.click();
    await vi.waitFor(() => expect(panel.root.querySelectorAll(".session-item")).toHaveLength(450));
    expect(line()).toBe("450 sessions");
    expect(more()).toBeNull();
  });

  test("a list that fits says its size in the singular too", async () => {
    sessions.mockResolvedValue(rows(1));
    const panel = createSessions(() => {}, () => []);
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-count")?.textContent).toBe("1 session");
  });
});
