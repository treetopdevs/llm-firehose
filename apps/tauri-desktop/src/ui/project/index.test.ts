// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../api";
import type { WorktreeCommit, WorktreeDetail, WorktreeLifetimeView } from "../../api";
import { createScope } from "../../scope";
import type { ScopeStore } from "../../scope";
import { shortId } from "../../format";
import { FIXTURE_ROWS, NOW, iso, row } from "./model.fixtures";
import { layoutLanes, orderLanes, resolveWindow, xToTime } from "./model";
import { isEscapeClaimed } from "../../escape";
import { createProject } from "./index";
import type { ProjectPanel } from "./index";

const { worktreesMock, worktreeMock } = vi.hoisted(() => ({ worktreesMock: vi.fn(), worktreeMock: vi.fn() }));
vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  worktrees: (s?: AbortSignal) => worktreesMock(s),
  worktree: (id: string, s?: AbortSignal) => worktreeMock(id, s),
}));

const D = 86_400_000;
const H = 3_600_000;
const rowsA = FIXTURE_ROWS.filter((r) => r.repo_id === "repoA");
const panels: ProjectPanel[] = [];
const spies: Array<{ mockRestore(): void }> = [];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const detail = (id: string, commits: WorktreeCommit[] = []): WorktreeDetail => ({ ...(FIXTURE_ROWS.find((r) => r.worktree_id === id) ?? row({ worktree_id: id })), commits });
const commit = (id: string, t: number, session?: string): WorktreeCommit => ({
  commit_id: id, time: iso(t), attribution: "time_join", ...(session ? { session_id: session } : {}),
});

function setup(goImpl?: (store: ScopeStore, getPanel: () => ProjectPanel) => (n: string, p?: never) => void) {
  const store = createScope();
  const go = vi.fn();
  let panel!: ProjectPanel;
  panel = createProject({
    store,
    go: goImpl ? (goImpl(store, () => panel) as never) : go,
    now: () => NOW,
    refreshMs: 15000,
  });
  document.body.append(panel.root);
  panels.push(panel);
  const q = (s: string) => [...panel.root.querySelectorAll<HTMLElement>(s)];
  const keys = () => q(".project-lane").map((l) => l.getAttribute("data-key"));
  return { store, go, panel, q, keys };
}

beforeEach(() => {
  worktreesMock.mockReset().mockImplementation(() => Promise.resolve(FIXTURE_ROWS));
  worktreeMock.mockReset().mockImplementation((id: string) => Promise.resolve(detail(id)));
});
afterEach(() => {
  for (const p of panels.splice(0)) p.deactivate();
  document.body.replaceChildren();
  vi.useRealTimers();
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("render", () => {
  test("counts for repoA", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    expect(q(".project-lane")).toHaveLength(6);
    expect(q(".project-bead")).toHaveLength(4);
    expect(q(".project-tick")).toHaveLength(1);
    expect(q(".project-glyph")).toHaveLength(3);
    expect(q(".project-idle")).toHaveLength(1);
    expect(q(".project-lane.idle")[0]!.getAttribute("data-key")).toBe("wt-idle");
    expect(q(".project-baseline")).toHaveLength(1);
    expect(q(".project-baseline")[0]!.textContent).toContain("default branch");
    expect(q(".project-axis-tick")).toHaveLength(6);
    expect(panel.root.matches("section.project")).toBe(true);
  });

  test("baseline names the default target ref when known", async () => {
    worktreesMock.mockResolvedValue([row({ worktree_id: "wt-t", default_target_ref: "origin/main" })]);
    const { panel, q } = setup();
    await panel.activate();
    expect(q(".project-baseline")[0]!.textContent).toContain("origin/main");
    expect(q(".project-baseline")[0]!.textContent).not.toContain("default branch");
  });

  test("lane classes per state", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    const lane = (id: string) => q(".project-lane").find((l) => l.getAttribute("data-key") === id)!;
    expect(lane("wt-landed").classList.contains("state-landed")).toBe(true);
    expect(lane("wt-landed").querySelector(".project-rejoin")).not.toBeNull();
    expect(lane("wt-open").querySelector(".project-tail")).not.toBeNull();
    expect(lane("wt-gone").querySelector(".project-gone")!.textContent).toBe("×");
    expect(lane("wt-gone").textContent).toContain("abandoned");
    expect(lane("wt-never").classList.contains("flat")).toBe(true);
    expect(lane("wt-never").querySelector(".project-fork, .project-rejoin")).toBeNull();
    expect(lane("wt-unk").classList.contains("hatched")).toBe(true);
    expect(lane("wt-unk").querySelector("title")!.textContent).toContain("repository not registered");
  });

  test("label-less lane shows the short id", async () => {
    const id = "worktree-with-a-long-id";
    worktreesMock.mockResolvedValue([row({ worktree_id: id })]);
    const { panel, q } = setup();
    await panel.activate();
    const lane = q(".project-lane")[0]!;
    expect(lane.textContent).toContain(shortId(id));
    expect(lane.getAttribute("aria-label")).toContain(shortId(id));
  });

  test("states pending hint while graph scans run, clearing on refresh", async () => {
    const pend = (id: string, reason: string) => row({ worktree_id: id, state: "unknown", state_reason: reason });
    worktreesMock.mockResolvedValue([pend("p1", "graph_unavailable"), pend("p2", "graph_unavailable"), pend("p3", "repository not registered"), row({ worktree_id: "ok" })]);
    const { panel, q } = setup();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    await panel.activate();
    expect(q(".project-status")[0]!.textContent).toContain("States pending: 2 of 4 lanes not classified yet (graph_unavailable)");
    worktreesMock.mockResolvedValue([row({ worktree_id: "ok" })]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(q(".project-status")[0]!.textContent).not.toContain("States pending");
  });

  test("repository_unregistered alone gets no pending hint", async () => {
    worktreesMock.mockResolvedValue([row({ worktree_id: "u", state: "unknown", state_reason: "repo_unregistered" })]);
    const { panel, q } = setup();
    await panel.activate();
    expect(q(".project-status")[0]!.textContent).not.toContain("States pending");
  });

  test("titles equal the model tooltip and never leak cost elsewhere", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    const geom = layoutLanes(rowsA, orderLanes(undefined, rowsA), resolveWindow("live", NOW), 170, 870, NOW);
    for (const l of q(".project-lane")) {
      const g = geom.find((x) => x.id === l.getAttribute("data-key"))!;
      expect(l.querySelector(":scope > title")!.textContent).toBe(g.tooltip);
    }
    const open = q(".project-lane").find((l) => l.getAttribute("data-key") === "wt-open")!;
    expect(open.querySelector("title")!.textContent).toContain("cost (meta events): 12");
    const clone = panel.root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("title").forEach((t) => t.remove());
    expect(clone.textContent!.toLowerCase()).not.toContain("cost");
  });
});

