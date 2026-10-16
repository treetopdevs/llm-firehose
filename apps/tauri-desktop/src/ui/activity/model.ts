// Activity Map: one repository's path hierarchy showing where Heat (file-category
// Captured Events per path per bucket) accumulated over a window
// (docs/plans/2026-10-16-activity-map-build-brief.md). Pure derivation, no DOM.
//
// Invariant: a tile's size is its path's total over the whole loaded window; its
// colour is the Heat summed over the brushed bucket range. Brushing never moves a tile.

import type { ActivityPath, ActivityResponse } from "../graph/api";
import { digestLabel } from "../score/model";

export const OUTSIDE_LABEL = "Outside known worktrees";

export type TreeNode = {
  /** Unique within one tree: group, NUL, then the directory or file path. */
  key: string;
  /** What the tile shows: a segment, a collapsed run of segments, or a group label. */
  name: string;
  /** The file path (as the response gives it) or the directory prefix. */
  path: string;
  group: string;
  /** Heat over the whole window: the tile's size. */
  total: number;
  /** Present for directories and group nodes, in path order. */
  children?: TreeNode[];
  /** Present for files. */
  entry?: ActivityPath;
};

export type Rect = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  node: TreeNode;
  depth: number;
  /** Key of the enclosing directory rect, or "" at the top. */
  parent: string;
  /** A directory tall and wide enough to carry its name strip. */
  label: boolean;
};

export const PAD = 2;
export const LABEL_H = 15;
const LABEL_MIN_H = LABEL_H + 12;
const LABEL_MIN_W = 36;

function dirNode(key: string, name: string, path: string, group: string): TreeNode {
  return { key, name, path, group, total: 0, children: [] };
}

function byLayoutOrder(a: { group: string; path: string }, b: { group: string; path: string }): number {
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Adds one path under `top`, creating directories by "/" segment in first-seen (path) order. */
function insert(top: TreeNode, entry: ActivityPath) {
  const segments = entry.path.split("/");
  const absolute = segments[0] === "";
  if (absolute) segments.shift();
  let node = top;
  let prefix = absolute ? "/" : "";
  node.total += entry.total;
  for (let i = 0; i < segments.length - 1; i++) {
    prefix += segments[i] + "/";
    const key = `${entry.group}\0${prefix}`;
    let next = node.children!.find((c) => c.key === key);
    if (!next) {
      next = dirNode(key, segments[i], prefix, entry.group);
      node.children!.push(next);
    }
    next.total += entry.total;
    node = next;
  }
  node.children!.push({
    key: `${entry.group}\0${entry.path}`,
    name: segments[segments.length - 1],
    path: entry.path,
    group: entry.group,
    total: entry.total,
    entry,
  });
}

/** A directory whose only child is a directory merges with it ("apps/desk/src"). */
function collapseChains(node: TreeNode): TreeNode {
  if (!node.children) return node;
  node.children = node.children.map((c) => {
    let d = c;
    while (d.children && d.children.length === 1 && d.children[0].children) {
      const only = d.children[0];
      d = { ...only, name: `${d.name}/${only.name}` };
    }
    return collapseChains(d);
  });
  return node;
}

/**
 * Directory tree of a response. Resolved (repository-relative) paths sit at the
 * top level; each unresolved group gets its own node, and those go last under one
 * "Outside known worktrees" node, keeping their raw paths.
 */
export function buildTree(resp: ActivityResponse): TreeNode {
  const root = dirNode("", "", "", "");
  const outside = dirNode("\0outside", OUTSIDE_LABEL, "", "");
  const groups = new Map<string, TreeNode>();
  for (const entry of [...resp.paths].sort(byLayoutOrder)) {
    if (entry.group === "") {
      insert(root, entry);
      continue;
    }
    let g = groups.get(entry.group);
    if (!g) {
      const label = resp.groups.find((x) => x.id === entry.group)?.label;
      const id = digestLabel(entry.group) || entry.group;
      g = dirNode(`${entry.group}\0`, label && label !== OUTSIDE_LABEL ? label : id, "", entry.group);
      groups.set(entry.group, g);
      outside.children!.push(g);
    }
    outside.total += entry.total;
    insert(g, entry);
  }
  for (const g of groups.values()) collapseChains(g);
  collapseChains(root);
  if (outside.children!.length) {
    root.children!.push(outside);
    root.total += outside.total;
  }
  return root;
}

export function findNode(node: TreeNode, key: string): TreeNode | undefined {
  if (node.key === key) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, key);
    if (hit) return hit;
  }
  return undefined;
}

