// @vitest-environment happy-dom
//
// Project altitude encodings: Lanes, Graph, Map and Events over one repository, one picker and
// one shared window. Rows carry no alias identity (no invented alias shapes): a Map group is
// matched to a lane only when its id equals a row worktree_id.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../api";
import { createScope } from "../../scope";
import type { ScopeStore } from "../../scope";
import { isEscapeClaimed } from "../../escape";
import { FIXTURE_ROWS, NOW, row } from "./model.fixtures";
import { orderLanes, pickRepo } from "./model";
import fixture from "../activity/fixture.activity.json";
import { createProject, splitGoPatch } from "./index";
import type { ProjectGraphHost, ProjectPanel } from "./index";

const { worktreesMock, worktreeMock, activity } = vi.hoisted(() => ({ worktreesMock: vi.fn(), worktreeMock: vi.fn(), activity: vi.fn() }));
vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  worktrees: (s?: AbortSignal) => worktreesMock(s),
  worktree: (id: string, s?: AbortSignal) => worktreeMock(id, s),
}));
vi.mock("../graph/api", () => ({ graphAPI: { activity } }));
// Pass-through: records each map Project builds so its cancel()/setActive() can be spied.
const { maps } = vi.hoisted(() => ({ maps: [] as import("../activity").ActivityMap[] }));
vi.mock("../activity", async (orig) => {
  const m = await orig<typeof import("../activity")>();
  return {
    ...m,
    createActivityMap: (...a: Parameters<typeof m.createActivityMap>) => {
      const map = m.createActivityMap(...a);
      maps.push(map);
      return map;
    },
  };
});

const H = 3_600_000;
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const panels: ProjectPanel[] = [];

function fakeGraph(registered: string[] = []) {
  const root = document.createElement("div");
  root.className = "fake-graph";
  let viewFn: ((v: "graph" | "events") => void) | undefined;
  const g = {
    root,
    show: vi.fn(),
    hide: vi.fn(),
    setWorktreeOrder: vi.fn(),
    onEvent: vi.fn(),
    onView: vi.fn((fn: (v: "graph" | "events") => void) => { viewFn = fn; }),
    currentRepo: vi.fn(() => ""),
    registeredRepos: vi.fn(() => registered),
  };
  return { g: g as unknown as ProjectGraphHost & typeof g, emitView: (v: "graph" | "events") => viewFn?.(v) };
}

function setup(opts: { registered?: string[]; worktreeOrder?: (r: string) => readonly string[] | undefined; withGraph?: boolean; initial?: Parameters<typeof createScope>[0] } = {}) {
  const store: ScopeStore = createScope(opts.initial);
  const go = vi.fn();
  const fg = fakeGraph(opts.registered);
  const panel = createProject({
    store,
    go,
    now: () => NOW,
    refreshMs: 15000,
    ...(opts.withGraph === false ? {} : { graph: fg.g }),
    ...(opts.worktreeOrder ? { worktreeOrder: opts.worktreeOrder } : {}),
  });
  document.body.append(panel.root);
  panels.push(panel);
  const q = (s: string) => [...panel.root.querySelectorAll<HTMLElement>(s)];
  const chip = (e: string) => panel.root.querySelector<HTMLButtonElement>(`.project-chips [data-encoding="${e}"]`)!;
  return { store, go, panel, fg, g: fg.g, q, chip, narrow: vi.spyOn(store, "narrow") };
}

