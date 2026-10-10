import { describe, expect, test } from "vitest";
import {
  countCrossings,
  estimateLabelWidth,
  fitBounds,
  focusPoint,
  layoutWorkspaceGraph,
  neighborLabel,
  type GraphLayout,
  type Rect,
} from "./layout";
import type { GraphNode } from "./model";
import {
  branchingGraph,
  commits,
  longChain,
  mockupGraph,
  node,
  perfBudget,
  randomDag,
  randomWorkspaces,
  shuffle,
  ws,
} from "./layout.fixtures";

const NODE = 7;
const nodeRect = (l: GraphLayout, key: string): Rect => {
  const n = l.nodes.get(key)!;
  return { x: n.x - NODE, y: n.y - NODE, w: 2 * NODE, h: 2 * NODE };
};
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (r: Rect, p: { x: number; y: number }) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Every drawn label-ish rectangle: pills, their badges and cluster chips. */
function boxes(l: GraphLayout): { name: string; r: Rect }[] {
  const out: { name: string; r: Rect }[] = [];
  for (const p of l.labels.values()) {
    out.push({ name: `pill ${p.id}`, r: { x: p.x, y: p.y, w: p.w, h: p.h } });
    p.badges.forEach((b, i) =>
      out.push({
        name: `badge ${p.id}#${i}`,
        r: { x: b.x, y: b.y, w: b.w, h: b.h },
      }),
    );
  }
  for (const c of l.clusters)
    out.push({
      name: `cluster ${c.revision_key}`,
      r: { x: c.x, y: c.y, w: c.w, h: c.h },
    });
  return out;
}
function expectNoCollisions(l: GraphLayout, tag = "") {
  const all = boxes(l);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++)
      if (overlaps(all[i].r, all[j].r))
        throw new Error(`${tag} ${all[i].name} overlaps ${all[j].name}`);
    for (const key of l.nodes.keys())
      if (overlaps(all[i].r, nodeRect(l, key)))
        throw new Error(`${tag} ${all[i].name} overlaps node ${key}`);
  }
}
const pairs = (nodes: GraphNode[]) => {
  const keys = new Set(nodes.map((n) => n.key));
  return nodes
    .flatMap((n) =>
      [...new Set(n.parents)]
        .filter((p) => keys.has(p))
        .map((p) => `${n.key}>${p}`),
    )
    .sort();
};
const layoutPairs = (l: GraphLayout) =>
  l.edges.map((e) => `${e.child}>${e.parent}`).sort();
const point = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const legacyNodes = [
  { key: "merge", parents: ["a", "b"] },
  { key: "a", parents: ["root"] },
  { key: "b", parents: ["root"] },
  { key: "root", parents: ["omitted"] },
].map((n) => ({ ...n, commit_id: n.key, description: "", timestamp: "" }));

describe("ranks, edges and boundaries (migrated legacy tests)", () => {
  test("layout retains actual merge parents and marks omitted parents without invented links", () => {
    const l = layoutWorkspaceGraph(legacyNodes, []);
    expect(layoutPairs(l)).toEqual(["a>root", "b>root", "merge>a", "merge>b"]);
    expect(l.edges.find((e) => e.child === "merge" && e.parent === "a")!.kind).toBe(
      "parent",
    );
    expect(l.edges.find((e) => e.child === "merge" && e.parent === "b")!.kind).toBe(
      "merge",
    );
    expect(l.boundaries).toEqual(["root"]);
    expect(l.nodes.get("root")!.boundary).toBe(true);
    expect(l.nodes.get("merge")!.merge).toBe(true);
    expect(l.nodes.get("a")!.merge).toBe(false);
    expect(l.nodes.get("root")!.y).toBeGreaterThan(l.nodes.get("a")!.y);
    expect(l.nodes.get("root")!.rank).toBe(0);
    expect(l.nodes.get("merge")!.rank).toBe(2);
  });

  test("crowded labels reserve space for every shared anchor", () => {
    const workspaces = Array.from({ length: 25 }, (_, i) =>
      ws(`w${i}`, "root", undefined, `w${i}`),
    );
    const l = layoutWorkspaceGraph(legacyNodes, workspaces, {
      expanded: new Set(["root"]),
    });
    expect(l.labels.size).toBe(25);
    expect(
      new Set([...l.labels.values()].map((p) => `${p.x},${p.y}`)).size,
    ).toBe(25);
    expectNoCollisions(l);
  });

  test("a merge parent whose first parent is omitted is still one edge per present parent", () => {
    const nodes = [
      node("x", ["gone", "p"]),
      node("p", []),
    ];
    const l = layoutWorkspaceGraph(nodes, []);
    expect(layoutPairs(l)).toEqual(["x>p"]);
    expect(l.boundaries).toEqual(["x"]);
    // kind follows the revision's own parent list: the second parent is a merge parent
    // even when the first is omitted, so the link is never drawn as a plain parent line
    expect(l.edges[0].kind).toBe("merge");
    expect(l.nodes.get("x")!.merge).toBe(false); // only one present parent
  });
});

describe("edges", () => {
  test("edges equal the set of present (child,parent) pairs including both merge parents, none across omitted parents", () => {
    const { nodes } = mockupGraph();
    const l = layoutWorkspaceGraph(nodes, []);
    expect(layoutPairs(l)).toEqual(pairs(nodes));
    const mg = l.edges.filter((e) => e.child === "MG1");
    expect(mg.map((e) => e.kind).sort()).toEqual(["merge", "parent"]);
    for (const seed of [3, 4, 5]) {
      const dag = randomDag(seed, 60, { mergeRate: 0.3, omitRoots: true });
      const out = layoutWorkspaceGraph(dag, []);
      expect(layoutPairs(out)).toEqual(pairs(dag));
      expect(out.edges.length).toBe(pairs(dag).length);
    }
  });

  test("child sits above parent for every edge on seeded random DAGs and the mockup", () => {
    const graphs = [mockupGraph().nodes];
    for (let seed = 1; seed <= 12; seed++)
      graphs.push(
        randomDag(seed, 30 + seed * 5, { mergeRate: 0.25, roots: 1 + (seed % 3) }),
      );
    for (const nodes of graphs) {
      const l = layoutWorkspaceGraph(nodes, []);
      for (const e of l.edges)
        expect(l.nodes.get(e.child)!.y).toBeLessThan(l.nodes.get(e.parent)!.y);
    }
  });

  test("edge paths are absolute S-curves from the child to the parent", () => {
    const l = layoutWorkspaceGraph(mockupGraph().nodes, []);
    for (const e of l.edges) {
      const nums = e.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const c = l.nodes.get(e.child)!;
      const p = l.nodes.get(e.parent)!;
      expect(e.d.startsWith("M ")).toBe(true);
      expect(e.d).toContain(" C ");
      expect(nums[0]).toBeCloseTo(c.x, 1);
      expect(nums[1]).toBeCloseTo(c.y, 1);
      expect(nums[nums.length - 2]).toBeCloseTo(p.x, 1);
      expect(nums[nums.length - 1]).toBeCloseTo(p.y, 1);
      expect(e.chain).toBe(c.chain);
    }
  });
});

