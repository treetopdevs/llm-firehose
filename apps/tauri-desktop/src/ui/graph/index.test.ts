// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createWorkspaceGraph } from "./index";
import { graphAPI, type Snapshot, type Workspace } from "./api";
import { attention, getConfig, type AttentionSession } from "../../api";
vi.mock("../../api", () => ({
  DAEMON_URL: "http://127.0.0.1:4517",
  attention: vi.fn(async () => ({ sessions: [] })),
  getConfig: vi.fn(async () => ({ privacy_mode: "balanced" })),
}));
vi.mock("./api", () => ({
  graphAPI: {
    repos: vi.fn(),
    snapshot: vi.fn(),
    timeline: vi.fn(),
    compare: vi.fn(),
    register: vi.fn(),
  },
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const flush = async () => {
  // microtask turns, enough for the scan, the parallel session request and the draws that follow
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const click = (root: HTMLElement, name: string) => {
  [...root.querySelectorAll("button")]
    .find((b) => b.textContent === name)!
    .click();
};
async function setup() {
  vi.stubGlobal("setInterval", () => 0);
  vi.mocked(graphAPI.repos).mockResolvedValue([
    { id: "r", vcs: "git", label: "repo", status: "ok", observed_at: "" },
  ]);
  vi.mocked(graphAPI.snapshot).mockResolvedValue({
    repository: {
      id: "r",
      vcs: "git",
      label: "repo",
      status: "ok",
      observed_at: "",
    },
    generation: "1",
    nodes: [
      {
        key: "a",
        commit_id: "a",
        parents: [],
        description: "root",
        timestamp: "",
      },
    ],
    workspaces: [
      {
        id: "w",
        repo_id: "r",
        label: "workspace one",
        revision: "a",
        refs: [],
        dirty: false,
        conflicted: false,
        availability: "available",
        unborn: false,
      },
    ],
    boundaries: [],
    warnings: [],
    stale: false,
  });
  vi.mocked(graphAPI.timeline).mockResolvedValue({
    events: [
      {
        id: "e",
        time: "2026-10-04T00:00:00Z",
        source: "codex",
        session_id: "s",
        category: "tool",
        name: "tool.completed",
        summary: "captured",
        repo_id: "r",
        worktree_id: "w",
      },
    ],
    has_more: true,
    next_cursor: "older",
    order: "newest_first",
  });
  const panel = createWorkspaceGraph(() => {});
  document.body.append(panel.root);
  await panel.refresh();
  await flush();
  return panel;
}
test("all workspace labels remain selectable; Graph and Timeline retain scope and selected event after live arrival", async () => {
  const panel = await setup();
  const label = panel.root.querySelector<SVGGElement>(".workspace-label")!;
  label.dispatchEvent(new MouseEvent("click"));
  await flush();
  click(panel.root, "Open scoped Timeline");
  await flush();
  expect(
    panel.root.querySelector<HTMLSelectElement>('[aria-label="Workspace"]')!
      .value,
  ).toBe("w");
  panel.root.querySelector<HTMLElement>('[data-key="event:e"]')!.click();
  expect(
    panel.root.querySelector(".graph-event-detail")!.textContent,
  ).toContain("captured");
  click(panel.root, "● Live · pause");
  panel.onEvent({
    id: "new",
    time: "2026-10-05T00:00:00Z",
    source: "codex",
    category: "tool",
    repo_id: "r",
    worktree_id: "w",
  });
  expect(panel.root.textContent).toContain("Resume · 1 arrivals");
  expect(panel.root.querySelectorAll(".graph-events tbody tr")).toHaveLength(1);
  click(panel.root, "Graph");
  click(panel.root, "Timeline");
  expect(
    panel.root.querySelector(".graph-event-detail")!.textContent,
  ).toContain("captured");
  click(panel.root, "Load older events");
  await flush();
  expect(graphAPI.timeline).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "older", workspace_id: "w", limit: "250" }),
    expect.any(AbortSignal),
  );
});
test("Show in Graph reports deleted workspace and failed scans keep successful topology", async () => {
  const panel = await setup();
  panel.onEvent({
    id: "gone",
    time: "2026-10-05T00:00:00Z",
    source: "codex",
    category: "tool",
    repo_id: "r",
    worktree_id: "deleted",
  });
  click(panel.root, "Timeline");
  await flush();
  panel.root
    .querySelector<HTMLButtonElement>('[data-key="event:gone"] button')!
    .click();
  expect(panel.root.querySelector(".graph-status")!.textContent).toContain(
    "Workspace unavailable",
  );
  vi.mocked(graphAPI.snapshot).mockRejectedValueOnce(new Error("failed"));
  await panel.refresh();
  click(panel.root, "Graph");
  expect(panel.root.querySelectorAll(".workspace-label")).toHaveLength(1);
  expect(panel.root.querySelector(".graph-status")!.textContent).toContain(
    "Stale",
  );
});

test("privacy transitions discard old graph labels even if the replacement scan fails", async () => {
  const panel = await setup();
  vi.mocked(getConfig).mockResolvedValueOnce({ privacy_mode: "minimal" });
  vi.mocked(graphAPI.snapshot).mockRejectedValueOnce(new Error("scan failed"));
  await panel.refresh();
  expect(panel.root.querySelectorAll(".workspace-label")).toHaveLength(0);
  expect(panel.root.textContent).not.toContain("workspace one");
});

test("paused live arrivals preserve timeline scroll position", async () => {
  const panel = await setup();
  click(panel.root, "Timeline");
  await flush();
  click(panel.root, "● Live · pause");
  panel.root.querySelector<HTMLElement>(".graph-timeline")!.scrollTop = 240;
  panel.onEvent({
    id: "arrival",
    time: "2026-10-05T00:00:00Z",
    source: "codex",
    category: "tool",
    repo_id: "r",
    worktree_id: "w",
  });
  expect(
    panel.root.querySelector<HTMLElement>(".graph-timeline")!.scrollTop,
  ).toBe(240);
});
test("Timeline workspace change updates revision and Show in Graph centers its anchor", async () => {
  const panel = await setup();
  const snap = await graphAPI.snapshot("r");
  snap.nodes.push({
    key: "b",
    commit_id: "b",
    parents: ["a"],
    description: "second",
    timestamp: "",
  });
  snap.workspaces.push({
    ...snap.workspaces[0],
    id: "w2",
    label: "second workspace",
    revision: "b",
  });
  await panel.refresh();
  await flush();
  panel.root
    .querySelector<SVGGElement>('[data-key="workspace:w"]')!
    .dispatchEvent(new MouseEvent("click"));
  click(panel.root, "Timeline");
  await flush();
  const ws = panel.root.querySelector<HTMLSelectElement>(
    '[aria-label="Workspace"]',
  )!;
  ws.value = "w2";
  ws.dispatchEvent(new Event("change"));
  click(panel.root, "Graph");
  expect(
    panel.root
      .querySelector('[data-key="revision:b"]')
      ?.classList.contains("selected"),
  ).toBe(true);
  expect(panel.root.querySelector(".graph-inspector code")?.textContent).toBe(
    "b",
  );
  panel.onEvent({
    id: "second",
    time: "2026-10-05T00:00:00Z",
    source: "codex",
    category: "tool",
    repo_id: "r",
    worktree_id: "w2",
  });
  click(panel.root, "Timeline");
  await flush();
  panel.root
    .querySelector<HTMLButtonElement>('[data-key="event:second"] button')!
    .click();
  expect(
    panel.root.querySelector(".graph-canvas > g")!.getAttribute("transform"),
  ).toContain("scale(1)");
});
test("All shows the whole deep history while Fit keeps the readable scale on the tips", async () => {
  const panel = await setup();
  const snap = await graphAPI.snapshot("r");
  snap.nodes = Array.from({ length: 2000 }, (_, i) => ({
    key: String(i),
    commit_id: String(i),
    parents: i < 1999 ? [String(i + 1)] : [],
    description: "",
    timestamp: "",
  }));
  snap.workspaces[0].revision = "0";
  await panel.refresh();
  await flush();
  const scale = () =>
    Number(
      panel.root
        .querySelector(".graph-canvas > g")!
        .getAttribute("transform")!
        .match(/scale\(([^)]+)/)![1],
    );
  click(panel.root, "All");
  expect(scale()).toBeLessThan(0.1);
  click(panel.root, "Fit");
  expect(scale()).toBeGreaterThanOrEqual(0.4);
});

// ---- mockup-fidelity behaviour -------------------------------------------------

const digest = (c: string) => c.repeat(64);
const node = (key: string, parents: string[] = []) => ({
  key,
  commit_id: key.padEnd(40, "0"),
  parents,
  description: `commit ${key}`,
  timestamp: "2026-10-01T00:00:00Z",
});
function workspace(id: string, revision: string, over: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repo_id: "r",
    label: digest("a"),
    revision,
    refs: [`refs/heads/${id}`],
    dirty: false,
    conflicted: false,
    availability: "available",
    unborn: false,
    ...over,
  };
}
function richSnapshot(): Snapshot {
  const nodes = [
    node("m0"),
    node("m1", ["m0"]),
    node("m2", ["m1"]),
    node("m3", ["m2"]),
    node("f1", ["m1"]),
    node("f2", ["f1"]),
    node("g", ["m3", "f2"]),
    node("h", ["g"]),
  ];
  const workspaces = [
    workspace("main", "m3"),
    workspace("agent/cache-fix", "f2", {
      id: "fix",
      dirty: true,
      changes: [
        { path: "session.go", status: "M", additions: 42, deletions: 11 },
        { path: "graph.go", status: "M", additions: 18, deletions: 6 },
        { path: "graph_test.go", status: "M", additions: 120, deletions: 4 },
      ],
      refs: ["refs/heads/agent/cache-fix"],
    }),
    workspace("tip", "h", { refs: ["refs/heads/tip"] }),
    ...["c1", "c2", "c3", "c4", "c5"].map((id) => workspace(id, "m0")),
  ];
  return {
    repository: {
      id: "r",
      vcs: "git",
      label: digest("c"),
      status: "ok",
      observed_at: "",
    },
    generation: "1",
    nodes,
    workspaces,
    boundaries: [],
    warnings: [],
    stale: false,
    default_target: "m3".padEnd(40, "0"),
    default_target_ref: "main",
  };
}
const agentSession = (
  id: string,
  source: string,
  worktree: string,
  state = "working",
): AttentionSession => ({
  id,
  source,
  repo_id: "r",
  worktree_id: worktree,
  events: 3,
  state,
  last: {
    event_id: `${source}-${id}`,
    source,
    kind: "tool",
    summary: "",
    time: new Date().toISOString(),
    observed_at: "",
  },
});
async function richSetup(
  opts: { snapshot?: Snapshot; sessions?: AttentionSession[]; mode?: string } = {},
) {
  vi.stubGlobal("setInterval", () => 0);
  vi.mocked(getConfig).mockResolvedValue({ privacy_mode: opts.mode ?? "balanced" });
  vi.mocked(attention).mockResolvedValue({ sessions: opts.sessions ?? [], warnings: [] });
  const snapshot = opts.snapshot ?? richSnapshot();
  vi.mocked(graphAPI.repos).mockResolvedValue([
    { id: "r", vcs: "git", label: snapshot.repository.label, status: "ok", observed_at: "" },
  ]);
  vi.mocked(graphAPI.snapshot).mockResolvedValue(snapshot);
  vi.mocked(graphAPI.timeline).mockResolvedValue({
    events: [],
    has_more: false,
    order: "newest_first",
  });
  vi.mocked(graphAPI.compare).mockResolvedValue({
    selected: "",
    target: "",
    selected_only: ["a", "b", "c", "d"],
    target_only: [],
    merge_bases: [],
    changed_files: [],
    disconnected: false,
    warnings: [],
  });
  const panel = createWorkspaceGraph(() => {});
  document.body.append(panel.root);
  await panel.refresh();
  await flush();
  return { panel, root: panel.root, snapshot };
}
const q = (root: HTMLElement, sel: string) => root.querySelector<SVGElement & HTMLElement>(sel)!;
const qa = (root: HTMLElement, sel: string) => [...root.querySelectorAll<SVGElement & HTMLElement>(sel)];
const label = (root: HTMLElement, id: string) => q(root, `[data-key="workspace:${id}"]`);
const scaleOf = (root: HTMLElement) =>
  Number(q(root, ".graph-canvas > g").getAttribute("transform")!.match(/scale\(([^)]+)/)![1]);
