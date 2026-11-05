// @vitest-environment happy-dom
//
// The workspace graph hosted by Project: scope.project is the only repository identity,
// there is no picker or tab strip, and nothing is requested, polled or claimed until
// Project calls show(). Harness mirrors graph/index.test.ts.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorkspaceGraph } from "./index";
import { graphAPI, type EventPage, type Repository, type Snapshot, type Workspace } from "./api";
import { attention, getConfig, type AttentionSession, type FirehoseEvent } from "../../api";
import { createScope, membership, type ScopeResolver } from "../../scope";
import { isEscapeClaimed } from "../../escape";
import { listKeys } from "../../keys";

vi.mock("../../api", () => ({
  DAEMON_URL: "http://127.0.0.1:4517",
  attention: vi.fn(async () => ({ sessions: [] })),
  getConfig: vi.fn(async () => ({ privacy_mode: "balanced" })),
}));
vi.mock("./api", () => ({
  graphAPI: {
    repos: vi.fn(),
    snapshot: vi.fn(),
    timeline: vi.fn(),
    activity: vi.fn(),
    compare: vi.fn(),
    register: vi.fn(),
  },
}));

const NOW = Date.UTC(2026, 10, 1, 12);
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubGlobal("setInterval", () => 0);
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const REPOS: Repository[] = [
  { id: "r", vcs: "git", label: "repo-r", status: "ok", observed_at: "" },
  { id: "other", vcs: "git", label: "repo-other", status: "ok", observed_at: "" },
];
const node = (key: string, parents: string[] = []) => ({
  key,
  commit_id: key.padEnd(40, "0"),
  parents,
  description: `commit ${key}`,
  timestamp: "2026-10-01T00:00:00Z",
});
function ws(repo: string, id: string, revision: string): Workspace {
  return {
    id,
    repo_id: repo,
    label: "a".repeat(64),
    revision,
    refs: [`refs/heads/${id}`],
    dirty: false,
    conflicted: false,
    availability: "available",
    unborn: false,
  };
}
function snapshotFor(repo: string): Snapshot {
  const label = REPOS.find((r) => r.id === repo)?.label ?? repo;
  return {
    repository: { id: repo, vcs: "git", label, status: "ok", observed_at: "" },
    generation: "1",
    nodes: [node("a"), node("b", ["a"])],
    workspaces: repo === "other" ? [ws(repo, "ox", "a")] : [ws(repo, "w1", "a"), ws(repo, "w2", "b")],
    boundaries: [],
    warnings: [],
    stale: false,
  };
}
const ev = (id: string, ageMs: number, over: Partial<FirehoseEvent> = {}): FirehoseEvent => ({
  id,
  time: iso(NOW - ageMs),
  source: "codex",
  session_id: "s-new",
  category: "tool",
  name: "tool.completed",
  summary: `summary ${id}`,
  repo_id: "r",
  worktree_id: "w1",
  ...over,
});
const page = (events: FirehoseEvent[], next?: string): EventPage => ({
  events,
  has_more: !!next,
  ...(next ? { next_cursor: next } : {}),
  order: "newest_first",
});
const E1 = ev("e1", 3 * H);
const E2 = ev("e2", 2 * H, { worktree_id: "w2" });
const E3 = ev("e3", 1 * H);
function session(id: string, ageMs: number, worktree = "w1"): AttentionSession {
  const t = iso(NOW - ageMs);
  return {
    id,
    source: "codex",
    repo_id: "r",
    worktree_id: worktree,
    events: 2,
    state: "working",
    last_observed_at: t,
    last: { event_id: `ev-${id}`, source: "codex", kind: "tool", summary: "", time: t, observed_at: t },
  };
}
const S_OLD = session("s-old", 10 * 86_400_000);
const S_NEW = session("s-new", 5 * 60_000);

function mocks(over: { timeline?: (p: Record<string, string>) => EventPage; sessions?: AttentionSession[] } = {}) {
  vi.mocked(getConfig).mockResolvedValue({ privacy_mode: "balanced" });
  vi.mocked(attention).mockResolvedValue({ sessions: over.sessions ?? [S_OLD, S_NEW], warnings: [] });
  vi.mocked(graphAPI.repos).mockResolvedValue(REPOS);
  vi.mocked(graphAPI.snapshot).mockImplementation(async (repo: string) => snapshotFor(repo));
  vi.mocked(graphAPI.timeline).mockImplementation(async (p: Record<string, string>) =>
    over.timeline ? over.timeline(p) : page([E1, E2, E3]),
  );
  vi.mocked(graphAPI.activity).mockResolvedValue({} as never);
}
function make(initial?: { project?: string; worktree?: string }, scopeInit?: Parameters<typeof createScope>[0]) {
  mocks();
  const store = createScope(scopeInit ?? initial);
  const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW });
  document.body.append(graph.root);
  return { store, graph, root: graph.root };
}
const snapshotCalls = () => vi.mocked(graphAPI.snapshot).mock.calls;
const timelineCalls = () => vi.mocked(graphAPI.timeline).mock.calls;
const q = (root: HTMLElement, sel: string) => root.querySelector<HTMLElement>(sel)!;
const qa = (root: HTMLElement, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const click = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === name)!.click();
const rowIds = (root: HTMLElement) =>
  qa(root, ".feed-row").map((r) => r.getAttribute("data-key")!);