/** The directory keys from the top of `tree` down to (and including) `key`. */
export function trail(tree: TreeNode, key: string): TreeNode[] {
  if (tree.key === key) return [tree];
  for (const c of tree.children ?? []) {
    const t = trail(c, key);
    if (t.length) return [tree, ...t];
  }
  return [];
}

/**
 * Order-preserving split treemap of `tree`'s children in a width x height area.
 * Children keep path order: the ordered list is split into two runs of roughly
 * equal weight along the longer side, recursively. Not squarified (that sorts by
 * size and breaks path order). Deterministic for the same tree and size.
 */
export function layout(tree: TreeNode, width: number, height: number): Rect[] {
  const out: Rect[] = [];
  place(tree.children ?? [], 0, 0, width, height, 0, "", out);
  return out;
}

function place(nodes: TreeNode[], x: number, y: number, w: number, h: number, depth: number, parent: string, out: Rect[]) {
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    placeNode(nodes[0], x, y, w, h, depth, parent, out);
    return;
  }
  const total = nodes.reduce((n, c) => n + c.total, 0);
  let k = 1;
  let left = nodes[0].total;
  let best = Math.abs(total / 2 - left);
  for (let i = 2, run = left; i < nodes.length; i++) {
    run += nodes[i - 1].total;
    const d = Math.abs(total / 2 - run);
    if (d < best) {
      best = d;
      k = i;
      left = run;
    }
  }
  const frac = total > 0 ? left / total : k / nodes.length;
  if (w >= h) {
    const lw = w * frac;
    place(nodes.slice(0, k), x, y, lw, h, depth, parent, out);
    place(nodes.slice(k), x + lw, y, w - lw, h, depth, parent, out);
  } else {
    const th = h * frac;
    place(nodes.slice(0, k), x, y, w, th, depth, parent, out);
    place(nodes.slice(k), x, y + th, w, h - th, depth, parent, out);
  }
}

function placeNode(node: TreeNode, x: number, y: number, w: number, h: number, depth: number, parent: string, out: Rect[]) {
  const label = !!node.children && h >= LABEL_MIN_H && w >= LABEL_MIN_W;
  out.push({ key: node.key, x, y, w, h, node, depth, parent, label });
  if (!node.children) return;
  const top = PAD + (label ? LABEL_H : 0);
  const iw = Math.max(0, w - 2 * PAD);
  const ih = Math.max(0, h - top - PAD);
  place(node.children, x + Math.min(PAD, w / 2), y + Math.min(top, h), iw, ih, depth + 1, node.key, out);
}

/** A path's Heat over buckets [a, b). */
export function rangeHeat(path: ActivityPath, a: number, b: number): number {
  let n = 0;
  for (const [i, c] of path.heat) if (i >= a && i < b) n += c;
  return n;
}

/** Heat over [a, b) for every node in the tree, directories summing their descendants. */
export function rangeTotals(tree: TreeNode, a: number, b: number): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (node: TreeNode): number => {
    const n = node.entry ? rangeHeat(node.entry, a, b) : (node.children ?? []).reduce((s, c) => s + walk(c), 0);
    out.set(node.key, n);
    return n;
  };
  walk(tree);
  return out;
}

/** Total Heat per bucket across every path: the scrubber strip. */
export function histogram(resp: ActivityResponse): number[] {
  const out = new Array<number>(Math.max(0, resp.buckets)).fill(0);
  for (const p of resp.paths) for (const [i, c] of p.heat) if (i >= 0 && i < out.length) out[i] += c;
  return out;
}

const RAMP_FLOOR = 18;

/** One sequential hue on a sqrt scale; zero Heat is the neutral fill. */
export function colour(heat: number, max: number): string {
  if (!(heat > 0) || !(max > 0)) return "var(--map-zero)";
  const pct = RAMP_FLOOR + (100 - RAMP_FLOOR) * Math.sqrt(Math.min(1, heat / max));
  return `color-mix(in srgb, var(--map-heat) ${pct.toFixed(1)}%, var(--map-zero))`;
}

export type Hot = { path: string; group: string; heat: number; total: number };

/** The hottest paths in [a, b): the accessible equivalent of the map. */
export function hottest(resp: ActivityResponse, a: number, b: number, n = 20): Hot[] {
  return resp.paths
    .map((p) => ({ path: p.path, group: p.group, heat: rangeHeat(p, a, b), total: p.total }))
    .filter((x) => x.heat > 0)
    .sort((x, y) => y.heat - x.heat || byLayoutOrder(x, y))
    .slice(0, n);
}
