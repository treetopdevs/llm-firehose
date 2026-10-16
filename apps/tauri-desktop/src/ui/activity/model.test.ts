import { describe, expect, test } from "vitest";
import type { ActivityResponse } from "../graph/api";
import { OUTSIDE_LABEL, buildTree, colour, findNode, histogram, hottest, layout, rangeHeat, rangeTotals } from "./model";
import type { TreeNode } from "./model";
import fixture from "./fixture.activity.json";

// A real GET /workspace-graph/activity response from a temporary daemon over a
// copy of real spool days (this repository, 2026-10-08 to 10-16, hourly
// buckets): resolved repository-relative paths merged across worktrees, plus
// three unresolved groups (a removed sibling worktree and edits outside the
// repository). Personal path segments are rewritten.
const real = fixture as ActivityResponse;

function resp(paths: ActivityResponse["paths"], over: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    repo_id: "r",
    workspace_id: "",
    from: "2026-10-16T00:00:00Z",
    to: "2026-10-16T04:00:00Z",
    bucket_seconds: 3600,
    buckets: 4,
    available: true,
    unavailable_reason: "",
    paths,
    groups: [],
    file_events: 0,
    unreadable_file_events: 0,
    truncated: false,
    truncated_total: 0,
    capture_gap: false,
    ...over,
  };
}
const p = (path: string, heat: [number, number][], group = "") => ({ path, group, heat, total: heat.reduce((n, [, c]) => n + c, 0) });

function files(node: TreeNode): string[] {
  return node.children ? node.children.flatMap(files) : [node.path];
}

describe("buildTree", () => {
  test("directories nest by path segment, keep byte order, and sum totals", () => {
    const tree = buildTree(resp([p("a/x.go", [[0, 2]]), p("a/y.go", [[1, 1]]), p("b.go", [[0, 4]]), p("Z.md", [[2, 1]])]));
    expect(tree.total).toBe(8);
    expect(tree.children!.map((c) => c.name)).toEqual(["Z.md", "a", "b.go"]);
    const a = tree.children![1];
    expect(a.total).toBe(3);
    expect(a.children!.map((c) => c.path)).toEqual(["a/x.go", "a/y.go"]);
  });

  test("single-child directory chains collapse into one node", () => {
    const tree = buildTree(resp([p("apps/desk/src/a.ts", [[0, 1]]), p("apps/desk/src/b.ts", [[0, 1]])]));
    expect(tree.children!.map((c) => c.name)).toEqual(["apps/desk/src"]);
  });

  test("unresolved groups go last under one Outside node, a node per group, raw paths kept", () => {
    const tree = buildTree(resp([p("x.go", [[0, 1]]), p("/tmp/o/a.go", [[0, 1]], "g2"), p("/tmp/o/b.go", [[0, 1]], "g1")]));
    const outside = tree.children![tree.children!.length - 1];
    expect(outside.name).toBe(OUTSIDE_LABEL);
    expect(outside.children!.map((c) => c.group)).toEqual(["g1", "g2"]);
    expect(files(outside)).toEqual(["/tmp/o/b.go", "/tmp/o/a.go"]);
  });

  test("the real response keeps every path exactly once, in response order", () => {
    const tree = buildTree(real);
    const all = files(tree);
    expect(all.length).toBe(real.paths.length);
    expect(new Set(all).size).toBe(all.length);
    const resolved = real.paths.filter((x) => x.group === "").map((x) => x.path);
    expect(all.slice(0, resolved.length)).toEqual(resolved);
    expect(tree.total).toBe(real.paths.reduce((n, x) => n + x.total, 0));
  });

  test("findNode reaches a directory by key", () => {
    const tree = buildTree(real);
    const dir = tree.children!.find((c) => c.children)!;
    expect(findNode(tree, dir.key)).toBe(dir);
    expect(findNode(tree, "missing")).toBeUndefined();
  });
});

