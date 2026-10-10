import type { GraphNode, Point } from "./model";

/*
 * Pure, deterministic layered layout for the workspace ancestry graph.
 *
 * Pipeline: index (present parents only) -> rank (Kahn, longest parent path) ->
 * components -> heavy-path chains -> lane packing with a drift ramp ->
 * barycentric refinement -> labels (stacks, counted clusters, collision-free
 * placement with leaders) -> axis ticks. Output never depends on input order:
 * every tie is broken by sorted key. Edges are exactly the present
 * (child, parent) pairs; nothing is ever invented across omitted history.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LayoutWorkspace {
  id: string;
  /** missing or unknown revision => the workspace is "unattached" */
  revision_key?: string;
  /** short display name (the view truncates to 24 chars) */
  name: string;
  /** one separate pill each, e.g. ["dirty"] or ["conflict"] */
  badges?: string[];
}
export interface LayoutOptions {
  /** default-branch tip revision key: its first-parent line becomes the trunk */
  trunkTip?: string;
  /** revision keys whose cluster is expanded */
  expanded?: ReadonlySet<string>;
  /** labels per revision that stack before collapsing into a counted cluster (default 3) */
  maxStack?: number;
  /** barycentric refinement sweeps, 0 disables (default 4) */
  refineSweeps?: number;
}
export interface LaidNode {
  key: string;
  x: number;
  y: number;
  rank: number;
  lane: number;
  chain: number;
  component: number;
  boundary: boolean;
  /** two or more present parents */
  merge: boolean;
  /** workspaces attached to this revision */
  anchors: number;
  /** the node's chain carries at least one workspace anchor */
  chainActive: boolean;
}
export interface LaidEdge {
  child: string;
  parent: string;
  /** "merge" for parent index >= 1 in the revision's own parent list */
  kind: "parent" | "merge";
  /** absolute world-coordinate cubic S-curve */
  d: string;
  chain: number;
}
export interface LaidBadge {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LaidLabel {
  id: string;
  /** "" for unattached workspaces */
  revision_key: string;
  /** top-left of the pill */
  x: number;
  y: number;
  w: number;
  h: number;
  side: "left" | "right";
  badges: LaidBadge[];
  leader?: { x1: number; y1: number; x2: number; y2: number };
}
export interface LaidCluster {
  revision_key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  members: string[];
  expanded: boolean;
  /** additive: present when the chip was displaced from its node */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}
export interface Tick {
  rank: number;
  y: number;
  label: string;
}
export interface GraphLayout {
  nodes: Map<string, LaidNode>;
  edges: LaidEdge[];
  /** workspaces drawn as individual pills (incl. unattached ones and expanded cluster members) */
  labels: Map<string, LaidLabel>;
  clusters: LaidCluster[];
  /** workspace id -> revision key of the COLLAPSED cluster hiding it */
  clusterOf: Map<string, string>;
  /** workspace ids with no resolvable revision; their pills are also in `labels` */
  unattached: string[];
  /** strip holding the unattached pills; its first 26 px are a caption row for the view */
  unattachedBox?: Rect;
  /** node keys with an absent parent */
  boundaries: string[];
  components: { x: number; w: number; nodes: number }[];
  ticks: Tick[];
  /** everything including labels, excluding the axis */
  bounds: Rect;
  rowH: number;
  maxRank: number;
}

const LANE_W = 44;
const NODE_HALF = 7;
const PILL_H = 24;
const PITCH = 28;
const BADGE_H = 22;
const BADGE_GAP = 4;
const LABEL_GAP = 14;
/** Outward lanes a chain tip's label reserves beside its node. */
const TIP_LABEL_LANES = 1;
const COMPONENT_GAP = 120;
const STRIP_CAPTION = 26;
const LANE_SEARCH = 64;
const MAX_CANDIDATES = 200;
const CELL = 64;
const MARGIN = 2;
const RAMP = 3;
const GUARD_EDGES = 1500;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fmt = (n: number) => String(Number(n.toFixed(2)));

/** Text starts 10 px in and ~6.7 px per character; the 9 px state dot sits at the right edge. */
const PILL_CHROME = 36;
function pillWidth(name: string): number {
  return Math.round(Math.min(200, Math.max(60, PILL_CHROME + 6.7 * [...name].length)));
}
function badgeWidth(text: string): number {
  return Math.round(14 + 6 * [...text].length);
}
/** Pill width; with badges, the full width including the separate badge pills. */
export function estimateLabelWidth(name: string, badges?: string[]): number {
  let w = pillWidth(name);
  for (const b of badges ?? []) w += BADGE_GAP + badgeWidth(b);
  return w;
}

function edgePath(cx: number, cy: number, px: number, py: number): string {
  const h = Math.min(120, Math.max(10, 0.55 * Math.abs(py - cy)));
  return `M ${fmt(cx)} ${fmt(cy)} C ${fmt(cx)} ${fmt(cy + h)} ${fmt(px)} ${fmt(py - h)} ${fmt(px)} ${fmt(py)}`;
}

/* ---------------------------------------------------------------- crossings */

interface EdgeGeom {
  cx: number;
  cy: number;
  px: number;
  py: number;
  a: number;
  b: number;
}
const SAMPLES = 7;

function curvePoint(g: EdgeGeom, t: number): [number, number] {
  const dy = g.py - g.cy;
  const h = Math.min(120, Math.max(10, 0.55 * Math.abs(dy)));
  const u = 1 - t;
  const s = t * t * (3 - 2 * t);
  const x = g.cx + (g.px - g.cx) * s;
  const y =
    g.cy * u * u * u +
    3 * (g.cy + h) * u * u * t +
    3 * (g.py - h) * u * t * t +
    g.py * t * t * t;
  return [x, y];
}

interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  y0: number;
  y9: number;
  e: number;
}
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function properCross(p: Seg, q: Seg): boolean {
  const o1 = orient(p.x1, p.y1, p.x2, p.y2, q.x1, q.y1);
  const o2 = orient(p.x1, p.y1, p.x2, p.y2, q.x2, q.y2);
  const o3 = orient(q.x1, q.y1, q.x2, q.y2, p.x1, p.y1);
  const o4 = orient(q.x1, q.y1, q.x2, q.y2, p.x2, p.y2);
  return o1 * o2 < 0 && o3 * o4 < 0;
}
/** Number of edge pairs whose S-curves cross; edges sharing a node never count. */
function crossingPairs(edges: EdgeGeom[]): number {
  const segs: Seg[] = [];
  edges.forEach((g, e) => {
    let [px, py] = curvePoint(g, 0);
    for (let i = 1; i <= SAMPLES; i++) {
      const [x, y] = curvePoint(g, i / SAMPLES);
      segs.push({
        x1: px,
        y1: py,
        x2: x,
        y2: y,
        y0: Math.min(py, y),
        y9: Math.max(py, y),
        e,
      });
      px = x;
      py = y;
    }
  });
  segs.sort((p, q) => p.y0 - q.y0 || p.e - q.e);
  let active: Seg[] = [];
  const counted = new Set<number>();
  for (const s of segs) {
    if (active.length > 64) active = active.filter((a) => a.y9 >= s.y0);
    for (const a of active) {
      if (a.y9 < s.y0 || a.e === s.e) continue;
      const lo = Math.min(a.e, s.e);
      const hi = Math.max(a.e, s.e);
      const pair = lo * edges.length + hi;
      if (counted.has(pair)) continue;
      const ea = edges[a.e];
      const eb = edges[s.e];
      if (ea.a === eb.a || ea.a === eb.b || ea.b === eb.a || ea.b === eb.b)
        continue;
      if (properCross(a, s)) counted.add(pair);
    }
    active.push(s);
  }
  return counted.size;
}