const key = (k: string, opts: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts });

// ---- toolbar ---------------------------------------------------------------------------

test("hosted toolbar has no repository select and no tabs; Fit, All and search remain", () => {
  const { root } = make();
  expect(root.querySelector(".graph-repo")).toBeNull();
  expect(root.querySelector('select[aria-label="Repository"]')).toBeNull();
  expect(root.querySelector(".graph-tabs")).toBeNull();
  expect(qa(root, ".graph-fit button").map((b) => b.textContent)).toEqual(["Fit", "All"]);
  expect(root.querySelector('input[aria-label="Search graph"]')).toBeTruthy();
});

// ---- gating and target ---------------------------------------------------------------------

test("nothing is requested before show(); a hidden project change defers; show requests one snapshot for scope.project", async () => {
  const { store, graph } = make();
  store.narrow({ project: "other" });
  await flush();
  expect(snapshotCalls()).toHaveLength(0);
  expect(timelineCalls()).toHaveLength(0);
  expect(vi.mocked(attention)).not.toHaveBeenCalled();
  expect(vi.mocked(graphAPI.activity)).not.toHaveBeenCalled();
  expect(vi.mocked(graphAPI.repos)).not.toHaveBeenCalled();
  graph.show("graph");
  await flush();
  expect(snapshotCalls()).toHaveLength(1);
  expect(snapshotCalls()[0][0]).toBe("other");
});

test("target repo: scope.project, else the first registered; an unknown project is stated and never rewritten", async () => {
  const a = make({ project: "other" });
  a.graph.show("graph");
  await flush();
  expect(snapshotCalls().map((c) => c[0])).toEqual(["other"]);
  expect(a.graph.currentRepo()).toBe("other");
  document.body.replaceChildren();
  vi.clearAllMocks();

  const b = make();
  b.graph.show("graph");
  await flush();
  expect(snapshotCalls().map((c) => c[0])).toEqual(["r"]);
  expect(b.store.get().project).toBeUndefined();
  document.body.replaceChildren();
  vi.clearAllMocks();

  const c = make({ project: "missing" });
  c.graph.show("graph");
  await flush();
  expect(q(c.root, ".graph-empty").textContent).toContain("not registered");
  expect(snapshotCalls()).toHaveLength(0);
  expect(c.store.get().project).toBe("missing");
  expect(c.graph.currentRepo()).toBe("");
});

test("a project change while hidden defers to show(); a failed refresh keeps the deferral for the next show", async () => {
  const { store, graph, root } = make({ project: "r" });
  graph.show("graph");
  await flush();
  graph.hide();
  vi.mocked(graphAPI.snapshot).mockClear();
  store.narrow({ project: "other" });
  await flush();
  expect(snapshotCalls()).toHaveLength(0);
  vi.mocked(graphAPI.snapshot).mockRejectedValueOnce(new Error("boom"));
  graph.show("graph");
  await flush();
  expect(snapshotCalls()).toHaveLength(1);
  expect(snapshotCalls()[0][0]).toBe("other");
  expect(root.textContent).toContain("Topology scan unavailable");
  graph.hide();
  graph.show("graph");
  await flush();
  expect(snapshotCalls()).toHaveLength(2);
  expect(q(root, ".graph-count").textContent).toBe("1 worktree");
});

test("race: a snapshot in flight for the previous project is discarded", async () => {
  const { store, graph, root } = make({ project: "r" });
  const held = deferred<Snapshot>();
  vi.mocked(graphAPI.snapshot).mockImplementation(async (repo: string) =>
    repo === "r" ? held.promise : snapshotFor(repo),
  );
  graph.show("graph");
  await flush();
  expect(snapshotCalls().map((c) => c[0])).toEqual(["r"]);
  store.narrow({ project: "other" });
  await flush();
  held.resolve(snapshotFor("r"));
  await flush();
  expect(snapshotCalls().map((c) => c[0])).toEqual(["r", "other"]);
  expect(graph.currentRepo()).toBe("other");
  expect(q(root, ".graph-count").textContent).toBe("1 worktree");
  expect(root.querySelector('[data-key="workspace:w1"]')).toBeNull();
  expect(root.querySelector('[data-key="workspace:ox"]')).toBeTruthy();
});