describe("repository choice", () => {
  test("defaults to the newest repo and the select drives scope without refetching", async () => {
    const { store, panel, q, keys } = setup();
    await panel.activate();
    expect(keys()).toEqual(["wt-b1"]);
    const sel = q("select.project-repo")[0] as unknown as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["repoB", "repoA"]);
    expect(sel.value).toBe("repoB");
    const before = worktreesMock.mock.calls.length;
    sel.value = "repoA";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(store.get().project).toBe("repoA");
    expect(keys()).toHaveLength(6);
    expect(worktreesMock.mock.calls.length).toBe(before);
  });

  test("a foreign project falls back without touching scope", async () => {
    const { store, panel, q, keys } = setup();
    store.narrow({ project: "zzz" });
    await panel.activate();
    expect(keys()).toEqual(["wt-b1"]);
    const sel = q("select.project-repo")[0] as unknown as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toContain(sel.value);
    expect(store.get().project).toBe("zzz");
    expect(q(".project-empty")).toHaveLength(0);
  });

  test("lane order is stable across refreshes and lazy for new repos", async () => {
    const { store, panel, keys } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    const old = keys();
    const changed = [...rowsA].reverse().map((r) => ({ ...r, last_time: iso(NOW - 10 * 60_000) }));
    changed.push(row({ worktree_id: "wt-newest", first_time: iso(NOW - 6.5 * D), last_time: iso(NOW - H) }));
    worktreesMock.mockResolvedValue(changed);
    await panel.refresh();
    expect(keys()).toEqual([...old, "wt-newest"]);
  });

  test("a repo first seen through scope gets its order lazily", async () => {
    const { store, panel, keys } = setup();
    await panel.activate();
    expect(keys()).toEqual(["wt-b1"]);
    store.narrow({ project: "repoA" });
    expect(keys()).toHaveLength(6);
  });
});

describe("window", () => {
  test("live and explicit windows", async () => {
    const { store, panel, q, keys } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    const live = q("button.project-live")[0]!;
    expect(live.getAttribute("aria-pressed")).toBe("true");
    expect(q(".project-window")[0]!.textContent).not.toContain("2026-10-30");
    const before = worktreesMock.mock.calls.length;
    store.narrow({ window: { from: NOW - D, to: NOW } });
    expect(keys()).not.toContain("wt-landed");
    expect(keys()).not.toContain("wt-gone");
    expect(keys()).toContain("wt-open");
    expect(worktreesMock.mock.calls.length).toBe(before);
    expect(live.getAttribute("aria-pressed")).toBe("false");
    expect(q(".project-window")[0]!.textContent).toContain("2026-10-30");
    live.click();
    expect(store.get().window).toBe("live");
    expect(keys()).toContain("wt-landed");
  });
});

describe("cadence", () => {
  test("polls while active only", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { panel } = setup();
    await panel.activate();
    expect(worktreesMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(worktreesMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(worktreesMock).toHaveBeenCalledTimes(3);
    panel.deactivate();
    await vi.advanceTimersByTimeAsync(60000);
    expect(worktreesMock).toHaveBeenCalledTimes(3);
  });

  test("deactivate aborts the in-flight request; overlapping ticks are skipped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const d = deferred<WorktreeLifetimeView[]>();
    worktreesMock.mockReturnValueOnce(d.promise);
    const { panel } = setup();
    void panel.activate();
    await vi.advanceTimersByTimeAsync(15000);
    expect(worktreesMock).toHaveBeenCalledTimes(1);
    const signal = worktreesMock.mock.calls[0]![0] as AbortSignal;
    panel.deactivate();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(worktreesMock).toHaveBeenCalledTimes(1);
  });
});