const translateOf = (root: HTMLElement) => {
  const m = q(root, ".graph-canvas > g").getAttribute("transform")!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};

test("header shows the repository, the worktree count and search with its shortcut; there is no permanent workspace list", async () => {
  const { root } = await richSetup();
  expect(q(root, ".graph-repo select").selectedOptions[0].textContent).toBe("repo cccccccc");
  expect(q(root, ".graph-count").textContent).toBe("8 worktrees");
  expect(q(root, 'input[aria-label="Search graph"]')).toBeTruthy();
  expect(q(root, ".graph-search-hint").textContent).toBe("⌘K");
  expect(root.querySelector(".graph-workspace-list")).toBeNull();
  expect(root.querySelector(".graph-controls")).toBeNull();
  expect(qa(root, ".graph-tabs button").map((b) => b.textContent)).toEqual(["Graph", "Timeline"]);
  expect(qa(root, ".graph-fit button").map((b) => b.textContent)).toEqual(["Fit", "All"]);
});

test("labels are compact pills: short name, state dot and a separate dirty badge", async () => {
  const { root } = await richSetup();
  const pill = label(root, "fix");
  expect(pill.querySelector("text")!.textContent).toBe("agent/cache-fix");
  expect(pill.querySelector(".agent-dot")).toBeTruthy();
  expect(pill.querySelector(".label-badge")!.textContent).toBe("dirty");
  expect(label(root, "main").querySelector(".label-badge")).toBeNull();
});

