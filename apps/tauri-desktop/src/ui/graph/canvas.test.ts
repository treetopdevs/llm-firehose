// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import {
  createGraphCanvas,
  type AgentInfo,
  type CanvasGraph,
  type CanvasHandlers,
  type CanvasState,
  type CanvasWorkspace,
} from "./canvas";
import { branchingGraph, commits, mockupGraph, node, perfBudget, ws } from "./layout.fixtures";
import type { GraphNode } from "./model";

afterEach(() => document.body.replaceChildren());

const idle: CanvasState = {
  workspace: "",
  revision: "",
  descendants: false,
  matches: null,
  agents: new Map(),
};
function handlers(): CanvasHandlers {
  return {
    selectWorkspace: vi.fn(),
    selectRevision: vi.fn(),
    toggleCluster: vi.fn(),
    clearSelection: vi.fn(),
    expandHistory: vi.fn(),
    fit: vi.fn(),
  };
}
function cw(id: string, revision?: string, badges: string[] = [], name = id): CanvasWorkspace {
  return { id, revision_key: revision, name, fullName: name, badges };
}
function graphOf(
  nodes: GraphNode[],
  workspaces: CanvasWorkspace[],
  over: Partial<CanvasGraph> = {},
): CanvasGraph {
  return { nodes, workspaces, expanded: new Set(), hasMore: false, boundaryCount: 0, ...over };
}
function mount(g: CanvasGraph, h = handlers(), state: Partial<CanvasState> = {}) {
  const canvas = createGraphCanvas(h);
  document.body.append(canvas.root);
  canvas.setGraph(g);
  canvas.setState({ ...idle, ...state });
  return { canvas, h };
}
const q = <T extends Element = SVGElement>(c: { root: HTMLElement }, sel: string) =>
  c.root.querySelector<T>(sel)!;
const qa = (c: { root: HTMLElement }, sel: string) => [...c.root.querySelectorAll<SVGElement>(sel)];
const click = (e: Element) => e.dispatchEvent(new MouseEvent("click"));

// a(root) <- b, c ; m merges b and c
const diamond = [node("a"), node("b", ["a"]), node("c", ["a"]), node("m", ["b", "c"])];

test("draws one edge per present parent edge, merge parents dotted, merge commits as squares", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "m")]));
  expect(qa(canvas, ".ancestry-edge")).toHaveLength(4);
  const dotted = qa(canvas, ".ancestry-edge.dotted");
  expect(dotted).toHaveLength(1);
  expect(q(canvas, '[data-key="revision:m"]').tagName.toLowerCase()).toBe("rect");
  expect(q(canvas, '[data-key="revision:m"]').classList.contains("merge")).toBe(true);
  expect(q(canvas, '[data-key="revision:b"]').tagName.toLowerCase()).toBe("circle");
});

test("an omitted parent gets a boundary marker and never an edge", () => {
  const nodes = [node("x", ["gone"]), node("y", ["x"])];
  const { canvas } = mount(graphOf(nodes, [cw("w", "y")], { boundaryCount: 1 }));
  expect(qa(canvas, ".ancestry-edge")).toHaveLength(1);
  expect(canvas.root.querySelector(".graph-boundary")!.textContent).toContain("older history not loaded");
});

test("a label is a compact pill with a short name, a state dot and a separate dirty badge", () => {
  const { canvas } = mount(graphOf([node("a")], [cw("w", "a", ["dirty"], "wt-18")]), handlers(), {
    agents: new Map<string, AgentInfo>([["w", { state: "attention", count: 1 }]]),
  });
  const label = q(canvas, '[data-key="workspace:w"]');
  expect(label.querySelector("text")!.textContent).toBe("wt-18");
  expect(label.querySelector(".agent-dot")!.getAttribute("class")).toContain("state-attention");
  const badge = label.querySelector(".label-badge")!;
  expect(badge.textContent).toBe("dirty");
  expect(label.querySelector("text")!.textContent).not.toContain("dirty");
  expect(label.getAttribute("aria-label")).toContain("needs attention");
});