describe("workspace attachment", () => {
  test("every workspace appears in exactly one of labels, clusterOf or unattached", () => {
    const { nodes, workspaces } = mockupGraph();
    const extras = [
      ...workspaces,
      ws("lost-1", undefined, undefined, "lost-1"),
      ws("lost-2", "no-such-revision", ["dirty"], "lost-2"),
      ...Array.from({ length: 6 }, (_, i) => ws(`crowd${i}`, "A3", undefined, `crowd${i}`)),
    ];
    for (const expanded of [new Set<string>(), new Set(["A3"])]) {
      const l = layoutWorkspaceGraph(nodes, extras, { expanded });
      const unattached = new Set(l.unattached);
      const pills = [...l.labels.keys()].filter((id) => !unattached.has(id));
      const clustered = [...l.clusterOf.keys()];
      const all = [...pills, ...clustered, ...unattached].sort();
      expect(all).toEqual(extras.map((w) => w.id).sort());
      expect(new Set(all).size).toBe(all.length);
      for (const id of unattached) expect(l.labels.has(id)).toBe(true);
    }
  });

  test("more than three labels on a revision become one counted cluster; three or fewer stack", () => {
    const nodes = commits("n", 4);
    const stack = [0, 1, 2].map((i) => ws(`s${i}`, "n3", undefined, `stack-${i}`));
    const three = layoutWorkspaceGraph(nodes, stack);
    expect(three.clusters).toEqual([]);
    expect(three.labels.size).toBe(3);
    expect(new Set([...three.labels.values()].map((p) => p.y)).size).toBe(3);
    expectNoCollisions(three);
    const four = layoutWorkspaceGraph(nodes, [...stack, ws("s3", "n3")]);
    expect(four.clusters).toHaveLength(1);
    expect(four.clusters[0].count).toBe(4);
    expect(four.labels.size).toBe(0);
    const wider = layoutWorkspaceGraph(nodes, [...stack, ws("s3", "n3")], {
      maxStack: 4,
    });
    expect(wider.clusters).toEqual([]);
    expect(wider.labels.size).toBe(4);
  });

  test("25 labels on one revision give one cluster counting 25; expanded shows 25 non-overlapping pills", () => {
    const nodes = commits("n", 6);
    const crowd = Array.from({ length: 25 }, (_, i) =>
      ws(`w${String(i).padStart(2, "0")}`, "n5", i % 4 === 0 ? ["dirty"] : [], `wt-${i}`),
    );
    const collapsed = layoutWorkspaceGraph(nodes, crowd);
    expect(collapsed.clusters).toHaveLength(1);
    const chip = collapsed.clusters[0];
    expect(chip.count).toBe(25);
    expect(chip.expanded).toBe(false);
    expect(chip.revision_key).toBe("n5");
    expect(chip.members).toEqual(crowd.map((w) => w.id).sort());
    expect(collapsed.clusterOf.size).toBe(25);
    for (const w of crowd) expect(collapsed.clusterOf.get(w.id)).toBe("n5");
    expect(collapsed.labels.size).toBe(0);
    expectNoCollisions(collapsed);

    const open = layoutWorkspaceGraph(nodes, crowd, { expanded: new Set(["n5"]) });
    expect(open.labels.size).toBe(25);
    expect(open.clusterOf.size).toBe(0);
    expect(open.clusters).toHaveLength(1);
    expect(open.clusters[0].expanded).toBe(true);
    expect(open.clusters[0].count).toBe(25);
    expectNoCollisions(open);
    expect(new Set([...open.labels.values()].map((p) => `${p.x},${p.y}`)).size).toBe(25);
  });

  test("workspaces with no resolvable revision go in a strip below the roots; no ancestry is drawn for them", () => {
    const nodes = commits("n", 5);
    const l = layoutWorkspaceGraph(nodes, [
      ws("a", "n4"),
      ws("unborn-1", undefined, undefined, "unborn-1"),
      ws("unborn-2", "ghost", ["dirty"], "unborn-2"),
    ]);
    expect(l.unattached).toEqual(["unborn-1", "unborn-2"]);
    expect(l.unattachedBox).toBeDefined();
    const box = l.unattachedBox!;
    const lowest = Math.max(...[...l.nodes.values()].map((n) => n.y));
    expect(box.y).toBeGreaterThan(lowest + NODE);
    for (const id of l.unattached) {
      const p = l.labels.get(id)!;
      expect(p.revision_key).toBe("");
      expect(overlaps(p, box) || contains(box, point(p))).toBe(true);
      expect(l.edges.some((e) => e.child === id || e.parent === id)).toBe(false);
    }
    expectNoCollisions(l);
    expect(layoutWorkspaceGraph(nodes, [ws("a", "n4")]).unattachedBox).toBeUndefined();
  });

  test("anchors count workspaces per revision and chainActive marks chains that carry one", () => {
    const nodes = [
      ...commits("t", 6),
      ...commits("b", 3, "t2"),
      ...commits("q", 3, "t4"),
    ];
    // heavy path: t0..t4 then q0..q2; t5 and b0..b2 are lighter forks
    const l = layoutWorkspaceGraph(nodes, [
      ws("w1", "b2"),
      ws("w2", "b2"),
      ws("w3", "q2"),
    ]);
    expect(l.nodes.get("b2")!.anchors).toBe(2);
    expect(l.nodes.get("q2")!.anchors).toBe(1);
    expect(l.nodes.get("t0")!.anchors).toBe(0);
    expect(l.nodes.get("b0")!.chainActive).toBe(true);
    expect(l.nodes.get("t0")!.chainActive).toBe(true); // same chain as q2
    expect(l.nodes.get("q1")!.chainActive).toBe(true);
    expect(l.nodes.get("t5")!.chainActive).toBe(false);
    expect(l.nodes.get("b0")!.chain).not.toBe(l.nodes.get("t0")!.chain);
  });
});