beforeEach(() => {
  worktreesMock.mockReset().mockImplementation(() => Promise.resolve(FIXTURE_ROWS));
  worktreeMock.mockReset().mockImplementation((id: string) => Promise.resolve({ ...(FIXTURE_ROWS.find((r) => r.worktree_id === id) ?? row({ worktree_id: id })), commits: [] }));
  activity.mockReset().mockImplementation(async () => structuredClone(fixture));
  maps.length = 0;
});
afterEach(() => {
  for (const p of panels.splice(0)) p.deactivate();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DEFAULT = pickRepo(FIXTURE_ROWS);
const repos = [...new Set(FIXTURE_ROWS.map((r) => r.repo_id))];
const rowsOf = (repo: string) => FIXTURE_ROWS.filter((r) => r.repo_id === repo);

describe("chips", () => {
  test("no graph dep, no chips", async () => {
    const { panel, q } = setup({ withGraph: false });
    await panel.activate();
    expect(q(".project-chips")).toHaveLength(0);
    expect(panel.root.querySelector(".project-lanes-body")).not.toBeNull();
  });

  test("tablist with four tabs, Lanes default, one select", async () => {
    const { panel, q } = setup();
    await panel.activate();
    const tabs = q('.project-chips[role="tablist"] [role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(["Lanes", "Graph", "Map", "Events"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    expect(q(".project-header select")).toHaveLength(1);
    expect(q("select")).toHaveLength(1);
  });

  test("arrow keys move selection and focus; Escape is not claimed", async () => {
    const { panel, chip, q } = setup();
    await panel.activate();
    chip("lanes").focus();
    chip("lanes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(panel.encoding()).toBe("graph");
    expect(document.activeElement).toBe(chip("graph"));
    expect(q('[aria-selected="true"]')[0]!.getAttribute("data-encoding")).toBe("graph");
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    chip("graph").dispatchEvent(esc);
    expect(isEscapeClaimed(esc)).toBe(false);
  });
});

describe("transitions", () => {
  test("Graph writes project before show; Events shows events; Lanes hides and detaches", async () => {
    const { panel, store, g, chip, q } = setup();
    await panel.activate();
    expect(store.get().project).toBeUndefined();
    const order: string[] = [];
    g.show.mockImplementation((v: string) => order.push(`show:${v}:${store.get().project}`));
    chip("graph").click();
    expect(order).toEqual(["show:graph:" + DEFAULT]);
    expect(store.get().project).toBe(DEFAULT);
    expect(q(".project-lanes-body")[0]!.hidden).toBe(true);
    expect(q(".project-encoding-body")[0]!.contains(g.root)).toBe(true);
    chip("events").click();
    expect(g.show).toHaveBeenLastCalledWith("events");
    chip("lanes").click();
    expect(g.hide).toHaveBeenCalled();
    expect(g.root.isConnected).toBe(false);
    expect(q(".project-lanes-body")[0]!.hidden).toBe(false);
  });

  test("default project is written once and never flip-flops", async () => {
    const { panel, store, g, chip, narrow } = setup();
    g.currentRepo.mockReturnValue("zzz");
    await panel.activate();
    chip("graph").click();
    const writes = () => narrow.mock.calls.filter((c) => "project" in c[0]).length;
    expect(writes()).toBe(1);
    chip("events").click();
    chip("lanes").click();
    chip("graph").click();
    panel.deactivate();
    await panel.activate();
    expect(writes()).toBe(1);
    expect(store.get().project).toBe(DEFAULT);
  });

  test("explicit project absent from rows is never replaced; map shows no lifetimes", async () => {
    const { panel, store, chip, q } = setup({ registered: ["reg-only", "repoA"], initial: { project: "reg-only" } });
    await panel.activate();
    await flush();
    for (const e of ["graph", "events", "map"]) chip(e).click();
    expect(store.get().project).toBe("reg-only");
    expect(q(".project-encoding-body")[0]!.textContent).toContain("No lifetimes for this project");
    expect(activity).not.toHaveBeenCalled();
  });

  test("picker is the union of rows and registered repos without duplicates", async () => {
    const { panel, store, q } = setup({ registered: ["reg-only", repos[0]!] });
    await panel.activate();
    const opts = q(".project-repo option").map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(expect.arrayContaining([...repos, "reg-only"]));
    expect(new Set(opts).size).toBe(opts.length);
    const sel = q(".project-repo")[0] as HTMLSelectElement;
    sel.value = "reg-only";
    sel.dispatchEvent(new Event("change"));
    expect(store.get().project).toBe("reg-only");
    expect(q(".project-lane")).toHaveLength(0);
    expect(q(".project-error")).toHaveLength(0);
  });

  test("every transition keeps the frozen window", async () => {
    const win = { from: NOW - 5 * H, to: NOW - H };
    const { panel, store, chip, narrow } = setup({ initial: { window: win, project: "repoA", session: { id: "s1", source: "claude-code" } } });
    expect(store.get().window).toEqual(win);
    await panel.activate();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    for (const e of ["graph", "map", "events", "lanes"]) {
      chip(e).click();
      expect(store.get().window).toEqual(win);
    }
    for (const c of narrow.mock.calls) expect(c[0]).toHaveProperty("window");
  });

  test("a Lanes pick becomes the graph tip; a narrowed worktree shows on return", async () => {
    const { panel, store, chip, q } = setup({ initial: { project: "repoA" } });
    await panel.activate();
    const key = q(".project-lane")[1]!.getAttribute("data-key")!;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    chip("graph").click();
    expect(store.get().worktree).toBe(key);
    store.narrow({ worktree: q(".project-lane")[0]?.getAttribute("data-key") ?? key });
    chip("lanes").click();
    expect(q(".project-lane.selected")[0]!.getAttribute("data-key")).toBe(store.get().worktree);
  });

  test("lane hotkeys are inert off Lanes and work again on Lanes", async () => {
    const { panel, store, go, chip } = setup({ initial: { project: "repoA", worktree: "wt-open" } });
    await panel.activate();
    chip("graph").click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(go).not.toHaveBeenCalled();
    chip("lanes").click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(go).toHaveBeenCalledWith("sessions", expect.objectContaining({ worktree: store.get().worktree }));
  });

  test("per-repo encoding memory", async () => {
    const { panel, store, g, chip } = setup({ initial: { project: "repoA" } });
    await panel.activate();
    chip("graph").click();
    store.narrow({ project: "repoB" });
    expect(panel.encoding()).toBe("lanes");
    g.show.mockClear();
    store.narrow({ project: "repoA" });
    expect(panel.encoding()).toBe("graph");
    expect(g.show).toHaveBeenCalledWith("graph");
  });

  test("activate({encoding}) lands on the chip, also before rows are known", async () => {
    worktreesMock.mockImplementation(() => new Promise(() => {}));
    const a = setup();
    void a.panel.activate({ encoding: "events" });
    expect(a.chip("events").getAttribute("aria-selected")).toBe("true");
    expect(a.g.show).toHaveBeenCalledWith("events");
    a.panel.deactivate();
    const d: { resolve?: (v: unknown) => void } = {};
    worktreesMock.mockImplementation(() => new Promise((r) => { d.resolve = r; }));
    const b = setup();
    void b.panel.activate({ encoding: "graph" });
    d.resolve!(FIXTURE_ROWS);
    await flush();
    expect(b.panel.encoding()).toBe("graph");
    expect(b.store.get().project).toBe(DEFAULT);
  });

  test("a view change requested by the graph switches the chip once", async () => {
    const { panel, fg, chip } = setup({ initial: { project: "repoA" } });
    await panel.activate();
    chip("graph").click();
    fg.emitView("events");
    expect(chip("events").getAttribute("aria-selected")).toBe("true");
    expect(panel.encoding()).toBe("events");
  });

  test("events reach the host only on Graph/Events while active", async () => {
    const { panel, g, chip } = setup({ initial: { project: "repoA" } });
    const ev = { id: "e" } as never;
    await panel.activate();
    panel.onEvent(ev);
    expect(g.onEvent).not.toHaveBeenCalled();
    chip("graph").click();
    panel.onEvent(ev);
    expect(g.onEvent).toHaveBeenCalledTimes(1);
    chip("map").click();
    panel.onEvent(ev);
    chip("events").click();
    panel.deactivate();
    panel.onEvent(ev);
    expect(g.onEvent).toHaveBeenCalledTimes(1);
    expect(g.hide).toHaveBeenCalled();
  });

  test("chip round trip reuses DOM instances", async () => {
    const { panel, chip, g } = setup({ initial: { project: "repoA" } });
    await panel.activate();
    const before = [chip("graph"), g.root, panel.root.querySelector(".project-encoding-body")];
    chip("graph").click();
    chip("lanes").click();
    chip("graph").click();
    expect([chip("graph"), g.root, panel.root.querySelector(".project-encoding-body")]).toEqual(before);
  });
});

describe("order", () => {
  test("seeded from the shared order and passed to the host", async () => {
    const rev = [...orderLanes(undefined, rowsOf("repoA"))].reverse();
    const { panel, g, q, chip } = setup({ initial: { project: "repoA" }, worktreeOrder: (r) => (r === "repoA" ? rev : undefined) });
    await panel.activate();
    expect(q(".project-lane").map((l) => l.getAttribute("data-key"))).toEqual(rev);
    chip("graph").click();
    expect(g.setWorktreeOrder).toHaveBeenCalledWith(rev);
  });
});

describe("map", () => {
  test("hosts the activity map, not the graph; reads shell window and worktree", async () => {
    const win = { from: NOW - 6 * H, to: NOW - 2 * H };
    const { panel, store, g, chip, q } = setup({ initial: { project: "repoA", window: win } });
    await panel.activate();
    chip("map").click();
    await flush();
    expect(g.hide).toHaveBeenCalled();
    expect(g.show).not.toHaveBeenCalled();
    expect(q(".activity-map")).toHaveLength(1);
    expect(q(".map-presets button")).toHaveLength(0);
    expect(activity).toHaveBeenCalledTimes(1);
    const p = activity.mock.calls[0]![0] as Record<string, string>;
    expect(p.repo_id).toBe("repoA");
    expect(p.from).toBe(new Date(win.from).toISOString());
    expect(p.to).toBe(new Date(win.to).toISOString());
    store.narrow({ worktree: "wt-open" });
    await flush();
    expect((activity.mock.calls.at(-1)![0] as Record<string, string>).workspace_id).toBe("wt-open");
    store.narrow({ worktree: undefined });
    await flush();
    expect(activity.mock.calls.at(-1)![0]).not.toHaveProperty("workspace_id");
  });

  test("live with a span reads NOW-span..NOW; one narrow is one request", async () => {
    const { panel, store, chip } = setup({ initial: { project: "repoA", liveSpanMs: 2 * H } });
    await panel.activate();
    chip("map").click();
    await flush();
    const p = activity.mock.calls[0]![0] as Record<string, string>;
    expect(p.from).toBe(new Date(NOW - 2 * H).toISOString());
    expect(p.to).toBe(new Date(NOW).toISOString());
    activity.mockClear();
    store.narrow({ project: "repoA", worktree: "wt-open", window: { from: NOW - 5 * H, to: NOW - H } });
    await flush();
    expect(activity).toHaveBeenCalledTimes(1);
  });

  test("no Back-to-live control; no repo shows Select a project", async () => {
    worktreesMock.mockImplementation(async () => { throw new ApiError("/worktrees", 404, "nf", "GET"); });
    const { panel, chip, q } = setup();
    await panel.activate();
    await flush();
    expect(q(".project-unsupported")[0]!.textContent).toContain("older daemon");
    expect(q(".project-chips")).toHaveLength(1);
    chip("map").click();
    expect(q(".project-encoding-body")[0]!.textContent).toContain("Select a project");
    expect(q(".map-live")).toHaveLength(0);
  });

  test("a group-tile pick and Clear narrow only the worktree; project and a frozen window are kept", async () => {
    const win = { from: NOW - 6 * H, to: NOW - 2 * H };
    const heat: [number, number][] = [[1, 3]];
    activity.mockImplementation(async () => ({
      ...structuredClone(fixture),
      groups: [{ id: "wt-open", label: "open", resolved: true }],
      paths: [
        { path: "a/x.ts", group: "wt-open", total: 3, heat },
        { path: "a/y.ts", group: "wt-open", total: 3, heat },
      ],
    }));
    const { panel, store, chip, q } = setup({ initial: { project: "repoA", window: win } });
    await panel.activate();
    chip("map").click();
    await flush();
    const tile = q(".map-dir").find((g) => g.getAttribute("data-key")?.includes("wt-open"));
    if (!tile) throw new Error("group tile missing: " + q(".map-dir").map((g) => g.getAttribute("data-key")).join(","));
    tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(store.get().worktree).toBe("wt-open");
    expect(store.get().project).toBe("repoA");
    expect(store.get().window).toEqual(win);
    const clear = q(".map-clear")[0];
    if (!clear) throw new Error("Clear control missing");
    clear.click();
    await flush();
    expect(store.get().worktree).toBeUndefined();
    expect(store.get().project).toBe("repoA");
    expect(store.get().window).toEqual(win);
  });

  // Rows carry no alias identity: a group is a lane only when its id is a row worktree_id.
  const twoGroups = (heat: [number, number][] = [[1, 3]]) => ({
    ...structuredClone(fixture),
    groups: [
      { id: "wt-open", label: "open", resolved: true },
      { id: "alias-elsewhere", label: "elsewhere", resolved: true },
    ],
    paths: [
      { path: "a/x.ts", group: "wt-open", total: 3, heat },
      { path: "a/y.ts", group: "wt-open", total: 3, heat },
      { path: "b/x.ts", group: "alias-elsewhere", total: 3, heat },
      { path: "b/y.ts", group: "alias-elsewhere", total: 3, heat },
    ],
  });
  const groupTile = (q: (s: string) => HTMLElement[], id: string) => {
    const tile = q(".map-dir").find((g) => g.getAttribute("data-key") === `${id}\0`);
    if (!tile) throw new Error(`group tile ${id} missing: ` + q(".map-dir").map((g) => JSON.stringify(g.getAttribute("data-key"))).join(","));
    return tile;
  };

  test("group pick: a row worktree_id narrows the worktree; an unknown group zooms and leaves it untouched", async () => {
    const win = { from: NOW - 6 * H, to: NOW - 2 * H };
    activity.mockImplementation(async () => twoGroups());
    const { panel, store, chip, q } = setup({ initial: { project: "repoA", window: win } });
    await panel.activate();
    chip("map").click();
    await flush();
    groupTile(q, "alias-elsewhere").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(store.get().worktree).toBeUndefined();
    expect(store.get().project).toBe("repoA");
    // Zoomed into the group (named by its id: no row names it), not narrowed.
    expect(q(".map-crumb.current")[0]!.textContent).toBe("alias-elsewhere");
    q(".map-crumb").find((c) => c.textContent === "Project")!.click();
    groupTile(q, "wt-open").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(store.get().worktree).toBe("wt-open");
    expect(store.get().project).toBe("repoA");
    expect(store.get().window).toEqual(win);
  });

  test("names update when rows resolve, without another activity request", async () => {
    const d: { resolve?: (v: unknown) => void } = {};
    worktreesMock.mockImplementation(() => new Promise((r) => { d.resolve = r; }));
    activity.mockImplementation(async () => {
      const r = twoGroups();
      return { ...r, groups: r.groups.map((g) => ({ ...g, label: "" })) };
    });
    const { panel, chip, q } = setup({ initial: { project: "repoA" } });
    void panel.activate();
    chip("map").click();
    await flush();
    expect(activity).toHaveBeenCalledTimes(1);
    const tileText = () => groupTile(q, "wt-open").querySelector("text")?.textContent ?? "";
    expect(tileText()).toContain("wt-open");
    d.resolve!(FIXTURE_ROWS);
    await flush();
    expect(tileText()).toContain("alpha-open");
    expect(activity).toHaveBeenCalledTimes(1);
  });

  test("leaving Map calls cancel() and setActive(false) and removes every drag listener", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 72, right: 1000, bottom: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    for (const leave of ["events", "lanes", "deactivate"]) {
      const { panel, chip, q } = setup({ initial: { project: "repoA" } });
      await panel.activate();
      chip("map").click();
      await flush();
      const map = maps.at(-1)!;
      const cancel = vi.spyOn(map, "cancel");
      const setActive = vi.spyOn(map, "setActive");
      const added: [EventTarget, string, unknown][] = [];
      const removed: [EventTarget, string, unknown][] = [];
      for (const t of [window, document] as EventTarget[]) {
        const add = t.addEventListener.bind(t);
        const rem = t.removeEventListener.bind(t);
        vi.spyOn(t, "addEventListener").mockImplementation((type: string, fn: unknown, o?: unknown) => { added.push([t, type, fn]); add(type, fn as EventListener, o as AddEventListenerOptions); });
        vi.spyOn(t, "removeEventListener").mockImplementation((type: string, fn: unknown, o?: unknown) => { removed.push([t, type, fn]); rem(type, fn as EventListener, o as EventListenerOptions); });
      }
      q(".map-strip")[0]!.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, clientY: 10, bubbles: true, pointerId: 1 }));
      const drags = added.filter(([, type]) => ["pointermove", "pointerup", "pointercancel", "keydown"].includes(type));
      expect(drags.map(([, type]) => type)).toEqual(expect.arrayContaining(["pointermove", "pointerup"]));
      cancel.mockClear();
      setActive.mockClear();
      if (leave === "deactivate") panel.deactivate();
      else chip(leave).click();
      expect(cancel, leave).toHaveBeenCalled();
      expect(setActive, leave).toHaveBeenCalledWith(false);
      for (const [t, type, fn] of drags)
        expect(removed.some(([rt, rtype, rfn]) => rt === t && rtype === type && rfn === fn), `${leave}: ${type}`).toBe(true);
      panel.deactivate();
      vi.mocked(window.addEventListener).mockRestore();
      vi.mocked(window.removeEventListener).mockRestore();
      vi.mocked(document.addEventListener).mockRestore();
      vi.mocked(document.removeEventListener).mockRestore();
      document.body.replaceChildren();
    }
    rect.mockRestore();
  });

  test("lifecycle: a brush in flight is cancelled by Events, Lanes and deactivate", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 1000, height: 72, right: 1000, bottom: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    for (const leave of ["events", "lanes", "deactivate"]) {
      const { panel, store, chip, q } = setup({ initial: { project: "repoA" } });
      await panel.activate();
      chip("map").click();
      await flush();
      const strip = q(".map-strip")[0];
      if (!strip) { rect.mockRestore(); throw new Error("map strip missing"); }
      const rm = vi.spyOn(window, "removeEventListener");
      strip.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, clientY: 10, bubbles: true, pointerId: 1 }));
      const before = store.get().window;
      activity.mockClear();
      if (leave === "deactivate") panel.deactivate();
      else chip(leave).click();
      expect(rm).toHaveBeenCalled();
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 600, clientY: 10, bubbles: true, pointerId: 1 }));
      await flush();
      expect(store.get().window).toEqual(before);
      expect(activity).not.toHaveBeenCalled();
      panel.deactivate();
      document.body.replaceChildren();
    }
    rect.mockRestore();
  });
});