test("more than three labels on a revision show a counted cluster that expands on click", async () => {
  const { root } = await richSetup();
  expect(qa(root, ".workspace-label")).toHaveLength(3);
  const cluster = q(root, ".workspace-cluster");
  expect(cluster.textContent).toContain("5 workspaces");
  cluster.dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(qa(root, ".workspace-label")).toHaveLength(8);
  expect(q(root, ".workspace-cluster").getAttribute("aria-expanded")).toBe("true");
  q(root, ".workspace-cluster").dispatchEvent(new MouseEvent("click"));
  expect(qa(root, ".workspace-label")).toHaveLength(3);
});

test("a workspace hidden in a cluster is reachable by search and its cluster expands for the selection", async () => {
  const { root } = await richSetup();
  const input = q(root, 'input[aria-label="Search graph"]') as unknown as HTMLInputElement;
  input.focus();
  input.value = "c3";
  input.dispatchEvent(new Event("input"));
  const option = qa(root, '[role="option"]').find((o) => o.textContent!.includes("c3"))!;
  option.click();
  await flush();
  expect(label(root, "c3").classList.contains("selected")).toBe(true);
  expect(qa(root, ".workspace-label")).toHaveLength(8);
});

test("selecting a workspace highlights its ancestry and dims the rest, which stays clickable", async () => {
  const { root } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  const selected = (k: string) => q(root, `[data-key="revision:${k}"]`).classList.contains("selected");
  expect(["f2", "f1", "m1", "m0"].map(selected)).toEqual([true, true, true, true]);
  expect(["m3", "g", "h"].map(selected)).toEqual([false, false, false]);
  expect(q(root, ".graph-viewport").classList.contains("has-selection")).toBe(true);
  expect(label(root, "fix").classList.contains("selected")).toBe(true);
  expect(label(root, "tip").classList.contains("related")).toBe(false);
  // the dimmed label still selects
  label(root, "tip").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(label(root, "tip").classList.contains("selected")).toBe(true);
  expect(selected("g")).toBe(true);
  // and so does a dimmed revision node
  q(root, '[data-key="revision:m2"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(q(root, ".graph-inspector code")!.textContent).toBe("m2".padEnd(40, "0"));
});

test("descendants are a separate toggle", async () => {
  const { root } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  click(root, "Show descendants");
  const selected = (k: string) => q(root, `[data-key="revision:${k}"]`).classList.contains("selected");
  expect(["f2", "g", "h"].map(selected)).toEqual([true, true, true]);
  expect(selected("m3")).toBe(false);
  expect(selected("f1")).toBe(false);
  click(root, "Highlight ancestry");
  expect(selected("f1")).toBe(true);
  expect(selected("h")).toBe(false);
});

test("merge parents are drawn: one edge per parent link, the second parent dotted", async () => {
  const { root, snapshot } = await richSetup();
  const links = snapshot.nodes.reduce((n, x) => n + x.parents.length, 0);
  expect(qa(root, ".ancestry-edge")).toHaveLength(links);
  expect(qa(root, ".ancestry-edge.dotted")).toHaveLength(1);
  expect(q(root, '[data-key="revision:g"]').classList.contains("merge")).toBe(true);
});

test("selection and attention refreshes recolor the dot without recreating the svg", async () => {
  const { panel, root } = await richSetup();
  const svg = q(root, ".graph-canvas");
  const dot = label(root, "fix").querySelector(".agent-dot")!;
  const node = q(root, '[data-key="revision:f2"]');
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(q(root, ".graph-canvas")).toBe(svg);
  vi.mocked(attention).mockResolvedValue({ sessions: [agentSession("s1", "codex", "fix")], warnings: [] });
  panel.onEvent({ id: "x", time: new Date().toISOString(), source: "codex", category: "tool", repo_id: "r", worktree_id: "fix" });
  await new Promise((r) => setTimeout(r, 560));
  await flush();
  expect(q(root, ".graph-canvas")).toBe(svg);
  expect(q(root, '[data-key="revision:f2"]')).toBe(node);
  expect(label(root, "fix").querySelector(".agent-dot")).toBe(dot);
  expect(dot.getAttribute("class")).toContain("state-working");
  expect(node.getAttribute("class")).toContain("state-working");
});

test("the inspector shows branch, agents, comparison, changes, activity and the honest origin", async () => {
  const sessions = [
    agentSession("same", "codex", "fix"),
    agentSession("same", "claude-code", "fix", "idle"),
  ];
  const { panel, root } = await richSetup({ sessions });
  const now = Date.now();
  vi.mocked(graphAPI.timeline).mockResolvedValue({
    events: ["a", "b", "c", "d"].map((id, i) => ({
      id: `ev-${id}`,
      time: new Date(now - (i + 1) * 120_000).toISOString(),
      source: "codex",
      session_id: "same",
      category: "tool",
      summary: `event ${id}`,
      repo_id: "r",
      worktree_id: "fix",
    })),
    has_more: false,
    order: "newest_first",
  });
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  await flush();
  const pane = q(root, ".graph-inspector");
  expect(pane.querySelector("h3")!.textContent).toBe("agent/cache-fix");
  expect(pane.textContent).toContain("agent/cache-fix");
  expect(pane.querySelector('[aria-label="Copy branch name"]')).toBeTruthy();
  const rows = qa(root, ".agent-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Codex");
  expect(rows[1].textContent).toContain("Claude Code");
  const compare = pane.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  expect(compare.selectedOptions[0].textContent).toBe("main");
  expect(graphAPI.compare).toHaveBeenCalledWith("r", "f2", "m3".padEnd(40, "0"));
  expect(pane.textContent).toContain("4 unique commits");
  expect(pane.textContent).toContain("3 uncommitted files");
  expect(pane.textContent).toMatch(/\d+ shared ancestors? loaded/);
  expect(pane.querySelector(".insp-changes h4")!.textContent).toBe("Changes (3 files)");
  expect(pane.querySelector(".insp-changes")!.textContent).toContain("+42");
  expect(pane.querySelector(".insp-changes")!.textContent).toContain("-11");
  const activity = [...pane.querySelectorAll(".activity-row")];
  expect(activity).toHaveLength(3);
  expect(activity[0].textContent).toContain("event a");
  expect(activity[0].textContent).toContain("2m ago");
  expect(pane.querySelector(".origin-value")!.textContent).toBe("unknown");
  expect(pane.textContent).toContain("does not infer or record which workspace created another");
  expect(pane.textContent).not.toContain("Origin workspace: ");
  click(root, "Highlight ancestry");
  click(root, "Inspect changes");
  expect(pane.querySelector(".graph-comparison")).toBeTruthy();
  void panel;
});

test("detached checkouts read Detached HEAD with the short commit", async () => {
  const snap = richSnapshot();
  snap.workspaces.push(workspace("det", "m2", { refs: ["detached"] }));
  const { root } = await richSetup({ snapshot: snap });
  expect(label(root, "det").querySelector("text")!.textContent).toBe("det m200000");
  label(root, "det").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(q(root, ".insp-branch").textContent).toBe("Detached HEAD m200000");
});

test("minimal mode: digests render as short hex and the full digest never reaches the page", async () => {
  const snap = richSnapshot();
  const digests = snap.workspaces.map((_, i) => `${(i + 10).toString(16).padStart(8, "0")}${"7f".repeat(28)}`);
  snap.workspaces = snap.workspaces.map((w, i) => ({
    ...w,
    id: digests[i],
    label: digests[i],
    refs: [digests[i]],
    changes: undefined,
    changed_files: w.dirty ? [digests[i].replace(/^.{8}/, "99999999")] : undefined,
  }));
  const { root } = await richSetup({ snapshot: snap, mode: "minimal" });
  expect(label(root, digests[0]).querySelector("text")!.textContent).toBe("0000000a");
  label(root, digests[1]).dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(root.textContent).not.toContain("7f7f7f7f");
  expect(q(root, ".graph-inspector").textContent).toContain("#99999999");
  expect(q(root, ".insp-branch").textContent).toBe("0000000b");
});

test("axis annotations, depth ticks and an honest footer", async () => {
  const { root } = await richSetup();
  const text = root.textContent!;
  expect(text).toContain("Newer commits ↑");
  expect(text).toContain("Older commits ↓");
  expect(text).toContain("Depth in loaded history");
  expect(text).toContain("Revision parent links");
  expect(text).toContain("Merge (multiple parents)");
  expect(q(root, ".graph-footer-status").textContent).toMatch(/^All 8 workspaces labelled .* · \d+ in view$/);
  expect(q(root, ".graph-expand").hidden).toBe(true);
});

test("the footer offers history expansion only when the daemon has more", async () => {
  const snap = richSnapshot();
  snap.next_cursor = "more";
  snap.boundaries = [{ child: "m0", parent: "gone", reason: "page" }];
  const { root } = await richSetup({ snapshot: snap });
  expect(q(root, ".graph-expand").hidden).toBe(false);
  q(root, ".graph-expand").click();
  await flush();
  expect(graphAPI.snapshot).toHaveBeenLastCalledWith("r", "more", false);
});

test("the initial view is readable and anchored on the active tips; All zooms out for deep history", async () => {
  const snap = richSnapshot();
  snap.nodes = Array.from({ length: 2000 }, (_, i) => ({
    key: String(i),
    commit_id: String(i),
    parents: i < 1999 ? [String(i + 1)] : [],
    description: "",
    timestamp: "",
  }));
  snap.workspaces = [workspace("deep", "0")];
  snap.default_target = undefined;
  const { root } = await richSetup({
    snapshot: snap,
    sessions: [agentSession("s", "codex", "deep")],
  });
  expect(scaleOf(root)).toBeGreaterThanOrEqual(0.4);
  const { y } = translateOf(root);
  expect(y).toBeGreaterThan(-200);
  expect(y).toBeLessThan(640);
  click(root, "All");
  expect(scaleOf(root)).toBeLessThan(0.1);
});

test("the viewport and selection survive a topology refresh", async () => {
  const { panel, root, snapshot } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  const svg = q(root, ".graph-canvas");
  svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  const before = q(root, ".graph-canvas > g").getAttribute("transform");
  snapshot.generation = "2";
  await panel.refresh();
  await flush();
  expect(q(root, ".graph-canvas")).toBe(svg);
  expect(q(root, ".graph-canvas > g").getAttribute("transform")).toBe(before);
  expect(label(root, "fix").classList.contains("selected")).toBe(true);
});

test("a moved HEAD moves its label and keeps the selection", async () => {
  const { panel, root, snapshot } = await richSetup();
  label(root, "tip").dispatchEvent(new MouseEvent("click"));
  await flush();
  const wsTip = snapshot.workspaces.find((w) => w.id === "tip")!;
  wsTip.revision = "m3";
  await panel.refresh();
  await flush();
  expect(label(root, "tip").classList.contains("selected")).toBe(true);
  expect(q(root, '[data-key="revision:m3"]').classList.contains("selected")).toBe(true);
});

test("⌘K focuses search, a result selects its workspace and centres its label", async () => {
  const { root } = await richSetup();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  const input = q(root, 'input[aria-label="Search graph"]');
  expect(document.activeElement).toBe(input);
  // empty focus lists every workspace
  expect(qa(root, '[role="option"]')).toHaveLength(8);
  const option = qa(root, '[role="option"]').find((o) => o.textContent!.includes("tip"))!;
  option.click();
  await flush();
  expect(label(root, "tip").classList.contains("selected")).toBe(true);
  const pill = label(root, "tip");
  const [tx, ty] = pill.getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
  const w = Number(pill.querySelector("rect")!.getAttribute("width"));
  const h = Number(pill.querySelector("rect")!.getAttribute("height"));
  const view = translateOf(root);
  const s = scaleOf(root);
  expect(Math.abs(view.x + (tx + w / 2) * s - (56 + (900 - 56) / 2))).toBeLessThan(2);
  expect(Math.abs(view.y + (ty + h / 2) * s - 320)).toBeLessThan(2);
});

test("arrow keys move focus between labels and Escape clears the selection", async () => {
  const { root } = await richSetup();
  const pill = label(root, "main");
  pill.focus();
  expect(document.activeElement).toBe(pill);
  pill.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  expect(document.activeElement).not.toBe(pill);
  expect((document.activeElement as Element).getAttribute("data-key")).toMatch(/^(workspace|cluster):/);
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(label(root, "fix").classList.contains("selected")).toBe(true);
  label(root, "fix").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(label(root, "fix").classList.contains("selected")).toBe(false);
  expect(q(root, ".graph-inspector").textContent).toContain("Select a workspace or revision");
});

test("2,000 revisions with 50 labels: no per-node listeners, selection stays fast", async () => {
  const nodes = Array.from({ length: 2000 }, (_, i) =>
    node(`n${i}`, i === 0 ? [] : [`n${i - Math.min(i, 1 + (i % 7 === 0 ? 3 : 0))}`]),
  );
  const snap = richSnapshot();
  snap.nodes = nodes;
  snap.default_target = undefined;
  snap.workspaces = Array.from({ length: 50 }, (_, i) =>
    workspace(`w${String(i).padStart(2, "0")}`, `n${1999 - i * 37}`, { dirty: i % 5 === 0 }),
  );
  const adds = vi.spyOn(EventTarget.prototype, "addEventListener");
  const { root } = await richSetup({ snapshot: snap });
  const registered = adds.mock.calls.length;
  adds.mockRestore();
  expect(registered).toBeLessThan(120);
  expect(qa(root, ".revision-node")).toHaveLength(2000);
  expect(qa(root, ".workspace-label").length + qa(root, ".workspace-cluster").length).toBeGreaterThan(0);
  const t0 = performance.now();
  label(root, "w10").dispatchEvent(new MouseEvent("click"));
  const elapsed = performance.now() - t0;
  expect(elapsed).toBeLessThan(100);
  expect(label(root, "w10").classList.contains("selected")).toBe(true);
});

test("Show in Graph reveals a workspace hidden in a cluster and the expansion outlives deselection", async () => {
  const { panel, root } = await richSetup();
  expect(root.querySelector('[data-key="workspace:c3"]')).toBeNull();
  panel.onEvent({
    id: "ev-c3",
    time: "2026-10-05T00:00:00Z",
    source: "codex",
    category: "tool",
    repo_id: "r",
    worktree_id: "c3",
  });
  click(root, "Timeline");
  await flush();
  root.querySelector<HTMLButtonElement>('[data-key="event:ev-c3"] button')!.click();
  await flush();
  expect(label(root, "c3").classList.contains("selected")).toBe(true);
  label(root, "c3").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(label(root, "c3").classList.contains("selected")).toBe(false);
  expect(root.querySelector('[data-key="workspace:c3"]')).not.toBeNull();
});

test("⌘K from the Timeline returns to the Graph and focuses search", async () => {
  const { root } = await richSetup();
  click(root, "Timeline");
  await flush();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  expect(root.querySelector(".graph-canvas")).toBeTruthy();
  expect(document.activeElement).toBe(q(root, 'input[aria-label="Search graph"]'));
});

test("the status banner lives inside the canvas area and the stale scan keeps the graph", async () => {
  const { panel, root } = await richSetup();
  vi.mocked(graphAPI.snapshot).mockRejectedValueOnce(new Error("scan failed"));
  await panel.refresh();
  await flush();
  expect(q(root, ".graph-main .graph-status").textContent).toContain("Topology scan unavailable");
  expect(qa(root, ".workspace-label").length).toBeGreaterThan(0);
});

test("the Workspace filter keeps names readable and only adds a tail when two checkouts read alike", async () => {
  const snap = richSnapshot();
  snap.workspaces[1] = { ...snap.workspaces[1], refs: ["refs/heads/main"], label: digest("e") };
  const { root } = await richSetup({ snapshot: snap });
  click(root, "Timeline");
  await flush();
  const options = qa(root, '[aria-label="Workspace"] option').map((o) => o.textContent);
  expect(options).toContain("tip");
  expect(options.filter((o) => o!.startsWith("main"))).toHaveLength(2);
  expect(options.filter((o) => o!.startsWith("main ·"))).toHaveLength(2);
});

test("search results are keyboard operable: arrows move, Enter picks, Escape clears", async () => {
  const { root } = await richSetup();
  const input = q(root, 'input[aria-label="Search graph"]') as unknown as HTMLInputElement;
  input.focus();
  input.value = "t";
  input.dispatchEvent(new Event("input"));
  const names = () => qa(root, '[role="option"]').map((o) => o.querySelector(".result-title")?.textContent);
  expect(names()).toContain("tip");
  // everything else is muted on the canvas while a search is active
  expect(label(root, "main").classList.contains("muted")).toBe(false);
  expect(label(root, "fix").classList.contains("muted")).toBe(false);
  input.value = "tip";
  input.dispatchEvent(new Event("input"));
  expect(label(root, "main").classList.contains("muted")).toBe(true);
  expect(label(root, "tip").classList.contains("match")).toBe(true);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(label(root, "tip").classList.contains("selected")).toBe(true);
  expect(label(root, "main").classList.contains("muted")).toBe(false);
  input.focus();
  input.value = "zzz";
  input.dispatchEvent(new Event("input"));
  expect(root.querySelector(".graph-search-empty")!.textContent).toBe("No match");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(input.value).toBe("");
});

test("revisions are searchable by commit ID and description", async () => {
  const { root } = await richSetup();
  const input = q(root, 'input[aria-label="Search graph"]') as unknown as HTMLInputElement;
  input.focus();
  input.value = "commit f1";
  input.dispatchEvent(new Event("input"));
  const option = qa(root, '[data-kind="revision"]')[0];
  expect(option.textContent).toContain("commit f1");
  option.click();
  await flush();
  expect(q(root, ".graph-inspector code").textContent).toBe("f1".padEnd(40, "0"));
  expect(q(root, '[data-key="revision:f1"]').classList.contains("selected")).toBe(true);
});

test("More holds Register local root and Refresh", async () => {
  const { root } = await richSetup();
  expect(root.querySelector(".graph-menu")!.hasAttribute("hidden")).toBe(true);
  click(root, "More");
  expect(root.querySelector(".graph-menu")!.hasAttribute("hidden")).toBe(false);
  click(root, "Register local root");
  const form = q(root, ".graph-register") as unknown as HTMLFormElement;
  const input = form.querySelector<HTMLInputElement>('[aria-label="Local repository root"]')!;
  input.value = "/work/repo";
  vi.mocked(graphAPI.register).mockRejectedValueOnce(new Error("no"));
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(form.querySelector('[role="alert"]')!.textContent).toContain("Unable to register repository");
  vi.mocked(graphAPI.register).mockResolvedValueOnce({ id: "r", vcs: "git", label: "x", status: "ok", observed_at: "" });
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(graphAPI.register).toHaveBeenLastCalledWith("/work/repo", "");
  expect(root.querySelector(".graph-menu")!.hasAttribute("hidden")).toBe(true);
  click(root, "More");
  vi.mocked(graphAPI.snapshot).mockClear();
  click(root, "Refresh");
  await flush();
  expect(graphAPI.snapshot).toHaveBeenCalledWith("r", "", true);
});

test("JJ repositories count workspaces and name pills after the workspace label", async () => {
  const snap = richSnapshot();
  snap.repository.vcs = "jj";
  snap.workspaces = snap.workspaces.map((w) => ({ ...w, label: `ws-${w.id}`, refs: ["main"] }));
  const { root } = await richSetup({ snapshot: snap });
  expect(q(root, ".graph-count").textContent).toBe("8 workspaces");
  expect(label(root, "tip").querySelector("text")!.textContent).toBe("ws-tip");
});

// ---- review fixes ---------------------------------------------------------------------

test("locked, pruned and inaccessible checkouts are labelled on the pill and in the inspector", async () => {
  const snap = richSnapshot();
  snap.workspaces.push(
    workspace("lock", "m2", { availability: "locked" }),
    workspace("gone", "m1", { availability: "pruned", dirty: true }),
    workspace("deny", "f1", { availability: "inaccessible" }),
  );
  const { root } = await richSetup({ snapshot: snap });
  for (const [id, word] of [
    ["lock", "locked"],
    ["gone", "pruned"],
    ["deny", "inaccessible"],
  ]) {
    const badges = [...label(root, id).querySelectorAll(".label-badge")].map((b) => b.textContent);
    expect(badges, id).toContain(word);
    expect(label(root, id).getAttribute("aria-label"), id).toContain(word);
    label(root, id).dispatchEvent(new MouseEvent("click"));
    await flush();
    expect(q(root, ".insp-checkout").textContent, id).toContain(word);
  }
  // an ordinary checkout carries no availability badge
  expect([...label(root, "main").querySelectorAll(".label-badge")]).toHaveLength(0);
});

test("Escape clears the selection from anywhere in the graph, not only from the canvas", async () => {
  const { root } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(label(root, "fix").classList.contains("selected")).toBe(true);
  const fit = qa(root, ".graph-fit button").find((b) => b.textContent === "Fit")!;
  fit.click();
  fit.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(label(root, "fix").classList.contains("selected")).toBe(false);
  expect(q(root, ".graph-inspector").textContent).toContain("Select a workspace or revision");
  // typing in a field keeps its own Escape behaviour: the selection stays
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  const input = q(root, '.graph-inspector select[aria-label="Compare with"]');
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(label(root, "fix").classList.contains("selected")).toBe(true);
});

test("0 shows the same view as the Fit button", async () => {
  const snap = richSnapshot();
  snap.nodes = Array.from({ length: 400 }, (_, i) => ({ ...node(`d${i}`, i < 399 ? [`d${i + 1}`] : []) }));
  snap.workspaces = [workspace("deep", "d0"), workspace("root", "d399")];
  snap.default_target = undefined;
  const { root } = await richSetup({ snapshot: snap, sessions: [agentSession("s", "codex", "deep")] });
  const fitted = q(root, ".graph-canvas > g").getAttribute("transform");
  click(root, "All");
  expect(q(root, ".graph-canvas > g").getAttribute("transform")).not.toBe(fitted);
  q(root, ".graph-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
  expect(q(root, ".graph-canvas > g").getAttribute("transform")).toBe(fitted);
});

test("search ranks workspace names above matches found only in a commit description", async () => {
  const snap = richSnapshot();
  snap.nodes.push({ ...node("s1", ["m1"]), description: "cache experiment" }, { ...node("s2", ["m1"]), description: "cache spike" });
  snap.workspaces = [
    workspace("spike", "s1", { refs: ["refs/heads/agent/spike"] }),
    workspace("refactor", "s2", { refs: ["refs/heads/agent/refactor"] }),
    workspace("cache-alt", "m2", { refs: ["refs/heads/agent/cache-alt"] }),
    workspace("cache", "m3", { refs: ["refs/heads/agent/cache"] }),
  ];
  snap.default_target = undefined;
  const { root } = await richSetup({ snapshot: snap });
  const input = q(root, 'input[aria-label="Search graph"]') as unknown as HTMLInputElement;
  input.focus();
  input.value = "cache";
  input.dispatchEvent(new Event("input"));
  const titles = qa(root, '[data-kind="workspace"] .result-title').map((o) => o.textContent);
  expect(titles).toEqual(["agent/cache", "agent/cache-alt", "agent/spike", "agent/refactor"]);
});

test("the first render does not wait for a slow attention endpoint", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    vi.stubGlobal("setInterval", () => 0);
    const snapshot = richSnapshot();
    vi.mocked(getConfig).mockResolvedValue({ privacy_mode: "balanced" });
    vi.mocked(attention).mockImplementation(() => new Promise(() => {}));
    vi.mocked(graphAPI.repos).mockResolvedValue([{ id: "r", vcs: "git", label: snapshot.repository.label, status: "ok", observed_at: "" }]);
    vi.mocked(graphAPI.snapshot).mockResolvedValue(snapshot);
    vi.mocked(graphAPI.timeline).mockResolvedValue({ events: [], has_more: false, order: "newest_first" });
    const panel = createWorkspaceGraph(() => {});
    document.body.append(panel.root);
    void panel.refresh();
    await vi.advanceTimersByTimeAsync(3000);
    expect(panel.root.querySelectorAll(".workspace-label").length).toBeGreaterThan(0);
    expect(panel.root.textContent).not.toContain("Loading repository topology");
  } finally {
    vi.useRealTimers();
  }
});

