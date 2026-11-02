// @vitest-environment happy-dom
import { createSessionDirectory } from "../../session-directory";
import type { SessionDirectory } from "../../session-directory";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../api";
import type { AttentionSession, FirehoseEvent, SessionSummary, WorktreeLifetimeView } from "../../api";
import { isEscapeClaimed } from "../../escape";
import { __resetKeysForTests, listKeys, registerKeys } from "../../keys";
import { DEFAULT_LIVE_SPAN_MS, createScope } from "../../scope";
import type { ScopePatch, ScopeStore } from "../../scope";
import { FIXTURE_ROWS, NOW, att, ev, iso, row } from "./model.fixtures";
import { orderLanes } from "../project/model";
import { createFleet } from "./index";
import type { FleetDeps } from "./index";
import type { FleetApi, FleetPanel } from "./index";

const MIN = 60_000;
const REFRESH = 15_000;
const TIMEOUT = 5_000;

const S = {
  needA: () => att({ id: "sa", repo_id: "repoA", worktree_id: "wt-open", waitMs: 8 * MIN }),
  workA: () => att({ id: "sw", repo_id: "repoA", worktree_id: "wt-open" }),
  workB: () => att({ id: "sb", repo_id: "repoB", worktree_id: "wt-b1", source: "codex", agent: "codex" }),
  fog: () => att({ id: "sz", repo_id: "repoZ", repo: "zeta" }),
  noRepo: () => att({ id: "sn", waitMs: 2 * MIN }),
};
const baseSessions = (): AttentionSession[] => [S.needA(), S.workA(), S.workB(), S.fog(), S.noRepo()];

let nowMs = NOW;
const panels: FleetPanel[] = [];
const spies: Array<{ mockRestore(): void }> = [];
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const never = <T>(): Promise<T> => new Promise<T>(() => {});

interface Rig {
  api: { worktrees: ReturnType<typeof vi.fn>; attention: ReturnType<typeof vi.fn>; sessions: ReturnType<typeof vi.fn> };
  data: { wt: WorktreeLifetimeView[]; sessions: AttentionSession[]; summaries: SessionSummary[]; events: FirehoseEvent[] };
}