describe("stale guards", () => {
  test("overlapping loads: the last started wins even when it resolves first", async () => {
    const d1 = deferred<WorktreeLifetimeView[]>();
    const d2 = deferred<WorktreeLifetimeView[]>();
    worktreesMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    const { panel, keys } = setup();
    const p1 = panel.activate();
    const p2 = panel.refresh();
    d2.resolve([row({ worktree_id: "wt-second" })]);
    await p2;
    d1.resolve([row({ worktree_id: "wt-first" })]);
    await p1;
    expect(keys()).toEqual(["wt-second"]);
  });

  test("detail is requested for the selected lane only and dropped when the project changes", async () => {
    const { store, panel, q } = setup();
    await panel.activate();
    expect(worktreeMock).not.toHaveBeenCalled();
    const d = deferred<WorktreeDetail>();
    worktreeMock.mockReturnValueOnce(d.promise);
    store.narrow({ project: "repoA", worktree: "wt-open" });
    expect(worktreeMock).toHaveBeenCalledTimes(1);
    const signal = worktreeMock.mock.calls[0]![1] as AbortSignal;
    store.narrow({ project: "repoB" });
    expect(signal.aborted).toBe(true);
    d.resolve(detail("wt-open", [commit("late", NOW - H)]));
    await flush();
    expect(q(".project-tick[data-kind=commit]")).toHaveLength(0);
  });

  test("detail for a no-longer-selected worktree is dropped", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    const d1 = deferred<WorktreeDetail>();
    worktreeMock.mockReturnValueOnce(d1.promise);
    store.narrow({ worktree: "wt-open" });
    store.narrow({ worktree: "wt-landed" });
    d1.resolve(detail("wt-open", [commit("stale", NOW - H)]));
    await flush();
    expect(q(".project-tick[data-id=stale]")).toHaveLength(0);
  });

  test("detail for a lane that vanished after a refresh is dropped", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    const d = deferred<WorktreeDetail>();
    worktreeMock.mockReturnValueOnce(d.promise);
    store.narrow({ worktree: "wt-open" });
    worktreesMock.mockResolvedValue(FIXTURE_ROWS.filter((r) => r.worktree_id !== "wt-open"));
    await panel.refresh();
    d.resolve(detail("wt-open", [commit("ghost", NOW - H)]));
    await flush();
    expect(q(".project-tick[data-id=ghost]")).toHaveLength(0);
    expect(q(".project-lane.selected")).toHaveLength(0);
  });
});

describe("races", () => {
  test("narrowing during an in-flight load renders after it resolves", async () => {
    const d = deferred<WorktreeLifetimeView[]>();
    worktreesMock.mockReturnValueOnce(d.promise);
    const { store, panel, keys } = setup();
    const p = panel.activate();
    store.narrow({ project: "repoA" });
    d.resolve(FIXTURE_ROWS);
    await p;
    expect(keys()).toHaveLength(6);
  });

  test("narrowing while inactive is honoured on the next activate", async () => {
    const { store, panel, keys } = setup();
    await panel.activate();
    panel.deactivate();
    store.narrow({ project: "repoA", window: { from: NOW - D, to: NOW } });
    await panel.activate();
    expect(keys()).not.toContain("wt-landed");
    expect(keys()).toContain("wt-open");
  });

  test("go() re-entrancy does not double render or request twice", async () => {
    const { store, panel, q, keys } = setup((st, getPanel) => ((_n: string, p?: never) => {
      st.narrow(p as never);
      void getPanel().activate();
    }) as never);
    store.narrow({ project: "repoA" });
    await panel.activate();
    const before = worktreesMock.mock.calls.length;
    expect(() => q(".project-lane[data-key=wt-open]")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))).not.toThrow();
    await flush();
    expect(worktreesMock.mock.calls.length).toBe(before + 1);
    expect(keys()).toHaveLength(6);
    expect(q(".project-lane.selected")).toHaveLength(1);
  });

  test("never writes scope on mount", async () => {
    const { store, panel } = setup();
    await panel.activate();
    expect(store.get()).toEqual({ window: "live" });
  });
});

describe("selection from scope", () => {
  test("selects, requests detail once, and ascend clears it", async () => {
    worktreeMock.mockResolvedValue(detail("wt-open", [commit("c1", NOW - H, "s-o1")]));
    const { store, panel, q } = setup();
    await panel.activate();
    store.narrow({ project: "repoA", worktree: "wt-open" });
    await flush();
    expect(q(".project-lane.selected").map((l) => l.getAttribute("data-key"))).toEqual(["wt-open"]);
    expect(worktreeMock).toHaveBeenCalledTimes(1);
    expect(worktreeMock.mock.calls[0]![0]).toBe("wt-open");
    const tick = q(".project-tick[data-kind=commit]");
    expect(tick).toHaveLength(1);
    expect(q(".project-lane.selected title")[0]!.textContent).toContain("time join");
    store.narrow({ worktree: undefined });
    expect(q(".project-lane.selected")).toHaveLength(0);
    expect(q(".project-tick[data-kind=commit]")).toHaveLength(0);
  });

  test("a worktree that is not a lane selects nothing", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA", worktree: "nope" });
    await panel.activate();
    expect(q(".project-lane.selected")).toHaveLength(0);
    expect(worktreeMock).not.toHaveBeenCalled();
  });

  test("lane and bead clicks navigate", async () => {
    const { store, panel, q, go } = setup();
    store.narrow({ project: "repoA" });
    await panel.activate();
    q(".project-lane[data-key=wt-open]")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenLastCalledWith("sessions", { project: "repoA", worktree: "wt-open" });
    q(".project-bead[data-session=s-o1]")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenLastCalledWith("score", { project: "repoA", worktree: "wt-open", session: { id: "s-o1", source: "codex" } });
    expect(go).toHaveBeenCalledTimes(2);
  });
});