/** Diagnostic: number of crossing edge pairs in a finished layout. */
export function countCrossings(layout: GraphLayout): number {
  const ids = new Map<string, number>();
  for (const k of layout.nodes.keys()) ids.set(k, ids.size);
  const geoms: EdgeGeom[] = [];
  for (const e of layout.edges) {
    const c = layout.nodes.get(e.child);
    const p = layout.nodes.get(e.parent);
    if (!c || !p) continue;
    geoms.push({
      cx: c.x,
      cy: c.y,
      px: p.x,
      py: p.y,
      a: ids.get(e.child)!,
      b: ids.get(e.parent)!,
    });
  }
  return crossingPairs(geoms);
}

/* ------------------------------------------------------------------- lanes */

interface Res {
  lane: number;
  lo: number;
  hi: number;
}
class LaneTable {
  private lanes = new Map<number, Res[]>();
  free(lane: number, lo: number, hi: number): boolean {
    const a = this.lanes.get(lane);
    if (!a) return true;
    for (let i = 0; i < a.length; i++)
      if (a[i].lo <= hi && lo <= a[i].hi) return false;
    return true;
  }
  add(r: Res) {
    let a = this.lanes.get(r.lane);
    if (!a) this.lanes.set(r.lane, (a = []));
    a.push(r);
  }
  remove(r: Res) {
    const a = this.lanes.get(r.lane);
    const i = a ? a.indexOf(r) : -1;
    if (a && i >= 0) a.splice(i, 1);
  }
}

interface Need {
  rank: number;
  /** outward lanes the label needs beside the node */
  lw: number;
  /** half-height in ranks */
  hs: number;
}
interface Chain {
  /** index in the global chain list */
  id: number;
  nodes: number[];
  comp: number;
  parent: number;
  fork: number;
  depth: number;
  lane: number;
  k: number;
  kids: number[];
  needs: Need[];
  gid: number;
}

interface WsInfo {
  id: string;
  name: string;
  w: number;
  badges: { text: string; w: number }[];
  total: number;
}

/* ------------------------------------------------------------ label hashing */

class Hash {
  private cells = new Map<number, Rect[]>();
  private key(cx: number, cy: number) {
    return cx * 1048576 + cy;
  }
  add(r: Rect) {
    const x0 = Math.floor(r.x / CELL);
    const x1 = Math.floor((r.x + r.w) / CELL);
    const y0 = Math.floor(r.y / CELL);
    const y1 = Math.floor((r.y + r.h) / CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const a = this.cells.get(k);
        if (a) a.push(r);
        else this.cells.set(k, [r]);
      }
  }
  hit(r: Rect, ignore?: Rect): boolean {
    const x0 = Math.floor((r.x - MARGIN) / CELL);
    const x1 = Math.floor((r.x + r.w + MARGIN) / CELL);
    const y0 = Math.floor((r.y - MARGIN) / CELL);
    const y1 = Math.floor((r.y + r.h + MARGIN) / CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const a = this.cells.get(this.key(cx, cy));
        if (!a) continue;
        for (const s of a) {
          if (s === ignore) continue;
          if (
            r.x < s.x + s.w + MARGIN &&
            s.x < r.x + r.w + MARGIN &&
            r.y < s.y + s.h + MARGIN &&
            s.y < r.y + r.h + MARGIN
          )
            return true;
        }
      }
    return false;
  }
}

/** [relative side (1 preferred, -1 other), extra outward dx, dy] in trial order. */
const CANDIDATES: [number, number, number][] = (() => {
  const out: [number, number, number][] = [[1, 0, 0], [-1, 0, 0]];
  for (let k = 1; k <= 6; k++)
    for (const s of [1, -1]) out.push([s, 0, k * 14], [s, 0, -k * 14]);
  for (let r = 1; out.length < MAX_CANDIDATES; r++)
    for (let kk = 0; kk <= 3; kk++)
      for (const s of [1, -1])
        for (const dy of kk === 0 ? [0] : [kk * 14, -kk * 14])
          if (out.length < MAX_CANDIDATES) out.push([s, r * 24, dy]);
  return out;
})();

/** Stacks exhaust every same-side position before flipping so a stack never splits across the node. */
const STACK_CANDIDATES: [number, number, number][] = [
  ...CANDIDATES.filter((c) => c[0] === 1),
  ...CANDIDATES.filter((c) => c[0] === -1),
];