function setup(opts: { scope?: Parameters<typeof createScope>[0]; realGo?: boolean; onLabels?: (l: Record<string, string>) => void; onEncoding?: () => void; directory?: SessionDirectory; hosts?: FleetDeps["hosts"] } = {}) {
  const store: ScopeStore = createScope(opts.scope);
  const data: Rig["data"] = { wt: FIXTURE_ROWS, sessions: baseSessions(), summaries: [], events: [] };
  const api = {
    worktrees: vi.fn((_s?: AbortSignal) => Promise.resolve(data.wt)),
    attention: vi.fn((_s?: AbortSignal) => Promise.resolve({ sessions: data.sessions, warnings: [] })),
    sessions: vi.fn((_s?: AbortSignal) => Promise.resolve(data.summaries)),
  };
  const go = vi.fn((_n: string, p?: ScopePatch) => { if (opts.realGo && p) store.narrow(p); });
  const panel = createFleet({
    store, go: go as never, events: () => data.events, api: api as unknown as FleetApi,
    now: () => nowMs, refreshMs: REFRESH, loadTimeoutMs: TIMEOUT, onLabels: opts.onLabels, onEncoding: opts.onEncoding, directory: opts.directory, hosts: opts.hosts,
  });
  document.body.append(panel.root);
  panels.push(panel);
  const q = (s: string) => [...panel.root.querySelectorAll<HTMLElement>(s)];
  const byKey = (k: string) => q("[data-key]").find((n) => n.getAttribute("data-key") === k)!;
  return { store, api, data, go, panel, q, byKey };
}
const key = (e: string, ...parts: string[]) => `${e}:${parts.join("|")}`;
const needKey = (source: string, id: string) => key("need", JSON.stringify([source, id]));
const press = (k: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

beforeEach(() => {
  __resetKeysForTests();
  vi.useFakeTimers();
  nowMs = NOW;
});
afterEach(() => {
  for (const p of panels.splice(0)) p.deactivate();
  __resetKeysForTests();
  document.body.replaceChildren();
  vi.useRealTimers();
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("render", () => {
  test("one row per repo in stable order: known, fog, then no-repo last", async () => {
    const { panel, q, api } = setup();
    await panel.activate();
    expect(q(".fleet-row").map((r) => r.getAttribute("data-key"))).toEqual([key("row", "repoB"), key("row", "repoA"), key("row", "repoZ"), key("row", "__no_repo__")]);
    expect(q(".fleet-row.fog").map((r) => r.getAttribute("data-key"))).toEqual([key("row", "repoZ")]);
    expect(q(".fleet-row.norepo")).toHaveLength(1);
    expect(q(".fleet-fork")).toHaveLength(7);
    expect(q(".fleet-need")).toHaveLength(2);
    expect(api.worktrees.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(api.attention.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
  });

  test("meta appears only in tooltips", async () => {
    const { panel, q, byKey } = setup();
    await panel.activate();
    expect(byKey(key("fork", "repoA", "wt-open")).getAttribute("title")).toContain("cost (meta events): 12");
    expect(panel.root.textContent!.toLowerCase()).not.toContain("meta");
    expect(q(".fleet-fork").every((f) => f.getAttribute("aria-label"))).toBe(true);
  });

  test("labels come from the text, never markup", async () => {
    const { panel, data, byKey } = setup();
    data.sessions = [att({ id: "x", repo_id: "repoQ", repo: "<img src=x onerror=alert(1)>" })];
    await panel.activate();
    expect(panel.root.querySelector("img")).toBeNull();
    expect(byKey(key("row", "repoQ")).textContent).toContain("<img src=x onerror=alert(1)>");
  });

  test("a resolver label replaces the repo name and onLabels reports it once", async () => {
    const onLabels = vi.fn();
    const { panel, store, q } = setup({ onLabels });
    store.setResolver({ sessions: () => undefined, labels: (sc) => (sc.project === "repoA" ? { project: "Alpha Repo" } : {}) });
    await panel.activate();
    expect(q(".fleet-row")[1]!.textContent).toContain("Alpha Repo");
    expect(onLabels).toHaveBeenCalled();
    const last = onLabels.mock.calls.at(-1)![0];
    expect(last.repoA).toBe("Alpha Repo");
    expect(last.__no_repo__).toBeUndefined();
    const n = onLabels.mock.calls.length;
    await panel.refresh();
    expect(onLabels.mock.calls.length).toBe(n);
  });

  test("current scope is highlighted on the row and fork", async () => {
    const { panel, q } = setup({ scope: { project: "repoA", worktree: "wt-open", window: "live" } });
    await panel.activate();
    expect(q(".fleet-row.current").map((r) => r.getAttribute("data-key"))).toEqual([key("row", "repoA")]);
    expect(q(".fleet-fork.current").map((r) => r.getAttribute("data-key"))).toEqual([key("fork", "repoA", "wt-open")]);
  });
});

describe("in-place rendering", () => {
  test("nodes are reused across refreshes with changed data", async () => {
    const { panel, data, q, byKey } = setup();
    await panel.activate();
    const rowA = byKey(key("row", "repoA"));
    const forkOpen = byKey(key("fork", "repoA", "wt-open"));
    const need = byKey(needKey("claude-code", "sa"));
    data.sessions = [...baseSessions(), att({ id: "sb2", repo_id: "repoA", worktree_id: "wt-open", waitMs: 3 * MIN })];
    await panel.refresh();
    expect(q(".fleet-need")).toHaveLength(3);
    expect(byKey(key("row", "repoA"))).toBe(rowA);
    expect(byKey(key("fork", "repoA", "wt-open"))).toBe(forkOpen);
    expect(byKey(needKey("claude-code", "sa"))).toBe(need);
  });

  test("an unchanged refresh produces zero DOM mutations", async () => {
    const { panel } = setup();
    await panel.activate();
    const seen: MutationRecord[] = [];
    const mo = new MutationObserver((r) => seen.push(...r));
    mo.observe(panel.root, { subtree: true, childList: true, attributes: true, characterData: true });
    await panel.refresh();
    await flush();
    expect(seen.length + mo.takeRecords().length).toBe(0);
    mo.disconnect();
  });

  test("row order does not move when a later repo becomes the newest", async () => {
    const { panel, data, q } = setup();
    await panel.activate();
    const before = q(".fleet-row").map((r) => r.getAttribute("data-key"));
    data.wt = FIXTURE_ROWS.map((w) => (w.repo_id === "repoA" ? { ...w, last_time: iso(NOW) } : w));
    await panel.refresh();
    expect(q(".fleet-row").map((r) => r.getAttribute("data-key"))).toEqual(before);
  });

  test("only transitions animate: .changed is set once and expires after 1600ms", async () => {
    const { panel, data, q, byKey } = setup();
    await panel.activate();
    expect(q(".changed")).toHaveLength(0);
    data.sessions = [...baseSessions(), att({ id: "sb2", repo_id: "repoA", worktree_id: "wt-open", waitMs: 3 * MIN })];
    await panel.refresh();
    expect(byKey(key("row", "repoA")).classList.contains("changed")).toBe(true);
    expect(byKey(key("row", "repoB")).classList.contains("changed")).toBe(false);
    expect(byKey(needKey("claude-code", "sb2")).classList.contains("changed")).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    await panel.refresh();
    expect(byKey(key("row", "repoA")).classList.contains("changed")).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(q(".changed").length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(q(".changed")).toHaveLength(0);
    await panel.refresh();
    expect(q(".changed")).toHaveLength(0);
  });

  test("a snapshot with attention ahead of worktrees draws fog, then the same row becomes known in place", async () => {
    const { panel, data, q, byKey } = setup();
    await panel.activate();
    const ids = () => q(".fleet-row").map((r) => r.getAttribute("data-key"));
    const fog = byKey(key("row", "repoZ"));
    const idx = ids().indexOf(key("row", "repoZ"));
    expect(fog.classList.contains("fog")).toBe(true);
    expect(fog.querySelectorAll(".fleet-fork")).toHaveLength(0);
    data.wt = [...FIXTURE_ROWS, row({ repo_id: "repoZ", worktree_id: "wt-z", label: "/w/zeta", last_time: iso(NOW) })];
    await panel.refresh();
    expect(byKey(key("row", "repoZ"))).toBe(fog);
    expect(ids().indexOf(key("row", "repoZ"))).toBe(idx);
    expect(fog.classList.contains("fog")).toBe(false);
    expect(fog.querySelectorAll(".fleet-fork")).toHaveLength(1);
  });
});

describe("navigation", () => {
  const hist = { from: NOW - 5 * 86_400_000, to: NOW - 2 * 86_400_000 };
  const populated = () => ({ project: "repoA", worktree: "wt-open", session: { id: "z" }, window: hist });
  const KEYS = ["cell", "project", "session", "window", "worktree"];

  test("every go patch carries project, worktree, session, cell and window keys", async () => {
    const { panel, go, byKey } = setup({ scope: populated() });
    await panel.activate();
    byKey(key("row", "repoB")).querySelector<HTMLElement>(".fleet-row-head")!.click();
    byKey(key("fork", "repoA", "wt-landed")).click();
    byKey(needKey("claude-code", "sa")).click();
    // Changed (fleet-altitude item 3): a fork glyph narrows project+worktree and descends to Sessions, not Project.
    expect(go.mock.calls.map((c) => c[0])).toEqual(["project", "sessions", "score"]);
    for (const c of go.mock.calls) {
      expect(Object.keys(c[1]!).sort()).toEqual(KEYS);
      expect((c[1] as ScopePatch).window).toEqual(hist);
    }
    expect(go.mock.calls[0]![1]).toMatchObject({ project: "repoB", worktree: undefined, session: undefined });
    expect(go.mock.calls[1]![1]).toMatchObject({ project: "repoA", worktree: "wt-landed", session: undefined, cell: undefined });
    expect(go.mock.calls[2]![1]).toMatchObject({ project: "repoA", worktree: "wt-open", session: { id: "sa", source: "claude-code" } });
  });

  test("a live window is passed as 'live'", async () => {
    const { panel, go, byKey } = setup();
    await panel.activate();
    byKey(key("fork", "repoA", "wt-open")).click();
    expect((go.mock.calls[0]![1] as ScopePatch).window).toBe("live");
  });

  test.each([
    ["row", () => key("row", "repoB"), ".fleet-row-head"],
    ["fork", () => key("fork", "repoA", "wt-landed"), ""],
    ["need", () => needKey("claude-code", "sa"), ""],
    ["lane", () => `claude-code\u0000sa`, ""],
  ])("%s click keeps the historical window in the real store", async (name, k, sub) => {
    const { panel, store, byKey, data } = setup({ scope: populated(), realGo: true });
    data.events = [ev({ id: "e1", session_id: "sa", time: iso(hist.to - 10_000) })];
    if (name === "lane") panel.encoding = "lanes";
    await panel.activate();
    await flush();
    const node = name === "lane" ? panel.root.querySelector<HTMLElement>(".fleet-lane-row")! : byKey(k());
    (sub ? node.querySelector<HTMLElement>(sub)! : node).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(store.get().window).toEqual(hist);
  });

  test("the unattributed row and fog rows are not navigable but their needs are", async () => {
    const { panel, go, byKey } = setup();
    await panel.activate();
    byKey(key("row", "__no_repo__")).querySelector<HTMLElement>(".fleet-row-head")!.click();
    byKey(key("row", "repoZ")).querySelector<HTMLElement>(".fleet-row-head")!.click();
    expect(go).not.toHaveBeenCalled();
    byKey(needKey("claude-code", "sn")).click();
    expect(go.mock.calls[0]![0]).toBe("score");
    expect((go.mock.calls[0]![1] as ScopePatch).project).toBeUndefined();
  });

  test("a window-only store change neither refetches nor re-renders rows, and draws no chip", async () => {
    const { panel, store, api, q } = setup();
    await panel.activate();
    expect(q(".fleet-window")).toHaveLength(0);
    const calls = api.worktrees.mock.calls.length;
    const rows = q(".fleet-row");
    const seen: MutationRecord[] = [];
    const mo = new MutationObserver((r) => seen.push(...r));
    mo.observe(panel.root.querySelector(".fleet-body")!, { subtree: true, childList: true, attributes: true, characterData: true });
    store.narrow({ window: hist });
    await flush();
    expect(q(".fleet-window")).toHaveLength(0);
    expect(api.worktrees.mock.calls.length).toBe(calls);
    expect(seen.length + mo.takeRecords().length).toBe(0);
    mo.disconnect();
    store.narrow({ window: "live" });
    expect(q(".fleet-window")).toHaveLength(0);
    expect(api.worktrees.mock.calls.length).toBe(calls);
    const after = q(".fleet-row");
    expect(after).toHaveLength(rows.length);
    after.forEach((r, i) => expect(r).toBe(rows[i]));
  });

  test("Lanes live span defaults to 5 min and follows a user-set liveSpanMs", async () => {
    const H = 3_600_000;
    const { panel, store, data, api, q } = setup();
    data.events = [ev({ id: "old", session_id: "sa", time: iso(NOW - 90 * MIN) }), ev({ id: "new", session_id: "sa", time: iso(NOW - 10_000) })];
    panel.encoding = "lanes";
    await panel.activate();
    await flush();
    expect(q("rect.lane-tick")).toHaveLength(1);
    const calls = api.worktrees.mock.calls.length;
    store.narrow({ liveSpanMs: 2 * H });
    await flush();
    expect(q("rect.lane-tick")).toHaveLength(2);
    expect(api.worktrees.mock.calls.length).toBe(calls);
    store.narrow({ liveSpanMs: H });
    await flush();
    expect(q("rect.lane-tick")).toHaveLength(1);
  });

  test("effectiveLiveSpan reports what Fleet draws", async () => {
    const { panel, store } = setup();
    await panel.activate();
    expect(panel.effectiveLiveSpan()).toBe(DEFAULT_LIVE_SPAN_MS);
    store.narrow({ liveSpanMs: 2 * 3_600_000 });
    expect(panel.effectiveLiveSpan()).toBe(DEFAULT_LIVE_SPAN_MS);
    panel.encoding = "lanes";
    expect(panel.effectiveLiveSpan()).toBe(2 * 3_600_000);
    store.reset();
    expect(panel.effectiveLiveSpan()).toBe(300_000);
  });

  test("navigation patches keep the remembered span and carry the window", async () => {
    const { panel, store, go, byKey } = setup({ realGo: true });
    store.narrow({ liveSpanMs: 2 * 3_600_000 });
    await panel.activate();
    byKey(key("row", "repoB")).querySelector<HTMLElement>(".fleet-row-head")!.click();
    const patch = go.mock.calls[0]![1] as ScopePatch;
    expect(patch.window).toBe("live");
    expect(Object.keys(patch).sort()).toEqual(["cell", "project", "session", "window", "worktree"]);
    expect(store.get().liveSpanMs).toBe(2 * 3_600_000);
    store.narrow({ window: hist });
    byKey(key("row", "repoA")).querySelector<HTMLElement>(".fleet-row-head")!.click();
    expect((go.mock.calls[1]![1] as ScopePatch).window).toEqual(hist);
    expect(store.get().liveSpanMs).toBe(2 * 3_600_000);
  });

  test("a preset window set in the shell survives a Fleet lane click", async () => {
    const { panel, store, data } = setup({ realGo: true });
    data.events = [ev({ id: "e1", session_id: "sa", time: iso(NOW - 10 * MIN) })];
    panel.encoding = "lanes";
    await panel.activate();
    await flush();
    const win = { from: NOW - 2 * 3_600_000, to: NOW };
    store.narrow({ window: win, liveSpanMs: 2 * 3_600_000 });
    await flush();
    panel.root.querySelector<HTMLElement>(".fleet-lane-row")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(store.get().window).toEqual(win);
    expect(store.get().liveSpanMs).toBe(2 * 3_600_000);
  });

  test("digit and Enter still act after a transport button blurs to body", async () => {
    const { panel, go } = setup();
    await panel.activate();
    const b = document.createElement("button");
    document.body.append(b);
    b.focus();
    b.blur();
    expect(document.activeElement).toBe(document.body);
    press("1");
    press("Enter");
    expect(go).toHaveBeenCalled();
  });

  test("a project change updates highlight without refetching", async () => {
    const { panel, store, api, q } = setup();
    await panel.activate();
    const calls = api.worktrees.mock.calls.length;
    store.narrow({ project: "repoB" });
    expect(q(".fleet-row.current").map((r) => r.getAttribute("data-key"))).toEqual([key("row", "repoB")]);
    expect(api.worktrees.mock.calls.length).toBe(calls);
  });
});

describe("keys", () => {
  test("1-9 select a row, Enter opens it, n/N walk needs, Space jumps to the longest wait", async () => {
    const { panel, go, q } = setup();
    await panel.activate();
    const k1 = press("1");
    expect(k1.defaultPrevented).toBe(true);
    expect(q(".fleet-row.selected").map((r) => r.getAttribute("data-key"))).toEqual([key("row", "repoB")]);
    press("Enter");
    expect(go.mock.calls.at(-1)![0]).toBe("project");
    expect((go.mock.calls.at(-1)![1] as ScopePatch).project).toBe("repoB");
    press("n");
    expect(q(".fleet-need.selected").map((r) => r.getAttribute("data-key"))).toEqual([needKey("claude-code", "sa")]);
    press("n");
    expect(q(".fleet-need.selected").map((r) => r.getAttribute("data-key"))).toEqual([needKey("claude-code", "sn")]);
    press("n");
    expect(q(".fleet-need.selected").map((r) => r.getAttribute("data-key"))).toEqual([needKey("claude-code", "sa")]);
    press("N");
    expect(q(".fleet-need.selected").map((r) => r.getAttribute("data-key"))).toEqual([needKey("claude-code", "sn")]);
    press("Enter");
    expect(go.mock.calls.at(-1)![0]).toBe("score");
    const n = go.mock.calls.length;
    const sp = press(" ");
    expect(sp.defaultPrevented).toBe(true);
    expect(go.mock.calls.length).toBe(n + 1);
    expect((go.mock.calls.at(-1)![1] as ScopePatch).session).toEqual({ id: "sa", source: "claude-code" });
  });

  test("1-9 beyond the row count does nothing", async () => {
    const { panel, go, q } = setup();
    await panel.activate();
    expect(press("9").defaultPrevented).toBe(false);
    expect(q(".selected")).toHaveLength(0);
    expect(go).not.toHaveBeenCalled();
  });

  test("Tab is never handled or prevented", async () => {
    const { panel, go, q } = setup();
    await panel.activate();
    press("1");
    const t = press("Tab");
    expect(t.defaultPrevented).toBe(false);
    expect(go).not.toHaveBeenCalled();
    expect(q(".fleet-row.selected")).toHaveLength(1);
  });

  test("guards: modifiers, inputs inside the root, outside targets, inactive panel", async () => {
    const { panel, q } = setup();
    await panel.activate();
    const input = document.createElement("input");
    panel.root.append(input);
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(press("1", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("1", { metaKey: true }).defaultPrevented).toBe(false);
    expect(press("1", {}, input).defaultPrevented).toBe(false);
    expect(press("1", {}, outside).defaultPrevented).toBe(false);
    expect(q(".selected")).toHaveLength(0);
    expect(press("1", {}, panel.root.querySelector(".fleet-body")!).defaultPrevented).toBe(true);
    panel.deactivate();
    expect(press("2").defaultPrevented).toBe(false);
  });

  test("Enter on a focused button-like node activates it exactly once", async () => {
    const { panel, go, byKey } = setup();
    await panel.activate();
    const fork = byKey(key("fork", "repoA", "wt-open"));
    press("Enter", {}, fork);
    expect(go).toHaveBeenCalledTimes(1);
  });

  test("Escape is claimed in the capture phase only while there is a selection", async () => {
    const { panel, q } = setup();
    await panel.activate();
    const none = press("Escape");
    expect(isEscapeClaimed(none)).toBe(false);
    press("1");
    const sel = press("Escape");
    expect(isEscapeClaimed(sel)).toBe(true);
    expect(q(".selected")).toHaveLength(0);
    expect(isEscapeClaimed(press("Escape"))).toBe(false);
  });

  test("a selection never outlives the encoding that draws it; hidden selections do not capture keys", async () => {
    const { panel, q, go } = setup();
    await panel.activate();
    press("1");
    expect(q(".selected")).toHaveLength(1);
    panel.encoding = "matrix";
    expect(isEscapeClaimed(press("Escape"))).toBe(false);
    panel.encoding = "map";
    expect(q(".selected")).toHaveLength(0);
    // n/N and Enter only act where the selection is visible.
    panel.encoding = "airspace";
    expect(press("n").defaultPrevented).toBe(false);
    expect(press("Enter").defaultPrevented).toBe(false);
    panel.encoding = "matrix";
    expect(press("n").defaultPrevented).toBe(false);
    press("Enter");
    expect(go).not.toHaveBeenCalled();
    panel.encoding = "dwell";
    expect(press("n").defaultPrevented).toBe(true);
    expect(isEscapeClaimed(press("Escape"))).toBe(true);
  });

  test("a resolver that arrives after the first draw relabels rows without another load", async () => {
    const onLabels = vi.fn();
    const { panel, store, q, api } = setup({ onLabels });
    await panel.activate();
    expect(q(".fleet-row")[1]!.textContent).not.toContain("Late Alpha");
    const calls = api.worktrees.mock.calls.length;
    store.setResolver({ sessions: () => undefined, labels: (sc) => (sc.project === "repoA" ? { project: "Late Alpha" } : {}) });
    expect(q(".fleet-row")[1]!.textContent).toContain("Late Alpha");
    expect(onLabels.mock.calls.at(-1)![0].repoA).toBe("Late Alpha");
    expect(api.worktrees.mock.calls.length).toBe(calls);
    panel.deactivate();
    store.setResolver(null);
    store.setResolver({ sessions: () => undefined, labels: () => ({ project: "Ignored" }) });
    expect(panel.root.textContent).not.toContain("Ignored");
  });

  test("listener hygiene: balanced add/remove, no leaked timers, idempotent activate", async () => {
    const add = vi.spyOn(document, "addEventListener");
    const rem = vi.spyOn(document, "removeEventListener");
    spies.push(add, rem);
    const { panel } = setup();
    await panel.activate();
    await panel.activate();
    const keydownAdds = () => add.mock.calls.filter((c) => c[0] === "keydown");
    expect(keydownAdds()).toHaveLength(2);
    panel.deactivate();
    const removed = rem.mock.calls.filter((c) => c[0] === "keydown");
    for (const a of keydownAdds()) {
      expect(removed.some((r) => r[1] === a[1] && Boolean(r[2]) === Boolean(a[2]))).toBe(true);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test("when the shared dispatcher already exists Fleet adds only its capture claimer, and removes it", async () => {
    registerKeys([{ scope: "global", keys: ["F9"], display: "F9", label: "other", handler: () => {} }]);
    const add = vi.spyOn(document, "addEventListener");
    const rem = vi.spyOn(document, "removeEventListener");
    spies.push(add, rem);
    const { panel } = setup();
    await panel.activate();
    expect(add.mock.calls.filter((c) => c[0] === "keydown")).toHaveLength(1);
    panel.deactivate();
    expect(rem.mock.calls.filter((c) => c[0] === "keydown")).toHaveLength(1);
  });

  test("Fleet's four queue keys are listed while active and gone after deactivate", async () => {
    const { panel } = setup();
    await panel.activate();
    document.body.append(panel.root);
    expect(listKeys().filter((r) => r.scope === "fleet").map((r) => r.display)).toEqual(["Enter", "1–9", "n / N", "Space"]);
    panel.deactivate();
    expect(listKeys().filter((r) => r.scope === "fleet")).toEqual([]);
  });

  test("the legend lists only the fleet keys the current encoding can act on", async () => {
    const { panel, q } = setup();
    await panel.activate();
    document.body.append(panel.root);
    const shown = () => listKeys().filter((r) => r.scope === "fleet").map((r) => r.display);
    expect(shown()).toEqual(["Enter", "1–9", "n / N", "Space"]);
    q(".fleet-enc[data-enc='dwell']")[0]!.click();
    expect(shown()).toEqual(["Enter", "n / N", "Space"]);
    for (const enc of ["lanes", "matrix", "airspace"]) {
      panel.encoding = enc as never;
      expect(shown(), enc).toEqual(["Space"]);
    }
  });
});

describe("Fleet encoding buttons", () => {
  test("visible labels in order are Map, Waiting, Table, Lanes, By state; ids unchanged", async () => {
    const { panel, q } = setup();
    await panel.activate();
    const btns = q(".fleet-enc");
    expect(btns.map((b) => b.textContent)).toEqual(["Map", "Waiting", "Table", "Lanes", "By state"]);
    expect(btns.map((b) => b.getAttribute("data-enc"))).toEqual(["map", "dwell", "matrix", "lanes", "airspace"]);
  });
});

const fakeHost = (name: string) => {
  const root = document.createElement("section");
  root.className = `fake-host-${name}`;
  return { root, activate: vi.fn(), deactivate: vi.fn() };
};
const hostRig = () => {
  const strata = fakeHost("strata");
  const ecosystem = fakeHost("ecosystem");
  const events = fakeHost("events");
  return { strata, ecosystem, events, ...setup({ hosts: { strata, ecosystem, events } }) };
};
const NON_HOST = ["map", "dwell", "matrix", "lanes", "airspace"] as const;

describe("Fleet host encodings", () => {
  test("hosts add Strata and Patches buttons; without hosts they are absent", async () => {
    const { panel, q } = hostRig();
    await panel.activate();
    expect(q(".fleet-enc").map((b) => b.textContent)).toEqual(["Map", "Waiting", "Table", "Lanes", "By state", "Strata", "Patches", "Events"]);
    expect(q(".fleet-enc").map((b) => b.getAttribute("data-enc")).slice(5)).toEqual(["strata", "ecosystem", "events"]);
    const bare = setup();
    expect(bare.q(".fleet-enc")).toHaveLength(5);
  });

  test("clicking Strata mounts its root in .fleet-body and activates once; Patches swaps it", async () => {
    const { panel, q, strata, ecosystem } = hostRig();
    await panel.activate();
    q(".fleet-enc[data-enc='strata']")[0]!.click();
    expect(q(".fleet-body > .fake-host-strata")).toHaveLength(1);
    expect(strata.activate).toHaveBeenCalledTimes(1);
    expect(q(".fleet-enc[aria-pressed='true']").map((b) => b.textContent)).toEqual(["Strata"]);
    expect(q(".fleet-hint")[0]!.hidden).toBe(true);
    q(".fleet-enc[data-enc='ecosystem']")[0]!.click();
    expect(strata.deactivate).toHaveBeenCalledTimes(1);
    expect(q(".fleet-body > .fake-host-strata")).toHaveLength(0);
    expect(q(".fleet-body > .fake-host-ecosystem")).toHaveLength(1);
    expect(ecosystem.activate).toHaveBeenCalledTimes(1);
    // A data refresh does not restart a mounted host.
    await panel.refresh();
    expect(ecosystem.activate).toHaveBeenCalledTimes(1);
    expect(ecosystem.deactivate).not.toHaveBeenCalled();
  });

  test.each(["strata", "ecosystem", "events"] as const)("leaving %s deactivates it exactly once and leaves nothing mounted", async (host) => {
    for (const dest of [...NON_HOST, host === "strata" ? "ecosystem" : "strata", "deactivate"] as const) {
      const rig = hostRig();
      await rig.panel.activate();
      rig.q(`.fleet-enc[data-enc='${host}']`)[0]!.click();
      expect(rig[host].activate).toHaveBeenCalledTimes(1);
      if (dest === "deactivate") rig.panel.deactivate();
      else rig.q(`.fleet-enc[data-enc='${dest}']`)[0]!.click();
      expect(rig[host].deactivate, dest).toHaveBeenCalledTimes(1);
      expect(rig.q(`.fake-host-${host}`), dest).toHaveLength(0);
      rig.panel.deactivate();
      expect(rig[host].deactivate, dest).toHaveBeenCalledTimes(1);
    }
  });

  test("the jump and row keys are absent in host encodings and Space does not navigate", async () => {
    const { panel, q, go } = hostRig();
    await panel.activate();
    expect(listKeys().filter((r) => r.scope === "fleet").map((r) => r.display)).toEqual(["Enter", "1–9", "n / N", "Space"]);
    q(".fleet-enc[data-enc='strata']")[0]!.click();
    expect(listKeys().filter((r) => r.scope === "fleet")).toEqual([]);
    press(" ");
    press("1");
    press("n");
    press("Enter");
    expect(go).not.toHaveBeenCalled();
    q(".fleet-enc[data-enc='map']")[0]!.click();
    expect(listKeys().filter((r) => r.scope === "fleet")).toHaveLength(4);
  });

  test("a hosted encoding survives deactivate and reactivate; unknown values fall back to map", async () => {
    const { panel, strata } = hostRig();
    await panel.activate();
    panel.encoding = "strata";
    panel.deactivate();
    expect(strata.deactivate).toHaveBeenCalledTimes(1);
    await panel.activate();
    expect(panel.encoding).toBe("strata");
    expect(strata.activate).toHaveBeenCalledTimes(2);
    panel.encoding = "bogus" as never;
    expect(panel.encoding).toBe("strata");
    const fresh = setup();
    expect(fresh.panel.encoding).toBe("map");
  });
});

describe("encodings", () => {
  test("map is the default and encoding switches via the header", async () => {
    const { panel, q } = setup();
    expect(panel.encoding).toBe("map");
    await panel.activate();
    expect(q(".fleet-enc[aria-pressed='true']").map((b) => b.getAttribute("data-enc"))).toEqual(["map"]);
    q(".fleet-enc[data-enc='dwell']")[0]!.click();
    expect(panel.encoding).toBe("dwell");
    expect(q(".fleet-row")).toHaveLength(0);
    expect(q(".fleet-dwell-row").length).toBeGreaterThan(0);
  });

  test("an encoding change notifies the shell after effectiveLiveSpan has moved", async () => {
    const seen: number[] = [];
    let p: ReturnType<typeof setup>["panel"] | undefined;
    const { panel, q } = setup({ onEncoding: () => seen.push(p!.effectiveLiveSpan()) });
    p = panel;
    await panel.activate();
    const before = panel.effectiveLiveSpan();
    q(".fleet-enc[data-enc='lanes']")[0]!.click();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(panel.effectiveLiveSpan());
    expect(seen[0]).not.toBe(before);
  });

  test("dwell shows a bar per live session and opens its score", async () => {
    const { panel, go, q } = setup();
    panel.encoding = "dwell";
    await panel.activate();
    expect(q(".fleet-dwell-row")).toHaveLength(5);
    q(".fleet-dwell-row")[0]!.click();
    expect(go.mock.calls[0]![0]).toBe("score");
    expect((go.mock.calls[0]![1] as ScopePatch).session).toEqual({ id: "sa", source: "claude-code" });
  });

  test("dwell values update in place as time passes", async () => {
    const { panel, q } = setup();
    panel.encoding = "dwell";
    await panel.activate();
    const first = q(".fleet-dwell-row")[0]!;
    const before = first.textContent;
    nowMs += 3 * MIN;
    await panel.refresh();
    expect(q(".fleet-dwell-row")[0]).toBe(first);
    expect(first.textContent).not.toBe(before);
  });

  // Replaced (fleet-altitude item 4): Matrix was a repository x agent grid with only a "repository" header
  // on real data. It is now the state matrix the plan names: open / idle / needs-you / gone (7d) / last activity.
  test("matrix is a real matrix: project, open, idle, needs-you, gone (7d), last activity", async () => {
    const { panel, q } = setup();
    panel.encoding = "matrix";
    await panel.activate();
    expect(q("table.fleet-matrix")).toHaveLength(1);
    expect(q(".fleet-matrix thead th").map((t) => t.textContent)).toEqual(["project", "open", "idle", "needs you", "gone (7d)", "last activity"]);
    expect(q(".fleet-matrix tbody tr")).toHaveLength(4);
  });

  test("matrix cells carry counts per repository", async () => {
    const { panel, q } = setup();
    panel.encoding = "matrix";
    await panel.activate();
    const cells = (id: string) => [...panel.root.querySelectorAll<HTMLElement>(`tr[data-key="matrix:${id}"] td`)].map((c) => c.textContent);
    // repoA: wt-open + wt-idle open (wt-idle idle), 1 need, wt-gone gone 2 days ago.
    expect(cells("repoA").slice(0, 4)).toEqual(["2", "1", "1", "1"]);
    expect(cells("repoB").slice(0, 4)).toEqual(["1", "0", "0", "0"]);
    // Changed (review round 2): fog and no-repo rows have no /worktrees data, so fork counts are unknown ("–"),
    // not zero; the observed needs count stays.
    expect(cells("repoZ").slice(0, 4)).toEqual(["–", "–", "0", "–"]);
    expect(cells("__no_repo__").slice(0, 4)).toEqual(["–", "–", "1", "–"]);
  });

  test("matrix needs cells open Score for the longest-waiting need; other cells are inert", async () => {
    const { panel, q, data, go } = setup();
    data.sessions = [
      att({ id: "short", repo_id: "repoA", worktree_id: "wt-open", waitMs: 2 * MIN }),
      att({ id: "long", repo_id: "repoA", worktree_id: "wt-open", waitMs: 9 * MIN }),
    ];
    panel.encoding = "matrix";
    await panel.activate();
    const need = panel.root.querySelector<HTMLElement>('td[data-key="matrix:repoA|needs"]')!;
    expect(need.getAttribute("role")).toBe("button");
    expect(need.textContent).toBe("2");
    expect(need.classList.contains("needs")).toBe(true);
    need.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(go.mock.calls[0]![0]).toBe("score");
    expect(go.mock.calls[0]![1]).toMatchObject({ project: "repoA", worktree: "wt-open", session: { id: "long", source: "claude-code" }, window: "live" });
    // A zero needs cell and a count cell are not buttons.
    expect(panel.root.querySelector('td[data-key="matrix:repoB|needs"]')).toBeNull();
    expect(q('tr[data-key="matrix:repoB"] td[role="button"]')).toHaveLength(0);
    press("Enter", {}, need);
    expect(go).toHaveBeenCalledTimes(2);
  });

  test("matrix row label opens the project; fog and no-repo labels do not", async () => {
    const { panel, go } = setup();
    panel.encoding = "matrix";
    await panel.activate();
    const th = (id: string) => panel.root.querySelector<HTMLElement>(`tr[data-key="matrix:${id}"] th`)!;
    th("repoA").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(go.mock.calls[0]![0]).toBe("project");
    expect(go.mock.calls[0]![1]).toMatchObject({ project: "repoA", worktree: undefined, session: undefined, cell: undefined, window: "live" });
    th("repoZ").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    th("__no_repo__").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  test("matrix last activity reads as an age", async () => {
    const { panel, data } = setup();
    data.sessions = [];
    panel.encoding = "matrix";
    await panel.activate();
    const last = (id: string) => panel.root.querySelector<HTMLElement>(`tr[data-key="matrix:${id}"] td:last-child`)!.textContent;
    expect(last("repoB")).toBe("10m");
  });

  test("airspace draws band chips without claiming running or idle", async () => {
    const { panel, q } = setup();
    panel.encoding = "airspace";
    await panel.activate();
    expect(q(".fleet-band")).toHaveLength(5);
    expect(panel.root.textContent!.toLowerCase()).not.toMatch(/running|idle/);
  });

  test("the sessions request exists only while lanes is active, with its own controller", async () => {
    const { panel, api, data, q } = setup();
    await panel.activate();
    expect(api.sessions).not.toHaveBeenCalled();
    data.events = [
      ev({ id: "1", source: "claude-code", session_id: "s", call_id: "c", time: iso(NOW - 40_000), payload: { phase: "start" } }),
      ev({ id: "2", source: "codex", session_id: "s", call_id: "c", time: iso(NOW - 20_000), payload: { phase: "end" } }),
    ];
    panel.encoding = "lanes";
    await flush();
    expect(api.sessions).toHaveBeenCalledTimes(1);
    expect(api.sessions.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(q(".fleet-lane-row")).toHaveLength(2);
    expect(q("rect.lane-span.open")).toHaveLength(1);
    panel.encoding = "map";
    await vi.advanceTimersByTimeAsync(REFRESH);
    expect(api.sessions).toHaveBeenCalledTimes(1);
  });

  test("lane click opens the session with its attention scope", async () => {
    const { panel, go, data, q } = setup();
    data.events = [ev({ id: "1", session_id: "sa", time: iso(NOW - 10_000) })];
    panel.encoding = "lanes";
    await panel.activate();
    await flush();
    q(".fleet-lane-row")[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(go.mock.calls[0]![0]).toBe("score");
    expect(go.mock.calls[0]![1]).toMatchObject({ project: "repoA", worktree: "wt-open", session: { id: "sa", source: "claude-code" } });
    expect(Object.keys(go.mock.calls[0]![1]!).sort()).toEqual(["cell", "project", "session", "window", "worktree"]);
  });
});

describe("loading", () => {
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  };

  test("a stale response never overwrites a newer one", async () => {
    const { panel, api, q } = setup();
    const first = deferred<WorktreeLifetimeView[]>();
    api.worktrees.mockImplementationOnce(() => first.promise);
    const p1 = panel.activate();
    const p2 = panel.refresh();
    await p2;
    expect(q(".fleet-row.fog").length).toBe(1);
    first.resolve([row({ repo_id: "repoOld", worktree_id: "wt-old" })]);
    await p1;
    await flush();
    expect(q(".fleet-row").map((r) => r.getAttribute("data-key"))).not.toContain(key("row", "repoOld"));
  });

  test("a response after deactivate is ignored and its signal was aborted", async () => {
    const { panel, api, q } = setup();
    const d = deferred<WorktreeLifetimeView[]>();
    api.worktrees.mockImplementationOnce(() => d.promise);
    const p = panel.activate();
    const signal = api.worktrees.mock.calls[0]![0] as AbortSignal;
    panel.deactivate();
    expect(signal.aborted).toBe(true);
    d.resolve(FIXTURE_ROWS);
    await p;
    await flush();
    expect(q(".fleet-fork")).toHaveLength(0);
  });

  test("the timer does not stack requests while one is in flight", async () => {
    const { panel, api } = setup();
    api.worktrees.mockImplementationOnce(() => never());
    void panel.activate();
    await vi.advanceTimersByTimeAsync(REFRESH - 1);
    // the hung request hit its deadline at TIMEOUT, so only after that may a tick issue another
    expect(api.worktrees.mock.calls.length).toBe(1);
  });

  test("an event burst triggers one throttled refresh", async () => {
    const { panel, api } = setup();
    await panel.activate();
    const n = api.attention.mock.calls.length;
    for (let i = 0; i < 20; i++) panel.onEvent(ev({ id: `e${i}`, session_id: "sa", time: iso(NOW) }));
    panel.onEvent(ev({ id: "meta", session_id: "sa", source: "firehose", time: iso(NOW) }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.attention.mock.calls.length).toBe(n + 1);
  });
});

describe("deadlines", () => {
  test("a hung worktrees request is aborted, keeps last data as stale, then recovers on the next tick", async () => {
    const { panel, api, data, q } = setup();
    await panel.activate();
    expect(q(".fleet-stale")).toHaveLength(0);
    let hungSignal: AbortSignal | undefined;
    api.worktrees.mockImplementationOnce((s?: AbortSignal) => { hungSignal = s; return never(); });
    data.sessions = [...baseSessions(), att({ id: "late", repo_id: "repoB", worktree_id: "wt-b1", waitMs: 4 * MIN })];
    const p = panel.refresh();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    await p;
    expect(hungSignal!.aborted).toBe(true);
    expect(q(".fleet-stale")).toHaveLength(1);
    expect(q(".fleet-fork")).toHaveLength(7);
    // attention, a separate request in the same load, was not affected by the timeout
    expect(q(".fleet-need")).toHaveLength(3);
    const calls = api.worktrees.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REFRESH - TIMEOUT);
    expect(api.worktrees.mock.calls.length).toBe(calls + 1);
    await flush();
    expect(q(".fleet-stale")).toHaveLength(0);
  });

  test("a hung sessions request times out on its own and recovers", async () => {
    const { panel, api, q } = setup();
    panel.encoding = "lanes";
    let hung: AbortSignal | undefined;
    api.sessions.mockImplementationOnce((s?: AbortSignal) => { hung = s; return never(); });
    await panel.activate();
    await vi.advanceTimersByTimeAsync(TIMEOUT);
    expect(hung!.aborted).toBe(true);
    expect(api.worktrees.mock.calls[0]![0].aborted).toBe(false);
    expect(q(".fleet-stale")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REFRESH - TIMEOUT);
    await flush();
    expect(api.sessions).toHaveBeenCalledTimes(2);
    expect(q(".fleet-stale")).toHaveLength(0);
  });
});

describe("degraded states", () => {
  test("a 404 on /worktrees says so and still shows attention as fog rows", async () => {
    const { panel, api, q } = setup();
    api.worktrees.mockRejectedValue(new ApiError("/worktrees", 404, "not found", "GET"));
    await panel.activate();
    expect(q(".fleet-status")[0]!.textContent).toContain("/worktrees");
    expect(q(".fleet-row.fog").length).toBeGreaterThan(0);
    expect(q(".fleet-stale")).toHaveLength(0);
  });

  test("a failure with no data shows an error with Retry that reloads", async () => {
    const { panel, api, q } = setup();
    api.worktrees.mockRejectedValueOnce(new Error("boom"));
    api.attention.mockRejectedValueOnce(new Error("boom"));
    await panel.activate();
    expect(q(".fleet-error")).toHaveLength(1);
    q(".fleet-retry")[0]!.click();
    await flush();
    expect(q(".fleet-error")).toHaveLength(0);
    expect(q(".fleet-row").length).toBeGreaterThan(0);
  });

  test("a failure while disconnected waits for the daemon and reloads on reconnect", async () => {
    const { panel, api, q } = setup();
    panel.setConnected(false);
    api.worktrees.mockRejectedValueOnce(new Error("down"));
    api.attention.mockRejectedValueOnce(new Error("down"));
    await panel.activate();
    expect(q(".fleet-connecting")).toHaveLength(1);
    panel.setConnected(true);
    await flush();
    expect(q(".fleet-connecting")).toHaveLength(0);
    expect(q(".fleet-row").length).toBeGreaterThan(0);
  });

  test("a failed refresh keeps the last data and marks it stale", async () => {
    const { panel, api, q } = setup();
    await panel.activate();
    api.attention.mockRejectedValueOnce(new Error("blip"));
    await panel.refresh();
    expect(q(".fleet-stale")).toHaveLength(1);
    expect(q(".fleet-row").length).toBe(4);
  });

  test("no data at all shows an empty state", async () => {
    const { panel, data, q } = setup();
    data.wt = [];
    data.sessions = [];
    await panel.activate();
    expect(q(".fleet-empty")).toHaveLength(1);
  });
});

describe("review regressions", () => {
  test("an unchanged-signature refresh keeps waiting times current", async () => {
    const { panel, q, byKey } = setup();
    await panel.activate();
    const before = byKey(needKey("claude-code", "sa")).getAttribute("aria-label");
    expect(before).toContain("waiting 8m");
    nowMs += 3 * MIN;
    await panel.refresh();
    const need = byKey(needKey("claude-code", "sa"));
    expect(need.getAttribute("aria-label")).toContain("waiting 11m");
    expect(need.querySelector(".fleet-need-dwell")!.textContent).toBe("11m");
    expect(q(".fleet-row").some((r) => r.querySelector(".fleet-dwell")!.textContent === "11m")).toBe(true);
  });

  test("a changed question or fork detail redraws the Map text and tooltip", async () => {
    const { panel, data, byKey } = setup();
    await panel.activate();
    const s = S.needA();
    s.pending = { ...s.pending!, summary: "a new question" };
    data.sessions = [s, S.workA(), S.workB(), S.fog(), S.noRepo()];
    data.wt = FIXTURE_ROWS.map((r) => (r.worktree_id === "wt-open" ? { ...r, ahead: 5 } : r));
    await panel.refresh();
    expect(byKey(needKey("claude-code", "sa")).querySelector(".fleet-need-summary")!.textContent).toBe("a new question");
    expect(byKey(key("fork", "repoA", "wt-open")).getAttribute("title")).toContain("ahead 5");
  });

  test("Dwell n then Enter focuses the selected row and opens that session", async () => {
    const { panel, go, q } = setup();
    panel.encoding = "dwell";
    await panel.activate();
    const rows = q(".fleet-dwell-row");
    rows[0]!.focus();
    press("n", {}, rows[0]!);
    const sel = q(".fleet-dwell-row.selected");
    expect(sel).toHaveLength(1);
    expect(document.activeElement).toBe(sel[0]);
    const id = sel[0]!.getAttribute("data-key")!;
    press("Enter", {}, document.body);
    expect(JSON.stringify((go.mock.calls.at(-1)![1] as ScopePatch).session)).toContain(JSON.parse(id.slice("dwell:".length))[1]);
  });

  test("a historical window redraws Lanes against its bounds", async () => {
    const { panel, store, data, q } = setup();
    data.events = [ev({ id: "1", session_id: "sa", time: iso(NOW - 10_000) })];
    panel.encoding = "lanes";
    await panel.activate();
    await flush();
    expect(q("rect.lane-tick")).toHaveLength(1);
    store.narrow({ window: { from: NOW - 60 * MIN, to: NOW - 30 * MIN } });
    await flush();
    expect(q("rect.lane-tick")).toHaveLength(0);
  });

  test("Matrix keeps keyboard focus on its cell across a refresh", async () => {
    const { panel, data, q } = setup();
    panel.encoding = "matrix";
    await panel.activate();
    const cell = q("td[data-key]")[0]!;
    cell.focus();
    const k = cell.getAttribute("data-key");
    data.sessions = [...baseSessions(), att({ id: "extra", repo_id: "repoQ", repo: "q" })];
    await panel.refresh();
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key")).toBe(k);
  });

  test("a lone meta event creates no lane", async () => {
    const { panel, data, q } = setup();
    data.sessions = [];
    data.events = [ev({ id: "m", session_id: "meta-only", category: "meta", name: "PreCompact", time: iso(NOW - 5_000) })];
    panel.encoding = "lanes";
    await panel.activate();
    await flush();
    expect(q(".fleet-lane-row")).toHaveLength(0);
  });
});

describe("compact map (fleet-altitude items 1, 2, 5, 6, 7)", () => {
  const D = 24 * 60 * MIN;
  const big = (n: number, extra: Partial<WorktreeLifetimeView> = {}): WorktreeLifetimeView[] =>
    Array.from({ length: n }, (_, i) => row({ repo_id: "/Users/n/browser-life/.git", worktree_id: `/Users/n/browser-life/.claude/worktrees/w${String(i).padStart(3, "0")}`, label: `/Users/n/browser-life/.claude/worktrees/w${String(i).padStart(3, "0")}`, state: "open", last_time: iso(NOW - MIN), ...extra }));
  const repoKey = key("row", "/Users/n/browser-life/.git");

  test("a row draws at most 12 glyphs, a +N overflow chip, and labels only for open forks", async () => {
    const { panel, data, byKey } = setup();
    data.wt = [...big(40), row({ repo_id: "/Users/n/browser-life/.git", worktree_id: "wg", label: "/x/gone-one", state: "gone", last_time: iso(NOW - D) })];
    data.sessions = [];
    await panel.activate();
    const r = byKey(repoKey);
    const forks = [...r.querySelectorAll<HTMLElement>(".fleet-fork")];
    expect(forks).toHaveLength(12);
    expect(r.querySelector(".fleet-more")!.textContent).toBe("+29");
    // Open forks carry the last path segment; no absolute path text anywhere in the row.
    expect(forks[0]!.querySelector(".fleet-fork-label")!.textContent).toBe("w000");
    expect(r.textContent).not.toContain("/Users/");
    expect(forks[0]!.getAttribute("title")).toContain("/Users/n/browser-life/.claude/worktrees/w000");
    expect(forks[0]!.getAttribute("aria-label")).toContain("/Users/n/browser-life/.claude/worktrees/w000");
  });

  test("non-open forks are glyph-only: no label text", async () => {
    const { panel, byKey } = setup();
    await panel.activate();
    const gone = byKey(key("fork", "repoA", "wt-gone"));
    expect(gone.querySelector(".fleet-fork-label")?.textContent ?? "").toBe("");
    expect(gone.textContent).toContain("×");
    expect(byKey(key("fork", "repoA", "wt-open")).querySelector(".fleet-fork-label")!.textContent).toBe("alpha-open");
  });

  test("glyphs are ordered open+idle, open, landed, never_diverged, unknown, gone", async () => {
    const { panel, byKey } = setup();
    await panel.activate();
    const order = [...byKey(key("row", "repoA")).querySelectorAll(".fleet-fork")].map((f) => f.getAttribute("data-key"));
    expect(order.slice(0, 2).sort()).toEqual([key("fork", "repoA", "wt-idle"), key("fork", "repoA", "wt-open")].sort());
    expect(order[0]).toBe(key("fork", "repoA", "wt-idle"));
    expect(order.slice(2)).toEqual([key("fork", "repoA", "wt-landed"), key("fork", "repoA", "wt-never"), key("fork", "repoA", "wt-unk"), key("fork", "repoA", "wt-gone")]);
  });

  test("gone forks older than seven days are behind the overflow; clicking it expands only that row and survives refresh", async () => {
    const { panel, data, byKey, q } = setup();
    data.wt = [...big(14), ...FIXTURE_ROWS.filter((w) => w.repo_id === "repoB"), row({ repo_id: "repoB", worktree_id: "old-gone", label: "/x/old-gone", state: "gone", last_time: iso(NOW - 9 * D), last_observed: iso(NOW - 9 * D) })];
    data.sessions = [];
    await panel.activate();
    expect(byKey(key("row", "repoB")).querySelectorAll(".fleet-fork")).toHaveLength(1);
    expect(byKey(key("row", "repoB")).querySelector(".fleet-more")!.textContent).toBe("+1");
    const bigRow = byKey(repoKey);
    expect(bigRow.querySelectorAll(".fleet-fork")).toHaveLength(12);
    bigRow.querySelector<HTMLElement>(".fleet-more")!.click();
    expect(bigRow.querySelectorAll(".fleet-fork")).toHaveLength(14);
    expect(bigRow.querySelector(".fleet-more")!.textContent).toBe("collapse");
    expect(byKey(key("row", "repoB")).querySelectorAll(".fleet-fork")).toHaveLength(1);
    await panel.refresh();
    nowMs += 1000;
    await panel.refresh();
    expect(byKey(repoKey).querySelectorAll(".fleet-fork")).toHaveLength(14);
    expect(q(".fleet-row").length).toBe(2);
    byKey(repoKey).querySelector<HTMLElement>(".fleet-more")!.click();
    expect(byKey(repoKey).querySelectorAll(".fleet-fork")).toHaveLength(12);
  });

  test("the overflow chip does not navigate", async () => {
    const { panel, data, byKey, go } = setup();
    data.wt = big(20);
    data.sessions = [];
    await panel.activate();
    byKey(repoKey).querySelector<HTMLElement>(".fleet-more")!.click();
    expect(go).not.toHaveBeenCalled();
  });

  test("row counts are open, idle and needs forks, never 0 on a repo with open forks", async () => {
    const { panel, data, byKey } = setup();
    data.wt = big(56);
    data.sessions = [att({ id: "n", repo_id: "/Users/n/browser-life/.git", waitMs: MIN })];
    await panel.activate();
    const counts = byKey(repoKey).querySelector(".fleet-counts")!.textContent!;
    expect(counts).toContain("56●");
    expect(counts).toContain("0…");
    expect(byKey(repoKey).querySelector(".fleet-needs-count")!.textContent).toBe("1?");
  });

  test("idle forks are counted separately from open", async () => {
    const { panel, byKey } = setup();
    await panel.activate();
    expect(byKey(key("row", "repoA")).querySelector(".fleet-counts")!.textContent).toBe("2● 1…");
  });

  test("repo labels drop the .git suffix but ids stay raw", async () => {
    const { panel, data, byKey, go } = setup();
    data.wt = big(2);
    data.sessions = [];
    await panel.activate();
    const r = byKey(repoKey);
    expect(r.querySelector(".fleet-row-label")!.textContent).toBe("browser-life");
    r.querySelector<HTMLElement>(".fleet-row-head")!.click();
    expect((go.mock.calls[0]![1] as ScopePatch).project).toBe("/Users/n/browser-life/.git");
  });

  test("a digest-only repo shows its prefix and an unregistered tag in the tooltip", async () => {
    const id = "3f9a1c0de5b7a2446f1d8e9c0b7a6d5e4c3b2a190f8e7d6c5b4a39281706f5e4";
    const { panel, data, byKey } = setup();
    data.wt = [row({ repo_id: id, worktree_id: "w", label: "/x/w" })];
    data.sessions = [];
    await panel.activate();
    const r = byKey(key("row", id));
    expect(r.querySelector(".fleet-row-label")!.textContent).toBe("3f9a1c0d");
    expect(r.querySelector(".fleet-row-head")!.getAttribute("title")).toContain("unregistered");
    expect(r.classList.contains("unregistered")).toBe(true);
  });

  test("a registered repo is not tagged unregistered", async () => {
    const { panel, byKey } = setup();
    await panel.activate();
    expect(byKey(key("row", "repoA")).classList.contains("unregistered")).toBe(false);
  });

  test("a needs-input session whose repo_id matches no /worktrees row still shows a unit, even when stale", async () => {
    const { panel, data, q, byKey } = setup();
    data.sessions = [att({ id: "orphan", repo_id: "deadbeefcafe0123", waitMs: 3 * D, lastAgoMs: 3 * D })];
    await panel.activate();
    const row = byKey(key("row", "deadbeefcafe0123"));
    expect(row.querySelectorAll(".fleet-need")).toHaveLength(1);
    expect(row.querySelector(".fleet-needs-count")!.textContent).toBe("1?");
    expect(q(".fleet-need.stale")).toHaveLength(1);
    expect(byKey(needKey("claude-code", "orphan")).getAttribute("title")).toContain("stale");
  });

  test("a pending session with no repo_id lands on the No project row", async () => {
    const { panel, data, byKey } = setup();
    data.sessions = [att({ id: "norepo", waitMs: 2 * D, lastAgoMs: 2 * D })];
    await panel.activate();
    expect(byKey(key("row", "__no_repo__")).querySelectorAll(".fleet-need")).toHaveLength(1);
  });
});

describe("empty needs queue feedback (item 7)", () => {
  const statusText = (panel: FleetPanel) => panel.root.querySelector(".fleet-toast")?.textContent ?? "";

  test.each([["n"], ["N"], [" "]])("key %j says no sessions need you, then clears", async (k) => {
    const { panel, data, go } = setup();
    data.sessions = [S.workA()];
    await panel.activate();
    expect(statusText(panel)).toBe("");
    const e = press(k);
    expect(e.defaultPrevented).toBe(true);
    expect(statusText(panel)).toBe("no sessions need you");
    expect(panel.root.querySelector(".fleet-toast")!.getAttribute("role")).toBe("status");
    expect(go).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(statusText(panel)).toBe("");
  });

  test("no feedback when the queue has entries", async () => {
    const { panel } = setup();
    await panel.activate();
    press("n");
    expect(statusText(panel)).toBe("");
  });

  test("the feedback timer does not leak past deactivate", async () => {
    const { panel, data } = setup();
    data.sessions = [];
    await panel.activate();
    press("n");
    panel.deactivate();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("Space on a focused control keeps its own behaviour and shows no toast", async () => {
    const { panel, data, q } = setup();
    data.sessions = [];
    await panel.activate();
    press(" ", {}, q(".fleet-row-head")[0]!);
    expect(statusText(panel)).toBe("");
  });
});

describe("adversarial review round 2", () => {
  const D = 24 * 60 * MIN;

  test("Dwell draws a stale pending request, labelled, and n and Space agree with it", async () => {
    const { panel, data, q, go } = setup();
    data.sessions = [att({ id: "old", repo_id: "repoA", waitMs: 3 * D, lastAgoMs: 3 * D })];
    panel.encoding = "dwell";
    await panel.activate();
    expect(q(".fleet-dwell-row")).toHaveLength(1);
    expect(q(".fleet-dwell-row.stale")).toHaveLength(1);
    expect(q(".fleet-dwell-row")[0]!.getAttribute("title")).toContain("stale");
    press("n");
    expect(panel.root.querySelector(".fleet-toast")!.textContent).toBe("");
    expect(q(".fleet-dwell-row.selected")).toHaveLength(1);
    press(" ");
    expect(go.mock.calls.at(-1)![0]).toBe("score");
  });

  test("Dwell keeps its display cap when stale requests are admitted", async () => {
    const { panel, data, q } = setup();
    data.sessions = Array.from({ length: 30 }, (_, i) => att({ id: `o${String(i).padStart(2, "0")}`, repo_id: "repoA", waitMs: (3 + i) * D, lastAgoMs: (3 + i) * D }));
    panel.encoding = "dwell";
    await panel.activate();
    expect(q(".fleet-dwell-row")).toHaveLength(24);
    expect(panel.root.querySelector(".fleet-dwell-more")!.textContent).toBe("+6 more");
  });

  test("a Matrix repository header keeps keyboard focus across a refresh", async () => {
    const { panel, data, q } = setup();
    panel.encoding = "matrix";
    await panel.activate();
    const head = q("th[role=button]")[0]!;
    head.focus();
    const k = head.getAttribute("data-key");
    expect(k).toBeTruthy();
    data.sessions = [...baseSessions(), att({ id: "extra", repo_id: "repoQ", repo: "q" })];
    await panel.refresh();
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key")).toBe(k);
  });

  test("Matrix shows unknown fork counts as a dash with a title, keeping the observed needs count", async () => {
    const { panel, q } = setup();
    panel.encoding = "matrix";
    await panel.activate();
    const cells = (id: string) => [...panel.root.querySelectorAll<HTMLElement>(`tr[data-key="matrix:${id}"] td`)];
    for (const id of ["repoZ", "__no_repo__"]) {
      const c = cells(id);
      for (const i of [0, 1, 3]) {
        expect(c[i]!.textContent).toBe("–");
        expect(c[i]!.getAttribute("title")).toBe("no worktree data");
      }
    }
    expect(cells("__no_repo__")[2]!.textContent).toBe("1");
    expect(cells("repoA")[0]!.textContent).toBe("2");
    expect(q('tr[data-key="matrix:repoZ"] td[title="no worktree data"]')).toHaveLength(3);
  });

  test("with /worktrees unsupported every Matrix fork count is a dash", async () => {
    const { panel, api } = setup();
    api.worktrees.mockRejectedValue(new ApiError("/worktrees", 404, "", "GET"));
    panel.encoding = "matrix";
    await panel.activate();
    const first = panel.root.querySelectorAll<HTMLElement>("tbody tr")[0]!.querySelectorAll("td");
    expect([first[0]!.textContent, first[1]!.textContent, first[3]!.textContent]).toEqual(["–", "–", "–"]);
  });

  test("Matrix gone cell tooltip tallies gone forks of unknown age separately", async () => {
    const { panel, data } = setup();
    data.wt = [
      row({ repo_id: "g", worktree_id: "g1", state: "gone", last_observed: iso(NOW - D) }),
      row({ repo_id: "g", worktree_id: "g2", state: "gone" }),
    ];
    data.sessions = [];
    panel.encoding = "matrix";
    await panel.activate();
    const gone = panel.root.querySelectorAll<HTMLElement>('tr[data-key="matrix:g"] td')[3]!;
    expect(gone.textContent).toBe("1");
    expect(gone.getAttribute("title")).toContain("1 gone (age unknown)");
  });

  test("expanding a static +N row adds no transition class and collapsing then expanding repeats nothing", async () => {
    const { panel, data, byKey } = setup();
    const id = "/Users/n/b/.git";
    data.wt = Array.from({ length: 20 }, (_, i) => row({ repo_id: id, worktree_id: `w${String(i).padStart(2, "0")}`, label: `/x/w${String(i).padStart(2, "0")}`, state: "open", last_time: iso(NOW - MIN) }));
    data.sessions = [];
    await panel.activate();
    const r = () => byKey(key("row", id));
    expect(r().querySelectorAll(".fleet-fork")).toHaveLength(12);
    r().querySelector<HTMLElement>(".fleet-more")!.click();
    expect(r().querySelectorAll(".fleet-fork")).toHaveLength(20);
    expect(r().querySelectorAll(".fleet-fork.changed")).toHaveLength(0);
    r().querySelector<HTMLElement>(".fleet-more")!.click();
    r().querySelector<HTMLElement>(".fleet-more")!.click();
    expect(r().querySelectorAll(".fleet-fork.changed")).toHaveLength(0);
  });
});

describe("forkOrder (shared with Project lanes)", () => {
  const repoA = () => FIXTURE_ROWS.filter((r) => r.repo_id === "repoA");
  test("undefined before the first load and for an unknown repo", async () => {
    const { panel } = setup();
    expect(panel.forkOrder("repoA")).toBeUndefined();
    await panel.activate();
    expect(panel.forkOrder("nope")).toBeUndefined();
  });

  test("equals orderLanes(undefined, rows) after load", async () => {
    const { panel } = setup();
    await panel.activate();
    expect(panel.forkOrder("repoA")).toEqual(orderLanes(undefined, repoA()));
  });

  test("stable under reversed rows; a new worktree is appended last", async () => {
    const { panel, data } = setup();
    await panel.activate();
    const first = [...panel.forkOrder("repoA")!];
    data.wt = [...FIXTURE_ROWS].reverse();
    await panel.refresh();
    expect(panel.forkOrder("repoA")).toEqual(first);
    data.wt = [...FIXTURE_ROWS, { ...repoA()[0]!, worktree_id: "wt-brand-new", first_time: iso(NOW - 1000) }];
    await panel.refresh();
    const next = panel.forkOrder("repoA")!;
    expect(next.slice(0, first.length)).toEqual(first);
    expect(next[next.length - 1]).toBe("wt-brand-new");
  });
});

describe("lane names from the session directory", () => {
  test("lanes read the directory late, in place, and stop after deactivate", async () => {
    const dir = createSessionDirectory();
    const { panel, data, q } = setup({ directory: dir });
    data.events = [ev({ id: "e1", session_id: "2385e3bc-1111-2222-3333-444444444444", time: iso(NOW - 10_000) })];
    panel.encoding = "lanes";
    await panel.activate();
    await flush();
    const label = () => q("text.lane-label").map((n) => n.textContent);
    expect(label()).toHaveLength(1);
    expect(label()[0]).not.toContain("Fix login bug");
    const calls = data.events.length;
    dir.remember([{ id: "2385e3bc-1111-2222-3333-444444444444", source: data.events[0]!.source, agent: "codex", title: "Fix login bug" }]);
    expect(label()).toEqual(["Fix login bug"]);
    expect(data.events).toHaveLength(calls);
    panel.deactivate();
    dir.remember([{ id: "2385e3bc-1111-2222-3333-444444444444", source: data.events[0]!.source, agent: "codex", title: "Renamed later" }]);
    expect(label()).toEqual(["Fix login bug"]);
  });
});

describe("fork aria labels", () => {
  test("idle and needs show in the fork's accessible name and follow changes", async () => {
    const { panel, data, byKey } = setup();
    await panel.activate();
    expect(byKey(key("fork", "repoA", "wt-idle")).getAttribute("aria-label")).toContain("idle");
    expect(byKey(key("fork", "repoA", "wt-open")).getAttribute("aria-label")).toContain("1 needs you");
    data.sessions = [...baseSessions(), att({ id: "sx", repo_id: "repoA", worktree_id: "wt-open", waitMs: 5 * MIN })];
    const node = byKey(key("fork", "repoA", "wt-open"));
    await vi.advanceTimersByTimeAsync(REFRESH + 1);
    await flush();
    expect(byKey(key("fork", "repoA", "wt-open"))).toBe(node);
    expect(node.getAttribute("aria-label")).toContain("2 need you");
  });
});

describe("Fleet Events host", () => {
  test("ENCODINGS lists the host encodings last", async () => {
    const { ENCODINGS } = await import("./model");
    expect([...ENCODINGS]).toEqual(["map", "dwell", "matrix", "lanes", "airspace", "strata", "ecosystem", "events"]);
  });

  test("clicking Events mounts the host, activates once and presses the button; leaving detaches and deactivates", async () => {
    const { panel, q, events } = hostRig();
    await panel.activate();
    q(".fleet-enc[data-enc='events']")[0]!.click();
    expect(q(".fleet-body > .fake-host-events")).toHaveLength(1);
    expect(events.activate).toHaveBeenCalledTimes(1);
    expect(q(".fleet-enc[data-enc='events']")[0]!.getAttribute("aria-pressed")).toBe("true");
    q(".fleet-enc[data-enc='map']")[0]!.click();
    expect(events.deactivate).toHaveBeenCalledTimes(1);
    expect(q(".fake-host-events")).toHaveLength(0);
    q(".fleet-enc[data-enc='events']")[0]!.click();
    panel.deactivate();
    expect(events.deactivate).toHaveBeenCalledTimes(2);
    expect(q(".fake-host-events")).toHaveLength(0);
  });

  test("with scope.project set the host still shows (the host decides, not the scope); jump and row keys are off", async () => {
    const { panel, q, events } = (() => {
      const e = fakeHost("events");
      return { events: e, ...setup({ scope: { project: "repoA", window: "live" }, hosts: { events: e } }) };
    })();
    await panel.activate();
    panel.encoding = "events";
    expect(q(".fleet-body > .fake-host-events")).toHaveLength(1);
    expect(events.activate).toHaveBeenCalledTimes(1);
    const { listKeys } = await import("../../keys");
    for (const r of listKeys().filter((k) => k.scope === "fleet")) expect(r.label).not.toMatch(/longest-waiting/);
    for (const key of ["1", "n", " ", "Enter"]) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(q(".fleet-body > .fake-host-events")).toHaveLength(1);
  });
});