test("selection marks the ancestry, dims the rest and leaves everything clickable", () => {
  const { canvas, h } = mount(graphOf(diamond, [cw("w", "b"), cw("v", "c")]), handlers(), {
    workspace: "w",
    revision: "b",
  });
  const sel = (k: string) => q(canvas, `[data-key="revision:${k}"]`).classList.contains("selected");
  expect([sel("b"), sel("a"), sel("c"), sel("m")]).toEqual([true, true, false, false]);
  expect(q(canvas, ".graph-viewport").classList.contains("has-selection")).toBe(true);
  expect(q(canvas, '[data-key="workspace:w"]').classList.contains("selected")).toBe(true);
  expect(q(canvas, '[data-key="workspace:v"]').classList.contains("related")).toBe(false);
  // exactly the edges between ancestry members are highlighted
  expect(qa(canvas, ".ancestry-edge.selected")).toHaveLength(1);
  // an unrelated, dimmed node and label still take clicks
  click(q(canvas, '[data-key="revision:c"]'));
  expect(h.selectRevision).toHaveBeenCalledWith("c");
  click(q(canvas, '[data-key="workspace:v"]'));
  expect(h.selectWorkspace).toHaveBeenCalledWith("v");
});

test("descendants are highlighted separately", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]), handlers(), {
    workspace: "w",
    revision: "b",
    descendants: true,
  });
  const sel = (k: string) => q(canvas, `[data-key="revision:${k}"]`).classList.contains("selected");
  expect([sel("b"), sel("m"), sel("a"), sel("c")]).toEqual([true, true, false, false]);
});

test("selection, search and attention only toggle classes: the svg and its nodes are never recreated", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]));
  const svg = canvas.svg;
  const node = q(canvas, '[data-key="revision:b"]');
  const label = q(canvas, '[data-key="workspace:w"]');
  const rebuilds = canvas.rebuilds();
  canvas.setState({ ...idle, workspace: "w", revision: "b" });
  canvas.setState({
    ...idle,
    workspace: "w",
    revision: "b",
    agents: new Map([["w", { state: "working", count: 1 }]]),
  });
  canvas.setState({ ...idle, matches: new Set(["zzz"]) });
  expect(canvas.svg).toBe(svg);
  expect(q(canvas, '[data-key="revision:b"]')).toBe(node);
  expect(q(canvas, '[data-key="workspace:w"]')).toBe(label);
  expect(canvas.rebuilds()).toBe(rebuilds);
  expect(label.querySelector(".agent-dot")!.getAttribute("class")).toContain("state-none");
  canvas.setState({
    ...idle,
    agents: new Map([["w", { state: "working", count: 1 }]]),
  });
  expect(label.querySelector(".agent-dot")!.getAttribute("class")).toContain("state-working");
  // the revision under the workspace is ringed by the same state
  expect(node.getAttribute("class")).toContain("state-working");
});

test("setGraph is memoized: same topology does nothing, a changed workspace list rebuilds the content only", () => {
  const g = graphOf(diamond, [cw("w", "b")]);
  const { canvas } = mount(g);
  const first = q(canvas, '[data-key="revision:b"]');
  expect(canvas.setGraph({ ...g, nodes: [...g.nodes] })).toBe(false);
  expect(q(canvas, '[data-key="revision:b"]')).toBe(first);
  expect(canvas.setGraph(graphOf(diamond, [cw("w", "c")]))).toBe(true);
  expect(q(canvas, '[data-key="revision:b"]')).not.toBe(first);
  expect(canvas.root.querySelectorAll(".graph-canvas")).toHaveLength(1);
});

test("search mutes labels that do not match and marks the ones that do", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b"), cw("v", "c")]), handlers(), {
    matches: new Set(["w"]),
  });
  expect(q(canvas, '[data-key="workspace:w"]').classList.contains("match")).toBe(true);
  expect(q(canvas, '[data-key="workspace:w"]').classList.contains("muted")).toBe(false);
  expect(q(canvas, '[data-key="workspace:v"]').classList.contains("muted")).toBe(true);
});