test("when sessions arrive after the first draw the automatic view re-fits onto the active tips", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    vi.stubGlobal("setInterval", () => 0);
    const snapshot = richSnapshot();
    snapshot.nodes = Array.from({ length: 600 }, (_, i) => node(`d${i}`, i < 599 ? [`d${i + 1}`] : []));
    snapshot.workspaces = [workspace("new", "d0"), workspace("old", "d599")];
    snapshot.default_target = undefined;
    vi.mocked(getConfig).mockResolvedValue({ privacy_mode: "balanced" });
    let release: (v: { sessions: AttentionSession[]; warnings: string[] }) => void = () => {};
    vi.mocked(attention).mockImplementation(() => new Promise((r) => (release = r)));
    vi.mocked(graphAPI.repos).mockResolvedValue([{ id: "r", vcs: "git", label: snapshot.repository.label, status: "ok", observed_at: "" }]);
    vi.mocked(graphAPI.snapshot).mockResolvedValue(snapshot);
    vi.mocked(graphAPI.timeline).mockResolvedValue({ events: [], has_more: false, order: "newest_first" });
    const panel = createWorkspaceGraph(() => {});
    document.body.append(panel.root);
    void panel.refresh();
    await vi.advanceTimersByTimeAsync(3000);
    const first = translateOf(panel.root).y;
    // the working agent is on the oldest revision: the Fit moves down to it
    release({ sessions: [agentSession("s", "codex", "old")], warnings: [] });
    await vi.advanceTimersByTimeAsync(10);
    expect(translateOf(panel.root).y).toBeLessThan(first - 2000);
  } finally {
    vi.useRealTimers();
  }
});

