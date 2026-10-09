// The ancestry canvas. The SVG is built once per layout (memoized on the topology,
// the workspace list and the expanded clusters); selection, search, agent state and
// attention only toggle classes afterwards, so a 500 ms attention poll never
// rebuilds 2,000 revisions. Events are delegated: one listener per kind on the
// svg, no per-node handlers.

import { el } from "../../dom";
import {
  fitBounds,
  layoutWorkspaceGraph,
  neighborLabel,
  type GraphLayout,
  type LaidBadge,
  type LaidCluster,
  type LaidLabel,
  type Rect,
} from "./layout";
import { relatives, type GraphNode, type Point } from "./model";
import { aggregateState, displayText, stateDescription, type AgentState } from "./names";

const svgNS = "http://www.w3.org/2000/svg";
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export const MIN_SCALE = 0.005;
export const MAX_SCALE = 3;
/** Readable floor for the initial and Fit views (12 px text at 0.75 is 9 px); All ignores it. */
export const READABLE_SCALE = 0.75;
/** Below this zoom 12 px labels are under 6 px: they are hidden and a hint says so. */
export const LABEL_MIN_SCALE = 0.5;
/** Left gutter reserved for the pinned depth ticks. */
const GUTTER = 56;
const PAD = 28;
const GLOW_LIMIT = 300;
/** Screen x of the axis arrows and rule, and of the notes beside them. */
const ARROW_X = 18;
const NOTE_X = 34;

export interface View {
  x: number;
  y: number;
  scale: number;
}
export interface CanvasWorkspace {
  id: string;
  revision_key?: string;
  /** Short pill name, already truncated. */
  name: string;
  /** Untruncated name for tooltips and the accessible label. */
  fullName: string;
  /** Absolute worktree path, shown in the tooltip only. */
  path?: string;
  badges: string[];
}
export interface CanvasGraph {
  nodes: GraphNode[];
  workspaces: CanvasWorkspace[];
  trunkTip?: string;
  expanded: ReadonlySet<string>;
  /** Footer: more history can be loaded. */
  hasMore: boolean;
  boundaryCount: number;
}
export interface AgentInfo {
  state: AgentState;
  count: number;
}
export interface CanvasState {
  workspace: string;
  revision: string;
  descendants: boolean;
  /** Workspace ids matching the search; null when no search is active. */
  matches: ReadonlySet<string> | null;
  agents: ReadonlyMap<string, AgentInfo>;
}
export interface CanvasHandlers {
  /** The Fit view (what the Fit button shows); bound to the 0 key. */
  fit(): void;
  selectWorkspace(id: string): void;
  selectRevision(key: string): void;
  toggleCluster(revisionKey: string): void;
  clearSelection(): void;
  expandHistory(): void;
}

interface NodeRec {
  el: SVGElement;
  base: string;
  merge: boolean;
  anchored: boolean;
  x: number;
  y: number;
  /** On the ancestry of a workspace whose agent is working or needs attention. */
  active: boolean;
  sel: boolean;
  chosen: boolean;
  ring: AgentState;
}
interface EdgeRec {
  el: SVGPathElement;
  d: string;
  base: string;
  child: string;
  parent: string;
  active: boolean;
  sel: boolean;
}
interface LabelRec {
  g: SVGGElement;
  dot: SVGCircleElement;
  ws: CanvasWorkspace;
  rect: LaidLabel;
  flags: string;
  aria: string;
}
interface ClusterRec {
  g: SVGGElement;
  dot: SVGCircleElement;
  cluster: LaidCluster;
  flags: string;
}

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Everything the layout depends on, hashed; changes only when the picture must change. */
export function graphSignature(g: CanvasGraph): string {
  let nodes = 2166136261;
  for (const n of g.nodes)
    nodes = fnv(nodes, `${n.key}\u0001${n.parents.join(",")}\u0001${n.conflicted ? 1 : 0}\u0002`);
  let ws = 2166136261;
  for (const w of g.workspaces)
    ws = fnv(ws, `${w.id}\u0001${w.revision_key ?? ""}\u0001${w.name}\u0001${w.badges.join(",")}\u0002`);
  return [
    g.nodes.length,
    nodes,
    g.workspaces.length,
    ws,
    g.trunkTip ?? "",
    [...g.expanded].sort().join(","),
  ].join("|");
}

const num = (n: number) => String(Math.round(n * 1000) / 1000);