test("more than three workspaces on one revision collapse into a counted cluster that expands", () => {
  const ids = ["a1", "a2", "a3", "a4", "a5"];
  const workspaces = ids.map((id) => cw(id, "a"));
  const { canvas, h } = mount(graphOf([node("a")], workspaces));
  expect(qa(canvas, ".workspace-label")).toHaveLength(0);
  const chip = q(canvas, ".workspace-cluster");
  expect(chip.textContent).toContain("5 workspaces");
  expect(chip.getAttribute("aria-expanded")).toBe("false");
  click(chip);
  expect(h.toggleCluster).toHaveBeenCalledWith("a");
  canvas.setGraph(graphOf([node("a")], workspaces, { expanded: new Set(["a"]) }));
  canvas.setState(idle);
  expect(qa(canvas, ".workspace-label")).toHaveLength(5);
  expect(q(canvas, ".workspace-cluster").getAttribute("aria-expanded")).toBe("true");
});

test("three workspaces on a revision stack as individual pills", () => {
  const { canvas } = mount(graphOf([node("a")], ["x", "y", "z"].map((id) => cw(id, "a"))));
  expect(qa(canvas, ".workspace-label")).toHaveLength(3);
  expect(qa(canvas, ".workspace-cluster")).toHaveLength(0);
});

test("workspaces without a revision stay reachable in a labelled strip", () => {
  const { canvas } = mount(graphOf([node("a")], [cw("w", "a"), cw("u", undefined, [], "unborn-one")]));
  expect(q(canvas, '[data-key="workspace:u"]')).toBeTruthy();
  expect(canvas.root.querySelector(".unattached-caption")!.textContent).toContain("No resolvable revision");
});

test("click and keyboard activation are delegated; Enter selects, Escape clears", () => {
  const { canvas, h } = mount(graphOf(diamond, [cw("w", "b")]));
  const label = q(canvas, '[data-key="workspace:w"]');
  label.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(h.selectWorkspace).toHaveBeenCalledWith("w");
  label.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(h.clearSelection).toHaveBeenCalled();
  click(canvas.svg); // background click clears too
  expect(h.clearSelection).toHaveBeenCalledTimes(2);
});

test("arrow keys pan the focused canvas and +/-/0 zoom", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]));
  canvas.setView({ x: 0, y: 0, scale: 1 });
  const key = (k: string) => canvas.svg.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  key("ArrowLeft");
  expect(canvas.view().x).toBeGreaterThan(0);
  key("ArrowDown");
  expect(canvas.view().y).toBeLessThan(0);
  const before = canvas.view().scale;
  key("+");
  expect(canvas.view().scale).toBeGreaterThan(before);
  key("-");
  key("-");
  expect(canvas.view().scale).toBeLessThan(before);
});

test("the pan/zoom group is the first g and carries a translate/scale transform", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]));
  const g = canvas.svg.querySelector(".graph-canvas > g, g")!;
  expect(g.parentElement).toBe(canvas.svg);
  expect(canvas.root.querySelector(".graph-canvas > g")!.getAttribute("transform")).toMatch(
    /^translate\(-?[\d.]+ -?[\d.]+\) scale\([\d.]+\)$/,
  );
});

test("axis annotations, depth ticks and the honest footer", () => {
  const chain = commits("c", 120);
  const { canvas } = mount(graphOf(chain, [cw("w", "c0")]));
  const text = canvas.root.textContent!;
  expect(text).toContain("Newer commits ↑");
  expect(text).toContain("(descendants)");
  expect(text).toContain("Older commits ↓");
  expect(text).toContain("(ancestors)");
  expect(text).toContain("Depth in loaded history");
  expect(text).toContain("not time");
  expect(canvas.root.querySelectorAll(".axis-ticks .tick").length).toBeGreaterThan(0);
  expect(text).toContain("Revision parent links");
  expect(text).toContain("Merge (multiple parents)");
  expect(canvas.root.querySelector(".graph-footer-status")!.textContent).toMatch(
    /^All 1 workspaces labelled · \d+ in view$/,
  );
});