// ---- registration races (finding 6) --------------------------------------------------------------

function submitRegister(root: HTMLElement) {
  q(root, ".graph-more-button").click();
  [...root.querySelectorAll("button")].find((b) => b.textContent === "Register local root")!.click();
  q(root, ".graph-register input").setAttribute("value", "/tmp/new");
  (q(root, ".graph-register input") as HTMLInputElement).value = "/tmp/new";
  q(root, ".graph-register").dispatchEvent(new Event("submit", { cancelable: true }));
}
const NEW_REPO: Repository = { id: "new", vcs: "git", label: "repo-new", status: "ok", observed_at: "" };

test("FINDING 6: navigation before register() resolves leaves scope and the view alone", async () => {
  const { store, graph, root } = make({ project: "r" });
  graph.show("graph");
  await flush();
  const reg = deferred<Repository>();
  vi.mocked(graphAPI.register).mockReturnValue(reg.promise);
  submitRegister(root);
  await flush();
  store.narrow({ project: "other" });
  await flush();
  const before = snapshotCalls().length;
  const seen: unknown[] = [];
  store.subscribe((n) => seen.push(n));
  reg.resolve(NEW_REPO);
  await flush();
  expect(store.get().project).toBe("other");
  expect(seen).toHaveLength(0);
  expect(snapshotCalls()).toHaveLength(before);
  expect(graph.currentRepo()).toBe("other");
});

test("FINDING 6: hide() before repos() resolves does not publish or refresh", async () => {
  const { store, graph, root } = make({ project: "r", worktree: "w1" });
  graph.show("graph");
  await flush();
  const list = deferred<Repository[]>();
  vi.mocked(graphAPI.register).mockResolvedValue(NEW_REPO);
  vi.mocked(graphAPI.repos).mockReturnValue(list.promise);
  submitRegister(root);
  await flush();
  graph.hide();
  const before = snapshotCalls().length;
  const seen: unknown[] = [];
  store.subscribe((n) => seen.push(n));
  list.resolve([...REPOS, NEW_REPO]);
  await flush();
  expect(store.get().project).toBe("r");
  expect(store.get().worktree).toBe("w1");
  expect(seen).toHaveLength(0);
  expect(snapshotCalls()).toHaveLength(before);
});

test("FINDING 6: with no navigation in between, registration succeeds and refreshes", async () => {
  const { store, graph, root } = make({ project: "r" });
  graph.show("graph");
  await flush();
  vi.mocked(graphAPI.register).mockResolvedValue(NEW_REPO);
  vi.mocked(graphAPI.repos).mockResolvedValue([...REPOS, NEW_REPO]);
  submitRegister(root);
  await flush();
  expect(store.get().project).toBe("new");
  expect(snapshotCalls().at(-1)![0]).toBe("new");
  expect(graph.registeredRepos()).toEqual(["r", "other", "new"]);
});

// ---- gating of events, polling, focus ---------------------------------------------------------------

test("onEvent while hidden is inert; the poll and window focus refresh only while shown", async () => {
  vi.unstubAllGlobals();
  vi.useFakeTimers();
  const { graph } = make({ project: "r" });
  graph.onEvent(ev("hid", 1000));
  await vi.advanceTimersByTimeAsync(600);
  expect(vi.mocked(attention)).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_000);
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(snapshotCalls()).toHaveLength(0);
  graph.show("graph");
  await vi.advanceTimersByTimeAsync(100);
  expect(snapshotCalls()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(snapshotCalls().length).toBeGreaterThanOrEqual(2);
  const n = snapshotCalls().length;
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(100);
  expect(snapshotCalls().length).toBe(n + 1);
  graph.hide();
  await vi.advanceTimersByTimeAsync(15_000);
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(100);
  expect(snapshotCalls().length).toBe(n + 1);
});

// ---- resolver (finding 1) --------------------------------------------------------------------------

function projectLike(): ScopeResolver {
  const keys = new Set(["codex\0hist", "codex\0hist-gone"]);
  return {
    sessions: () => new Set(["hist", "hist-gone"]),
    matcher: () => (ref) => ref.source !== undefined && keys.has(`${ref.source}\0${ref.id}`),
    knows: () => true,
    labels: (sc) => (sc.worktree ? { worktree: "Fallback worktree" } : {}),
  };
}