describe("codex findings", () => {
  test("a Lanes brush in flight does not commit after the encoding changes to Graph", async () => {
    const rect = vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 960, bottom: 200, width: 960, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const { panel, store, chip, q } = setup({ initial: { project: "repoA" } });
    await panel.activate();
    const mouse = (type: string, x: number, target: EventTarget) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 }));
    mouse("mousedown", 550, q("svg.project-svg")[0]!);
    mouse("mousemove", 325, document);
    const before = store.get().window;
    chip("graph").click();
    mouse("mouseup", 325, document);
    expect(store.get().window).toEqual(before);
    rect.mockRestore();
  });

  test("reactivation restores the repository's remembered encoding before mounting the previous one", async () => {
    const { panel, store, g, chip } = setup({ initial: { project: "repoA" } });
    await panel.activate();
    chip("graph").click();
    panel.deactivate();
    store.narrow({ project: "repoB" }); // repoB has no memory: Lanes
    g.show.mockClear();
    await panel.activate();
    expect(panel.encoding()).toBe("lanes");
    expect(g.show).not.toHaveBeenCalled();
  });
});

describe("degraded", () => {
  test("404 with scope.project: Graph and Map both work", async () => {
    worktreesMock.mockImplementation(async () => { throw new ApiError("/worktrees", 404, "nf", "GET"); });
    const { panel, g, chip } = setup({ initial: { project: "r1" } });
    await panel.activate();
    await flush();
    chip("graph").click();
    expect(g.show).toHaveBeenCalledWith("graph");
    chip("map").click();
    await flush();
    expect((activity.mock.calls[0]![0] as Record<string, string>).repo_id).toBe("r1");
  });

  test("error keeps Retry and connecting keeps its copy; ready-empty still hosts", async () => {
    worktreesMock.mockImplementation(async () => { throw new Error("boom"); });
    const a = setup();
    await a.panel.activate();
    await flush();
    expect(a.q(".project-retry")).toHaveLength(1);
    a.chip("graph").click();
    expect(a.q(".project-retry")).toHaveLength(1);
    expect(a.g.show).toHaveBeenCalledWith("graph");
    a.panel.deactivate();
    worktreesMock.mockImplementation(async () => []);
    const b = setup();
    await b.panel.activate();
    await flush();
    b.chip("events").click();
    expect(b.g.show).toHaveBeenCalledWith("events");
  });

  test("fallback resolver labels a project unknown to rows with a marked short id", async () => {
    const { panel, store } = setup({ initial: { project: "reg-only" } });
    await panel.activate();
    await flush();
    expect(store.resolver()!.labels(store.get()).project).toMatch(/unknown/);
  });
});

describe("splitGoPatch", () => {
  test("splits the encoding from the scope patch", () => {
    const r = splitGoPatch({ window: "live" as const, encoding: "graph" as const });
    expect(r).toEqual({ scopePatch: { window: "live" }, encoding: "graph" });
    expect(splitGoPatch({ window: "live" as const })).toEqual({ scopePatch: { window: "live" } });
    expect(splitGoPatch({ window: "live" as const }).encoding).toBeUndefined();
    expect(splitGoPatch(undefined).scopePatch).toBeUndefined();
  });
});