test("depth tick labels step aside for the axis annotations instead of overprinting them", () => {
  const { canvas } = mount(graphOf(commits("c", 120), [cw("w", "c0")]));
  const lay = canvas.layout()!;
  const idx = lay.ticks.findIndex((t) => t.rank > 0);
  const tick = lay.ticks[idx];
  const group = () => qa(canvas, ".axis-ticks .tick")[idx];
  const label = () => group().querySelector(".tick-label")!;
  // under the "Newer commits" note: the gridline stays, the number yields
  canvas.setView({ x: 0, y: 30 - tick.y, scale: 1 });
  expect(group().getAttribute("display")).not.toBe("none");
  expect(label().getAttribute("display")).toBe("none");
  // under the bottom notes (default pane height 640)
  canvas.setView({ x: 0, y: 640 - 60 - tick.y, scale: 1 });
  expect(label().getAttribute("display")).toBe("none");
  // clear of every note: the number is back
  canvas.setView({ x: 0, y: 300 - tick.y, scale: 1 });
  expect(label().getAttribute("display")).not.toBe("none");
});

test("the footer offers history expansion only when more history exists", () => {
  const h = handlers();
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")], { hasMore: true, boundaryCount: 2 }), h);
  const button = canvas.root.querySelector<HTMLButtonElement>(".graph-expand")!;
  expect(button.hidden).toBe(false);
  expect(button.textContent).toContain("2 boundaries");
  button.click();
  expect(h.expandHistory).toHaveBeenCalled();
  canvas.setGraph(graphOf(diamond, [cw("w", "b")], { hasMore: false }));
  expect(button.hidden).toBe(true);
});

test("Fit keeps a readable scale anchored on the tips, All shows the whole deep history", () => {
  const chain = commits("c", 2000);
  const { canvas } = mount(graphOf(chain, [cw("w", "c1999")]));
  canvas.fit(["w"]);
  const v = canvas.view();
  expect(v.scale).toBeGreaterThanOrEqual(0.4);
  const tip = canvas.layout()!.nodes.get("c1999")!;
  const screenY = v.y + tip.y * v.scale;
  expect(screenY).toBeGreaterThanOrEqual(0);
  expect(screenY).toBeLessThan(640);
  canvas.fitAll();
  expect(canvas.view().scale).toBeLessThan(0.1);
});

test("centerOnWorkspace puts the label at the middle of the canvas", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]));
  canvas.centerOnWorkspace("w");
  const l = canvas.layout()!.labels.get("w")!;
  const v = canvas.view();
  const cx = v.x + (l.x + l.w / 2) * v.scale;
  const cy = v.y + (l.y + l.h / 2) * v.scale;
  expect(Math.abs(cx - (56 + (900 - 56) / 2))).toBeLessThan(1);
  expect(Math.abs(cy - 320)).toBeLessThan(1);
});

test("the mockup graph renders every workspace as a pill or a cluster", () => {
  const f = mockupGraph();
  const workspaces = f.workspaces.map((w) => cw(w.id, w.revision_key, w.badges ?? [], w.name));
  const { canvas } = mount(graphOf(f.nodes, workspaces, { trunkTip: f.trunkTip }));
  const pills = qa(canvas, ".workspace-label").length;
  const grouped = canvas.layout()!.clusterOf.size;
  expect(pills + grouped).toBe(25);
  expect(qa(canvas, ".ancestry-edge").length).toBe(canvas.layout()!.edges.length);
});

test("2,000 revisions and 50 labels: delegated listeners only, selection toggles quickly", () => {
  const adds = vi.spyOn(EventTarget.prototype, "addEventListener");
  const nodes = branchingGraph(7, 2000);
  const workspaces = Array.from({ length: 50 }, (_, i) =>
    cw(`w${String(i).padStart(2, "0")}`, nodes[(i * 37) % nodes.length].key, i % 4 === 0 ? ["dirty"] : [], `wt-${i}`),
  );
  const { canvas } = mount(graphOf(nodes, workspaces));
  const perNode = adds.mock.calls.length;
  adds.mockRestore();
  expect(perNode).toBeLessThan(40);
  expect(qa(canvas, ".revision-node").length).toBe(2000);
  const target = workspaces[10];
  const t0 = performance.now();
  canvas.setState({ ...idle, workspace: target.id, revision: target.revision_key! });
  canvas.setState({ ...idle });
  canvas.setState({ ...idle, workspace: workspaces[20].id, revision: workspaces[20].revision_key! });
  const elapsed = performance.now() - t0;
  expect(elapsed).toBeLessThan(perfBudget(300));
  const t1 = performance.now();
  canvas.setState({ ...idle, workspace: target.id, revision: target.revision_key! });
  expect(performance.now() - t1).toBeLessThan(perfBudget(100));
});