test("the Timeline tab shows the status notice in the flow instead of floating over its filters", async () => {
  const { panel, root } = await richSetup();
  const main = q(root, ".graph-main");
  expect(main.classList.contains("is-timeline")).toBe(false);
  click(root, "Timeline");
  await flush();
  expect(main.classList.contains("is-timeline")).toBe(true);
  click(root, "Graph");
  expect(main.classList.contains("is-timeline")).toBe(false);
  void panel;
});

test("a refresh that adds commits keeps the revision the user is looking at where it was", async () => {
  const { panel, root, snapshot } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  q(root, ".graph-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  const screen = (key: string) => {
    const n = q(root, `[data-key="revision:${key}"]`);
    const v = translateOf(root);
    const s = scaleOf(root);
    return { x: v.x + Number(n.getAttribute("cx") ?? n.getAttribute("x")) * s, y: v.y + Number(n.getAttribute("cy") ?? n.getAttribute("y")) * s };
  };
  const before = screen("f1");
  snapshot.nodes.push(node("h2", ["h"]), node("h3", ["h2"]), node("h4", ["h3"]));
  snapshot.workspaces.find((w) => w.id === "tip")!.revision = "h4";
  snapshot.generation = "2";
  await panel.refresh();
  await flush();
  const after = screen("f1");
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
});