describe("lanes", () => {
  test("trunk follows the default branch tip at lane 0 and x 0", () => {
    const nodes = [
      ...commits("r", 2),
      ...commits("big", 10, "r1"),
      ...commits("small", 3, "r1"),
    ];
    const byDefault = layoutWorkspaceGraph(nodes, []);
    expect(byDefault.nodes.get("big9")!.lane).toBe(0);
    expect(byDefault.nodes.get("small2")!.lane).not.toBe(0);
    const pinned = layoutWorkspaceGraph(nodes, [], { trunkTip: "small2" });
    for (const k of ["r0", "r1", "small0", "small1", "small2"]) {
      expect(pinned.nodes.get(k)!.lane).toBe(0);
      expect(pinned.nodes.get(k)!.x).toBe(0);
    }
    expect(pinned.nodes.get("big9")!.lane).not.toBe(0);
  });

  test("sibling branches fan out to both sides of the trunk", () => {
    const nodes = [
      ...commits("t", 12),
      ...commits("a", 3, "t4"),
      ...commits("b", 3, "t4"),
      ...commits("c", 3, "t4"),
      ...commits("d", 3, "t4"),
    ];
    const l = layoutWorkspaceGraph(nodes, []);
    const lanes = ["a2", "b2", "c2", "d2"].map((k) => l.nodes.get(k)!.lane);
    expect(Math.min(...lanes)).toBeLessThan(0);
    expect(Math.max(...lanes)).toBeGreaterThan(0);
    const m = mockupGraph();
    const mock = layoutWorkspaceGraph(m.nodes, m.workspaces, { trunkTip: m.trunkTip });
    const all = [...mock.nodes.values()].map((n) => n.lane);
    expect(Math.min(...all)).toBeLessThan(0);
    expect(Math.max(...all)).toBeGreaterThan(0);
    expect(mock.nodes.get(m.trunkTip)!.lane).toBe(0);
  });

  test("no two nodes share a position or sit closer than a node width", () => {
    const m = mockupGraph();
    const graphs = [
      layoutWorkspaceGraph(m.nodes, m.workspaces, { trunkTip: m.trunkTip }),
      layoutWorkspaceGraph(randomDag(7, 200, { mergeRate: 0.2, roots: 2 }), []),
    ];
    for (const l of graphs) {
      const ns = [...l.nodes.values()];
      for (let i = 0; i < ns.length; i++)
        for (let j = i + 1; j < ns.length; j++)
          if (Math.abs(ns[i].y - ns[j].y) < 1 && Math.abs(ns[i].x - ns[j].x) < 14)
            throw new Error(`${ns[i].key} collides with ${ns[j].key}`);
    }
  });

  test("node positions do not move when a cluster is expanded", () => {
    const nodes = commits("n", 8);
    const crowd = Array.from({ length: 12 }, (_, i) => ws(`w${i}`, "n7"));
    const base = layoutWorkspaceGraph(nodes, crowd);
    const open = layoutWorkspaceGraph(nodes, crowd, { expanded: new Set(["n7"]) });
    expect([...open.nodes.entries()]).toEqual([...base.nodes.entries()]);
  });

  test("disconnected components get disjoint x ranges that contain their nodes and labels", () => {
    const nodes = randomDag(9, 90, { roots: 4, mergeRate: 0.1 });
    const workspaces = randomWorkspaces(9, nodes, 20);
    const l = layoutWorkspaceGraph(nodes, workspaces);
    expect(l.components.length).toBe(4);
    for (let i = 1; i < l.components.length; i++)
      expect(l.components[i - 1].x + l.components[i - 1].w).toBeLessThan(
        l.components[i].x,
      );
    expect(l.components.reduce((s, c) => s + c.nodes, 0)).toBe(nodes.length);
    for (const n of l.nodes.values()) {
      const c = l.components[n.component];
      expect(n.x).toBeGreaterThanOrEqual(c.x);
      expect(n.x).toBeLessThanOrEqual(c.x + c.w);
    }
    for (const p of l.labels.values()) {
      const c = l.components[l.nodes.get(p.revision_key)!.component];
      expect(p.x).toBeGreaterThanOrEqual(c.x);
      expect(p.x + p.w).toBeLessThanOrEqual(c.x + c.w);
    }
    const ys = [...l.nodes.values()].filter((n) => n.rank === 0).map((n) => n.y);
    expect(new Set(ys).size).toBe(1); // bottom aligned
  });

  test("each component is laid out independently of its neighbours", () => {
    const nodes = randomDag(12, 160, { roots: 2, mergeRate: 0.3, branchRate: 0.3 });
    const second = nodes.filter((n) => n.key.startsWith("h1n"));
    const both = layoutWorkspaceGraph(nodes, []);
    const solo = layoutWorkspaceGraph(second, []);
    const anchor = [...solo.nodes.values()].find((n) => n.lane === 0 && n.x === 0)!;
    const shift = both.nodes.get(anchor.key)!.x;
    for (const n of solo.nodes.values()) {
      const b = both.nodes.get(n.key)!;
      expect(b.x - shift).toBeCloseTo(n.x, 6);
      expect(b.rank).toBe(n.rank); // y shares the graph-wide row scale, x does not interact
      expect(b.lane).toBe(n.lane);
    }
  });

  test("the component holding the trunk tip is laid out first", () => {
    const nodes = [...commits("a", 3), ...commits("b", 9)];
    const l = layoutWorkspaceGraph(nodes, [], { trunkTip: "a2" });
    expect(l.nodes.get("a0")!.component).toBe(0);
    expect(l.nodes.get("b0")!.component).toBe(1);
    expect(l.nodes.get("a0")!.x).toBe(0);
    const natural = layoutWorkspaceGraph(nodes, []);
    expect(natural.nodes.get("b0")!.component).toBe(0);
  });
});