test("FINDING 1: while hidden the graph defers membership and labels to the fallback; shown it answers", async () => {
  const { store, graph } = make({ project: "r", worktree: "gone" });
  store.setFallbackResolver(projectLike());
  const hist = { id: "hist-gone", source: "codex" };
  // hidden: the graph answers undefined / knows false, so the removed worktree's history is a member
  expect(membership(store, store.get())!(hist)).toBe(true);
  expect(store.resolver()!.labels(store.get()).worktree).toBe("Fallback worktree");

  graph.show("graph");
  await flush();
  expect(membership(store, store.get())!(hist)).toBe(true); // 'gone' is absent from the snapshot: still a member
  graph.hide();
  expect(membership(store, store.get())!(hist)).toBe(true);
  expect(store.resolver()!.labels(store.get()).worktree).toBe("Fallback worktree");

  // shown, a worktree the graph knows: the graph's own membership and labels win
  store.narrow({ worktree: "w1" });
  graph.show("graph");
  await flush();
  const m = membership(store, store.get())!;
  expect(m({ id: "s-new", source: "codex" })).toBe(true);
  expect(m({ id: "hist", source: "codex" })).toBe(false);
  expect(store.resolver()!.labels(store.get()).worktree).toBe("w1");
  expect(store.resolver()!.labels(store.get()).project).toBe("repo-r");
  graph.hide();
  expect(membership(store, store.get())!({ id: "hist", source: "codex" })).toBe(true);
  expect(store.resolver()!.labels(store.get()).worktree).toBe("Fallback worktree");
});

// ---- Events: catch-up (finding 4) ------------------------------------------------------------------

function pagedTimeline() {
  // Newest-first pages keyed by cursor; ids are contiguous numbers n1..n12.
  const n = (i: number) => ev(`n${String(i).padStart(2, "0")}`, (13 - i) * 60_000);
  const pages: Record<string, EventPage> = { cA: page([n(3), n(2), n(1)]) };
  const state = { head: page([n(6), n(5), n(4)], "cA") };
  const timeline = (p: Record<string, string>): EventPage => {
    if (!p.cursor) return state.head;
    if (p.cursor === "cA") return pages.cA;
    if (p.cursor === "cB") return page([n(9), n(8), n(7)]);
    return page([]);
  };
  return { n, state, timeline };
}

test("FINDING 4: events missed while hidden restart pagination at the head; Load older walks contiguously", async () => {
  const t = pagedTimeline();
  mocks({ timeline: t.timeline });
  const store = createScope({ project: "r" });
  const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW });
  document.body.append(graph.root);
  graph.show("events");
  await flush();
  expect(rowIds(graph.root)).toEqual(["n06", "n05", "n04"]);
  expect(timelineCalls()).toHaveLength(1);
  graph.hide();
  for (let i = 0; i < 260; i++) graph.onEvent(ev(`hidden${i}`, 1000));
  expect(rowIds(graph.root)).toEqual(["n06", "n05", "n04"]); // hidden arrivals are not merged
  t.state.head = page([t.n(12), t.n(11), t.n(10)], "cB");
  vi.mocked(graphAPI.timeline).mockClear();
  graph.show("events");
  await flush();
  expect(timelineCalls()).toHaveLength(1);
  expect(timelineCalls()[0][0].cursor).toBeUndefined();
  expect(rowIds(graph.root).slice(0, 3)).toEqual(["n12", "n11", "n10"]);
  click(graph.root, "Load older events");
  await flush();
  expect(timelineCalls().at(-1)![0].cursor).toBe("cB");
  expect(rowIds(graph.root)).toEqual(
    ["n12", "n11", "n10", "n09", "n08", "n07", "n06", "n05", "n04"],
  );
});

test("FINDING 4: show() with a cursor but no missed events refetches the head once", async () => {
  const t = pagedTimeline();
  mocks({ timeline: t.timeline });
  const store = createScope({ project: "r" });
  const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW });
  document.body.append(graph.root);
  graph.show("events");
  await flush();
  graph.hide();
  vi.mocked(graphAPI.timeline).mockClear();
  graph.show("events");
  await flush();
  expect(timelineCalls()).toHaveLength(1);
  expect(timelineCalls()[0][0].cursor).toBeUndefined();
});

// ---- Events: bounded timeline (D110) --------------------------------------------------------------