test("expanding a cluster from the keyboard keeps focus on its chip", async () => {
  const { root } = await richSetup();
  const chip = q(root, ".workspace-cluster");
  chip.focus();
  chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(qa(root, ".workspace-label")).toHaveLength(8);
  const now = document.activeElement as Element;
  expect(now.getAttribute("data-key")).toBe("cluster:m0");
  expect(now.getAttribute("aria-expanded")).toBe("true");
  now.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(qa(root, ".workspace-label")).toHaveLength(3);
  expect((document.activeElement as Element).getAttribute("data-key")).toBe("cluster:m0");
});

test("stepping to a parent from the inspector keeps keyboard focus in the inspector", async () => {
  const { root } = await richSetup();
  q(root, '[data-key="revision:m2"]').dispatchEvent(new MouseEvent("click"));
  await flush();
  const link = q(root, ".graph-inspector .parent-link");
  link.focus();
  link.click();
  await flush();
  expect(q(root, ".graph-inspector code").textContent).toBe("m1".padEnd(40, "0"));
  expect(document.activeElement?.classList.contains("parent-link")).toBe(true);
});

test("a compare target that disappears from the options is reset, so the select and the request agree", async () => {
  const { root } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  const select = () => q(root, '.graph-inspector select[aria-label="Compare with"]') as unknown as HTMLSelectElement;
  const tipRev = "h";
  select().value = tipRev;
  select().dispatchEvent(new Event("change"));
  await flush();
  expect(graphAPI.compare).toHaveBeenLastCalledWith("r", "f2", tipRev);
  vi.mocked(graphAPI.compare).mockClear();
  label(root, "tip").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(select().selectedOptions[0].textContent).toBe("main");
  expect(graphAPI.compare).toHaveBeenCalledWith("r", tipRev, "m3".padEnd(40, "0"));
  expect(graphAPI.compare).not.toHaveBeenCalledWith("r", tipRev, tipRev);
});