function union(a: Rect | undefined, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* -------------------------------------------------------------- the layout */

export function layoutWorkspaceGraph(
  inputNodes: GraphNode[],
  inputWorkspaces: LayoutWorkspace[],
  options: LayoutOptions = {},
): GraphLayout {
  const maxStack = Math.max(1, Math.floor(options.maxStack ?? 3));
  const sweeps = Math.max(0, Math.floor(options.refineSweeps ?? 4));
  const expanded = options.expanded;

  /* 1. index: sorted keys, present parents only */
  const sortedIn = [...inputNodes].sort((a, b) => cmp(a.key, b.key));
  const nodes: GraphNode[] = [];
  const keyIndex = new Map<string, number>();
  for (const nd of sortedIn)
    if (!keyIndex.has(nd.key)) {
      keyIndex.set(nd.key, nodes.length);
      nodes.push(nd);
    }
  const N = nodes.length;
  const par: number[][] = [];
  const parOrd: number[][] = [];
  const kids: number[][] = Array.from({ length: N }, () => []);
  const boundary: boolean[] = [];
  for (let i = 0; i < N; i++) {
    const ps: number[] = [];
    const ord: number[] = [];
    let gap = false;
    nodes[i].parents.forEach((p, j) => {
      if (p === nodes[i].key) return;
      const pi = keyIndex.get(p);
      if (pi === undefined) gap = true;
      else if (!ps.includes(pi)) {
        ps.push(pi);
        ord.push(j);
      }
    });
    par.push(ps);
    parOrd.push(ord);
    boundary.push(gap);
    for (const p of ps) kids[p].push(i);
  }

  /* 2. rank: 1 + max(rank of present parents); roots are 0 (iterative Kahn) */
  const rank = new Int32Array(N);
  const indeg = Int32Array.from(par, (p) => p.length);
  const seen = new Uint8Array(N);
  const queue: number[] = [];
  for (let i = 0; i < N; i++)
    if (indeg[i] === 0) {
      seen[i] = 1;
      queue.push(i);
    }
  let qi = 0;
  const drain = () => {
    while (qi < queue.length) {
      const u = queue[qi++];
      for (const c of kids[u]) {
        if (rank[c] < rank[u] + 1) rank[c] = rank[u] + 1;
        if (--indeg[c] === 0 && !seen[c]) {
          seen[c] = 1;
          queue.push(c);
        }
      }
    }
  };
  drain();
  for (let u = 0; u < N; u++)
    if (!seen[u]) {
      // only reachable for cyclic (invalid) input: release deterministically
      seen[u] = 1;
      indeg[u] = 0;
      queue.push(u);
      drain();
    }
  let maxRank = 0;
  for (let i = 0; i < N; i++) if (rank[i] > maxRank) maxRank = rank[i];
  const rowH = Math.min(34, Math.max(14, 1360 / Math.max(1, maxRank)));
  const Y = new Float64Array(N);
  for (let i = 0; i < N; i++) Y[i] = (maxRank - rank[i]) * rowH;

  /* 3. components (union-find), trunk component first, then by size */
  const uf = Int32Array.from({ length: N }, (_, i) => i);
  const find = (x: number) => {
    while (uf[x] !== x) {
      uf[x] = uf[uf[x]];
      x = uf[x];
    }
    return x;
  };
  for (let i = 0; i < N; i++)
    for (const p of par[i]) {
      const a = find(i);
      const b = find(p);
      if (a !== b) uf[Math.max(a, b)] = Math.min(a, b);
    }
  const trunkIdx = options.trunkTip ? keyIndex.get(options.trunkTip) : undefined;
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    const a = byRoot.get(r);
    if (a) a.push(i);
    else byRoot.set(r, [i]);
  }
  const trunkRoot = trunkIdx === undefined ? -1 : find(trunkIdx);
  const compMembers = [...byRoot.entries()]
    .sort(
      (a, b) =>
        (b[0] === trunkRoot ? 1 : 0) - (a[0] === trunkRoot ? 1 : 0) ||
        b[1].length - a[1].length ||
        a[1][0] - b[1][0],
    )
    .map(([, m]) => m);
  const compOf = new Int32Array(N);
  compMembers.forEach((m, c) => m.forEach((i) => (compOf[i] = c)));

  /* 4. chains: heavy paths in the primary (first present parent) forest */
  // a primary parent must rank below its child; only cyclic (invalid) input breaks that
  const pp = Int32Array.from(par, (p, i) => (p.length && rank[p[0]] < rank[i] ? p[0] : -1));
  const onTrunk = new Uint8Array(N);
  if (trunkIdx !== undefined)
    for (let i = trunkIdx; i >= 0; i = pp[i]) onTrunk[i] = 1;
  const order = Array.from({ length: N }, (_, i) => i).sort(
    (a, b) => rank[b] - rank[a] || a - b,
  );
  const size = new Int32Array(N).fill(1);
  for (const i of order) if (pp[i] >= 0) size[pp[i]] += size[i];
  const heavy = new Int32Array(N).fill(-1);
  for (let c = 0; c < N; c++) {
    const p = pp[c];
    if (p < 0) continue;
    const cur = heavy[p];
    if (
      cur < 0 ||
      onTrunk[c] > onTrunk[cur] ||
      (onTrunk[c] === onTrunk[cur] && size[c] > size[cur])
    )
      heavy[p] = c;
  }
  // the trunk is the default branch's own line: commits beyond its tip start new chains
  if (trunkIdx !== undefined) heavy[trunkIdx] = -1;
  const chainOf = new Int32Array(N).fill(-1);
  const posIn = new Int32Array(N);
  const chains: Chain[] = [];
  for (let i = 0; i < N; i++) {
    if (pp[i] >= 0 && heavy[pp[i]] === i) continue;
    const c: Chain = {
      id: chains.length,
      nodes: [],
      comp: compOf[i],
      parent: -1,
      fork: pp[i],
      depth: 0,
      lane: 0,
      k: 0,
      kids: [],
      needs: [],
      gid: 0,
    };
    for (let u = i; u >= 0; u = heavy[u]) {
      chainOf[u] = c.id;
      posIn[u] = c.nodes.length;
      c.nodes.push(u);
    }
    chains.push(c);
  }
  const chainsOfComp: Chain[][] = compMembers.map(() => []);
  for (const c of chains) chainsOfComp[c.comp].push(c);
  for (const c of chains) if (c.fork >= 0) c.parent = chainOf[c.fork];
  // extra roots of a component hang off its main root chain
  const trunkChain: Chain[] = [];
  compMembers.forEach((_, ci) => {
    const roots = chainsOfComp[ci].filter((c) => c.parent < 0);
    roots.sort(
      (a, b) =>
        onTrunk[b.nodes[0]] - onTrunk[a.nodes[0]] ||
        size[b.nodes[0]] - size[a.nodes[0]] ||
        a.nodes[0] - b.nodes[0],
    );
    trunkChain[ci] = roots[0];
    for (let r = 1; r < roots.length; r++) roots[r].parent = roots[0].id;
  });
  const byHeadRank = [...chains].sort(
    (a, b) =>
      rank[a.nodes[0]] - rank[b.nodes[0]] ||
      (trunkChain[b.comp] === b ? 1 : 0) - (trunkChain[a.comp] === a ? 1 : 0) ||
      a.nodes[0] - b.nodes[0],
  );
  for (const c of byHeadRank) {
    if (c.parent < 0) c.depth = 0;
    else {
      c.depth = chains[c.parent].depth + 1;
      chains[c.parent].kids.push(c.id);
    }
  }

  /* 5. workspace attachment and label groups */
  const wsSorted = [...inputWorkspaces].sort((a, b) => cmp(a.id, b.id));
  const info = (w: LayoutWorkspace): WsInfo => {
    const badges = (w.badges ?? [])
      .filter((b) => b.length > 0)
      .map((text) => ({ text, w: badgeWidth(text) }));
    const pw = pillWidth(w.name);
    return {
      id: w.id,
      name: w.name,
      w: pw,
      badges,
      total: pw + badges.reduce((s, b) => s + BADGE_GAP + b.w, 0),
    };
  };
  const groups = new Map<number, WsInfo[]>();
  const unattachedInfo: WsInfo[] = [];
  const seenIds = new Set<string>();
  for (const w of wsSorted) {
    if (seenIds.has(w.id)) continue;
    seenIds.add(w.id);
    const at =
      w.revision_key === undefined ? undefined : keyIndex.get(w.revision_key);
    if (at === undefined) unattachedInfo.push(info(w));
    else {
      const g = groups.get(at);
      if (g) g.push(info(w));
      else groups.set(at, [info(w)]);
    }
  }
  for (const g of groups.values())
    g.sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
  // exactly what the view draws, including the expand arrow
  const chipText = (n: number) => `${n} workspaces ▸`;
  for (const [n, g] of groups) {
    const c = chains[chainOf[n]];
    // only a chain's tip reserves label room; interior anchors rely on placement
    if (c.nodes[c.nodes.length - 1] !== n) continue;
    const clustered = g.length > maxStack;
    const rows = clustered ? 1 : g.length;
    c.needs.push({
      rank: rank[n],
      // Only the adjacent outward lane is held back. Reserving the label's whole width
      // made lane spacing sum to about twice the label width on branchy graphs; a wider
      // label spills into free space (collision placement) or takes a leader stub.
      lw: TIP_LABEL_LANES,
      hs: Math.max(1, Math.ceil((rows * PITCH) / 2 / rowH)),
    });
  }

  /* 6. lanes: nested (planar) assignment over the chain tree. Within a parent,
     a later (higher) fork sits nearer than an earlier one whose subtree is
     still alive, so no fork edge ever crosses a sibling's lane. */
  /** fraction of the way from the parent lane to the own lane at ramp node i */
  const rampFrac = (k: number, i: number, dist: number) => {
    const t = (i + 1) / (k + 1);
    // first step is ~0.45 lane so a ramp node never sits on its parent lane's node
    const s0 = Math.min(0.5, 0.45 / Math.max(1, dist));
    return s0 + (1 - s0) * (t * t * (3 - 2 * t));
  };
  const parentLane = (c: Chain) => (c.parent >= 0 ? chains[c.parent].lane : c.lane);
  const nodeX = (n: number): number => {
    const c = chains[chainOf[n]];
    const p = posIn[n];
    if (c.fork < 0 || p >= c.k) return c.lane * LANE_W;
    const from = parentLane(c);
    return (
      (from + (c.lane - from) * rampFrac(c.k, p, Math.abs(c.lane - from))) * LANE_W
    );
  };
  const outward = (lane: number) => (lane < 0 ? -1 : 1);

  interface Item {
    lo: number;
    hi: number;
    o: number;
    need: number;
  }
  const span = new Int32Array(chains.length); // highest rank in the chain's subtree
  const offOf = new Int32Array(chains.length);
  const needOf = new Int32Array(chains.length);
  const sideOf = new Int8Array(chains.length);
  const required = (lo: number, hi: number, list: Item[]): number => {
    let o = 1;
    for (const k of list) {
      if (lo > k.hi || k.lo > hi) continue;
      if (o < k.o + k.need + 1) o = k.o + k.need + 1;
    }
    return o;
  };
  /** longest ramp (<= 8 nodes) whose nodes stay clear of every inner footprint */
  const pickRamp = (j: Chain, o: number, list: Item[]): number => {
    if (j.fork < 0) return 0;
    const most = Math.min(j.nodes.length - 1, Math.min(8, Math.max(RAMP, Math.ceil(o * 0.75))));
    for (let k = most; k > 0; k--) {
      let ok = true;
      for (let i = 0; i < k && ok; i++) {
        const r = rank[j.nodes[i]];
        for (const it of list)
          if (
            r >= it.lo &&
            r <= it.hi &&
            o * rampFrac(k, i, o) < it.o + it.need + 0.7
          ) {
            ok = false;
            break;
          }
      }
      if (ok) return k;
    }
    return 0;
  };
  for (let ci = chains.length - 1; ci >= 0; ci--) {
    const p = byHeadRank[ci];
    span[p.id] = rank[p.nodes[p.nodes.length - 1]];
    for (const k of p.kids) span[p.id] = Math.max(span[p.id], span[k]);
    const isTrunk = p.depth === 0;
    const lists: Item[][] = isTrunk ? [[], []] : [[]];
    const tip = p.needs[0];
    if (tip)
      lists[0].push({
        lo: tip.rank - tip.hs,
        hi: tip.rank + tip.hs,
        o: 1,
        need: tip.lw - 1,
      });
    const order = p.kids
      .map((id) => {
        const c = chains[id];
        return { c, lo: c.fork >= 0 ? rank[c.fork] : 0, hi: span[id] };
      })
      .sort(
        (a, b) =>
          b.lo - a.lo || a.hi - b.hi || a.c.nodes[0] - b.c.nodes[0],
      );
    const weight = [0, 0];
    let flip = 0;
    for (const { c, lo, hi } of order) {
      const req = lists.map((l) => required(lo, hi, l));
      let li = 0;
      if (isTrunk) {
        if (req[0] !== req[1]) li = req[0] < req[1] ? 0 : 1;
        else if (weight[0] !== weight[1]) li = weight[0] < weight[1] ? 0 : 1;
        else li = flip++ % 2;
      }
      c.k = pickRamp(c, req[li], lists[li]);
      lists[li].push({ lo, hi, o: req[li], need: needOf[c.id] });
      offOf[c.id] = req[li];
      sideOf[c.id] = li === 0 ? 1 : -1;
      weight[li] += size[c.nodes[0]];
    }
    let need = 0;
    for (const l of lists) for (const it of l) need = Math.max(need, it.o + it.need);
    needOf[p.id] = need;
  }
  for (const c of byHeadRank) {
    if (c.depth === 0) c.lane = 0;
    else {
      const p = chains[c.parent];
      const dir = p.depth === 0 ? sideOf[c.id] : outward(p.lane);
      c.lane = p.lane + dir * offOf[c.id];
    }
  }

  /* barycentric refinement of chains tied by merge edges, never worsening crossings */
  const rampLanes = (c: Chain, lane: number, from: number): Res[] => {
    const out: Res[] = [];
    if (c.fork < 0) return out;
    for (let i = 0; i < c.k; i++)
      out.push({
        lane: Math.round(
          from + (lane - from) * rampFrac(c.k, i, Math.abs(lane - from)),
        ),
        lo: rank[c.nodes[i]],
        hi: rank[c.nodes[i]],
      });
    return out;
  };
  let table = new LaneTable(); // occupancy of the component being refined
  const own = new Map<number, Res[]>();
  const ramps = new Map<number, Res[]>();
  const ownRes = (c: Chain, lane: number): Res[] => {
    const head = rank[c.nodes[0]];
    const tip = rank[c.nodes[c.nodes.length - 1]];
    // one empty rank of padding between chains stacked in one lane
    const out: Res[] = [{ lane, lo: head - 1, hi: tip + 1 }];
    const s = outward(lane);
    for (const nd of c.needs)
      for (let k = 1; k <= nd.lw; k++)
        out.push({ lane: lane + s * k, lo: nd.rank - nd.hs, hi: nd.rank + nd.hs });
    return out;
  };
  const register = (c: Chain) => {
    const o = ownRes(c, c.lane);
    const r = rampLanes(c, c.lane, parentLane(c));
    own.set(c.id, o);
    ramps.set(c.id, r);
    for (const x of o) table.add(x);
    for (const x of r) table.add(x);
  };
  const unregister = (c: Chain) => {
    for (const x of own.get(c.id) ?? []) table.remove(x);
    for (const x of ramps.get(c.id) ?? []) table.remove(x);
  };
  const resFree = (list: Res[]) => list.every((r) => table.free(r.lane, r.lo, r.hi));
  const mergeLinked = new Set<number>();
  const crossOf = new Map<number, [number, number][]>();
  for (let n = 0; n < N; n++)
    for (let j = 1; j < par[n].length; j++) {
      const q = par[n][j];
      if (chainOf[n] !== chainOf[q]) {
        mergeLinked.add(chainOf[n]);
        mergeLinked.add(chainOf[q]);
      }
    }
  const cross = (c: Chain) => {
    let list = crossOf.get(c.id);
    if (!list) {
      list = [];
      c.nodes.forEach((n, pos) => {
        for (const p of par[n]) if (chainOf[p] !== c.id) list!.push([pos, p]);
        for (const k of kids[n]) if (chainOf[k] !== c.id) list!.push([pos, k]);
      });
      crossOf.set(c.id, list);
    }
    return list;
  };

  const refine = (ordered: Chain[]) => {
    const tryMove = (c: Chain): boolean => {
      const cr = cross(c);
      if (!cr.length) return false;
      const cur = c.lane;
      let sum = 0;
      for (const [, other] of cr) sum += nodeX(other);
      const target = Math.round(sum / cr.length / LANE_W);
      const sgn = Math.sign(cur);
      if (target === cur || sgn === 0) return false;
      const cost = () => {
        let s = 0;
        for (const [pos, other] of cr)
          s += Math.abs(nodeX(c.nodes[pos]) - nodeX(other));
        return s;
      };
      const base = cost();
      unregister(c);
      for (const k of c.kids) for (const x of ramps.get(k) ?? []) table.remove(x);
      let best: number | undefined;
      for (let d = 0; d <= LANE_SEARCH && best === undefined; d++) {
        const cands = d === 0 ? [target] : [target - d, target + d];
        cands.sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
        for (const l of cands) {
          if (l === 0 || l === cur || Math.sign(l) !== sgn) continue;
          if (
            resFree(ownRes(c, l)) &&
            resFree(rampLanes(c, l, parentLane(c))) &&
            c.kids.every((k) => resFree(rampLanes(chains[k], chains[k].lane, l)))
          ) {
            best = l;
            break;
          }
        }
      }
      let moved = false;
      if (best !== undefined) {
        c.lane = best;
        if (cost() < base - 1e-9) moved = true;
        else c.lane = cur;
      }
      register(c);
      for (const k of c.kids) {
        const r = rampLanes(chains[k], chains[k].lane, c.lane);
        ramps.set(k, r);
        for (const x of r) table.add(x);
      }
      return moved;
    };
    for (let s = 0; s < sweeps; s++) {
      let moved = false;
      const seq = s % 2 === 0 ? ordered : [...ordered].reverse();
      for (const c of seq)
        if (c.depth > 0 && mergeLinked.has(c.id) && tryMove(c)) moved = true;
      if (!moved) break;
    }
  };

  const compEdgeGeoms = (members: number[]): EdgeGeom[] => {
    const out: EdgeGeom[] = [];
    for (const i of members)
      for (const p of par[i])
        out.push({ cx: nodeX(i), cy: Y[i], px: nodeX(p), py: Y[p], a: i, b: p });
    return out;
  };

  const placementOrder: Chain[][] = compMembers.map(() => []);
  for (const c of byHeadRank) placementOrder[c.comp].push(c);
  if (sweeps > 0)
    compMembers.forEach((members, ci) => {
      const ordered = placementOrder[ci];
      if (!ordered.some((c) => mergeLinked.has(c.id))) return;
      // refinement is only kept when a crossing count proves it no worse; above
      // GUARD_EDGES that check is too costly, so large components keep the planar base layout
      const edgeCount = members.reduce((s, i) => s + par[i].length, 0);
      if (edgeCount > GUARD_EDGES) return;
      table = new LaneTable();
      own.clear();
      ramps.clear();
      for (const c of ordered) register(c);
      const snapshot = ordered.map((c) => c.lane);
      refine(ordered);
      const refined = ordered.map((c) => c.lane);
      const after = crossingPairs(compEdgeGeoms(members));
      ordered.forEach((c, i) => (c.lane = snapshot[i]));
      const before = crossingPairs(compEdgeGeoms(members));
      ordered.forEach((c, i) => (c.lane = after > before ? snapshot[i] : refined[i]));
    });

  const X = new Float64Array(N);
  for (let i = 0; i < N; i++) X[i] = nodeX(i);
  let gid = 0;
  for (const list of placementOrder) for (const c of list) c.gid = gid++;
  const chainActive = chains.map((c) => c.nodes.some((n) => groups.has(n)));

  /* 7. labels per component, in a component-local frame */
  interface CompOut {
    labels: LaidLabel[];
    clusters: LaidCluster[];
    clusterOf: [string, string][];
    bbox: Rect;
  }
  const placeLabels = (members: number[]): CompOut => {
    const hash = new Hash();
    const nodeRect = new Map<number, Rect>();
    let bbox: Rect | undefined;
    for (const i of members) {
      const r = {
        x: X[i] - NODE_HALF,
        y: Y[i] - NODE_HALF,
        w: 2 * NODE_HALF,
        h: 2 * NODE_HALF,
      };
      nodeRect.set(i, r);
      hash.add(r);
      bbox = union(bbox, r);
    }
    const out: CompOut = { labels: [], clusters: [], clusterOf: [], bbox: bbox! };
    const anchored = members
      .filter((i) => groups.has(i))
      .sort((a, b) => Y[a] - Y[b] || X[a] - X[b] || a - b);
    for (const n of anchored) {
      const g = groups.get(n)!;
      const key = nodes[n].key;
      const nx = X[n];
      const ny = Y[n];
      const lane = chains[chainOf[n]].lane;
      const pref = lane < 0 ? -1 : 1;
      const own = nodeRect.get(n)!;
      type Slot = { id?: string; w: number; badges: { text: string; w: number }[] };
      const slots: Slot[] = [];
      const clustered = g.length > maxStack;
      const open = clustered && expanded?.has(key) === true;
      if (clustered) slots.push({ w: pillWidth(chipText(g.length)), badges: [] });
      if (!clustered || open)
        for (const x of g) slots.push({ id: x.id, w: x.w, badges: x.badges });
      if (clustered && !open) out.clusterOf.push(...g.map((x): [string, string] => [x.id, key]));
      const stackH = slots.length * PITCH - (PITCH - PILL_H);
      const members2 = g.map((x) => x.id).sort(cmp);
      const build = (slot: Slot, side: number, x0: number, y0: number) => {
        const badges: LaidBadge[] = [];
        let cursor = side > 0 ? x0 + slot.w : x0;
        for (const b of slot.badges) {
          const bx = side > 0 ? cursor + BADGE_GAP : cursor - BADGE_GAP - b.w;
          badges.push({
            text: b.text,
            x: bx,
            y: y0 + (PILL_H - BADGE_H) / 2,
            w: b.w,
            h: BADGE_H,
          });
          cursor = side > 0 ? bx + b.w : bx;
        }
        const left = side > 0 ? x0 : Math.min(x0, cursor);
        const right = side > 0 ? Math.max(x0 + slot.w, cursor) : x0 + slot.w;
        const box: Rect = { x: left, y: y0, w: right - left, h: PILL_H };
        return { x0, y0, side, badges, box };
      };
      const slotTop = (j: number) => ny - stackH / 2 + j * PITCH;
      const idealX = (slot: Slot, side: number) =>
        side > 0 ? nx + LABEL_GAP : nx - LABEL_GAP - slot.w;
      // keep a stack on one side of its node: the side where most slots fit unmoved
      const fitting = (side: number) =>
        slots.filter((slot, j) => !hash.hit(build(slot, side, idealX(slot, side), slotTop(j)).box, own)).length;
      const stackSide = fitting(pref) >= fitting(-pref) ? pref : -pref;
      slots.forEach((slot, j) => {
        const top = slotTop(j);
        let chosen: ReturnType<typeof build> | undefined;
        let displaced = false;
        for (const [rel, dx, dy] of slots.length > 1 ? STACK_CANDIDATES : CANDIDATES) {
          const side = stackSide * rel;
          const x0 = side > 0 ? nx + LABEL_GAP + dx : nx - LABEL_GAP - dx - slot.w;
          const trial = build(slot, side, x0, top + dy);
          if (!hash.hit(trial.box, own)) {
            chosen = trial;
            displaced = dx !== 0 || dy !== 0;
            break;
          }
        }
        if (!chosen) {
          // dense neighbourhood: a free column right of everything placed so far
          const x0 = out.bbox.x + out.bbox.w + 40;
          for (let i = 0; ; i++) {
            const trial = build(slot, 1, x0, out.bbox.y + i * PITCH);
            if (!hash.hit(trial.box, own)) {
              chosen = trial;
              displaced = true;
              break;
            }
          }
        }
        const c = chosen;
        const pill: Rect = { x: c.x0, y: c.y0, w: slot.w, h: PILL_H };
        hash.add(pill);
        for (const b of c.badges) hash.add(b);
        out.bbox = union(out.bbox, c.box);
        const leader = displaced
          ? {
              x1: nx,
              y1: ny,
              x2: c.side > 0 ? pill.x : pill.x + pill.w,
              y2: pill.y + PILL_H / 2,
            }
          : undefined;
        const side = c.side > 0 ? "right" : "left";
        if (slot.id === undefined) {
          out.clusters.push({
            revision_key: key,
            ...pill,
            count: g.length,
            members: members2,
            expanded: open,
            ...(leader ? { leader } : {}),
          });
        } else {
          out.labels.push({
            id: slot.id,
            revision_key: key,
            ...pill,
            side,
            badges: c.badges,
            ...(leader ? { leader } : {}),
          });
        }
      });
    }
    return out;
  };

  const compOut = compMembers.map((m) => placeLabels(m));

  /* 8. assemble: components side by side, bottom aligned */
  const labels: LaidLabel[] = [];
  const clusters: LaidCluster[] = [];
  const clusterOf = new Map<string, string>();
  const dxOf: number[] = [];
  const components: { x: number; w: number; nodes: number }[] = [];
  let cursor = 0;
  let bounds: Rect | undefined;
  compOut.forEach((co, ci) => {
    const dx = ci === 0 ? 0 : cursor + COMPONENT_GAP - co.bbox.x;
    dxOf[ci] = dx;
    cursor = dx + co.bbox.x + co.bbox.w;
    components.push({
      x: dx + co.bbox.x,
      w: co.bbox.w,
      nodes: compMembers[ci].length,
    });
    bounds = union(bounds, { ...co.bbox, x: co.bbox.x + dx });
    for (const l of co.labels) {
      l.x += dx;
      l.badges.forEach((b) => (b.x += dx));
      if (l.leader) {
        l.leader.x1 += dx;
        l.leader.x2 += dx;
      }
      labels.push(l);
    }
    for (const c of co.clusters) {
      c.x += dx;
      if (c.leader) {
        c.leader.x1 += dx;
        c.leader.x2 += dx;
      }
      clusters.push(c);
    }
    for (const [id, key] of co.clusterOf) clusterOf.set(id, key);
  });

  // workspaces with no resolvable revision: a labelled strip below the roots
  const unattached = unattachedInfo.map((x) => x.id);
  let unattachedBox: Rect | undefined;
  if (unattachedInfo.length) {
    const left = bounds ? bounds.x : 0;
    // below the roots, and below every label already placed (an expanded cluster or a
    // displaced stack can reach past the root row)
    const floor = bounds ? bounds.y + bounds.h + 24 : 0;
    const top = N ? Math.max(maxRank * rowH + NODE_HALF + 56, floor) : 0;
    const limit = Math.max(480, bounds ? bounds.w : 0);
    let x = left;
    let row = 0;
    let used = 0;
    for (const u of unattachedInfo) {
      if (x > left && x + u.total - left > limit) {
        x = left;
        row++;
      }
      const y = top + STRIP_CAPTION + row * PITCH;
      const badges: LaidBadge[] = [];
      let bx = x + u.w;
      for (const b of u.badges) {
        badges.push({
          text: b.text,
          x: bx + BADGE_GAP,
          y: y + (PILL_H - BADGE_H) / 2,
          w: b.w,
          h: BADGE_H,
        });
        bx += BADGE_GAP + b.w;
      }
      labels.push({
        id: u.id,
        revision_key: "",
        x,
        y,
        w: u.w,
        h: PILL_H,
        side: "right",
        badges,
      });
      used = Math.max(used, bx - left);
      x = bx + 10;
    }
    unattachedBox = {
      x: left,
      y: top,
      w: Math.max(used, 180),
      h: STRIP_CAPTION + (row + 1) * PITCH - (PITCH - PILL_H) + 4,
    };
    bounds = union(bounds, unattachedBox);
  }

  const laidNodes = new Map<string, LaidNode>();
  for (let i = 0; i < N; i++) {
    const c = chains[chainOf[i]];
    laidNodes.set(nodes[i].key, {
      key: nodes[i].key,
      x: X[i] + dxOf[compOf[i]],
      y: Y[i],
      rank: rank[i],
      lane: c.lane,
      chain: c.gid,
      component: compOf[i],
      boundary: boundary[i],
      merge: par[i].length >= 2,
      anchors: groups.get(i)?.length ?? 0,
      chainActive: chainActive[c.id],
    });
  }
  const edges: LaidEdge[] = [];
  for (let i = 0; i < N; i++) {
    const c = laidNodes.get(nodes[i].key)!;
    par[i].forEach((p, j) => {
      const q = laidNodes.get(nodes[p].key)!;
      edges.push({
        child: nodes[i].key,
        parent: nodes[p].key,
        kind: parOrd[i][j] >= 1 ? "merge" : "parent",
        d: edgePath(c.x, c.y, q.x, q.y),
        chain: c.chain,
      });
    });
  }

  labels.sort((a, b) => cmp(a.id, b.id));
  clusters.sort((a, b) => cmp(a.revision_key, b.revision_key));
  const labelMap = new Map(labels.map((l) => [l.id, l]));
  const sortedClusterOf = new Map(
    [...clusterOf.entries()].sort((a, b) => cmp(a[0], b[0])),
  );

  /* 9. depth ticks: honest ranks, at most 40, never denser than 70 px */
  const ticks: Tick[] = [];
  if (N) {
    let step = 1;
    for (let mag = 1; ; mag *= 10) {
      const found = [1, 2, 5]
        .map((m) => m * mag)
        .find((s) => s * rowH >= 70 && Math.floor(maxRank / s) + 1 <= 40);
      if (found !== undefined) {
        step = found;
        break;
      }
    }
    for (let r = 0; r <= maxRank; r += step)
      ticks.push({ rank: r, y: (maxRank - r) * rowH, label: String(r) });
  }

  return {
    nodes: laidNodes,
    edges,
    labels: labelMap,
    clusters,
    clusterOf: sortedClusterOf,
    unattached,
    ...(unattachedBox ? { unattachedBox } : {}),
    boundaries: nodes.filter((_, i) => boundary[i]).map((n) => n.key),
    components,
    ticks,
    bounds: bounds ?? { x: 0, y: 0, w: 0, h: 0 },
    rowH,
    maxRank,
  };
}