test("workspace id lookups in labels never collide with revisions of the same name", () => {
  const { canvas, h } = mount(graphOf([node("same")], [cw("same", "same")]));
  click(q(canvas, '[data-key="workspace:same"]'));
  expect(h.selectWorkspace).toHaveBeenCalledWith("same");
  expect(h.selectRevision).not.toHaveBeenCalled();
  click(q(canvas, '[data-key="revision:same"]'));
  expect(h.selectRevision).toHaveBeenCalledWith("same");
  void ws;
});

test("the selected ancestry gets a halo underlay, dropped when it would be too large", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]), handlers(), { workspace: "w", revision: "b" });
  expect(qa(canvas, ".layer-halo .halo")).toHaveLength(qa(canvas, ".ancestry-edge.selected").length);
  expect(qa(canvas, ".layer-halo .halo").length).toBeGreaterThan(0);
  canvas.setState(idle);
  expect(qa(canvas, ".layer-halo .halo")).toHaveLength(0);
  const chain = commits("c", 800);
  const big = mount(graphOf(chain, [cw("w", "c799")]), handlers(), { workspace: "w", revision: "c799" });
  expect(qa(big.canvas, ".ancestry-edge.selected").length).toBeGreaterThan(300);
  expect(qa(big.canvas, ".layer-halo .halo")).toHaveLength(0);
});

// ---- review fixes: focus, keyboard access, zoom, stability, legibility ---------------

const keydown = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
const crowd = (rev: string, n = 7) => Array.from({ length: n }, (_, i) => cw(`c${i}`, rev, [], `wt-${i}`));

test("keyboard focus survives expanding and collapsing a counted cluster", () => {
  const nodes = commits("n", 4);
  const workspaces = [...crowd("n3"), cw("solo", "n1")];
  const { canvas } = mount(graphOf(nodes, workspaces));
  const chip = q(canvas, '[data-key="cluster:n3"]');
  chip.focus();
  expect(document.activeElement).toBe(chip);
  // the app answers Enter by rebuilding with the cluster expanded
  canvas.setGraph(graphOf(nodes, workspaces, { expanded: new Set(["n3"]) }));
  canvas.setState(idle);
  let now = document.activeElement as Element;
  expect(now.getAttribute("data-key")).toBe("cluster:n3");
  expect(now.getAttribute("aria-expanded")).toBe("true");
  expect(now.getAttribute("tabindex")).toBe("0");
  // collapsing: focus on a member pill that disappears moves to its cluster chip
  q(canvas, '[data-key="workspace:c2"]').focus();
  canvas.setGraph(graphOf(nodes, workspaces));
  canvas.setState(idle);
  now = document.activeElement as Element;
  expect(now.getAttribute("data-key")).toBe("cluster:n3");
  // focusing a pill that survives the rebuild keeps it
  q(canvas, '[data-key="workspace:solo"]').focus();
  canvas.setGraph(graphOf(nodes, workspaces, { expanded: new Set(["n3"]) }));
  expect((document.activeElement as Element).getAttribute("data-key")).toBe("workspace:solo");
});

test("a rebuild does not steal focus that was outside the canvas", () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  const nodes = commits("n", 4);
  const workspaces = crowd("n3");
  const { canvas } = mount(graphOf(nodes, workspaces));
  outside.focus();
  canvas.setGraph(graphOf(nodes, workspaces, { expanded: new Set(["n3"]) }));
  expect(document.activeElement).toBe(outside);
});