test("D110: live events past the cap evict the oldest; Load older stays offered and restarts at the head", async () => {
  for (const headCursor of ["cA", ""]) {
    const t = pagedTimeline();
    const head = page([t.n(6), t.n(5), t.n(4)], headCursor || undefined);
    const fresh = page([ev("live3", 1000), ev("live2", 2000), ev("live1", 3000)], "cH");
    let served = head;
    mocks({ timeline: (p) => (p.cursor === "cH" ? page([t.n(6), t.n(5), t.n(4)], "cA") : p.cursor ? t.timeline(p) : served) });
    const store = createScope({ project: "r" });
    const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW, timelineCap: 5 });
    document.body.append(graph.root);
    graph.show("events");
    await flush();
    expect(rowIds(graph.root)).toEqual(["n06", "n05", "n04"]);
    for (const id of ["live1", "live2", "live3"]) graph.onEvent(ev(id, { live1: 3000, live2: 2000, live3: 1000 }[id]!));
    // n04 (oldest) evicted: the cursor that pointed at it is dropped, older history is still offered.
    expect(rowIds(graph.root)).toEqual(["live3", "live2", "live1", "n06", "n05"]);
    expect(graph.root.textContent, headCursor).toContain("Load older events");
    served = fresh;
    vi.mocked(graphAPI.timeline).mockClear();
    click(graph.root, "Load older events");
    await flush();
    expect(timelineCalls()).toHaveLength(1);
    expect(timelineCalls()[0][0].cursor, headCursor).toBeUndefined();
    click(graph.root, "Load older events");
    await flush();
    expect(timelineCalls().at(-1)![0].cursor).toBe("cH");
    // The older page is kept (n04 back); the newest is evicted instead. Exact IDs dedupe.
    expect(rowIds(graph.root)).toEqual(["live2", "live1", "n06", "n05", "n04"]);
    graph.hide();
    document.body.replaceChildren();
    vi.clearAllMocks();
  }
});

// ---- Events: window ------------------------------------------------------------------------------

test("Events follow the shared window: live state, frozen range, no pause UI, no cap figure", async () => {
  const { store, graph, root } = make({ project: "r" });
  graph.show("events");
  await flush();
  const state = () => q(root, ".graph-timeline-state").textContent!;
  expect(state()).toContain("Following live · last 7 d");
  expect(state()).toContain("3 shown");
  expect(root.querySelector(".pause")).toBeNull();
  expect(root.textContent).not.toContain("resume");
  expect(root.textContent).not.toMatch(/unread/i);
  expect(root.textContent).not.toContain("250");
  // following live adds a row immediately
  graph.onEvent(ev("fresh", 30_000));
  expect(rowIds(root)).toContain("fresh");
  expect(state()).toContain("4 shown");
  // a window change re-renders without a click
  store.narrow({ window: { from: NOW - 4 * H, to: NOW - 90 * 60_000 } });
  expect(state()).toContain("Frozen range");
  expect(rowIds(root)).toEqual(["e2", "e1"]);
  // a frozen range ignores new rows
  graph.onEvent(ev("later", 10_000));
  expect(rowIds(root)).toEqual(["e2", "e1"]);
  store.narrow({ window: "live", liveSpanMs: 2 * H });
  expect(state()).toContain("Following live · last 2 h");
  expect(rowIds(root)).toEqual(["later", "fresh", "e3", "e2"]); // e2 sits exactly on the inclusive bound
  expect(rowIds(root)).not.toContain("e1");
});

test("hosted Events: Space is inert and registers no events-scope binding; the standalone panel owns exactly one", async () => {
  const eventsScope = () => listKeys().filter((r) => r.scope === "events");
  // Standalone (not hosted) owns the events scope from creation; it has no hide().
  mocks();
  const standalone = createWorkspaceGraph(() => {}, createScope({ project: "r" }), { now: () => NOW });
  document.body.append(standalone.root);
  await standalone.refresh();
  await flush();
  click(standalone.root, "Timeline");
  await flush();
  expect(eventsScope()).toHaveLength(1);
  document.body.replaceChildren();
  expect(eventsScope()).toHaveLength(0); // listed only while connected
  const { graph, root } = make({ project: "r" });
  graph.show("events");
  await flush();
  expect(eventsScope()).toHaveLength(0);
  graph.hide();
  expect(eventsScope()).toHaveLength(0);
  graph.show("events");
  await flush();
  const before = root.querySelectorAll(".feed-row").length;
  const sp = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
  document.body.dispatchEvent(sp);
  expect(sp.defaultPrevented).toBe(false);
  expect(root.querySelectorAll(".feed-row").length).toBe(before);
});

test("an empty window says so and points at Load older", async () => {
  const { graph, root } = make({ project: "r" }, { project: "r", window: { from: NOW - 30 * H, to: NOW - 20 * H } });
  graph.show("events");
  await flush();
  expect(root.textContent).toContain("No captured events in this window. Load older events to look further back.");
});

test("a window older than the newest page renders the older page after Load older", async () => {
  mocks({
    timeline: (p) => (p.cursor === "c1" ? page([E1, E2]) : page([E3], "c1")),
  });
  const store = createScope({ project: "r", window: { from: NOW - 4 * H, to: NOW - 90 * 60_000 } });
  const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW });
  document.body.append(graph.root);
  graph.show("events");
  await flush();
  expect(rowIds(graph.root)).toEqual([]);
  click(graph.root, "Load older events");
  await flush();
  expect(rowIds(graph.root)).toEqual(["e2", "e1"]);
});