describe("crossings", () => {
  test("a pure tree has zero crossings", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const tree = randomDag(seed, 20 + seed * 4, { mergeRate: 0, branchRate: 0.35 });
      const l = layoutWorkspaceGraph(tree, randomWorkspaces(seed, tree, 8));
      expect(countCrossings(l), `seed ${seed}`).toBe(0);
    }
    const m = mockupGraph();
    const noMerges = m.nodes.filter((n) => n.key !== "MG1" && n.key !== "MG2" && !n.key.startsWith("R2t") && !n.key.startsWith("L1t"));
    expect(
      countCrossings(layoutWorkspaceGraph(noMerges, [], { trunkTip: m.trunkTip })),
    ).toBe(0);
  });

  test("countCrossings counts a deliberate crossing and ignores shared endpoints", () => {
    const x = [
      node("a", []),
      node("b", []),
      node("c", ["b"]),
      node("d", ["a"]),
    ];
    const l = layoutWorkspaceGraph(x, []);
    expect(countCrossings(l)).toBeGreaterThanOrEqual(0);
    const forced: GraphLayout = {
      ...l,
      nodes: new Map([
        ["a", { ...l.nodes.get("a")!, x: 0, y: 200 }],
        ["b", { ...l.nodes.get("b")!, x: 100, y: 200 }],
        ["c", { ...l.nodes.get("c")!, x: 0, y: 0 }],
        ["d", { ...l.nodes.get("d")!, x: 100, y: 0 }],
      ]),
    };
    expect(countCrossings(forced)).toBe(1);
    const star: GraphLayout = {
      ...forced,
      nodes: new Map([
        ["a", { ...l.nodes.get("a")!, x: 0, y: 200 }],
        ["b", { ...l.nodes.get("b")!, x: 0, y: 200 }],
        ["c", { ...l.nodes.get("c")!, x: 0, y: 0 }],
        ["d", { ...l.nodes.get("d")!, x: 0, y: 0 }],
      ]),
    };
    expect(countCrossings(star)).toBe(0);
  });

  test("refinement never increases crossings versus refineSweeps 0", () => {
    const m = mockupGraph();
    const opts = { trunkTip: m.trunkTip };
    const plain = countCrossings(
      layoutWorkspaceGraph(m.nodes, m.workspaces, { ...opts, refineSweeps: 0 }),
    );
    const refined = countCrossings(layoutWorkspaceGraph(m.nodes, m.workspaces, opts));
    expect(refined).toBeLessThanOrEqual(plain);
    for (let seed = 1; seed <= 10; seed++) {
      const dag = randomDag(seed, 70, { mergeRate: 0.3, branchRate: 0.3 });
      const w = randomWorkspaces(seed, dag, 15);
      const a = countCrossings(layoutWorkspaceGraph(dag, w, { refineSweeps: 0 }));
      const b = countCrossings(layoutWorkspaceGraph(dag, w));
      expect(b, `seed ${seed}`).toBeLessThanOrEqual(a);
    }
  });
});

describe("compactness", () => {
  const leaderLength = (l: { leader?: { x1: number; y1: number; x2: number; y2: number } }) =>
    l.leader ? Math.hypot(l.leader.x2 - l.leader.x1, l.leader.y2 - l.leader.y1) : 0;

  test("tip labels do not reserve their full width in lanes: the mockup graph fits a 1,050 px canvas at scale >= 0.7", () => {
    // Reserving every tip label's whole width beside its lane made lane spacing sum to
    // roughly twice the label width on branchy graphs, so Fit landed below readable
    // scale. Labels spill into free space (or take a leader) instead.
    const m = mockupGraph();
    const l = layoutWorkspaceGraph(m.nodes, m.workspaces, { trunkTip: m.trunkTip });
    expect(1050 / l.bounds.w).toBeGreaterThanOrEqual(0.7);
    expectNoCollisions(l, "compact mockup");
  });

  test("compaction keeps labels beside their tips: few leaders, all short", () => {
    const m = mockupGraph();
    const l = layoutWorkspaceGraph(m.nodes, m.workspaces, { trunkTip: m.trunkTip });
    const labels = [...l.labels.values()];
    const led = labels.filter((x) => x.leader);
    expect(led.length).toBeLessThanOrEqual(Math.ceil(labels.length * 0.2));
    for (const x of led) expect(leaderLength(x)).toBeLessThanOrEqual(60);
    expect(l.labels.size + l.clusterOf.size + l.unattached.length).toBe(m.workspaces.length);
  });

  test("a wide label on a dense branchy graph is still reachable and collision-free", () => {
    for (let seed = 1; seed <= 6; seed++) {
      const dag = randomDag(seed, 150, { mergeRate: 0.15, branchRate: 0.35 });
      const w = randomWorkspaces(seed, dag, 50);
      const l = layoutWorkspaceGraph(dag, w, { trunkTip: dag[dag.length - 1].key });
      expectNoCollisions(l, `dense ${seed}`);
      expect(l.labels.size + l.clusterOf.size + l.unattached.length).toBe(50);
    }
  });
});

describe("refinement", () => {
  test("refinement pulls merge-linked chains together without adding crossings", () => {
    const m = mockupGraph();
    const opts = { trunkTip: m.trunkTip };
    const plain = layoutWorkspaceGraph(m.nodes, m.workspaces, { ...opts, refineSweeps: 0 });
    const refined = layoutWorkspaceGraph(m.nodes, m.workspaces, opts);
    expect(refined.bounds.w).toBeLessThanOrEqual(plain.bounds.w);
    expect(countCrossings(refined)).toBeLessThanOrEqual(countCrossings(plain));
    // a pure tree is already tight: refinement leaves it untouched
    const tree = randomDag(4, 60, { mergeRate: 0, branchRate: 0.3 });
    expect(layoutWorkspaceGraph(tree, [])).toEqual(
      layoutWorkspaceGraph(tree, [], { refineSweeps: 0 }),
    );
  });

  test("on merge-heavy DAGs refinement never lengthens merge links and shortens them for some seeds", () => {
    const mergeSpan = (l: GraphLayout) =>
      l.edges
        .filter((e) => e.kind === "merge")
        .reduce((sum, e) => sum + Math.abs(l.nodes.get(e.child)!.x - l.nodes.get(e.parent)!.x), 0);
    let shorter = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const dag = randomDag(seed, 120, { mergeRate: 0.3, branchRate: 0.3 });
      const before = mergeSpan(layoutWorkspaceGraph(dag, [], { refineSweeps: 0 }));
      const after = mergeSpan(layoutWorkspaceGraph(dag, []));
      expect(after).toBeLessThanOrEqual(before);
      if (after < before) shorter++;
    }
    expect(shorter).toBeGreaterThan(0);
  });

  test("on merge-heavy DAGs refinement strictly reduces crossings for some seeds and never adds any", () => {
    let better = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const dag = randomDag(seed, 120, { mergeRate: 0.3, branchRate: 0.3 });
      const before = countCrossings(layoutWorkspaceGraph(dag, [], { refineSweeps: 0 }));
      const after = countCrossings(layoutWorkspaceGraph(dag, []));
      expect(after).toBeLessThanOrEqual(before);
      if (after < before) better++;
    }
    expect(better).toBeGreaterThan(0);
  });
});