export function createGraphCanvas(handlers: CanvasHandlers) {
  const root = el("div", { class: "graph-canvas-wrap" });
  const canvas = svg("svg", {
    class: "graph-canvas",
    role: "group",
    "aria-label": "Revision ancestry graph",
    tabindex: 0,
  });
  const viewport = svg("g", { class: "graph-viewport" });
  const edgesLayer = svg("g", { class: "layer-edges" });
  // A soft teal underlay beneath the selected ancestry; plain strokes, no SVG filter.
  const haloLayer = svg("g", { class: "layer-halo" });
  const boundaryLayer = svg("g", { class: "layer-boundaries" });
  const nodesLayer = svg("g", { class: "layer-nodes" });
  const labelsLayer = svg("g", { class: "layer-labels" });
  viewport.append(edgesLayer, haloLayer, boundaryLayer, nodesLayer, labelsLayer);
  canvas.append(viewport);

  // Screen-space axis: depth gridlines and annotations stay put while the graph pans.
  const axis = svg("svg", { class: "graph-axis", "aria-hidden": "true" });
  const grid = svg("g", { class: "axis-ticks" });
  // The vertical axis rule with an arrowhead at each end, as in the design.
  const rule = svg("line", { class: "axis-rule", x1: ARROW_X, x2: ARROW_X });
  const arrowUp = svg("path", { class: "axis-arrow up" });
  const arrowDown = svg("path", { class: "axis-arrow down" });
  axis.append(grid, rule, arrowUp, arrowDown);
  const note = (cls: string, x: number, lines: string[], anchorBottom: boolean) => {
    const t = svg("text", { class: `axis-note ${cls}`, x });
    lines.forEach((line, i) => {
      const s = svg("tspan", { x, dy: i === 0 ? "0" : "1.25em" });
      s.textContent = line;
      t.append(s);
    });
    t.dataset.bottom = anchorBottom ? "1" : "";
    return t;
  };
  const newer = note("newer", NOTE_X, ["Newer commits ↑", "(descendants)"], false);
  const older = note("older", NOTE_X, ["Older commits ↓", "(ancestors)"], true);
  const caption = note("caption", NOTE_X, ["Depth in loaded history,", "not time"], true);
  axis.append(newer, older, caption);

  const footer = el("div", { class: "graph-footer" });
  const legend = el("div", { class: "graph-legend" });
  const swatch = (dotted: boolean) => {
    const s = svg("svg", { class: "legend-swatch", width: 44, height: 12, viewBox: "0 0 44 12", "aria-hidden": "true" });
    s.append(
      svg("circle", { cx: 5, cy: 6, r: 3.5, class: "legend-dot" }),
      svg("line", { x1: 5, y1: 6, x2: 39, y2: 6, class: dotted ? "legend-line dotted" : "legend-line" }),
      svg("circle", { cx: 39, cy: 6, r: 3.5, class: "legend-dot" }),
    );
    return s;
  };
  legend.append(
    el("span", { class: "legend-item" }, swatch(false), "Revision parent links"),
    el("span", { class: "legend-item" }, swatch(true), "Merge (multiple parents)"),
  );
  const footerStatus = el("span", { class: "graph-footer-status" });
  const expandButton = el("button", { class: "graph-expand", type: "button" });
  expandButton.hidden = true;
  expandButton.onclick = () => handlers.expandHistory();
  footer.append(legend, footerStatus, expandButton);
  // Zoomed far out the labels are too small to read; say so rather than show specks.
  const zoomHint = el("div", { class: "graph-zoom-hint", role: "status" }, "Zoomed out: labels are hidden. Zoom in, or search, to read workspaces.");
  zoomHint.hidden = true;
  // Workspaces beyond each edge of the view, so a cropped Fit never hides them silently.
  // Each is a button that pans a screenful toward them.
  const edgeHints = {
    left: el("button", { type: "button", class: "edge-hint left" }),
    right: el("button", { type: "button", class: "edge-hint right" }),
    top: el("button", { type: "button", class: "edge-hint top" }),
    bottom: el("button", { type: "button", class: "edge-hint bottom" }),
  };
  for (const h of Object.values(edgeHints)) h.hidden = true;
  root.append(canvas, axis, zoomHint, ...Object.values(edgeHints), footer);

  let layout: GraphLayout | undefined;
  let signature = "";
  let graph: CanvasGraph | undefined;
  let nodesByKey = new Map<string, GraphNode>();
  let wsById = new Map<string, CanvasWorkspace>();
  let nodeRecs = new Map<string, NodeRec>();
  let anchoredRecs = new Map<string, NodeRec>();
  let edgeRecs: EdgeRec[] = [];
  let incident = new Map<string, number[]>();
  let labelRecs = new Map<string, LabelRec>();
  let clusterRecs = new Map<string, ClusterRec>();
  let tickRecs: { g: SVGGElement; label: SVGTextElement; y: number }[] = [];
  let state: CanvasState = {
    workspace: "",
    revision: "",
    descendants: false,
    matches: null,
    agents: new Map(),
  };
  let highlight: Set<string> | null = null;
  let chosenKey = "";
  let view: View = { x: 0, y: 0, scale: 1 };
  let autoView: (() => View | undefined) | undefined;
  let tabStop: Element | undefined;
  let nodeStop: Element | undefined;
  let clusterByRev = new Map<string, LaidCluster>();
  let childrenOf = new Map<string, string[]>();
  let rows: Map<number, { key: string; x: number }[]> | undefined;
  let activeSig = "";
  let activeSet = new Set<string>();
  let far = false;
  let rebuilds = 0;

  function size() {
    const r = canvas.getBoundingClientRect?.();
    return {
      w: canvas.clientWidth || r?.width || 900,
      h: canvas.clientHeight || r?.height || 640,
    };
  }

  // ---- view -------------------------------------------------------------

  function clampScale(s: number) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }
  function viewForRect(r: Rect, minScale: number, anchorTop: boolean): View {
    const { w, h } = size();
    const availW = Math.max(120, w - GUTTER - PAD);
    const availH = Math.max(120, h - 2 * PAD);
    const fit = Math.min(availW / Math.max(1, r.w), availH / Math.max(1, r.h));
    const scale = clampScale(Math.min(1, Math.max(fit, minScale)));
    const x = GUTTER + availW / 2 - (r.x + r.w / 2) * scale;
    const overflow = r.h * scale > availH;
    const y = overflow && anchorTop ? PAD - r.y * scale : h / 2 - (r.y + r.h / 2) * scale;
    return { x, y, scale };
  }
  function applyView() {
    viewport.setAttribute(
      "transform",
      `translate(${num(view.x)} ${num(view.y)}) scale(${num(view.scale)})`,
    );
    const tooSmall = view.scale < LABEL_MIN_SCALE;
    if (tooSmall !== far) {
      far = tooSmall;
      viewport.classList.toggle("labels-far", far);
    }
    zoomHint.hidden = !far || !graph?.workspaces.length;
    updateAxis();
    updateFooter();
  }
  function setView(v: View, auto = false) {
    view = { x: v.x, y: v.y, scale: clampScale(v.scale) };
    if (!auto) autoView = undefined;
    applyView();
  }
  function reapplyAuto() {
    const v = autoView?.();
    if (v) {
      view = v;
      applyView();
    }
  }
  /** Tips of the given workspaces plus the history joining them, never below the readable floor. */
  function fit(focus: string[] | undefined, minScale = READABLE_SCALE) {
    if (!layout) return;
    autoView = () => (layout ? viewForRect(fitBounds(layout, focus), minScale, true) : undefined);
    reapplyAuto();
  }
  function fitAll() {
    if (!layout) return;
    autoView = () => (layout ? viewForRect(layout.bounds, 0, false) : undefined);
    reapplyAuto();
  }
  function fitRevisions(keys: Iterable<string>, minScale = READABLE_SCALE) {
    if (!layout) return;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const k of keys) {
      const n = layout.nodes.get(k);
      if (!n) continue;
      x0 = Math.min(x0, n.x);
      x1 = Math.max(x1, n.x);
      y0 = Math.min(y0, n.y);
      y1 = Math.max(y1, n.y);
    }
    if (!Number.isFinite(x0)) return;
    const r = { x: x0 - 40, y: y0 - 40, w: x1 - x0 + 80, h: y1 - y0 + 80 };
    autoView = undefined;
    setView(viewForRect(r, minScale, true));
  }
  function centerOn(p: Point, minScale = 1) {
    const { w, h } = size();
    const scale = clampScale(Math.max(view.scale, minScale));
    setView({
      x: GUTTER + (w - GUTTER) / 2 - p.x * scale,
      y: h / 2 - p.y * scale,
      scale,
    });
  }
  function pointOf(id: string): Point | undefined {
    if (!layout) return undefined;
    const l = layout.labels.get(id);
    if (l) return { x: l.x + l.w / 2, y: l.y + l.h / 2 };
    const rev = layout.clusterOf.get(id);
    const c = rev ? layout.clusters.find((c) => c.revision_key === rev) : undefined;
    if (c) return { x: c.x + c.w / 2, y: c.y + c.h / 2 };
    const key = wsById.get(id)?.revision_key;
    const n = key ? layout.nodes.get(key) : undefined;
    return n ? { x: n.x, y: n.y } : undefined;
  }
  function centerOnWorkspace(id: string, minScale = 1) {
    const p = pointOf(id);
    if (p) centerOn(p, minScale);
  }
  function centerOnRevision(key: string, minScale = 1) {
    const n = layout?.nodes.get(key);
    if (n) centerOn({ x: n.x, y: n.y }, minScale);
  }
  /** Pan the least amount that brings a world rect fully on screen. */
  function ensureVisible(r: Rect) {
    const { w, h } = size();
    const margin = 24;
    let dx = 0,
      dy = 0;
    const left = view.x + r.x * view.scale;
    const right = left + r.w * view.scale;
    const top = view.y + r.y * view.scale;
    const bottom = top + r.h * view.scale;
    if (left < GUTTER + margin) dx = GUTTER + margin - left;
    else if (right > w - margin) dx = w - margin - right;
    if (top < margin) dy = margin - top;
    else if (bottom > h - margin) dy = h - margin - bottom;
    if (dx || dy) setView({ ...view, x: view.x + dx, y: view.y + dy });
  }

  // ---- axis and footer --------------------------------------------------

  function updateAxis() {
    const { h } = size();
    // Annotation text bands (screen y), so tick numbers never print over them.
    const bands: [number, number][] = [];
    for (const t of [newer, older, caption]) {
      const bottom = t.dataset.bottom === "1";
      const lines = t.childElementCount;
      const lift = bottom ? (t === caption ? 74 : 44) : 0;
      const baseline = bottom ? h - lift - (lines - 1) * 14 : 26;
      t.setAttribute("y", num(baseline));
      for (const s of Array.from(t.children)) s.setAttribute("x", String(NOTE_X));
      bands.push([baseline - 13, baseline + (lines - 1) * 14 + 5]);
    }
    // arrowheads beside the "Newer" and "Older" notes, joined by a faint rule
    const topY = 12;
    const bottomY = h - 26;
    arrowUp.setAttribute("d", `M ${ARROW_X} ${topY + 34} V ${topY} M ${ARROW_X - 5} ${topY + 5} L ${ARROW_X} ${topY} L ${ARROW_X + 5} ${topY + 5}`);
    arrowDown.setAttribute("d", `M ${ARROW_X} ${bottomY - 44} V ${bottomY} M ${ARROW_X - 5} ${bottomY - 5} L ${ARROW_X} ${bottomY} L ${ARROW_X + 5} ${bottomY - 5}`);
    rule.setAttribute("y1", String(topY + 44));
    rule.setAttribute("y2", String(Math.max(topY + 44, bottomY - 54)));
    for (const t of tickRecs) {
      const y = view.y + t.y * view.scale;
      if (y < 4 || y > h - 4) t.g.setAttribute("display", "none");
      else {
        t.g.removeAttribute("display");
        t.g.setAttribute("transform", `translate(0 ${num(y)})`);
        // the number sits just above its gridline: [y - 15, y - 1]
        const clash = bands.some(([top, bottom]) => y - 15 < bottom && y - 1 > top);
        if (clash) t.label.setAttribute("display", "none");
        else t.label.removeAttribute("display");
      }
    }
  }
  function worldRect(): Rect {
    const { w, h } = size();
    return { x: -view.x / view.scale, y: -view.y / view.scale, w: w / view.scale, h: h / view.scale };
  }
  const intersects = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  /** Workspaces in view, and those beyond each edge (by the larger overshoot when diagonal). */
  function viewCounts() {
    const out = { inView: 0, left: 0, right: 0, top: 0, bottom: 0 };
    if (!layout || !graph) return out;
    const v = worldRect();
    for (const w of graph.workspaces) {
      let r: Rect | undefined = layout.labels.get(w.id);
      if (!r) {
        const rev = layout.clusterOf.get(w.id);
        r = rev ? clusterByRev.get(rev) : undefined;
      }
      if (!r) continue;
      if (intersects(v, r)) {
        out.inView++;
        continue;
      }
      const dx = r.x + r.w <= v.x ? v.x - (r.x + r.w) : r.x >= v.x + v.w ? r.x - (v.x + v.w) : 0;
      const dy = r.y + r.h <= v.y ? v.y - (r.y + r.h) : r.y >= v.y + v.h ? r.y - (v.y + v.h) : 0;
      if (dx >= dy) out[r.x + r.w <= v.x ? "left" : "right"]++;
      else out[r.y + r.h <= v.y ? "top" : "bottom"]++;
    }
    return out;
  }
  function inViewCount(): number {
    return viewCounts().inView;
  }
  const hintText = {
    left: (n: number) => `◂ ${n} more`,
    right: (n: number) => `${n} more ▸`,
    top: (n: number) => `▴ ${n} more`,
    bottom: (n: number) => `▾ ${n} more`,
  };
  function updateFooter() {
    if (!layout || !graph) {
      footerStatus.textContent = "";
      for (const h of Object.values(edgeHints)) h.hidden = true;
      return;
    }
    const total = graph.workspaces.length;
    const clustered = layout.clusterOf.size;
    const grouped = clustered
      ? ` (${clustered} grouped in ${new Set(layout.clusterOf.values()).size} counted ${new Set(layout.clusterOf.values()).size === 1 ? "cluster" : "clusters"})`
      : "";
    const counts = viewCounts();
    const text = `All ${total} workspaces labelled${grouped} · ${counts.inView} in view`;
    if (footerStatus.textContent !== text) footerStatus.textContent = text;
    for (const side of ["left", "right", "top", "bottom"] as const) {
      const hint = edgeHints[side];
      const n = counts[side];
      hint.hidden = n === 0;
      if (n) {
        const t = hintText[side](n);
        if (hint.textContent !== t) hint.textContent = t;
        hint.setAttribute("aria-label", `${n} more ${n === 1 ? "workspace" : "workspaces"} ${side === "left" ? "to the left" : side === "right" ? "to the right" : side === "top" ? "above" : "below"}; pan toward them`);
      }
    }
    expandButton.hidden = !graph.hasMore;
    expandButton.textContent = `Expand omitted ancestry (${graph.boundaryCount} boundaries)`;
  }

  // ---- build ------------------------------------------------------------

  function edgeBase(kind: string) {
    return `ancestry-edge${kind === "merge" ? " dotted merge" : ""}`;
  }
  function nodeClass(r: Pick<NodeRec, "base" | "active" | "sel" | "chosen" | "ring">) {
    return (
      r.base +
      (r.active ? " active" : "") +
      (r.sel ? " selected" : "") +
      (r.chosen ? " chosen" : "") +
      (r.ring !== "none" ? ` ring state-${r.ring}` : "")
    );
  }
  function nodeShape(r: NodeRec) {
    const half = r.chosen ? 6 : r.anchored ? 5 : 4;
    if (r.merge) {
      r.el.setAttribute("x", num(r.x - half));
      r.el.setAttribute("y", num(r.y - half));
      r.el.setAttribute("width", String(half * 2));
      r.el.setAttribute("height", String(half * 2));
    } else r.el.setAttribute("r", String(r.chosen ? 7 : r.anchored ? 5 : 4));
  }
  /** Text in a nested viewport that stops short of the state dot, so a long name is cut, never overprinted. */
  function clipped(text: SVGTextElement, w: number, h: number): SVGSVGElement {
    const box = svg("svg", { class: "pill-text", x: 0, y: 0, width: Math.max(20, w - 22), height: h });
    box.append(text);
    return box;
  }
  function buildBadge(b: LaidBadge, l: LaidLabel): SVGGElement {
    const g = svg("g", {
      class: `label-badge badge-${b.text.replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
      transform: `translate(${num(b.x - l.x)},${num(b.y - l.y)})`,
    });
    g.append(svg("rect", { width: b.w, height: b.h, rx: 5 }));
    const t = svg("text", { x: b.w / 2, y: b.h / 2 + 3.5, "text-anchor": "middle" });
    t.textContent = b.text;
    g.append(t);
    return g;
  }
  function buildLabel(l: LaidLabel, ws: CanvasWorkspace): LabelRec {
    const g = svg("g", {
      class: "workspace-label",
      tabindex: -1,
      role: "button",
      "data-key": `workspace:${l.id}`,
      transform: `translate(${num(l.x)},${num(l.y)})`,
    });
    if (l.leader)
      g.append(
        svg("line", {
          class: "label-leader",
          x1: num(l.leader.x1 - l.x),
          y1: num(l.leader.y1 - l.y),
          x2: num(l.leader.x2 - l.x),
          y2: num(l.leader.y2 - l.y),
        }),
      );
    g.append(svg("rect", { class: "pill", width: l.w, height: l.h, rx: 6 }));
    const text = svg("text", { x: 10, y: l.h / 2 + 4 });
    text.textContent = ws.name;
    const dot = svg("circle", {
      class: "agent-dot state-none",
      cx: l.w - 12,
      cy: l.h / 2,
      r: 4.5,
    });
    g.append(clipped(text, l.w, l.h), dot);
    for (const b of l.badges) g.append(buildBadge(b, l));
    const title = svg("title");
    title.textContent = ws.path ? `${ws.fullName}\n${ws.path}` : ws.fullName;
    g.append(title);
    return { g, dot, ws, rect: l, flags: "", aria: "" };
  }
  function buildCluster(c: LaidCluster): ClusterRec {
    const g = svg("g", {
      class: "workspace-cluster",
      tabindex: 0,
      role: "button",
      "data-key": `cluster:${c.revision_key}`,
      transform: `translate(${num(c.x)},${num(c.y)})`,
      "aria-expanded": c.expanded ? "true" : "false",
      "aria-label": `${c.count} workspaces on one revision, ${c.expanded ? "expanded" : "collapsed"}`,
    });
    if (c.leader)
      g.append(
        svg("line", {
          class: "label-leader",
          x1: num(c.leader.x1 - c.x),
          y1: num(c.leader.y1 - c.y),
          x2: num(c.leader.x2 - c.x),
          y2: num(c.leader.y2 - c.y),
        }),
      );
    g.append(svg("rect", { class: "chip", width: c.w, height: c.h, rx: 6 }));
    const text = svg("text", { x: 10, y: c.h / 2 + 4 });
    text.textContent = `${c.count} workspaces ${c.expanded ? "▾" : "▸"}`;
    const dot = svg("circle", {
      class: "agent-dot state-none",
      cx: c.w - 12,
      cy: c.h / 2,
      r: 4.5,
    });
    const title = svg("title");
    title.textContent = c.expanded
      ? "Collapse this group of workspaces"
      : "Expand to show every workspace on this revision";
    g.append(clipped(text, c.w, c.h), dot, title);
    return { g, dot, cluster: c, flags: "" };
  }

  /** Key (`workspace:..`, `cluster:..`, `revision:..`) of the focused element inside the svg. */
  function focusedKey(): string | null {
    const a = document.activeElement;
    if (!a || a === canvas || !canvas.contains(a)) return null;
    return a.closest?.("[data-key]")?.getAttribute("data-key") ?? null;
  }
  function elementForKey(key: string): SVGElement | undefined {
    if (key.startsWith("workspace:")) {
      const id = key.slice(10);
      const rev = layout?.clusterOf.get(id);
      return labelRecs.get(id)?.g ?? (rev ? clusterRecs.get(rev)?.g : undefined);
    }
    if (key.startsWith("cluster:")) return clusterRecs.get(key.slice(8))?.g;
    if (key.startsWith("revision:")) return nodeRecs.get(key.slice(9))?.el;
    return undefined;
  }
  /** The node nearest the middle of the view, or the selected revision: what stays put across a rebuild. */
  function pickAnchor(old: GraphLayout | undefined): string | undefined {
    if (!old || !old.nodes.size) return undefined;
    if (chosenKey && old.nodes.has(chosenKey)) return chosenKey;
    const v = worldRect();
    const cx = v.x + v.w / 2;
    const cy = v.y + v.h / 2;
    let best: string | undefined;
    let bestD = Infinity;
    for (const [k, n] of old.nodes) {
      const d = (n.x - cx) ** 2 + (n.y - cy) ** 2;
      if (d < bestD || (d === bestD && best !== undefined && k < best)) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  function rebuild(anchor?: string) {
    if (!graph) return;
    const old = layout;
    const focus = focusedKey();
    // A user-driven change (an explicit anchor) pins that node; otherwise the
    // automatic view re-fits, and a view the user set keeps what they look at in place.
    let anchorKey = anchor;
    if (anchor) autoView = undefined;
    else if (!autoView) anchorKey = pickAnchor(old);
    const before = anchorKey ? old?.nodes.get(anchorKey) : undefined;
    rebuilds++;
    layout = layoutWorkspaceGraph(
      graph.nodes,
      graph.workspaces.map((w) => ({
        id: w.id,
        revision_key: w.revision_key,
        name: w.name,
        badges: w.badges,
      })),
      { trunkTip: graph.trunkTip, expanded: graph.expanded },
    );
    const lay = layout;
    nodeRecs = new Map();
    anchoredRecs = new Map();
    edgeRecs = [];
    incident = new Map();
    labelRecs = new Map();
    clusterRecs = new Map();
    tickRecs = [];
    highlight = null;
    chosenKey = "";
    tabStop = undefined;
    nodeStop = undefined;
    rows = undefined;
    activeSig = "";
    activeSet = new Set();
    clusterByRev = new Map(lay.clusters.map((c) => [c.revision_key, c]));
    childrenOf = new Map();

    const edgeFrag = document.createDocumentFragment();
    for (const e of lay.edges) {
      const base = edgeBase(e.kind);
      const p = svg("path", { d: e.d, class: base });
      edgeFrag.append(p);
      const i = edgeRecs.length;
      edgeRecs.push({ el: p, d: e.d, base, child: e.child, parent: e.parent, active: false, sel: false });
      const kids = childrenOf.get(e.parent);
      if (kids) kids.push(e.child);
      else childrenOf.set(e.parent, [e.child]);
      for (const k of [e.child, e.parent]) {
        const list = incident.get(k);
        if (list) list.push(i);
        else incident.set(k, [i]);
      }
    }
    edgesLayer.replaceChildren(edgeFrag);

    const nodeFrag = document.createDocumentFragment();
    for (const [key, n] of lay.nodes) {
      const src = nodesByKey.get(key);
      const base =
        "revision-node" +
        (n.merge ? " merge" : "") +
        (src?.conflicted ? " conflicted" : "") +
        (n.anchors > 0 ? " tip" : "");
      // Every revision is a named button; only one is a tab stop (see setNodeStop).
      const access = {
        "data-key": `revision:${key}`,
        role: "button",
        tabindex: -1,
        "aria-label": src ? `${src.commit_id.slice(0, 8)} ${displayText(src.description).split("\n")[0].slice(0, 80)}`.trim() : key,
      };
      const rec: NodeRec = {
        el: n.merge
          ? svg("rect", { class: base, ...access })
          : svg("circle", { class: base, cx: num(n.x), cy: num(n.y), ...access }),
        base,
        merge: n.merge,
        anchored: n.anchors > 0,
        x: n.x,
        y: n.y,
        active: false,
        sel: false,
        chosen: false,
        ring: "none",
      };
      nodeShape(rec);
      nodeFrag.append(rec.el);
      nodeRecs.set(key, rec);
      if (rec.anchored) anchoredRecs.set(key, rec);
    }
    nodesLayer.replaceChildren(nodeFrag);

    const boundaryFrag = document.createDocumentFragment();
    for (const key of lay.boundaries) {
      const n = lay.nodes.get(key);
      if (!n) continue;
      boundaryFrag.append(
        svg("line", {
          class: "boundary-stub",
          x1: num(n.x),
          y1: num(n.y + 7),
          x2: num(n.x),
          y2: num(n.y + 19),
        }),
      );
      const t = svg("text", { class: "graph-boundary", x: num(n.x + 6), y: num(n.y + 26) });
      t.textContent = "⋮ older history not loaded";
      boundaryFrag.append(t);
    }
    boundaryLayer.replaceChildren(boundaryFrag);
    haloLayer.replaceChildren();

    const labelFrag = document.createDocumentFragment();
    if (lay.unattachedBox) {
      const b = lay.unattachedBox;
      labelFrag.append(
        svg("rect", {
          class: "unattached-box",
          x: num(b.x),
          y: num(b.y),
          width: b.w,
          height: b.h,
          rx: 8,
        }),
      );
      const cap = svg("text", { class: "unattached-caption", x: num(b.x + 10), y: num(b.y + 17) });
      cap.textContent = `No resolvable revision (${lay.unattached.length}) · no ancestry drawn`;
      labelFrag.append(cap);
    }
    for (const c of lay.clusters) {
      const rec = buildCluster(c);
      clusterRecs.set(c.revision_key, rec);
      labelFrag.append(rec.g);
    }
    for (const [id, l] of lay.labels) {
      const ws = wsById.get(id);
      if (!ws) continue;
      const rec = buildLabel(l, ws);
      labelRecs.set(id, rec);
      labelFrag.append(rec.g);
    }
    labelsLayer.replaceChildren(labelFrag);

    const tickFrag = document.createDocumentFragment();
    for (const t of lay.ticks) {
      const g = svg("g", { class: "tick" });
      g.append(svg("line", { class: "tick-line", x1: GUTTER - 6, x2: "100%", y1: 0, y2: 0 }));
      const label = svg("text", { class: "tick-label", x: ARROW_X + 8, y: -4 });
      label.textContent = t.label;
      g.append(label);
      tickFrag.append(g);
      tickRecs.push({ g, label, y: t.y });
    }
    grid.replaceChildren(tickFrag);

    const first = labelRecs.values().next().value?.g ?? clusterRecs.values().next().value?.g;
    if (first) setTabStop(first);
    const firstNode = anchoredRecs.values().next().value?.el ?? nodeRecs.values().next().value?.el;
    if (firstNode) setNodeStop(firstNode);

    if (before && anchorKey) {
      const after = lay.nodes.get(anchorKey);
      if (after) {
        view = {
          ...view,
          x: view.x + (before.x - after.x) * view.scale,
          y: view.y + (before.y - after.y) * view.scale,
        };
      }
    }
    applyState(true);
    if (autoView) reapplyAuto();
    else applyView();
    // The focused element was replaced: put focus on its successor.
    if (focus) {
      const next = elementForKey(focus);
      if (next) {
        if (focus.startsWith("revision:")) setNodeStop(next);
        else setTabStop(next);
        (next as SVGElement).focus();
      }
    }
  }

  function setGraph(next: CanvasGraph, anchor?: string): boolean {
    graph = next;
    nodesByKey = new Map(next.nodes.map((n) => [n.key, n]));
    wsById = new Map(next.workspaces.map((w) => [w.id, w]));
    const sig = graphSignature(next);
    if (sig === signature && layout) {
      updateFooter();
      return false;
    }
    signature = sig;
    rebuild(anchor);
    return true;
  }

  // ---- state ------------------------------------------------------------

  function setTabStop(next: Element) {
    if (tabStop === next) return;
    tabStop?.setAttribute("tabindex", "-1");
    next.setAttribute("tabindex", "0");
    tabStop = next;
  }
  function setNodeStop(next: Element) {
    if (nodeStop === next) return;
    nodeStop?.setAttribute("tabindex", "-1");
    next.setAttribute("tabindex", "0");
    nodeStop = next;
  }
  function setClass(e: Element, value: string) {
    if (e.getAttribute("class") !== value) e.setAttribute("class", value);
  }
  function edgeClass(r: EdgeRec) {
    return r.base + (r.active ? " active" : "") + (r.sel ? " selected" : "");
  }
  function applyState(force = false) {
    if (!layout || !graph) return;
    const sel = state.workspace ? wsById.get(state.workspace) : undefined;
    const chosen = state.revision || sel?.revision_key || "";
    const next = chosen && nodesByKey.has(chosen) ? relatives(graph.nodes, chosen, state.descendants) : null;

    // Ancestry highlight: touch only the nodes and edges whose membership changed.
    const prev = force ? null : highlight;
    const touched = new Set<string>();
    if (next) for (const k of next) if (!prev?.has(k)) touched.add(k);
    if (prev) for (const k of prev) if (!next?.has(k)) touched.add(k);
    const edgeIdx = new Set<number>();
    for (const k of touched) {
      const rec = nodeRecs.get(k);
      if (rec) {
        rec.sel = !!next?.has(k);
        setClass(rec.el, nodeClass(rec));
      }
      for (const i of incident.get(k) ?? []) edgeIdx.add(i);
    }
    for (const i of edgeIdx) {
      const e = edgeRecs[i];
      e.sel = !!next && next.has(e.child) && next.has(e.parent);
      setClass(e.el, edgeClass(e));
    }
    if (edgeIdx.size || force) {
      const halo = document.createDocumentFragment();
      let count = 0;
      if (next)
        for (const e of edgeRecs)
          if (e.sel && ++count <= GLOW_LIMIT) halo.append(svg("path", { class: "halo", d: e.d }));
      haloLayer.replaceChildren(count <= GLOW_LIMIT ? halo : document.createDocumentFragment());
    }
    highlight = next;
    viewport.classList.toggle("has-selection", !!next || !!state.workspace);

    if (chosenKey !== chosen) {
      const old = nodeRecs.get(chosenKey);
      if (old) {
        old.chosen = false;
        nodeShape(old);
        setClass(old.el, nodeClass(old));
      }
      const cur = nodeRecs.get(chosen);
      if (cur) {
        cur.chosen = true;
        nodeShape(cur);
        setClass(cur.el, nodeClass(cur));
        if (!canvas.contains(document.activeElement) || document.activeElement === canvas) setNodeStop(cur.el);
      }
      chosenKey = chosen;
    }

    // History an agent is working on (or waiting on you for) is purple: the
    // ancestors of those workspaces. Everything else stays gray.
    const hot = new Set<string>();
    for (const w of graph.workspaces) {
      const st = state.agents.get(w.id)?.state;
      if (w.revision_key && (st === "working" || st === "attention")) hot.add(w.revision_key);
    }
    const sig = [...hot].sort().join(",");
    if (force || sig !== activeSig) {
      activeSig = sig;
      const nextActive = new Set<string>();
      const pending = [...hot];
      while (pending.length) {
        const k = pending.pop()!;
        if (nextActive.has(k) || !nodesByKey.has(k)) continue;
        nextActive.add(k);
        for (const p of nodesByKey.get(k)!.parents) pending.push(p);
      }
      const changed = new Set<string>();
      for (const k of nextActive) if (!activeSet.has(k)) changed.add(k);
      for (const k of activeSet) if (!nextActive.has(k)) changed.add(k);
      for (const k of changed) {
        const rec = nodeRecs.get(k);
        if (rec) {
          rec.active = nextActive.has(k);
          setClass(rec.el, nodeClass(rec));
        }
        // an edge is active exactly when its child is: the parent is then an ancestor too
        for (const i of incident.get(k) ?? []) {
          const e = edgeRecs[i];
          if (e.child !== k) continue;
          e.active = nextActive.has(k);
          setClass(e.el, edgeClass(e));
        }
      }
      activeSet = nextActive;
    }

    // Per-revision ring: the strongest agent state among the workspaces on it.
    const ringStates = new Map<string, AgentState[]>();
    for (const w of graph.workspaces) {
      if (!w.revision_key) continue;
      const s = state.agents.get(w.id)?.state ?? "none";
      const list = ringStates.get(w.revision_key);
      if (list) list.push(s);
      else ringStates.set(w.revision_key, [s]);
    }
    for (const [key, rec] of anchoredRecs) {
      const ring = aggregateState(ringStates.get(key) ?? []);
      if (ring !== rec.ring) {
        rec.ring = ring;
        setClass(rec.el, nodeClass(rec));
      }
    }

    for (const [id, rec] of labelRecs) {
      const info = state.agents.get(id);
      const agent = info?.state ?? "none";
      const selected = state.workspace === id;
      const related = selected || (!!rec.ws.revision_key && !!next?.has(rec.ws.revision_key));
      const matched = !!state.matches?.has(id);
      const flags = `${selected ? " selected" : ""}${related ? " related" : ""}${
        state.matches && !matched ? " muted" : ""
      }${matched ? " match" : ""}${rec.rect.leader ? " displaced" : ""}`;
      if (flags !== rec.flags || force) {
        rec.flags = flags;
        setClass(rec.g, `workspace-label${flags}`);
      }
      const dotClass = `agent-dot state-${agent}`;
      setClass(rec.dot, dotClass);
      const aria = [
        rec.ws.fullName,
        ...rec.ws.badges,
        stateDescription(agent),
        info && info.count > 0 ? `${info.count} ${info.count === 1 ? "agent" : "agents"}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      if (aria !== rec.aria) {
        rec.aria = aria;
        rec.g.setAttribute("aria-label", aria);
      }
    }
    for (const [rev, rec] of clusterRecs) {
      const members = rec.cluster.members;
      const agent = aggregateState(members.map((m) => state.agents.get(m)?.state ?? "none"));
      const hasSelected = members.includes(state.workspace);
      const matched = !!state.matches && members.some((m) => state.matches!.has(m));
      const related =
        hasSelected ||
        members.some((m) => {
          const k = wsById.get(m)?.revision_key;
          return !!k && !!next?.has(k);
        }) ||
        (!!next && next.has(rev));
      const flags = `${hasSelected ? " selected" : ""}${related ? " related" : ""}${
        state.matches && !matched ? " muted" : ""
      }${matched ? " match" : ""}${rec.cluster.expanded ? " expanded" : ""}`;
      if (flags !== rec.flags || force) {
        rec.flags = flags;
        setClass(rec.g, `workspace-cluster${flags}`);
      }
      setClass(rec.dot, `agent-dot state-${agent}`);
    }
    // Keep the selected label as the keyboard entry point unless focus is inside the canvas.
    if (!canvas.contains(document.activeElement) || document.activeElement === canvas) {
      const target = labelRecs.get(state.workspace)?.g;
      if (target) setTabStop(target);
    }
  }
  function setState(next: CanvasState) {
    state = next;
    applyState();
    updateFooter();
  }

  // ---- interaction (delegated) -------------------------------------------

  function keyOf(target: EventTarget | null): string | null {
    const t = (target as Element | null)?.closest?.("[data-key]");
    return t && canvas.contains(t) ? t.getAttribute("data-key") : null;
  }
  let drag: { x: number; y: number; moved: number } | undefined;
  let suppressClick = false;
  canvas.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      const key = keyOf(e.target);
      if (key === null) {
        handlers.clearSelection();
        return;
      }
      if (key.startsWith("workspace:")) handlers.selectWorkspace(key.slice(10));
      else if (key.startsWith("revision:")) handlers.selectRevision(key.slice(9));
      else if (key.startsWith("cluster:")) handlers.toggleCluster(key.slice(8));
    },
    true,
  );
  /** Revisions walk along the real parent edges: down is older, up is newer, sideways the same row. */
  function moveRevisionFocus(key: string, dir: "up" | "down" | "left" | "right") {
    if (!layout) return;
    const here = layout.nodes.get(key);
    if (!here) return;
    let next: string | undefined;
    if (dir === "down") {
      next = (nodesByKey.get(key)?.parents ?? []).find((p) => layout!.nodes.has(p));
    } else if (dir === "up") {
      let best = Infinity;
      for (const c of childrenOf.get(key) ?? []) {
        const n = layout.nodes.get(c);
        if (!n) continue;
        const d = Math.abs(n.x - here.x);
        if (d < best || (d === best && next !== undefined && c < next)) {
          best = d;
          next = c;
        }
      }
    } else {
      if (!rows) {
        rows = new Map();
        for (const [k, n] of layout.nodes) {
          const row = rows.get(n.rank);
          if (row) row.push({ key: k, x: n.x });
          else rows.set(n.rank, [{ key: k, x: n.x }]);
        }
        for (const row of rows.values()) row.sort((a, b) => a.x - b.x || (a.key < b.key ? -1 : 1));
      }
      const row = rows.get(here.rank) ?? [];
      const i = row.findIndex((r) => r.key === key);
      next = row[i + (dir === "right" ? 1 : -1)]?.key;
    }
    if (next) focusRevision(next);
  }
  function focusRevision(key: string) {
    const rec = nodeRecs.get(key);
    if (!rec) return;
    ensureVisible({ x: rec.x - 12, y: rec.y - 12, w: 24, h: 24 });
    setNodeStop(rec.el);
    (rec.el as SVGElement).focus();
  }
  function moveFocus(fromKey: string, dir: "up" | "down" | "left" | "right") {
    if (!layout) return;
    if (fromKey.startsWith("revision:")) {
      moveRevisionFocus(fromKey.slice(9), dir);
      return;
    }
    let from = "";
    if (fromKey.startsWith("workspace:")) from = fromKey.slice(10);
    else if (fromKey.startsWith("cluster:"))
      from = clusterRecs.get(fromKey.slice(8))?.cluster.members[0] ?? "";
    if (!from) return;
    const next = neighborLabel(layout, from, dir);
    if (next) focusWorkspace(next);
  }
  function focusWorkspace(id: string) {
    const rec = labelRecs.get(id);
    const rev = layout?.clusterOf.get(id);
    const cluster = rev ? clusterRecs.get(rev) : undefined;
    const target = rec?.g ?? cluster?.g;
    if (!target) return;
    const r = rec?.rect ?? cluster?.cluster;
    if (r) ensureVisible(r);
    setTabStop(target);
    (target as SVGElement).focus();
  }
  canvas.addEventListener("focusin", (e) => {
    const t = (e.target as Element | null)?.closest?.("[data-key]");
    const k = t?.getAttribute("data-key") ?? "";
    if (t && /^(workspace|cluster):/.test(k)) setTabStop(t);
    else if (t && k.startsWith("revision:")) setNodeStop(t);
  });
  canvas.addEventListener(
    "keydown",
    (e) => {
      const ev = e as KeyboardEvent;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "Escape") {
        handlers.clearSelection();
        return;
      }
      const key = keyOf(ev.target);
      if (key !== null) {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          (ev.target as Element).dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return;
        }
        const dirs: Record<string, "up" | "down" | "left" | "right"> = {
          ArrowUp: "up",
          ArrowDown: "down",
          ArrowLeft: "left",
          ArrowRight: "right",
        };
        const dir = dirs[ev.key];
        if (dir) {
          ev.preventDefault();
          moveFocus(key, dir);
        }
        return;
      }
      if (ev.target !== canvas) return;
      const step = 48;
      let handled = true;
      if (ev.key === "ArrowLeft") setView({ ...view, x: view.x + step });
      else if (ev.key === "ArrowRight") setView({ ...view, x: view.x - step });
      else if (ev.key === "ArrowUp") setView({ ...view, y: view.y + step });
      else if (ev.key === "ArrowDown") setView({ ...view, y: view.y - step });
      else if (ev.key === "+" || ev.key === "=") zoomAt(1.2);
      else if (ev.key === "-" || ev.key === "_") zoomAt(1 / 1.2);
      else if (ev.key === "0") handlers.fit();
      else handled = false;
      if (handled) ev.preventDefault();
    },
    true,
  );
  function zoomAt(factor: number, cx?: number, cy?: number) {
    const { w, h } = size();
    const x = cx ?? w / 2;
    const y = cy ?? h / 2;
    const scale = clampScale(view.scale * factor);
    setView({
      x: x - ((x - view.x) * scale) / view.scale,
      y: y - ((y - view.y) * scale) / view.scale,
      scale,
    });
  }
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      // one notch is about 13 percent; line and page wheels are scaled to pixels, and a
      // runaway event cannot take more than about 25 percent
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const capped = Math.max(-240, Math.min(240, px));
      zoomAt(Math.exp(-capped * (e.ctrlKey ? 0.01 : 0.0012)), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (keyOf(e.target) !== null) return;
    drag = { x: e.clientX, y: e.clientY, moved: 0 };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.moved > 3) setView({ ...view, x: view.x + dx, y: view.y + dy });
  });
  const endDrag = () => {
    if (drag && drag.moved > 3) suppressClick = true;
    drag = undefined;
    // A drag that ends over the background must not also clear the selection.
    if (suppressClick) setTimeout(() => (suppressClick = false), 0);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  // Native tooltips for revisions are attached lazily: 2,000 <title> nodes cost more than they help.
  canvas.addEventListener(
    "mouseover",
    (e) => {
      const t = (e.target as Element | null)?.closest?.(".revision-node");
      if (!t || t.firstChild) return;
      const key = t.getAttribute("data-key")?.slice(9) ?? "";
      const n = nodesByKey.get(key);
      if (!n) return;
      const title = svg("title");
      title.textContent = `${n.commit_id}\n${displayText(n.description)}`;
      t.append(title);
    },
    true,
  );
  for (const side of ["left", "right", "top", "bottom"] as const)
    edgeHints[side].onclick = () => {
      const { w, h } = size();
      const dx = (w - GUTTER) * 0.8;
      const dy = h * 0.8;
      setView({
        ...view,
        x: view.x + (side === "left" ? dx : side === "right" ? -dx : 0),
        y: view.y + (side === "top" ? dy : side === "bottom" ? -dy : 0),
      });
    };
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (autoView) reapplyAuto();
      else updateAxis();
      updateFooter();
    }).observe(canvas);
  }

  return {
    root,
    svg: canvas,
    viewport,
    setGraph,
    setState,
    layout: () => layout,
    view: () => ({ ...view }),
    setView,
    fit,
    fitAll,
    fitRevisions,
    centerOnWorkspace,
    centerOnRevision,
    focusWorkspace,
    /** True until the user pans or zooms: the view is still the automatic Fit. */
    autoActive: () => !!autoView,
    inViewCount,
    /** Number of times the SVG content was rebuilt (diagnostic; the svg element itself never changes). */
    rebuilds: () => rebuilds,
    highlighted: () => highlight,
  };
}

export type GraphCanvas = ReturnType<typeof createGraphCanvas>;