describe("empty and degraded states", () => {
  test("no rows at all", async () => {
    worktreesMock.mockResolvedValue([]);
    const { panel, q } = setup();
    await panel.activate();
    expect(q(".project-empty")[0]!.textContent).toContain("No worktrees captured yet");
  });

  test("rows but none in the window", async () => {
    const { store, panel, q } = setup();
    store.narrow({ project: "repoA", window: { from: NOW - 100 * D, to: NOW - 90 * D } });
    await panel.activate();
    expect(q(".project-empty")[0]!.textContent).toContain("No worktree activity");
    expect((q("select.project-repo")[0] as unknown as HTMLSelectElement).options).toHaveLength(2);
  });

  test("404 shows one unsupported banner and recovers", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(err);
    worktreesMock.mockRejectedValueOnce(new ApiError("/worktrees", 404, "not found", "GET"));
    const { panel, q, go } = setup();
    await panel.activate();
    expect(q(".project-unsupported")).toHaveLength(1);
    expect(q(".project-unsupported")[0]!.textContent).toContain("/worktrees");
    expect(q(".project-unsupported")[0]!.textContent).toContain("older daemon");
    expect(q(".project-lane")).toHaveLength(0);
    q(".project-unsupported button")[0]!.click();
    expect(go).toHaveBeenCalledWith("live");
    expect(err).not.toHaveBeenCalled();
    await panel.refresh();
    expect(q(".project-unsupported")).toHaveLength(0);
    expect(q(".project-lane").length).toBeGreaterThan(0);
  });

  test("network failure shows retry, keeps lanes on later failures", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    spies.push(err);
    worktreesMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { panel, q, keys } = setup();
    panel.setConnected(true);
    await panel.activate();
    expect(q(".project-error")).toHaveLength(1);
    expect(q(".project-lane")).toHaveLength(0);
    q("button.project-retry")[0]!.click();
    await vi.waitFor(() => expect(keys().length).toBeGreaterThan(0));
    expect(q(".project-error")).toHaveLength(0);
    worktreesMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await panel.refresh();
    expect(keys().length).toBeGreaterThan(0);
    expect(q("button.project-retry")).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
  });

  test("abort after deactivate renders nothing", async () => {
    const d = deferred<WorktreeLifetimeView[]>();
    worktreesMock.mockReturnValueOnce(d.promise);
    const { panel, q } = setup();
    const p = panel.activate();
    panel.deactivate();
    d.reject(new DOMException("aborted", "AbortError"));
    await p;
    expect(q(".project-error, .project-connecting, .project-lane")).toHaveLength(0);
  });

  test("disconnected failure shows connecting and recovers on setConnected(true)", async () => {
    worktreesMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { panel, q, keys } = setup();
    panel.setConnected(false);
    await panel.activate();
    expect(q(".project-connecting")[0]!.textContent).toContain("Connecting to daemon");
    expect(q(".project-error")).toHaveLength(0);
    panel.setConnected(true);
    await vi.waitFor(() => expect(keys().length).toBeGreaterThan(0));
    expect(q(".project-connecting")).toHaveLength(0);
  });
});