/* ------------------------------------------------------- viewport helpers */

const pillBox = (l: LaidLabel): Rect => {
  let x0 = l.x;
  let x1 = l.x + l.w;
  for (const b of l.badges) {
    x0 = Math.min(x0, b.x);
    x1 = Math.max(x1, b.x + b.w);
  }
  return { x: x0, y: l.y, w: x1 - x0, h: l.h };
};

/**
 * Rectangle to frame the given workspaces: their revisions, the history
 * connecting them down to the lowest fork, and their labels. Unrelated
 * lanes and older history are left out. No resolvable focus -> whole graph.
 */
export function fitBounds(layout: GraphLayout, focus?: string[]): Rect {
  if (!focus?.length) return layout.bounds;
  const tips = new Set<string>();
  let extra: Rect | undefined;
  for (const id of new Set(focus)) {
    const label = layout.labels.get(id);
    if (label) {
      extra = union(extra, pillBox(label));
      if (label.revision_key && layout.nodes.has(label.revision_key))
        tips.add(label.revision_key);
      continue;
    }
    const rev = layout.clusterOf.get(id);
    if (rev === undefined) continue;
    const chip = layout.clusters.find((c) => c.revision_key === rev);
    if (chip) extra = union(extra, chip);
    if (layout.nodes.has(rev)) tips.add(rev);
  }
  if (!tips.size && !extra) return layout.bounds;

  const list = [...layout.nodes.values()].sort(
    (a, b) => b.rank - a.rank || cmp(a.key, b.key),
  );
  const idx = new Map(list.map((n, i) => [n.key, i]));
  const parents: number[][] = list.map(() => []);
  const children: number[][] = list.map(() => []);
  for (const e of layout.edges) {
    const c = idx.get(e.child);
    const p = idx.get(e.parent);
    if (c === undefined || p === undefined) continue;
    parents[c].push(p);
    children[p].push(c);
  }
  const tipList = [...tips].sort();
  const words = Math.ceil(tipList.length / 32) || 1;
  const mask = new Uint32Array(list.length * words);
  const isTip = new Uint8Array(list.length);
  tipList.forEach((k, t) => {
    const i = idx.get(k)!;
    isTip[i] = 1;
    mask[i * words + (t >> 5)] |= 1 << (t & 31);
  });
  for (let i = 0; i < list.length; i++)
    for (const p of parents[i])
      for (let w = 0; w < words; w++) mask[p * words + w] |= mask[i * words + w];
  const has = (i: number) => {
    for (let w = 0; w < words; w++) if (mask[i * words + w]) return true;
    return false;
  };
  const floor = new Map<number, number>();
  const lowTip = new Map<number, number>();
  for (let i = 0; i < list.length; i++) {
    if (!has(i)) continue;
    const comp = list[i].component;
    if (isTip[i])
      lowTip.set(comp, Math.min(lowTip.get(comp) ?? Infinity, list[i].rank));
    const masked = children[i].filter(has).length;
    if (masked >= 2 || (isTip[i] && masked >= 1))
      floor.set(comp, Math.min(floor.get(comp) ?? Infinity, list[i].rank));
  }
  let rect = extra;
  for (let i = 0; i < list.length; i++) {
    if (!has(i)) continue;
    const comp = list[i].component;
    const floorRank =
      floor.get(comp) ?? Math.max(0, (lowTip.get(comp) ?? 0) - 4);
    if (list[i].rank < floorRank) continue;
    rect = union(rect, {
      x: list[i].x - NODE_HALF,
      y: list[i].y - NODE_HALF,
      w: 2 * NODE_HALF,
      h: 2 * NODE_HALF,
    });
  }
  const r = rect!;
  const pad = 40;
  return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
}