describe("layout", () => {
  const tree = buildTree(real);
  const rects = layout(tree, 900, 520);

  test("is deterministic for the same response and size", () => {
    expect(layout(buildTree(structuredClone(real)), 900, 520)).toEqual(rects);
  });

  test("tiles every file inside the area without overlap, area proportional to total", () => {
    const leaves = rects.filter((r) => !r.node.children);
    expect(leaves.length).toBe(real.paths.length);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(900 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(520 + 1e-6);
    }
    for (let i = 0; i < leaves.length; i++)
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i], b = leaves[j];
        const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
        expect(overlap).toBe(false);
      }
  });

  test("an order-preserving split: siblings stay in path order, reading left-to-right then top-to-bottom", () => {
    const flat = buildTree(resp([p("a", [[0, 5]]), p("b", [[0, 1]]), p("c", [[0, 1]]), p("d", [[0, 5]])]));
    const r = layout(flat, 400, 100).filter((x) => !x.node.children);
    expect(r.map((x) => x.node.path)).toEqual(["a", "b", "c", "d"]);
    // Equal weight halves: a+b | c+d, split along the longer (horizontal) side.
    const ab = r[0].w + 0, cd = r[3].w;
    expect(r[0].x).toBe(0);
    expect(r[3].x + r[3].w).toBeCloseTo(400);
    expect(ab).toBeCloseTo(cd);
    expect(r[1].x).toBeGreaterThanOrEqual(r[0].x);
    expect(r[2].x).toBeGreaterThanOrEqual(r[1].x);
  });

  test("directories are padded and labelled when tall enough", () => {
    const dir = rects.find((r) => r.node.children && r.h > 40)!;
    expect(dir.label).toBe(true);
    const kids = rects.filter((r) => r.parent === dir.node.key);
    for (const k of kids) {
      expect(k.x).toBeGreaterThanOrEqual(dir.x + 2 - 1e-6);
      expect(k.y).toBeGreaterThan(dir.y + 2);
    }
  });

  test("tile rects do not depend on the brushed range", () => {
    // Size is window total; only colour reads the range. layout() takes no range at all,
    // so two brush positions over the same response draw identical rects.
    const before = layout(tree, 900, 520);
    rangeTotals(tree, 0, 10);
    expect(layout(tree, 900, 520)).toEqual(before);
  });
});

describe("range heat, histogram, colour, hottest", () => {
  const r = resp([p("a.go", [[0, 2], [3, 1]]), p("b.go", [[1, 4]]), p("c.go", [[3, 3]])]);

  test("rangeHeat sums a path's buckets in [a, b)", () => {
    expect(rangeHeat(r.paths[0], 0, 4)).toBe(3);
    expect(rangeHeat(r.paths[0], 1, 3)).toBe(0);
    expect(rangeHeat(r.paths[0], 3, 4)).toBe(1);
  });

  test("rangeTotals sums descendants for directories", () => {
    const tree = buildTree(resp([p("d/a.go", [[0, 2]]), p("d/b.go", [[1, 4]]), p("e.go", [[1, 1]])]));
    const totals = rangeTotals(tree, 1, 2);
    expect(totals.get(tree.children![0].key)).toBe(4);
    expect(totals.get(tree.key)).toBe(5);
  });

  test("histogram is total Heat per bucket", () => {
    expect(histogram(r)).toEqual([2, 4, 0, 4]);
    const h = histogram(real);
    expect(h.length).toBe(real.buckets);
    expect(h.reduce((n, x) => n + x, 0)).toBe(real.paths.reduce((n, x) => n + x.total, 0));
  });

  test("colour: neutral for zero, one hue on a sqrt scale", () => {
    expect(colour(0, 10)).toBe("var(--map-zero)");
    const low = colour(1, 100), mid = colour(25, 100), high = colour(100, 100);
    const pct = (s: string) => Number(/(\d+(?:\.\d+)?)%/.exec(s)![1]);
    expect(low).toContain("var(--map-heat)");
    expect(pct(low)).toBeLessThan(pct(mid));
    expect(pct(high)).toBe(100);
    // sqrt: a quarter of the max is half way up the ramp above its floor.
    expect(pct(mid) - pct(colour(1e-9, 100))).toBeCloseTo((pct(high) - pct(colour(1e-9, 100))) / 2, 0);
  });

  test("hottest ranks by range Heat, ties by path, drops zero, at most n", () => {
    expect(hottest(r, 0, 4).map((x) => [x.path, x.heat])).toEqual([["b.go", 4], ["a.go", 3], ["c.go", 3]]);
    expect(hottest(r, 3, 4, 1).map((x) => x.path)).toEqual(["c.go"]);
    expect(hottest(r, 2, 3)).toEqual([]);
    expect(hottest(real, 0, real.buckets).length).toBe(20);
  });
});