// ---- halo, order ---------------------------------------------------------------------------------

const aria = (root: HTMLElement, id: string) => q(root, `[data-key="workspace:${id}"]`).getAttribute("aria-label")!;

test("the halo reads the window: only sessions active inside it are counted", async () => {
  const { store, graph, root } = make({ project: "r", worktree: undefined });
  graph.show("graph");
  await flush();
  expect(aria(root, "w1")).toContain("1 agent");
  store.narrow({ window: { from: NOW - H, to: NOW } });
  expect(aria(root, "w1")).toContain("1 agent");
  store.narrow({ window: { from: NOW - 20 * 86_400_000, to: NOW } });
  expect(aria(root, "w1")).toContain("2 agents");
  store.narrow({ window: { from: NOW - 30 * H, to: NOW - 20 * H } });
  expect(aria(root, "w1")).not.toMatch(/\d agents?/);
});

test("standalone (not hosted) counts every session regardless of the window", async () => {
  mocks();
  const store = createScope({ window: { from: NOW - H, to: NOW } });
  const graph = createWorkspaceGraph(() => {}, store);
  document.body.append(graph.root);
  await graph.refresh();
  await flush();
  expect(aria(graph.root, "w1")).toContain("2 agents");
});

test("setWorktreeOrder orders search results and the Events workspace select; undefined restores the snapshot order", async () => {
  const { graph, root } = make({ project: "r" });
  graph.show("graph");
  await flush();
  const focusSearch = () => q(root, 'input[aria-label="Search graph"]').dispatchEvent(new Event("focus"));
  const titles = () => qa(root, ".graph-search-option .result-title").map((n) => n.textContent);
  focusSearch();
  expect(titles()).toEqual(["w1", "w2"]);
  graph.setWorktreeOrder(["w2", "w1"]);
  focusSearch();
  expect(titles()).toEqual(["w2", "w1"]);
  graph.show("events");
  await flush();
  const options = () => qa(root, 'select[aria-label="Worktree"] option').map((o) => o.textContent);
  expect(options()).toEqual(["Whole project", "w2", "w1"]);
  graph.setWorktreeOrder(undefined);
  expect(options()).toEqual(["Whole project", "w1", "w2"]);
});

test("registeredRepos is empty before the first load and never fetched by a hidden graph", async () => {
  const { graph } = make();
  expect(graph.registeredRepos()).toEqual([]);
  await flush();
  expect(vi.mocked(graphAPI.repos)).not.toHaveBeenCalled();
  graph.show("graph");
  await flush();
  expect(graph.registeredRepos()).toEqual(["r", "other"]);
});

// ---- views and scope ---------------------------------------------------------------------------------