describe("robustness", () => {
  test("invariants hold across seeded random graphs with merges, roots, omitted parents and shuffled input", () => {
    for (let seed = 30; seed < 66; seed++) {
      const dag = randomDag(seed, 40 + (seed % 7) * 25, {
        mergeRate: (seed % 4) * 0.12,
        branchRate: 0.15 + (seed % 5) * 0.08,
        roots: 1 + (seed % 3),
        omitRoots: seed % 2 === 0,
      });
      const w = [
        ...randomWorkspaces(seed, dag, 10 + (seed % 5) * 10),
        ws("lost", undefined, ["dirty"], "lost"),
      ];
      const opts = { trunkTip: seed % 3 ? dag[dag.length - 1].key : undefined };
      const l = layoutWorkspaceGraph(dag, w, opts);
      expect(layoutPairs(l), `edges seed ${seed}`).toEqual(pairs(dag));
      for (const e of l.edges)
        expect(l.nodes.get(e.child)!.y).toBeLessThan(l.nodes.get(e.parent)!.y);
      const unattached = new Set(l.unattached);
      const seen = [
        ...[...l.labels.keys()].filter((id) => !unattached.has(id)),
        ...l.clusterOf.keys(),
        ...unattached,
      ].sort();
      expect(seen, `workspaces seed ${seed}`).toEqual(w.map((x) => x.id).sort());
      expectNoCollisions(l, `seed ${seed}`);
      expect(layoutWorkspaceGraph(shuffle(seed, dag), shuffle(seed + 1, w), opts)).toEqual(l);
    }
  });

  test("large bushy trees stay planar", () => {
    for (const seed of [101, 102, 103]) {
      const tree = randomDag(seed, 220, { mergeRate: 0, branchRate: 0.5 });
      expect(countCrossings(layoutWorkspaceGraph(tree, randomWorkspaces(seed, tree, 30)))).toBe(0);
    }
  });

  test("duplicate keys, self parents and repeated parents do not produce extra or invented edges", () => {
    const l = layoutWorkspaceGraph(
      [
        node("a", []),
        node("a", ["zzz"]),
        node("b", ["a", "a", "b"]),
        node("c", ["b", "a"]),
      ],
      [ws("w", "c")],
    );
    expect(l.nodes.size).toBe(3);
    expect(layoutPairs(l)).toEqual(["b>a", "c>a", "c>b"]);
    expect(l.edges.find((e) => e.child === "c" && e.parent === "a")!.kind).toBe("merge");
  });

  test("cyclic (invalid) input terminates with finite coordinates", () => {
    const l = layoutWorkspaceGraph(
      [node("a", ["c"]), node("b", ["a"]), node("c", ["b"]), node("ok", [])],
      [ws("w", "a")],
    );
    expect(l.nodes.size).toBe(4);
    for (const n of l.nodes.values()) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  test("fifty unattached workspaces wrap into a strip without overlapping", () => {
    const l = layoutWorkspaceGraph(
      commits("n", 5),
      Array.from({ length: 50 }, (_, i) =>
        ws(`u${String(i).padStart(2, "0")}`, undefined, i % 7 ? [] : ["dirty"], `unborn-${i}`),
      ),
    );
    expect(l.unattached).toHaveLength(50);
    expectNoCollisions(l);
    const box = l.unattachedBox!;
    for (const id of l.unattached) {
      const p = l.labels.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(box.x);
      expect(p.y + p.h).toBeLessThanOrEqual(box.y + box.h);
    }
    expect(box.y + box.h).toBeLessThanOrEqual(l.bounds.y + l.bounds.h);
  });

  test("the unattached strip sits below every placed label, expanded cluster or displaced stack included", () => {
    // 8 workspaces on the root row, expanded, fan out beyond the root floor; 2 more have no revision
    const nodes = commits("c", 6);
    const crowd = Array.from({ length: 8 }, (_, i) => ws(`w${i}`, "c0", [], `wt-${i}`));
    const lost = [ws("lost-1", undefined, undefined, "lost-1"), ws("lost-2", "ghost", ["dirty"], "lost-2")];
    for (const expanded of [new Set<string>(), new Set(["c0"])]) {
      const l = layoutWorkspaceGraph(nodes, [...crowd, ...lost], { expanded });
      expectNoCollisions(l, `expanded=${expanded.size}`);
      const box = l.unattachedBox!;
      const placed = [...l.labels.values()].filter((p) => !l.unattached.includes(p.id));
      for (const p of placed) {
        expect(p.y + p.h, `${p.id} ends above the strip`).toBeLessThanOrEqual(box.y);
        for (const b of p.badges) expect(b.y + b.h).toBeLessThanOrEqual(box.y);
      }
      for (const c of l.clusters) expect(c.y + c.h).toBeLessThanOrEqual(box.y);
    }
    // 25 expanded workspaces on one root plus one unattached: the old fixed offset overlapped
    const big = Array.from({ length: 25 }, (_, i) => ws(`b${String(i).padStart(2, "0")}`, "c0", [], `b-${i}`));
    const l = layoutWorkspaceGraph(commits("c", 1), [...big, ws("u", undefined)], { expanded: new Set(["c0"]) });
    expectNoCollisions(l, "25 expanded");
    expect(l.unattachedBox!.y).toBeGreaterThanOrEqual(
      Math.max(...[...l.labels.values()].filter((p) => p.id !== "u").map((p) => p.y + p.h)),
    );
  });

  test("a graph of only unattached workspaces is just the strip", () => {
    const l = layoutWorkspaceGraph([], [ws("a", undefined), ws("b", "x")]);
    expect(l.nodes.size).toBe(0);
    expect(l.ticks).toEqual([]);
    expect(l.labels.size).toBe(2);
    expect(l.unattachedBox).toBeDefined();
  });
});

describe("label placement", () => {
  test("no label, badge or cluster overlaps another or any node on the mockup graph", () => {
    const m = mockupGraph();
    for (const expanded of [new Set<string>(), new Set(["A0", "M4"])]) {
      const l = layoutWorkspaceGraph(m.nodes, m.workspaces, {
        trunkTip: m.trunkTip,
        expanded,
      });
      expectNoCollisions(l, "mockup");
      expect(l.labels.size + l.clusterOf.size).toBe(m.workspaces.length);
    }
  });

  test("no overlaps on seeded random DAGs with merges, shared revisions and 50 labels", () => {
    for (let seed = 1; seed <= 14; seed++) {
      const dag = randomDag(seed, 40 + seed * 8, {
        mergeRate: 0.2,
        roots: 1 + (seed % 3),
      });
      const w = randomWorkspaces(seed, dag, seed % 2 ? 50 : 25);
      const l = layoutWorkspaceGraph(dag, w, { expanded: new Set(dag.slice(0, 5).map((n) => n.key)) });
      expectNoCollisions(l, `seed ${seed}`);
    }
  });

  test("pills sit beside their node on the outward side and displaced ones carry a leader", () => {
    const m = mockupGraph();
    const l = layoutWorkspaceGraph(m.nodes, m.workspaces, {
      trunkTip: m.trunkTip,
      expanded: new Set(["A0"]),
    });
    let shown = 0;
    for (const p of l.labels.values()) {
      const n = l.nodes.get(p.revision_key)!;
      if (p.leader) {
        shown++;
        expect(p.leader.x1).toBeCloseTo(n.x, 1);
        expect(p.leader.y1).toBeCloseTo(n.y, 1);
        const edgeX = p.side === "right" ? p.x : p.x + p.w;
        expect(p.leader.x2).toBeCloseTo(edgeX, 1);
        expect(p.leader.y2).toBeGreaterThanOrEqual(p.y);
        expect(p.leader.y2).toBeLessThanOrEqual(p.y + p.h);
      } else {
        const near = p.side === "right" ? p.x - n.x : n.x - (p.x + p.w);
        expect(near).toBeGreaterThanOrEqual(NODE);
        expect(near).toBeLessThanOrEqual(40);
      }
      for (const b of p.badges) {
        expect(b.h).toBeLessThanOrEqual(p.h);
        expect(b.text.length).toBeGreaterThan(0);
      }
    }
    expect(shown).toBeGreaterThanOrEqual(0);
    // four stacks on neighbouring rows overfill both sides of the node, so some are displaced
    const chain = commits("n", 120);
    const stacked = layoutWorkspaceGraph(
      chain,
      ["n60", "n61", "n62", "n63"].flatMap((rev, g) =>
        [0, 1, 2].map((i) =>
          ws(`g${g}-${i}`, rev, g === 0 ? ["dirty"] : undefined, `stack${g}-${i}`),
        ),
      ),
    );
    const leaders = [...stacked.labels.values()].filter((p) => p.leader);
    expect(leaders.length).toBeGreaterThan(0);
    for (const p of leaders) {
      const n = stacked.nodes.get(p.revision_key)!;
      expect(p.leader!.x1).toBeCloseTo(n.x, 1);
      expect(p.leader!.y1).toBeCloseTo(n.y, 1);
    }
    expectNoCollisions(stacked);
    const heavy = layoutWorkspaceGraph(
      commits("n", 4),
      Array.from({ length: 20 }, (_, i) => ws(`w${i}`, "n3", ["dirty"], `name-${i}`)),
      { expanded: new Set(["n3"]) },
    );
    expect(heavy.labels.size).toBe(20);
    expectNoCollisions(heavy);
  });

  test("an expanded cluster keeps its header and pills on one side of the node", () => {
    const nodes = [
      ...commits("M", 14),
      ...commits("A", 6, "M8"),
      ...commits("L", 5, "M3"),
      node("Z", ["A3"]),
    ];
    const crowd = [
      ...["wt-07", "wt-07-alt", "wt-07-tests", "wt-07-fix", "wt-07-c", "wt-07-d", "wt-07-e"].map(
        (n) => ws(n, "A2", n === "wt-07" ? ["dirty"] : undefined, n),
      ),
      ws("wt-06", "A5"),
      ws("main", "M13"),
    ];
    const l = layoutWorkspaceGraph(nodes, crowd, {
      trunkTip: "M13",
      expanded: new Set(["A2"]),
    });
    const n = l.nodes.get("A2")!;
    const chip = l.clusters[0];
    const chipSide = chip.x + chip.w / 2 < n.x ? "left" : "right";
    expect(chip.expanded).toBe(true);
    const sides = new Set(
      [...l.labels.values()].filter((p) => p.revision_key === "A2").map((p) => p.side),
    );
    expect(sides).toEqual(new Set([chipSide]));
    expectNoCollisions(l);
  });

  test("badges are separate pills outside the pill and never overlap it", () => {
    const l = layoutWorkspaceGraph(commits("n", 3), [
      ws("a", "n2", ["dirty", "conflict"], "alpha"),
      ws("b", "n0", undefined, "beta"),
    ]);
    const a = l.labels.get("a")!;
    expect(a.badges.map((b) => b.text)).toEqual(["dirty", "conflict"]);
    expect(l.labels.get("b")!.badges).toEqual([]);
    for (const b of a.badges) expect(overlaps(b, a)).toBe(false);
    expect(a.h).toBe(24);
    expect(a.w).toBe(estimateLabelWidth("alpha"));
  });

  test("a pill reserves room for its state dot and a cluster chip for its exact text", () => {
    // text starts at x=10, runs ~6.7 px per character, and the dot (9 px) sits at the right edge
    for (const n of [8, 14, 24]) expect(estimateLabelWidth("x".repeat(n))).toBeGreaterThanOrEqual(10 + 6.7 * n + 22);
    const nodes = commits("n", 4);
    const crowd = Array.from({ length: 7 }, (_, i) => ws(`w${i}`, "n3", [], `wt-${i}`));
    const chip = layoutWorkspaceGraph(nodes, crowd).clusters[0];
    expect(chip.w).toBeGreaterThanOrEqual(10 + 6.7 * [..."7 workspaces ▸"].length + 22);
    const big = layoutWorkspaceGraph(nodes, Array.from({ length: 25 }, (_, i) => ws(`w${i}`, "n3", [], `wt-${i}`))).clusters[0];
    expect(big.w).toBeGreaterThanOrEqual(10 + 6.7 * [..."25 workspaces ▸"].length + 22);
  });

  test("estimateLabelWidth grows with the name, clamps to 60..200 and accounts for badges", () => {
    expect(estimateLabelWidth("a")).toBe(60);
    expect(estimateLabelWidth("x".repeat(80))).toBe(200);
    expect(estimateLabelWidth("wt-07-fix")).toBeGreaterThan(estimateLabelWidth("wt-07"));
    expect(estimateLabelWidth("wt-07", ["dirty"])).toBeGreaterThan(
      estimateLabelWidth("wt-07"),
    );
  });
});

describe("axis, fit and navigation", () => {
  test("depth ticks are monotonic, honest ranks and at most 40", () => {
    for (const nodes of [longChain(2000), mockupGraph().nodes, commits("c", 1), []]) {
      const l = layoutWorkspaceGraph(nodes, []);
      expect(l.ticks.length).toBeLessThanOrEqual(40);
      for (let i = 1; i < l.ticks.length; i++) {
        expect(l.ticks[i].rank).toBeGreaterThan(l.ticks[i - 1].rank);
        expect(l.ticks[i].y).toBeLessThan(l.ticks[i - 1].y);
      }
      for (const t of l.ticks) {
        expect(t.label).toBe(String(t.rank));
        expect(t.y).toBeCloseTo((l.maxRank - t.rank) * l.rowH, 5);
        expect(t.rank).toBeLessThanOrEqual(l.maxRank);
      }
    }
    const long = layoutWorkspaceGraph(longChain(2000), []);
    expect(long.maxRank).toBe(1999);
    expect(long.rowH).toBe(14);
    expect(long.ticks.length).toBeGreaterThan(5);
  });

  test("row height shrinks with depth between 14 and 34 and gaps stay above node size", () => {
    expect(layoutWorkspaceGraph(commits("c", 3), []).rowH).toBe(34);
    expect(layoutWorkspaceGraph(longChain(50), []).rowH).toBeCloseTo(1360 / 49, 5);
    expect(layoutWorkspaceGraph(longChain(200), []).rowH).toBe(14);
    expect(layoutWorkspaceGraph([], []).bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  test("bounds contain every node, label, badge and cluster", () => {
    const m = mockupGraph();
    const l = layoutWorkspaceGraph(m.nodes, [...m.workspaces, ws("lost", undefined)], {
      trunkTip: m.trunkTip,
    });
    for (const n of l.nodes.values()) expect(contains(l.bounds, n)).toBe(true);
    for (const b of boxes(l)) {
      expect(b.r.x).toBeGreaterThanOrEqual(l.bounds.x - 0.01);
      expect(b.r.x + b.r.w).toBeLessThanOrEqual(l.bounds.x + l.bounds.w + 0.01);
      expect(b.r.y).toBeGreaterThanOrEqual(l.bounds.y - 0.01);
      expect(b.r.y + b.r.h).toBeLessThanOrEqual(l.bounds.y + l.bounds.h + 0.01);
    }
  });

  test("fitBounds covers the focus tips and the fork floor but not an unrelated deep lane", () => {
    const nodes = [
      ...commits("T", 21),
      ...commits("X", 6, "T5"),
      ...commits("Y", 4, "T8"),
      ...commits("Z", 15, "T2"),
    ];
    const l = layoutWorkspaceGraph(
      nodes,
      [ws("wx", "X5"), ws("wy", "Y3"), ws("wt", "T20")],
      { trunkTip: "T20" },
    );
    const rect = fitBounds(l, ["wx", "wy"]);
    const inside = (key: string) =>
      contains(rect, l.nodes.get(key)!);
    expect(inside("X5")).toBe(true);
    expect(inside("Y3")).toBe(true);
    expect(inside("T5")).toBe(true); // lowest fork of the two tips
    expect(inside("T8")).toBe(true);
    expect(inside("T0")).toBe(false); // history below the fork floor
    expect(inside("Z14")).toBe(false); // unrelated deep lane
    expect(inside("T20")).toBe(false); // other active tip not in focus
    for (const id of ["wx", "wy"]) {
      const p = l.labels.get(id)!;
      expect(contains(rect, point(p))).toBe(true);
    }
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeLessThan(l.bounds.h);
  });

  test("fitBounds with a single tip keeps a little history; no focus returns the whole graph", () => {
    const nodes = commits("c", 30);
    const l = layoutWorkspaceGraph(nodes, [ws("w", "c29")]);
    const rect = fitBounds(l, ["w"]);
    expect(contains(rect, l.nodes.get("c29")!)).toBe(true);
    expect(contains(rect, l.nodes.get("c26")!)).toBe(true);
    expect(contains(rect, l.nodes.get("c10")!)).toBe(false);
    expect(fitBounds(l)).toEqual(l.bounds);
    expect(fitBounds(l, [])).toEqual(l.bounds);
    expect(fitBounds(l, ["missing"])).toEqual(l.bounds);
  });

  test("fitBounds includes the pill of a clustered focus tip", () => {
    const nodes = commits("c", 5);
    const crowd = Array.from({ length: 6 }, (_, i) => ws(`w${i}`, "c4"));
    const l = layoutWorkspaceGraph(nodes, crowd);
    const rect = fitBounds(l, ["w3"]);
    expect(contains(rect, point(l.clusters[0]))).toBe(true);
  });

  test("focusPoint of a clustered member returns the chip; pills return their centre", () => {
    const nodes = commits("c", 5);
    const crowd = Array.from({ length: 25 }, (_, i) => ws(`w${i}`, "c4"));
    const collapsed = layoutWorkspaceGraph(nodes, crowd);
    const chip = point(collapsed.clusters[0]);
    for (const w of crowd) expect(focusPoint(collapsed, w.id)).toEqual(chip);
    const open = layoutWorkspaceGraph(nodes, crowd, { expanded: new Set(["c4"]) });
    expect(focusPoint(open, "w7")).toEqual(point(open.labels.get("w7")!));
    expect(focusPoint(open, "nope")).toBeUndefined();
    const single = layoutWorkspaceGraph(nodes, [ws("solo", "c2")]);
    expect(focusPoint(single, "solo")).toEqual(point(single.labels.get("solo")!));
    const lost = layoutWorkspaceGraph(nodes, [ws("lost", undefined)]);
    expect(focusPoint(lost, "lost")).toEqual(point(lost.labels.get("lost")!));
  });

  test("neighborLabel moves in the requested direction and never to itself", () => {
    const m = mockupGraph();
    const l = layoutWorkspaceGraph(m.nodes, m.workspaces, { trunkTip: m.trunkTip });
    const ids = [...l.labels.keys()];
    let moves = 0;
    for (const id of ids) {
      const from = focusPoint(l, id)!;
      for (const dir of ["up", "down", "left", "right"] as const) {
        const to = neighborLabel(l, id, dir);
        if (to === undefined) continue;
        moves++;
        expect(to).not.toBe(id);
        const p = focusPoint(l, to)!;
        if (dir === "up") expect(p.y).toBeLessThan(from.y);
        if (dir === "down") expect(p.y).toBeGreaterThan(from.y);
        if (dir === "left") expect(p.x).toBeLessThan(from.x);
        if (dir === "right") expect(p.x).toBeGreaterThan(from.x);
      }
    }
    expect(moves).toBeGreaterThan(ids.length * 2);
    expect(neighborLabel(l, "no-such-workspace", "up")).toBeUndefined();
  });

  test("neighborLabel picks the nearest label in the direction", () => {
    const nodes = commits("t", 30);
    const l = layoutWorkspaceGraph(nodes, [
      ws("low", "t4"),
      ws("mid", "t14"),
      ws("high", "t28"),
    ]);
    expect(neighborLabel(l, "low", "up")).toBe("mid");
    expect(neighborLabel(l, "mid", "up")).toBe("high");
    expect(neighborLabel(l, "high", "down")).toBe("mid");
    expect(neighborLabel(l, "mid", "down")).toBe("low");
    expect(neighborLabel(l, "high", "up")).toBeUndefined();
    expect(neighborLabel(l, "low", "down")).toBeUndefined();
  });

  test("neighborLabel treats a collapsed cluster as one stop", () => {
    const nodes = commits("t", 12);
    const l = layoutWorkspaceGraph(nodes, [
      ...Array.from({ length: 5 }, (_, i) => ws(`c${i}`, "t10")),
      ws("below", "t2"),
    ]);
    expect(neighborLabel(l, "below", "up")).toBe("c0");
    expect(neighborLabel(l, "c3", "down")).toBe("below");
  });
});

describe("determinism and scale", () => {
  test("output is deep-equal after shuffling nodes, parents-independent order and workspaces", () => {
    const m = mockupGraph();
    const opts = { trunkTip: m.trunkTip, expanded: new Set(["A0"]) };
    const base = layoutWorkspaceGraph(m.nodes, m.workspaces, opts);
    for (const seed of [1, 2, 3]) {
      const other = layoutWorkspaceGraph(
        shuffle(seed, m.nodes),
        shuffle(seed + 100, m.workspaces),
        opts,
      );
      expect(other).toEqual(base);
      expect(JSON.stringify([...other.nodes])).toBe(JSON.stringify([...base.nodes]));
    }
    const dag = randomDag(21, 120, { mergeRate: 0.25, roots: 2 });
    const w = randomWorkspaces(21, dag, 40);
    const ref = layoutWorkspaceGraph(dag, w);
    expect(layoutWorkspaceGraph(shuffle(5, dag), shuffle(6, w))).toEqual(ref);
    expect(layoutWorkspaceGraph(dag, w)).toEqual(ref);
  });

  test("perfBudget is strict only when FIREHOSE_GRAPH_PERF=1", () => {
    expect(perfBudget(400, {})).toBe(4000);
    expect(perfBudget(400, { FIREHOSE_GRAPH_PERF: "0" })).toBe(4000);
    expect(perfBudget(400, { FIREHOSE_GRAPH_PERF: "1" })).toBe(400);
  });

  test("a 2,000-commit chain with 50 labels lays out in under 400 ms", () => {
    const nodes = longChain(2000);
    const workspaces = Array.from({ length: 50 }, (_, i) =>
      ws(`w${i}`, `c${40 + i * 38}`, i % 3 ? [] : ["dirty"], `wt-${i}`),
    );
    layoutWorkspaceGraph(nodes, workspaces); // warm up the JIT before timing
    const t0 = performance.now();
    const l = layoutWorkspaceGraph(nodes, workspaces);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(perfBudget(400));
    expect(l.nodes.size).toBe(2000);
    expect(l.labels.size + l.clusterOf.size).toBe(50);
    expect(l.ticks.length).toBeLessThanOrEqual(40);
  });

  test("a 2,000-commit branching graph with 50 labels lays out in under 400 ms and stays collision free", () => {
    const nodes = branchingGraph(42, 2000);
    const workspaces = randomWorkspaces(42, nodes, 50);
    layoutWorkspaceGraph(nodes, workspaces); // warm up the JIT before timing
    const t0 = performance.now();
    const l = layoutWorkspaceGraph(nodes, workspaces);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(perfBudget(400));
    expect(l.nodes.size).toBe(2000);
    expect(l.edges.length).toBe(pairs(nodes).length);
    expectNoCollisions(l, "branching");
    const focus = workspaces.slice(0, 10).map((w) => w.id);
    fitBounds(l, focus);
    const t1 = performance.now();
    fitBounds(l, focus);
    expect(performance.now() - t1).toBeLessThan(perfBudget(100));
  });

  test("a star of 300 siblings and an empty graph still produce valid layouts", () => {
    const star = [node("root", []), ...Array.from({ length: 300 }, (_, i) => node(`k${String(i).padStart(3, "0")}`, ["root"]))];
    const l = layoutWorkspaceGraph(star, [ws("w", "k150")]);
    expect(l.nodes.size).toBe(301);
    const seen = new Set<string>();
    for (const n of l.nodes.values()) {
      const slot = `${n.x},${n.y}`;
      expect(seen.has(slot)).toBe(false);
      seen.add(slot);
    }
    const empty = layoutWorkspaceGraph([], [ws("w", "x")]);
    expect(empty.unattached).toEqual(["w"]);
    expect(empty.nodes.size).toBe(0);
  });
});