test("revision nodes are named buttons that keyboard users can walk along the ancestry", () => {
  const { canvas, h } = mount(graphOf(diamond, [cw("w", "b")]));
  const a = q(canvas, '[data-key="revision:a"]');
  expect(a.getAttribute("role")).toBe("button");
  expect(a.getAttribute("aria-label")).toContain("a".padEnd(8, "0"));
  expect(a.getAttribute("aria-label")).toContain("commit a");
  expect(qa(canvas, '.revision-node[tabindex="0"]')).toHaveLength(1);
  const node = (k: string) => q(canvas, `[data-key="revision:${k}"]`);
  const lay = canvas.layout()!;
  const [left, right] = lay.nodes.get("b")!.x < lay.nodes.get("c")!.x ? ["b", "c"] : ["c", "b"];
  node("m").focus();
  keydown(node("m"), "ArrowDown"); // older: the first parent
  expect(document.activeElement).toBe(node("b"));
  keydown(node("b"), "ArrowUp"); // newer: a child
  expect(document.activeElement).toBe(node("m"));
  node(left).focus();
  keydown(node(left), "ArrowRight"); // sideways along the same row
  expect(document.activeElement).toBe(node(right));
  keydown(node(right), "ArrowRight"); // nothing further right
  expect(document.activeElement).toBe(node(right));
  keydown(node(right), "ArrowLeft");
  expect(document.activeElement).toBe(node(left));
  keydown(node(left), "ArrowDown");
  expect(document.activeElement).toBe(node("a"));
  keydown(node("a"), "ArrowDown"); // nothing older is loaded: focus stays
  expect(document.activeElement).toBe(node("a"));
  keydown(node("a"), "Enter");
  expect(h.selectRevision).toHaveBeenCalledWith("a");
  // still a single tab stop for revisions (roving), now on the focused node
  expect(qa(canvas, '.revision-node[tabindex="0"]')).toHaveLength(1);
  expect(node("a").getAttribute("tabindex")).toBe("0");
});

test("wheel zoom is gentle, bounded per event and understands line-mode wheels", () => {
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]));
  canvas.setView({ x: 0, y: 0, scale: 1 });
  const wheel = (init: WheelEventInit) => canvas.svg.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
  wheel({ deltaY: 120 });
  const one = canvas.view().scale;
  expect(one).toBeLessThan(1);
  expect(one).toBeGreaterThan(0.78); // about 0.87 per notch, not 0.62
  canvas.setView({ x: 0, y: 0, scale: 1 });
  wheel({ deltaY: 100000 });
  expect(canvas.view().scale).toBeGreaterThan(0.6); // a runaway event is capped
  canvas.setView({ x: 0, y: 0, scale: 1 });
  wheel({ deltaY: 3, deltaMode: 1 }); // Firefox: lines
  expect(canvas.view().scale).toBeLessThan(0.95);
  canvas.setView({ x: 0, y: 0, scale: 1 });
  wheel({ deltaY: -120 });
  expect(canvas.view().scale).toBeGreaterThan(1.1);
  expect(canvas.view().scale).toBeLessThan(1.3);
});

test("the 0 key asks for the same view as the Fit button", () => {
  const h = handlers();
  const { canvas } = mount(graphOf(diamond, [cw("w", "b")]), h);
  keydown(canvas.svg, "0");
  expect(h.fit).toHaveBeenCalledTimes(1);
});

test("a topology change keeps what the user is looking at under the same screen position", () => {
  const before = commits("c", 6);
  const { canvas } = mount(graphOf(before, [cw("w", "c3")]));
  canvas.setView({ x: 120, y: 60, scale: 1 });
  const screen = (k: string) => {
    const n = canvas.layout()!.nodes.get(k)!;
    const v = canvas.view();
    return { x: v.x + n.x * v.scale, y: v.y + n.y * v.scale };
  };
  const was = screen("c2");
  // two commits land on top of the longest chain: ranks and y of every node shift
  canvas.setGraph(graphOf(commits("c", 8), [cw("w", "c3")]));
  const now = screen("c2");
  expect(Math.abs(now.x - was.x)).toBeLessThan(1);
  expect(Math.abs(now.y - was.y)).toBeLessThan(1);
  // a selected revision wins as the anchor
  canvas.setState({ ...idle, workspace: "w", revision: "c3" });
  const sel = screen("c3");
  canvas.setGraph(graphOf(commits("c", 11), [cw("w", "c3")]));
  expect(Math.abs(screen("c3").y - sel.y)).toBeLessThan(1);
});