// ---- readable names -------------------------------------------------------------------------

test("the repository picker shows the root folder with the full path as its tooltip", async () => {
  const snap = richSnapshot();
  snap.repository.label = "/Users/nicholas/develop/llm-firehose";
  const { root } = await richSetup({ snapshot: snap });
  const select = q(root, ".graph-repo select") as unknown as HTMLSelectElement;
  expect(select.selectedOptions[0].textContent).toBe("llm-firehose");
  expect(select.selectedOptions[0].getAttribute("title")).toBe("/Users/nicholas/develop/llm-firehose");
  expect(select.getAttribute("title")).toBe("/Users/nicholas/develop/llm-firehose");
});

test("repositories that share a folder name are told apart by their parent directory", async () => {
  const snap = richSnapshot();
  snap.repository.label = "/work/fixtures/main";
  const { panel, root } = await richSetup({ snapshot: snap });
  vi.mocked(graphAPI.repos).mockResolvedValue([
    { id: "r", vcs: "git", label: "/work/fixtures/main", status: "ok", observed_at: "" },
    { id: "r2", vcs: "git", label: "/work/other/main", status: "ok", observed_at: "" },
    { id: "r3", vcs: "jj", label: "/work/llm-firehose", status: "ok", observed_at: "" },
  ]);
  await panel.refresh();
  await flush();
  const options = qa(root, ".graph-repo option");
  expect(options.map((o) => o.textContent)).toEqual(["fixtures/main", "other/main", "llm-firehose"]);
  expect(options.map((o) => o.getAttribute("title"))).toEqual([
    "/work/fixtures/main",
    "/work/other/main",
    "/work/llm-firehose",
  ]);
});