/** Centre of the workspace's pill, else of its collapsed cluster chip. */
export function focusPoint(
  layout: GraphLayout,
  workspaceId: string,
): Point | undefined {
  const l = layout.labels.get(workspaceId);
  if (l) return { x: l.x + l.w / 2, y: l.y + l.h / 2 };
  const rev = layout.clusterOf.get(workspaceId);
  if (rev === undefined) return undefined;
  const chip = layout.clusters.find((c) => c.revision_key === rev);
  if (chip) return { x: chip.x + chip.w / 2, y: chip.y + chip.h / 2 };
  const n = layout.nodes.get(rev);
  return n ? { x: n.x, y: n.y } : undefined;
}

/** Nearest label stop in a screen direction; a collapsed cluster is one stop. */
export function neighborLabel(
  layout: GraphLayout,
  fromId: string,
  dir: "up" | "down" | "left" | "right",
): string | undefined {
  const from = focusPoint(layout, fromId);
  if (!from) return undefined;
  const stops = new Map<string, Point>();
  for (const id of layout.labels.keys()) stops.set(id, focusPoint(layout, id)!);
  for (const c of layout.clusters)
    if (!c.expanded && c.members.length)
      stops.set(c.members[0], { x: c.x + c.w / 2, y: c.y + c.h / 2 });
  let best: { id: string; cone: number; score: number } | undefined;
  for (const [id, p] of stops) {
    if (id === fromId) continue;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    if (dx === 0 && dy === 0) continue;
    const primary =
      dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    if (primary <= 0.5) continue;
    const lateral = Math.abs(dir === "left" || dir === "right" ? dy : dx);
    const inCone = lateral <= primary;
    const score = inCone ? Math.hypot(dx, dy) : primary + 2 * lateral;
    const cone = inCone ? 0 : 1;
    if (
      !best ||
      cone < best.cone ||
      (cone === best.cone && (score < best.score || (score === best.score && id < best.id)))
    )
      best = { id, cone, score };
  }
  return best?.id;
}