test("while the automatic view is in charge a topology change re-fits and keeps the focus on screen", () => {
  const { canvas } = mount(graphOf(commits("c", 20), [cw("w", "c10")]));
  canvas.fit(["w"]);
  const fitted = canvas.view();
  const onScreen = () => {
    const n = canvas.layout()!.nodes.get("c10")!;
    const v = canvas.view();
    return v.y + n.y * v.scale;
  };
  expect(onScreen()).toBeGreaterThan(0);
  expect(onScreen()).toBeLessThan(640);
  // ten commits land on top: c10 moves 340 px down in layout space
  canvas.setGraph(graphOf(commits("c", 30), [cw("w", "c10")]));
  expect(canvas.view()).not.toEqual(fitted);
  expect(onScreen()).toBeGreaterThan(0);
  expect(onScreen()).toBeLessThan(640);
});

test("labels stay readable: Fit never goes below 9 px text, and a far zoom-out hides unreadable labels with a hint", () => {
  const chain = commits("c", 2000);
  const workspaces = [cw("w", "c1999", [], "wt-tip"), cw("v", "c1000", [], "wt-mid")];
  const { canvas } = mount(graphOf(chain, workspaces));
  const far = () => q(canvas, ".graph-viewport").classList.contains("labels-far");
  const hint = () => q<HTMLElement>(canvas, ".graph-zoom-hint");
  canvas.fit(["w"]);
  expect(canvas.view().scale).toBeGreaterThanOrEqual(0.75);
  expect(far()).toBe(false);
  expect(hint().hidden).toBe(true);
  canvas.fitAll();
  expect(canvas.view().scale).toBeLessThan(0.1);
  expect(far()).toBe(true);
  expect(hint().hidden).toBe(false);
  expect(hint().textContent).toContain("Zoom in");
  // the labels still exist and stay selectable; they are only unreadable
  expect(qa(canvas, ".workspace-label")).toHaveLength(2);
  canvas.setView({ x: 0, y: 0, scale: 1 });
  expect(far()).toBe(false);
  expect(hint().hidden).toBe(true);
});

test("pill text is clipped to the room beside the state dot, so a long name never runs under it", () => {
  const long = "feature/PROJ-1234-UPDATE-MMMM";
  const { canvas } = mount(graphOf([node("a")], [cw("w", "a", [], long)]));
  const label = q(canvas, '[data-key="workspace:w"]');
  const rect = canvas.layout()!.labels.get("w")!;
  const clip = label.querySelector<SVGElement>("svg.pill-text")!;
  expect(clip).toBeTruthy();
  expect(Number(clip.getAttribute("width"))).toBeLessThanOrEqual(rect.w - 22);
  expect(clip.querySelector("text")!.textContent).toBe(long);
  const dot = label.querySelector(".agent-dot")!;
  expect(Number(dot.getAttribute("cx")) - 4.5).toBeGreaterThanOrEqual(Number(clip.getAttribute("width")));
  // a cluster chip is clipped the same way
  const stack = mount(graphOf(commits("n", 2), crowd("n1")));
  expect(stack.canvas.root.querySelector('[data-key="cluster:n1"] svg.pill-text')).toBeTruthy();
});

test("a locked or pruned checkout is a separate badge on its pill", () => {
  const { canvas } = mount(graphOf([node("a")], [cw("w", "a", ["locked", "dirty"], "wt-lock")]));
  const badges = [...q(canvas, '[data-key="workspace:w"]').querySelectorAll(".label-badge")].map((b) => b.textContent);
  expect(badges).toEqual(["locked", "dirty"]);
  expect(q(canvas, '[data-key="workspace:w"]').getAttribute("aria-label")).toContain("locked");
});

test("history is purple only where an agent is working or needs you; the rest is gray", () => {
  const working = new Map<string, AgentInfo>([["w", { state: "working", count: 1 }]]);
  const { canvas } = mount(graphOf(diamond, [cw("w", "b"), cw("v", "c")]));
  const active = (k: string) => q(canvas, `[data-key="revision:${k}"]`).classList.contains("active");
  expect(qa(canvas, ".active")).toHaveLength(0);
  const svgBefore = canvas.svg;
  const nodeBefore = q(canvas, '[data-key="revision:a"]');
  canvas.setState({ ...idle, agents: working });
  expect([active("a"), active("b"), active("c"), active("m")]).toEqual([true, true, false, false]);
  // exactly the edge between the two active revisions
  expect(qa(canvas, ".ancestry-edge.active")).toHaveLength(1);
  expect(canvas.svg).toBe(svgBefore);
  expect(q(canvas, '[data-key="revision:a"]')).toBe(nodeBefore);
  // merely observed sessions and idle workspaces do not light history up
  canvas.setState({ ...idle, agents: new Map<string, AgentInfo>([["w", { state: "observed", count: 1 }]]) });
  expect(qa(canvas, ".active")).toHaveLength(0);
  // a merge above an active tip stays gray; a second agent lights its own ancestry
  canvas.setState({
    ...idle,
    agents: new Map<string, AgentInfo>([
      ["w", { state: "working", count: 1 }],
      ["v", { state: "attention", count: 1 }],
    ]),
  });
  expect([active("a"), active("b"), active("c"), active("m")]).toEqual([true, true, true, false]);
});