test("view changes the graph makes itself are announced via onView; show() does not announce", async () => {
  const { graph, root } = make({ project: "r" });
  const views: string[] = [];
  graph.onView((v) => views.push(v));
  graph.show("events");
  await flush();
  expect(views).toEqual([]);
  document.dispatchEvent(key("k", { ctrlKey: true }));
  expect(views).toEqual(["graph"]);
  expect(q(root, ".graph-pane")).toBeTruthy();
  // '/' from Events
  graph.show("events");
  await flush();
  q(root, ".feed-rows").focus();
  document.body.dispatchEvent(key("/"));
  expect(views).toEqual(["graph", "graph"]);
  // Open scoped Timeline from the inspector
  q(root, '[data-key="workspace:w1"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  click(root, "Open scoped Timeline");
  await flush();
  expect(views).toEqual(["graph", "graph", "events"]);
  // Show in Graph from a row
  click(root, "Show in Graph");
  expect(views.at(-1)).toBe("graph");
});

test("selecting a tip publishes project and worktree; the Events select publishes the worktree; a store change selects the tip", async () => {
  const { store, graph, root } = make();
  graph.show("graph");
  await flush();
  q(root, '[data-key="workspace:w2"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(store.get().project).toBe("r");
  expect(store.get().worktree).toBe("w2");
  graph.show("events");
  await flush();
  const sel = q(root, 'select[aria-label="Worktree"]') as HTMLSelectElement;
  sel.value = "w1";
  sel.dispatchEvent(new Event("change"));
  await flush();
  expect(store.get().worktree).toBe("w1");
  store.narrow({ worktree: "w2" });
  await flush();
  expect((q(root, 'select[aria-label="Worktree"]') as HTMLSelectElement).value).toBe("w2");
});

// ---- Escape (finding 8) ----------------------------------------------------------------------------------

test("FINDING 8: a hidden graph and a stale More menu never claim Escape; a shown graph claims it for a selection", async () => {
  const { graph, root } = make({ project: "r" });
  graph.show("graph");
  await flush();
  q(root, '[data-key="workspace:w1"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  graph.hide();
  const hiddenEsc = key("Escape");
  document.body.dispatchEvent(hiddenEsc);
  expect(isEscapeClaimed(hiddenEsc)).toBe(false);

  graph.show("graph");
  await flush();
  q(root, ".graph-more-button").click();
  expect((q(root, ".graph-menu") as HTMLElement).hidden).toBe(false);
  graph.hide();
  expect((q(root, ".graph-menu") as HTMLElement).hidden).toBe(true);
  const staleEsc = key("Escape");
  document.body.dispatchEvent(staleEsc);
  expect(isEscapeClaimed(staleEsc)).toBe(false);

  graph.show("graph");
  await flush();
  q(root, '[data-key="workspace:w1"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  const shownEsc = key("Escape");
  document.body.dispatchEvent(shownEsc);
  expect(isEscapeClaimed(shownEsc)).toBe(true);
});

test("hide() during a pending refresh stops it: no snapshot is fetched for a hidden encoding, and show() restarts it", async () => {
  const { store, graph } = make({ project: "r" });
  const list = deferred<Repository[]>();
  vi.mocked(graphAPI.repos).mockReturnValue(list.promise);
  graph.show("graph");
  await flush();
  graph.hide();
  list.resolve(REPOS);
  await flush();
  expect(snapshotCalls()).toHaveLength(0);
  vi.mocked(graphAPI.repos).mockResolvedValue(REPOS);
  graph.show("graph");
  await flush();
  expect(snapshotCalls().map((c) => c[0])).toEqual(["r"]);
  expect(store.get().project).toBe("r");
});

test("a repository switch from the host clears the Events source filter", async () => {
  const { store, graph, root } = make({ project: "r" });
  graph.show("events");
  await flush();
  const sel = () => root.querySelector<HTMLSelectElement>('select[title="source filter"]')!;
  sel().value = "codex";
  sel().dispatchEvent(new Event("change"));
  expect(sel().value).toBe("codex");
  store.narrow({ project: "other" });
  await flush();
  expect(sel().value).toBe("");
});

// ---- Codex findings (round 2) ------------------------------------------------------------------------

test("CODEX: Events keeps a retained worktree the topology no longer holds as its filter", async () => {
  const { store, graph, root } = make({ project: "r", worktree: "gone-fork" });
  store.setFallbackResolver(projectLike()); // Project's lifetime view knows the removed worktree
  graph.show("events");
  await flush();
  expect(timelineCalls().length).toBeGreaterThan(0);
  expect(timelineCalls().every((c) => c[0].workspace_id === "gone-fork")).toBe(true);
  expect(rowIds(root)).toEqual([]); // no event belongs to the removed fork; it must not widen to every worktree
});

test("CODEX: a later retained-worktree choice reloads the Events feed under that filter", async () => {
  const { store, graph } = make({ project: "r" });
  store.setFallbackResolver(projectLike());
  graph.show("events");
  await flush();
  store.narrow({ worktree: "gone-fork" });
  await flush();
  expect(timelineCalls().at(-1)![0].workspace_id).toBe("gone-fork");
});

test("CODEX: a graph selection keeps a frozen window while it clears the session", async () => {
  const { store, graph, root } = make({ project: "r", worktree: "w1", session: { id: "s-new", source: "codex" } } as never);
  graph.show("graph");
  await flush();
  const win = { from: NOW - 3 * H, to: NOW - H };
  store.narrow({ window: win });
  expect(store.get().window).toEqual(win);
  q(root, '[data-key="workspace:w2"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(store.get().worktree).toBe("w2");
  expect(store.get().session).toBeUndefined();
  expect(store.get().window).toEqual(win);
});

test("CODEX: registering a repository that moves the host off Graph requests no hidden topology", async () => {
  const { store, graph, root } = make({ project: "r" });
  graph.show("graph");
  await flush();
  // The host reacts to the published project by hiding this encoding.
  let hid = false;
  store.subscribe((n, p) => {
    if (n.project !== p.project && !hid) {
      hid = true;
      graph.hide();
    }
  });
  vi.mocked(graphAPI.register).mockResolvedValue(NEW_REPO);
  vi.mocked(graphAPI.repos).mockResolvedValue([...REPOS, NEW_REPO]);
  const before = snapshotCalls().length;
  submitRegister(root);
  await flush();
  expect(hid).toBe(true);
  expect(snapshotCalls()).toHaveLength(before);
  graph.show("graph");
  await flush();
  expect(snapshotCalls().at(-1)![0]).toBe("new");
});

test("CODEX: refresh() on a hidden graph issues no request", async () => {
  const { graph } = make({ project: "r" });
  await graph.refresh();
  await flush();
  expect(snapshotCalls()).toHaveLength(0);
});

// ---- one event list (slice 15) ------------------------------------------------------------

test("Events rows: Enter opens the detail aside, selection survives a live arrival, Show in Graph is a sibling button", async () => {
  const { graph, root } = make({ project: "r" });
  graph.show("events");
  await flush();
  const row = q(root, '.feed-row[data-key="e2"]');
  row.dispatchEvent(key("Enter"));
  expect(q(root, ".graph-event-detail").textContent).not.toBe("");
  graph.onEvent(ev("fresh", 30_000));
  expect(q(root, '.feed-row[data-key="e2"]').classList.contains("selected")).toBe(true);
  expect(q(root, ".graph-event-detail").textContent).not.toBe("");
  const action = q(root, '[data-key="e2\0action"]');
  expect(action.closest(".feed-row")).toBeNull();
  action.click();
  expect(q(root, ".graph-pane")).toBeTruthy();
});

test("Events toggle with Graph reloads the head exactly once per show; repeated show/hide adds no listeners or key registrations", async () => {
  const { graph, root } = make({ project: "r" });
  graph.show("events");
  await flush();
  const calls = timelineCalls().length;
  const kb = listKeys().length;
  for (let i = 0; i < 3; i++) {
    graph.hide();
    graph.show("events");
    await flush();
  }
  expect(listKeys().length).toBe(kb);
  expect(qa(root, ".feed-rows")).toHaveLength(1);
  // hide() aborts history and show() restarts it (intentional): exactly one head request per show, never more.
  expect(timelineCalls().length).toBe(calls + 3);
});

test("Events search: typing refetches once after a pause and the search box keeps focus through the rebuild", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { graph, root } = make({ project: "r" });
  graph.show("events");
  await vi.advanceTimersByTimeAsync(0);
  await flush();
  const calls = timelineCalls().length;
  const input = q(root, "input[type=search]") as HTMLInputElement;
  input.focus();
  for (const text of ["e", "er", "err"]) {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(80);
  }
  expect(timelineCalls().length).toBe(calls); // nothing mid-word
  await vi.advanceTimersByTimeAsync(300);
  await flush();
  expect(timelineCalls().length).toBe(calls + 1);
  expect(timelineCalls().at(-1)![0]).toMatchObject({ search: "err" });
  expect(document.activeElement).toBe(q(root, "input[type=search]"));
});

test("Events source filter offers the loaded events and this project's sessions, not other projects'", async () => {
  mocks({ sessions: [{ ...S_NEW, source: "claude-code" }, { ...S_NEW, id: "elsewhere", source: "opencode", repo_id: "other", worktree_id: "ox" }] });
  vi.mocked(graphAPI.timeline).mockImplementation(async () => page([E1]));
  const store = createScope({ project: "r" });
  const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW });
  document.body.append(graph.root);
  graph.show("events");
  await flush();
  const opts = qa(graph.root, "select[title='source filter'] option").map((o) => o.textContent);
  expect(opts).toContain("codex");
  expect(opts).toContain("claude-code");
  expect(opts).not.toContain("opencode");
});

test("REVIEW: a session filter the graph clears while away is not kept by the list on return", async () => {
  const { store, graph, root } = make({ project: "r", worktree: "w1" });
  graph.show("events");
  await flush();
  const sel = q(root, "select[title='session filter']") as HTMLSelectElement;
  sel.value = "codex\0s-new";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  graph.show("graph");
  await flush();
  q(root, '[data-key="workspace:w2"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(store.get().worktree).toBe("w2");
  graph.show("events");
  await flush();
  expect((q(root, "select[title='session filter']") as HTMLSelectElement).value).toBe("");
  expect(timelineCalls().at(-1)![0].session_id).toBeUndefined();
});

test("REVIEW: search typed inside the debounce survives leaving and returning to Events", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { graph, root } = make({ project: "r" });
  graph.show("events");
  await vi.advanceTimersByTimeAsync(0);
  await flush();
  const input = q(root, "input[type=search]") as HTMLInputElement;
  input.value = "err";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(50);
  graph.hide();
  await vi.advanceTimersByTimeAsync(400);
  graph.show("events");
  await vi.advanceTimersByTimeAsync(0);
  await flush();
  expect((q(root, "input[type=search]") as HTMLInputElement).value).toBe("err");
  expect(timelineCalls().at(-1)![0]).toMatchObject({ search: "err" });
});