describe("interaction", () => {
  const key = (k: string, target: Element | Document = document.body, init: KeyboardEventInit = {}): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const lane = (q: (s: string) => HTMLElement[], id: string) => q(".project-lane").find((l) => l.getAttribute("data-key") === id)!;
  const sel = (q: (s: string) => HTMLElement[]) => q(".project-lane.selected").map((l) => l.getAttribute("data-key"));
  const mouse = (type: string, x: number, target: EventTarget, init: MouseEventInit = {}) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0, ...init }));

  async function ready() {
    const s = setup();
    s.store.narrow({ project: "repoA" });
    await s.panel.activate();
    return s;
  }

  test("lane click descends once without touching the store", async () => {
    const { store, go, q } = await ready();
    const before = store.get();
    lane(q, "wt-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("sessions", { project: "repoA", worktree: "wt-open" });
    expect(store.get()).toBe(before);
  });

  test("bead click descends to score and not to sessions", async () => {
    const { go, q } = await ready();
    q(".project-bead[data-session=s-o1]")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith("score", { project: "repoA", worktree: "wt-open", session: { id: "s-o1", source: "codex" } });
  });

  test("bead identity carries its own source", async () => {
    worktreesMock.mockResolvedValue([
      row({
        worktree_id: "wt-x", repo_id: "repoA", state: "open", fork_time: iso(NOW - 2 * D), last_time: iso(NOW - H),
        sessions: [
          { session_id: "dup", source: "codex", first_time: iso(NOW - 2 * H), last_time: iso(NOW - H), events: 3 },
          { session_id: "dup", source: "claude-code", first_time: iso(NOW - 4 * H), last_time: iso(NOW - 3 * H), events: 3 },
        ],
      } as never),
    ]);
    const { go, q } = await ready();
    const beads = q(".project-bead[data-session=dup]");
    expect(beads).toHaveLength(2);
    for (const b of beads) b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const sources = go.mock.calls.map((c) => (c[1] as { session: { source: string } }).session.source).sort();
    expect(sources).toEqual(["claude-code", "codex"]);
  });

  describe("keys", () => {
    test("digit moves the cursor only", async () => {
      const { store, go, q, keys } = await ready();
      const before = store.get();
      const e = key("2");
      expect(e.defaultPrevented).toBe(true);
      expect(sel(q)).toEqual([keys()[1]]);
      expect(go).not.toHaveBeenCalled();
      expect(store.get()).toBe(before);
      await vi.waitFor(() => expect(worktreeMock).toHaveBeenCalledWith(keys()[1], expect.anything()));
    });

    test("out of range digit does nothing", async () => {
      const { q } = await ready();
      const e = key("9");
      expect(e.defaultPrevented).toBe(false);
      expect(sel(q)).toEqual([]);
    });

    test("arrows move by one and clamp", async () => {
      const { q, keys } = await ready();
      key("ArrowDown");
      expect(sel(q)).toEqual([keys()[0]]);
      key("ArrowUp");
      expect(sel(q)).toEqual([keys()[0]]);
      for (let i = 0; i < 10; i++) key("ArrowDown");
      expect(sel(q)).toEqual([keys()[5]]);
      key("ArrowUp");
      expect(sel(q)).toEqual([keys()[4]]);
    });

    test("a keyboard cursor does not survive leaving and returning after a scope change elsewhere", async () => {
      const { store, panel, q, keys } = await ready();
      key("ArrowDown");
      key("ArrowDown");
      expect(sel(q)).toEqual([keys()[1]]);
      panel.deactivate();
      store.narrow({ worktree: keys()[4]! });
      await panel.activate();
      expect(sel(q)).toEqual([keys()[4]]);
      panel.deactivate();
      store.narrow({ worktree: undefined });
      await panel.activate();
      expect(sel(q)).toEqual([]);
    });

    test("Enter descends the selection, nothing without one", async () => {
      const { go, keys } = await ready();
      const none = key("Enter");
      expect(none.defaultPrevented).toBe(false);
      expect(go).not.toHaveBeenCalled();
      key("3");
      const e = key("Enter");
      expect(e.defaultPrevented).toBe(true);
      expect(go).toHaveBeenCalledTimes(1);
      expect(go).toHaveBeenCalledWith("sessions", { project: "repoA", worktree: keys()[2] });
    });

    test("excluded targets and modifiers", async () => {
      const { go, q, panel } = await ready();
      const outside = (tag: string, attrs: Record<string, string> = {}) => {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        document.body.append(n);
        return n;
      };
      const targets: Element[] = [
        outside("input"), outside("textarea"), outside("select"), outside("div", { contenteditable: "true" }),
        outside("button", { class: "nav-btn" }), outside("div", { class: "attention" }), outside("aside", { class: "detail" }),
        panel.root.querySelector("select.project-repo")!,
      ];
      for (const t of targets) {
        const e = key("2", t);
        expect(e.defaultPrevented).toBe(false);
      }
      expect(sel(q)).toEqual([]);
      for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
        expect(key("2", document.body, init).defaultPrevented).toBe(false);
      }
      const pre = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
      document.body.addEventListener("keydown", (ev) => ev.preventDefault(), { once: true });
      document.body.dispatchEvent(pre);
      expect(sel(q)).toEqual([]);
      const dlg = outside("div", { role: "dialog" });
      expect(key("2").defaultPrevented).toBe(false);
      dlg.remove();
      const ov = outside("div", { class: "onboarding-overlay" });
      expect(key("2").defaultPrevented).toBe(false);
      ov.remove();
      expect(go).not.toHaveBeenCalled();
      expect(key("2").defaultPrevented).toBe(true);
    });

    test("root detached ignores keys", async () => {
      const { panel, q } = await ready();
      panel.root.remove();
      expect(key("2").defaultPrevented).toBe(false);
      document.body.append(panel.root);
      expect(q(".project-lane.selected")).toHaveLength(0);
    });

    test("Enter on a focused lane or button descends once", async () => {
      const { go, q, panel } = await ready();
      key("Enter", lane(q, "wt-open"));
      expect(go).toHaveBeenCalledTimes(1);
      go.mockClear();
      key("2");
      const btn = panel.root.querySelector("button.project-live")!;
      key("Enter", btn);
      expect(go).not.toHaveBeenCalled();
    });

    test("Space on a focused lane descends once and is prevented", async () => {
      const { go, q } = await ready();
      const e = key(" ", lane(q, "wt-open"));
      expect(e.defaultPrevented).toBe(true);
      expect(go).toHaveBeenCalledTimes(1);
    });
  });

  describe("listener hygiene", () => {
    test("activate twice adds one listener, deactivate removes it", async () => {
      const add = vi.spyOn(document, "addEventListener");
      const remove = vi.spyOn(document, "removeEventListener");
      spies.push(add, remove);
      const { panel } = await ready();
      await panel.activate();
      // One bubble listener for keys plus one capture listener so Escape claims land first.
      const added = add.mock.calls.filter((c) => c[0] === "keydown");
      expect(added).toHaveLength(2);
      expect(added.filter((c) => c[2] === true)).toHaveLength(1);
      panel.deactivate();
      expect(remove.mock.calls.filter((c) => c[0] === "keydown")).toHaveLength(2);
      expect(key("2").defaultPrevented).toBe(false);
    });

    test("a second panel does not react after the first is deactivated", async () => {
      const a = await ready();
      a.panel.deactivate();
      const b = await ready();
      key("2");
      expect(b.q(".project-lane.selected")).toHaveLength(1);
      expect(a.q(".project-lane.selected")).toHaveLength(0);
    });
  });

  test("Escape is claimed only for a keyboard-picked lane or an open brush; otherwise left to the shared handler", async () => {
    const { store, go, q, panel } = await ready();
    const before = store.get();
    for (const t of [document.body, panel.root.querySelector("select.project-repo")!, lane(q, "wt-open")]) {
      const e = key("Escape", t);
      expect(e.defaultPrevented).toBe(false);
      expect(isEscapeClaimed(e)).toBe(false);
    }
    key("2");
    expect(sel(q)).not.toEqual([]);
    const picked = key("Escape");
    expect(isEscapeClaimed(picked)).toBe(true);
    expect(sel(q)).toEqual([]);
    expect(isEscapeClaimed(key("Escape"))).toBe(false);
    expect(store.get()).toBe(before);
    expect(go).not.toHaveBeenCalled();
  });

  describe("brush", () => {
    beforeEach(() => {
      spies.push(
        vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({
          left: 0, top: 0, right: 960, bottom: 200, width: 960, height: 200, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect),
      );
    });
    const X0 = 170;

    test("drag sets the shared window", async () => {
      const { store, q } = await ready();
      const svg = q("svg.project-svg")[0]!;
      const range = resolveWindow(store.get().window, NOW);
      mouse("mousedown", 550, svg);
      mouse("mousemove", 325, document);
      expect(q(".project-brush")).toHaveLength(1);
      expect(q(".project-brush")[0]!.getAttribute("width")).toBe("225");
      mouse("mouseup", 325, document);
      expect(q(".project-brush")).toHaveLength(0);
      expect(store.get().window).toEqual({ from: xToTime(325, range, X0, 870), to: xToTime(550, range, X0, 870) });
      expect(q(".project-lane").length).toBeGreaterThan(0);
      expect(q("button.project-live")[0]!.getAttribute("aria-pressed")).toBe("false");
      q("button.project-live")[0]!.click();
      expect(store.get().window).toBe("live");
      expect(q("button.project-live")[0]!.getAttribute("aria-pressed")).toBe("true");
    });

    test("tiny drag changes nothing", async () => {
      const { store, q } = await ready();
      const svg = q("svg.project-svg")[0]!;
      mouse("mousedown", 550, svg);
      mouse("mousemove", 552, document);
      expect(q(".project-brush")).toHaveLength(0);
      mouse("mouseup", 552, document);
      expect(store.get().window).toBe("live");
    });

    test("mouseup outside the plot clamps", async () => {
      const { store, q } = await ready();
      const svg = q("svg.project-svg")[0]!;
      const range = resolveWindow(store.get().window, NOW);
      mouse("mousedown", 550, svg);
      mouse("mouseup", 5000, document);
      expect(store.get().window).toEqual({ from: xToTime(550, range, X0, 870), to: range.to });
    });

    test("mousedown in the label gutter is ignored", async () => {
      const { store, q } = await ready();
      mouse("mousedown", 100, q("svg.project-svg")[0]!);
      mouse("mousemove", 400, document);
      mouse("mouseup", 400, document);
      expect(q(".project-brush")).toHaveLength(0);
      expect(store.get().window).toBe("live");
    });

    test("document listeners are removed after mouseup and on deactivate", async () => {
      const add = vi.spyOn(document, "addEventListener");
      const remove = vi.spyOn(document, "removeEventListener");
      spies.push(add, remove);
      const { panel, q } = await ready();
      const count = (spy: typeof add, t: string) => spy.mock.calls.filter((c) => c[0] === t).length;
      mouse("mousedown", 550, q("svg.project-svg")[0]!);
      expect(count(add, "mousemove")).toBe(1);
      mouse("mouseup", 600, document);
      expect(count(remove, "mousemove")).toBe(1);
      expect(count(remove, "mouseup")).toBe(1);
      mouse("mousedown", 550, q("svg.project-svg")[0]!);
      panel.deactivate();
      expect(count(remove, "mousemove")).toBe(2);
      expect(count(remove, "mouseup")).toBe(2);
    });

    test("plain click on a lane descends; a drag from a lane brushes and does not", async () => {
      const { store, go, q } = await ready();
      const l = lane(q, "wt-open");
      mouse("mousedown", 500, l);
      mouse("mouseup", 500, document);
      l.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(go).toHaveBeenCalledTimes(1);
      go.mockClear();
      const l2 = lane(q, "wt-open");
      mouse("mousedown", 500, l2);
      mouse("mousemove", 600, document);
      mouse("mouseup", 5000, document);
      l2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(go).not.toHaveBeenCalled();
      expect(store.get().window).not.toBe("live");
      lane(q, "wt-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(go).toHaveBeenCalledTimes(1);
    });
  });

  describe("window round trip", () => {
    test("shared scope window follows scope.ts rules", async () => {
      const store = createScope();
      const panel = createProject({ store, go: (_n, p) => store.narrow(p!), now: () => NOW });
      document.body.append(panel.root);
      panels.push(panel);
      store.narrow({ project: "repoA" });
      await panel.activate();
      spies.push(
        vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({
          left: 0, top: 0, right: 960, bottom: 200, width: 960, height: 200, x: 0, y: 0, toJSON: () => ({}),
        } as DOMRect),
      );
      const q = (s: string) => [...panel.root.querySelectorAll<HTMLElement>(s)];
      const svg = q("svg.project-svg")[0]!;
      mouse("mousedown", 300, svg);
      mouse("mouseup", 5000, document);
      const win = store.get().window;
      expect(win).not.toBe("live");
      await new Promise((r) => setTimeout(r, 5));
      lane(q, "wt-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(store.get().worktree).toBe("wt-open");
      expect(store.get().window).toEqual(win);
      panel.deactivate();
      await panel.activate();
      expect(q(".project-window")[0]!.textContent).toContain("→");
      q(".project-bead[data-session=s-o1]")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(store.get().session).toEqual({ id: "s-o1", source: "codex" });
      expect(store.get().window).toBe("live");
    });
  });
});

describe("scope membership", () => {
  const M = (store: ScopeStore, sc: Parameters<NonNullable<ReturnType<ScopeStore["resolver"]>>["sessions"]>[0]) => store.resolver()!.matcher!(sc);

  test("registered on createProject; worktree and project matchers follow session refs", async () => {
    const { store, panel } = setup();
    expect(store.resolver()).not.toBeNull();
    await panel.activate();
    await flush();
    const wt = M(store, { project: "repoA", worktree: "wt-open", window: "live" })!;
    expect(wt({ source: "codex", id: "s-o1" })).toBe(true);
    // wt-open is a capped sample (sessions_total 2, 1 listed): a session known to sit in another lane is out.
    expect(wt({ source: "codex", id: "s-l1" })).toBe(false);
    const done = M(store, { project: "repoA", worktree: "wt-landed", window: "live" })!;
    expect(done({ source: "codex", id: "s-l1" })).toBe(true);
    expect(done({ source: "claude-code", id: "s-l1" })).toBe(false);
    expect(done({ source: "codex", id: "s-o1" })).toBe(false);
    const proj = M(store, { project: "repoA", window: "live" })!;
    for (const r of rowsA) for (const s of r.sessions) expect(proj({ source: s.source, id: s.session_id })).toBe(true);
    expect(proj({ source: "codex", id: "s-b1" })).toBe(false);
  });

  test("unknown project or worktree is unrestricted", async () => {
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    expect(M(store, { project: "nope", window: "live" })).toBeUndefined();
    expect(M(store, { project: "repoA", worktree: "nope", window: "live" })).toBeUndefined();
    expect(M(store, { window: "live" })).toBeUndefined();
  });

  test("labels: worktree label only when present; project never invented", async () => {
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    const r = store.resolver()!;
    expect(r.labels({ project: "repoA", worktree: "wt-open", window: "live" })).toEqual({ worktree: "/w/alpha-open" });
    expect(r.labels({ project: "repoA", worktree: "wt-unk", window: "live" })).toEqual({});
  });

  test("membership follows a refreshed load and survives deactivate", async () => {
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    worktreesMock.mockImplementation(() => Promise.resolve(FIXTURE_ROWS.map((r) => r.worktree_id === "wt-open"
      ? { ...r, sessions_total: 1, sessions: [{ ...r.sessions[0], session_id: "s-o9" }] } : r)));
    await panel.refresh();
    await flush();
    const wt = M(store, { project: "repoA", worktree: "wt-open", window: "live" })!;
    expect(wt({ source: "codex", id: "s-o9" })).toBe(true);
    expect(wt({ source: "codex", id: "s-o1" })).toBe(false);
    panel.deactivate();
    expect(M(store, { project: "repoA", worktree: "wt-open", window: "live" })).toBeDefined();
  });

  test("resolver refresh re-reads membership while the panel is inactive", async () => {
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    panel.deactivate();
    worktreesMock.mockImplementation(() => Promise.resolve(FIXTURE_ROWS.map((r) => r.worktree_id === "wt-open"
      ? { ...r, sessions_total: 1, sessions: [{ ...r.sessions[0], session_id: "s-o9" }] } : r)));
    await store.resolver()!.refresh!();
    const wt = M(store, { project: "repoA", worktree: "wt-open", window: "live" })!;
    expect(wt({ source: "codex", id: "s-o9" })).toBe(true);
    expect(wt({ source: "codex", id: "s-o1" })).toBe(false);
  });
});

describe("review regressions", () => {
  const sessRef = (source: string, id: string) => ({ source, session_id: id, first_time: iso(NOW - D), last_time: iso(NOW - H), events: 1 });
  test("navigation patches clear Matrix's cell filter", async () => {
    const { store, go, panel, q } = setup();
    store.narrow({ project: "repoA", cell: { where: "w", agent: "a", label: "l" } as never });
    await panel.activate();
    store.narrow({ cell: { where: "w", agent: "a", label: "l" } as never });
    q(".project-lane")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    q(".project-bead")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledTimes(2);
    for (const c of go.mock.calls) expect(Object.prototype.hasOwnProperty.call(c[1], "cell") && c[1].cell === undefined).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const last = go.mock.calls[2]!;
    expect(last[1]).toHaveProperty("cell", undefined);
    const sel = q("select.project-repo")[0] as unknown as HTMLSelectElement;
    store.narrow({ cell: { where: "w", agent: "a", label: "l" } as never });
    sel.value = "repoB";
    sel.dispatchEvent(new Event("change"));
    expect(store.get().cell).toBeUndefined();
    expect(store.get().project).toBe("repoB");
  });

  test("a capped lane admits unknown sessions, excludes ones known elsewhere, and reports partial membership", async () => {
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    const sc = { project: "repoA", worktree: "wt-open", window: "live" } as const;
    const r = store.resolver()!;
    expect(r.matcher!(sc)!({ source: "codex", id: "s-never-listed" })).toBe(true);
    expect(r.matcher!(sc)!({ source: "claude-code", id: "s-i1" })).toBe(false);
    expect(r.sessions(sc)).toBeUndefined();
    expect(r.partial!(sc)).toEqual({ known: 1, total: 2 });
    expect(r.partial!({ project: "repoA", worktree: "wt-landed", window: "live" })).toBeUndefined();
  });

  test("overlapping background refreshes: the older response never overwrites the newer", async () => {
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    panel.deactivate();
    const slow = deferred<WorktreeLifetimeView[]>();
    const fast = deferred<WorktreeLifetimeView[]>();
    worktreesMock.mockReset().mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
    const r = store.resolver()!;
    const p1 = r.refresh!();
    const p2 = r.refresh!();
    const withNew = FIXTURE_ROWS.map((x) => (x.worktree_id === "wt-landed" ? { ...x, sessions: [...x.sessions, sessRef("codex", "s-new")], sessions_total: 3 } : x));
    fast.resolve(withNew);
    await p2;
    slow.resolve(FIXTURE_ROWS);
    await p1;
    const m = store.resolver()!.matcher!({ project: "repoA", worktree: "wt-landed", window: "live" })!;
    expect(m({ source: "codex", id: "s-new" })).toBe(true);
  });

  test("a deleted worktree is a valid historical identity for membership", async () => {
    worktreesMock.mockImplementation(() => Promise.resolve([...FIXTURE_ROWS, row({ worktree_id: "wt-del", state: "gone", outcome: "landed", sessions: [sessRef("codex", "s-del")], sessions_total: 1 })]));
    const { store, panel } = setup();
    await panel.activate();
    await flush();
    const sc = { project: "repoA", worktree: "wt-del", window: "live" } as const;
    expect(store.resolver()!.knows!(sc)).toBe(true);
    expect(store.resolver()!.matcher!(sc)!({ source: "codex", id: "s-del" })).toBe(true);
  });

  test("a gone lane shows its real outcome, not always abandoned", async () => {
    worktreesMock.mockImplementation(() => Promise.resolve([
      row({ worktree_id: "g-land", state: "gone", outcome: "landed", last_time: iso(NOW - H) }),
      row({ worktree_id: "g-none", state: "gone", last_time: iso(NOW - H) }),
      row({ worktree_id: "g-nd", state: "gone", outcome: "never_diverged", last_time: iso(NOW - H) }),
    ]));
    const { panel, q } = setup();
    await panel.activate();
    const txt = (id: string) => q(".project-lane").find((l) => l.getAttribute("data-key") === id)!.querySelector(".project-outcome")!.textContent;
    expect(txt("g-land")).toBe("landed");
    expect(txt("g-none")).toBe("removed");
    expect(txt("g-nd")).toBe("never diverged");
  });

  test("a landed lane without a merge mark draws a dashed unknown-time rejoin", async () => {
    worktreesMock.mockImplementation(() => Promise.resolve([
      row({ worktree_id: "l-unk", state: "landed", last_time: iso(NOW - D) }),
      row({ worktree_id: "l-mark", state: "landed", first_time: iso(NOW - 3 * D), last_time: iso(NOW - 2 * D), marks: [{ kind: "pr_merge", time: iso(NOW - D), event_id: "m" }], marks_total: 1 }),
    ]));
    const { panel, q } = setup();
    await panel.activate();
    const laneOf = (id: string) => q(".project-lane").find((l) => l.getAttribute("data-key") === id)!;
    expect(laneOf("l-unk").querySelector(".project-rejoin.unknown-time")).not.toBeNull();
    expect(laneOf("l-unk").textContent).toContain("landed ?");
    expect(laneOf("l-mark").querySelector(".project-rejoin.unknown-time")).toBeNull();
    expect(laneOf("l-mark").querySelector(".project-landgap")).not.toBeNull();
  });
});

describe("fleet hooks", () => {
  function make(extra: Partial<Parameters<typeof createProject>[0]>) {
    const store = createScope();
    const panel = createProject({ store, go: vi.fn(), now: () => NOW, refreshMs: 15000, ...extra });
    document.body.append(panel.root);
    panels.push(panel);
    return { store, panel };
  }
  test("onRows fires after each successful load, not on failure or 404", async () => {
    const onRows = vi.fn();
    const { panel } = make({ onRows });
    await panel.activate();
    expect(onRows).toHaveBeenCalledTimes(1);
    expect(onRows).toHaveBeenLastCalledWith(FIXTURE_ROWS);
    await panel.refresh();
    expect(onRows).toHaveBeenCalledTimes(2);
    worktreesMock.mockRejectedValueOnce(new Error("boom"));
    await panel.refresh();
    worktreesMock.mockRejectedValueOnce(new ApiError("/worktrees", 404, "not found", "GET"));
    await panel.refresh();
    expect(onRows).toHaveBeenCalledTimes(2);
  });
  test("a throwing onRows does not break the panel", async () => {
    const { panel } = make({ onRows: () => { throw new Error("nope"); } });
    await expect(panel.activate()).resolves.toBeUndefined();
    expect(panel.root.querySelectorAll(".project-lane").length).toBeGreaterThan(0);
  });
  test("projectLabel names the repository option and falls back to the id", async () => {
    const { panel } = make({ projectLabel: (id) => (id === "repoA" ? "Alpha" : undefined) });
    await panel.activate();
    const opts = [...panel.root.querySelectorAll("select.project-repo option")];
    expect(opts.find((o) => o.getAttribute("value") === "repoA")!.textContent).toBe("Alpha");
    const other = opts.find((o) => o.getAttribute("value") !== "repoA")!;
    expect(other.textContent).toBe(other.getAttribute("value"));
  });
});