test("off-screen workspaces are counted at the edges they are beyond", () => {
  const f = mockupGraph();
  const workspaces = f.workspaces.map((w) => cw(w.id, w.revision_key, w.badges ?? [], w.name));
  const { canvas } = mount(graphOf(f.nodes, workspaces, { trunkTip: f.trunkTip }));
  const hint = (side: string) => q<HTMLElement>(canvas, `.edge-hint.${side}`);
  canvas.fitAll();
  for (const side of ["left", "right", "top", "bottom"]) expect(hint(side).hidden).toBe(true);
  canvas.setView({ x: 0, y: 0, scale: 4 });
  const shown = ["left", "right", "top", "bottom"].filter((s) => !hint(s).hidden);
  expect(shown.length).toBeGreaterThan(0);
  const counted = shown.reduce((n, s) => n + Number(/\d+/.exec(hint(s).textContent!)![0]), 0);
  expect(counted).toBeGreaterThan(0);
  expect(counted).toBeLessThanOrEqual(25 * 2);
});

test("the axis has a vertical rule with arrowheads and the notes sit beside it", () => {
  const { canvas } = mount(graphOf(commits("c", 120), [cw("w", "c0")]));
  const axis = q(canvas, ".graph-axis");
  expect(axis.querySelector(".axis-rule")).toBeTruthy();
  expect(axis.querySelectorAll(".axis-arrow")).toHaveLength(2);
});

test("an edge hint is a button that pans toward the workspaces it counts", () => {
  const f = mockupGraph();
  const workspaces = f.workspaces.map((w) => cw(w.id, w.revision_key, w.badges ?? [], w.name));
  const { canvas } = mount(graphOf(f.nodes, workspaces, { trunkTip: f.trunkTip }));
  canvas.setView({ x: 0, y: 0, scale: 2 });
  const hint = (side: string) => q<HTMLButtonElement>(canvas, `.edge-hint.${side}`);
  const side = ["right", "bottom", "left", "top"].find((s) => !hint(s).hidden)!;
  expect(hint(side).tagName).toBe("BUTTON");
  expect(hint(side).getAttribute("aria-label")).toMatch(/more workspaces? /);
  const before = canvas.view();
  const seen = canvas.inViewCount();
  hint(side).click();
  const after = canvas.view();
  expect(after.scale).toBe(before.scale);
  if (side === "right") expect(after.x).toBeLessThan(before.x);
  if (side === "left") expect(after.x).toBeGreaterThan(before.x);
  if (side === "bottom") expect(after.y).toBeLessThan(before.y);
  if (side === "top") expect(after.y).toBeGreaterThan(before.y);
  expect(canvas.inViewCount()).not.toBe(seen);
});

test("a label's tooltip carries the full path while its accessible name stays short", () => {
  const w: CanvasWorkspace = { ...cw("w", "a", ["dirty"], "wt-18"), path: "/work/fixtures/wt-18" };
  const { canvas } = mount(graphOf([node("a")], [w, cw("v", "a", [], "plain")]));
  const label = q(canvas, '[data-key="workspace:w"]');
  expect(label.querySelector("title")!.textContent).toBe("wt-18\n/work/fixtures/wt-18");
  expect(label.getAttribute("aria-label")).not.toContain("/work");
  // a workspace without a path (JJ, or a digest from an older daemon) keeps the plain tooltip
  expect(q(canvas, '[data-key="workspace:v"] title').textContent).toBe("plain");
});
