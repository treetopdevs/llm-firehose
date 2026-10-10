import type { GraphNode } from "./model";
import type { LayoutWorkspace } from "./layout";

/** Test fixtures for the layout engine: seeded DAGs and a mockup-shaped graph. No test runner imports. */

type Env = Record<string, string | undefined>;
const processEnv = (): Env =>
  (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/**
 * Wall-clock budget for a timing assertion. Strict only with FIREHOSE_GRAPH_PERF=1
 * (like the Go perf test); otherwise 10× headroom, which still catches an
 * algorithmic regression at 2,000 nodes but not a loaded shared CI runner.
 */
export function perfBudget(ms: number, env: Env = processEnv()): number {
  return env.FIREHOSE_GRAPH_PERF === "1" ? ms : ms * 10;
}

/** mulberry32: small deterministic PRNG so every fixture is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function node(key: string, parents: string[] = []): GraphNode {
  return {
    key,
    parents,
    commit_id: key.padEnd(40, "0"),
    description: `commit ${key}`,
    timestamp: "2026-10-08T00:00:00Z",
  };
}

/** `count` commits named prefix0..prefix(count-1); the first has `parent` (if given). */
export function commits(
  prefix: string,
  count: number,
  parent?: string,
): GraphNode[] {
  const out: GraphNode[] = [];
  for (let i = 0; i < count; i++)
    out.push(
      node(
        `${prefix}${i}`,
        i === 0 ? (parent ? [parent] : []) : [`${prefix}${i - 1}`],
      ),
    );
  return out;
}

export function ws(
  id: string,
  revision_key: string | undefined,
  badges?: string[],
  name = id,
): LayoutWorkspace {
  return { id, revision_key, name, badges };
}

/** Deterministic Fisher-Yates using the seeded generator. */
export function shuffle<T>(seed: number, items: readonly T[]): T[] {
  const r = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface DagOptions {
  /** probability a new commit starts a branch from a random earlier commit */
  branchRate?: number;
  /** probability a new commit also gets a second (merge) parent */
  mergeRate?: number;
  /** number of independent histories (default 1) */
  roots?: number;
  /** give the first root of each history an omitted parent */
  omitRoots?: boolean;
}

/**
 * Random DAG: each new commit extends a recent tip (first parent), sometimes
 * forks from an arbitrary earlier commit, sometimes gains a second parent.
 */
export function randomDag(
  seed: number,
  size: number,
  opts: DagOptions = {},
): GraphNode[] {
  const r = rng(seed);
  const { branchRate = 0.25, mergeRate = 0, roots = 1, omitRoots } = opts;
  const nodes: GraphNode[] = [];
  const tips: string[][] = [];
  for (let h = 0; h < roots; h++) {
    const key = `h${h}n0`;
    nodes.push(node(key, omitRoots ? [`omitted-${h}`] : []));
    tips.push([key]);
  }
  for (let i = roots; i < size; i++) {
    const h = i % roots;
    const own = nodes.filter((n) => n.key.startsWith(`h${h}n`));
    const key = `h${h}n${own.length}`;
    let parent: string;
    if (r() < branchRate && own.length > 1)
      parent = own[Math.floor(r() * own.length)].key;
    else {
      const t = tips[h];
      parent = t[Math.floor(r() * Math.min(t.length, 3)) % t.length];
    }
    const parents = [parent];
    if (own.length > 3 && r() < mergeRate) {
      const other = own[Math.floor(r() * own.length)].key;
      if (other !== parent) parents.push(other);
    }
    nodes.push(node(key, parents));
    tips[h] = [key, ...tips[h].filter((t) => t !== parent)].slice(0, 6);
  }
  return nodes;
}

/** Attach `count` workspaces to random commits (sharing allowed); some get badges. */
export function randomWorkspaces(
  seed: number,
  nodes: readonly GraphNode[],
  count: number,
): LayoutWorkspace[] {
  const r = rng(seed ^ 0x9e3779b9);
  const out: LayoutWorkspace[] = [];
  for (let i = 0; i < count; i++) {
    const at = nodes[Math.floor(r() * nodes.length)];
    const badges = r() < 0.25 ? ["dirty"] : r() < 0.08 ? ["conflict"] : [];
    out.push(ws(`w${String(i).padStart(3, "0")}`, at.key, badges, `wt-${i}`));
  }
  return out;
}

export function longChain(count: number): GraphNode[] {
  return commits("c", count);
}

/** Linear spine with many short side branches; ~`size` commits in total. */
export function branchingGraph(seed: number, size: number): GraphNode[] {
  const r = rng(seed);
  const nodes = commits("s", Math.max(2, Math.floor(size * 0.55)));
  const spine = nodes.map((n) => n.key);
  let b = 0;
  while (nodes.length < size) {
    const fork = spine[Math.floor(r() * (spine.length - 1))];
    const length = 1 + Math.floor(r() * 8);
    const made = commits(`b${b++}_`, Math.min(length, size - nodes.length), fork);
    nodes.push(...made);
  }
  return nodes;
}

export interface FixtureGraph {
  nodes: GraphNode[];
  workspaces: LayoutWorkspace[];
  trunkTip: string;
  /** the wt-07 anchor family (selected in the mockup) */
  family: string[];
}

/**
 * Mockup-shaped history: trunk M0..M12 with the default branch tip on M12,
 * lanes of varied depth on both sides, an anchor revision with seven
 * worktrees around it, a deep lane with short forks, two merge commits (one
 * merging a sibling lane, one merging main into a feature), a detached
 * worktree at an interior commit, and a small disconnected history.
 * 25 workspaces over ~120 commits.
 */
export function mockupGraph(): FixtureGraph {
  const nodes: GraphNode[] = [];
  const add = (list: GraphNode[]) => {
    nodes.push(...list);
    return list;
  };
  const trunk = add(commits("M", 13));
  const M = (i: number) => trunk[i].key;

  // deep left lane off M3 with three short forks
  const deep = add(commits("D", 18, M(3)));
  const D = (i: number) => deep[i].key;
  const dF1 = add(commits("DFa", 2, D(4)));
  const dF2 = add(commits("DFb", 3, D(9)));
  const dF3 = add(commits("DFc", 1, D(14)));

  // anchor lane: A (child of M9) and a lane of commits with forks along it
  const lane = add(commits("A", 7, M(9)));
  const A = (i: number) => lane[i].key;
  const f7tests = add(commits("Ft", 2, A(3)));
  const f7alt = add(commits("Fa", 1, A(5)));
  const f7fix = add(commits("Ff", 3, A(6)));

  // assorted branches at varied depths
  const bR1 = add(commits("R1_", 8, M(2)));
  const bL1 = add(commits("L1_", 6, M(5)));
  const bR2 = add(commits("R2_", 12, M(7)));
  const bR3 = add(commits("R3_", 5, M(10)));
  const bL2 = add(commits("L2_", 3, M(11)));
  const bT = add(commits("T", 2, M(12)));
  add(commits("S", 4, M(4)));

  // two merges: a sibling lane merged into another, and main merged into a feature
  const merge1 = node("MG1", [bR2[8].key, bR1[6].key]);
  const merge2 = node("MG2", [bL1[5].key, M(8)]);
  add([merge1, merge2]);
  const tailR2 = add(commits("R2t", 2, "MG1"));
  const tailL1 = add(commits("L1t", 2, "MG2"));

  // small disconnected history
  const island = add(commits("I", 3));

  const dirty = ["dirty"];
  const workspaces: LayoutWorkspace[] = [
    ws("wt-01", bL2[2].key, undefined, "wt-01"),
    ws("wt-02", bL1[3].key, dirty, "wt-02"),
    ws("wt-03", D(6), undefined, "wt-03"), // detached at an interior commit
    ws("wt-04", dF1[1].key, undefined, "wt-04"),
    ws("wt-05", dF2[2].key, dirty, "wt-05"),
    ws("wt-06", dF3[0].key, undefined, "wt-06"),
    ws("wt-07", A(0), dirty, "wt-07"),
    ws("wt-07-alt", A(0), undefined, "wt-07-alt"),
    ws("wt-07-tests", f7tests[1].key, undefined, "wt-07-tests"),
    ws("wt-07-fix", f7fix[2].key, undefined, "wt-07-fix"),
    ws("wt-07-c", f7alt[0].key, dirty, "wt-07-c"),
    ws("wt-07-d", A(1), undefined, "wt-07-d"),
    ws("wt-07-tip", A(6), undefined, "wt-07-tip"),
    ws("wt-08", bR1[7].key, undefined, "wt-08"),
    ws("wt-09", bR1[4].key, undefined, "wt-09"),
    ws("wt-10", M(4), undefined, "wt-10"),
    ws("wt-11", M(4), undefined, "wt-11"), // second worktree on the shared trunk revision
    ws("wt-12", tailR2[1].key, dirty, "wt-12"),
    ws("wt-13", bR3[4].key, undefined, "wt-13"),
    ws("wt-14", bT[1].key, undefined, "wt-14"),
    ws("wt-15", D(17), undefined, "wt-15"),
    ws("wt-16", tailL1[1].key, ["conflict"], "wt-16"),
    ws("wt-17", island[2].key, undefined, "wt-17"),
    ws("wt-18", bR2[11].key, dirty, "wt-18"),
    ws("main", M(12), undefined, "main"),
  ];
  return {
    nodes,
    workspaces,
    trunkTip: M(12),
    family: workspaces.filter((w) => w.id.startsWith("wt-07")).map((w) => w.id),
  };
}