test("a digest repository label from an older daemon keeps the short fallback and no tooltip", async () => {
  const { root } = await richSetup();
  const option = q(root, ".graph-repo option");
  expect(option.textContent).toBe("repo cccccccc");
  expect(option.getAttribute("title") ?? "").toBe("");
});

test("a Git worktree pill shows the directory name, the tooltip and inspector the full path", async () => {
  const snap = richSnapshot();
  snap.repository.label = "/Users/nicholas/develop/llm-firehose";
  snap.workspaces = [
    workspace("mockup", "m3", { label: "/Users/nicholas/develop/llm-firehose-graph-mockup", refs: ["refs/heads/feat/graph-mockup-fidelity"] }),
    workspace("other", "f2", { label: "/Users/nicholas/develop/llm-firehose", refs: ["refs/heads/main"] }),
  ];
  const { root } = await richSetup({ snapshot: snap });
  const pill = label(root, "mockup");
  // the pill clips at 24 characters; the tooltip and the inspector carry the whole name and path
  expect(pill.querySelector("text")!.textContent).toBe("llm-firehose-graph-mock…");
  expect(pill.querySelector("title")!.textContent).toBe(
    "llm-firehose-graph-mockup\n/Users/nicholas/develop/llm-firehose-graph-mockup",
  );
  expect(label(root, "other").querySelector("text")!.textContent).toBe("llm-firehose");
  pill.dispatchEvent(new MouseEvent("click"));
  await flush();
  const inspector = q(root, ".graph-inspector");
  expect(inspector.querySelector("h3")!.textContent).toBe("llm-firehose-graph-mockup");
  expect(inspector.querySelector(".insp-branch")!.textContent).toBe("feat/graph-mockup-fidelity");
  expect(inspector.querySelector(".insp-path code")!.textContent).toBe("/Users/nicholas/develop/llm-firehose-graph-mockup");
  expect(inspector.querySelector(".insp-repo-path code")!.textContent).toBe("/Users/nicholas/develop/llm-firehose");
  // search by the folder name finds it
  const input = q(root, 'input[aria-label="Search graph"]') as unknown as HTMLInputElement;
  input.focus();
  input.value = "graph-mockup";
  input.dispatchEvent(new Event("input"));
  expect(qa(root, '[data-kind="workspace"] .result-title').map((o) => o.textContent)).toEqual(["llm-firehose-graph-mockup"]);
});

test("a JJ workspace pill shows the workspace name and the inspector shows no worktree path", async () => {
  const snap = richSnapshot();
  snap.repository.vcs = "jj";
  snap.repository.label = "/Users/nicholas/develop/jj-repo";
  snap.workspaces = [workspace("agent-7", "m3", { label: "agent-7", refs: ["main"] })];
  const { root } = await richSetup({ snapshot: snap });
  expect(label(root, "agent-7").querySelector("text")!.textContent).toBe("agent-7");
  label(root, "agent-7").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(root.querySelector(".graph-inspector .insp-path")).toBeNull();
  expect(q(root, ".graph-inspector .insp-repo-path code").textContent).toBe("/Users/nicholas/develop/jj-repo");
});

test("digest worktree labels from an older daemon still read as the branch, with no path claimed", async () => {
  const { root } = await richSetup();
  label(root, "fix").dispatchEvent(new MouseEvent("click"));
  await flush();
  expect(label(root, "fix").querySelector("text")!.textContent).toBe("agent/cache-fix");
  expect(root.querySelector(".graph-inspector .insp-path")).toBeNull();
  expect(root.querySelector(".graph-inspector .insp-repo-path")).toBeNull();
  expect(root.textContent).not.toContain("a".repeat(64));
});
