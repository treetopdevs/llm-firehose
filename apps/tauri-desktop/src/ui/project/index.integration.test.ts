// @vitest-environment happy-dom
//
// Project hosting the real workspace graph (createWorkspaceGraph, hosted) over the real API
// modules. Only fetch is stubbed: every daemon URL the two panels ask for is answered here and
// anything else throws, so nothing reaches the network.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createScope } from "../../scope";
import type { ScopeStore } from "../../scope";
import { createWorkspaceGraph } from "../graph";
import { FIXTURE_ROWS, NOW } from "./model.fixtures";
import fixture from "../activity/fixture.activity.json";
import { createProject } from "./index";
import type { ProjectPanel } from "./index";

const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const panels: ProjectPanel[] = [];

const REPOS = [
  { id: "repoA", vcs: "git", label: "alpha", status: "ok", observed_at: "" },
  { id: "reg-only", vcs: "git", label: "registered", status: "ok", observed_at: "" },
];
const snapshotFor = (repo: string) => ({
  repository: REPOS.find((r) => r.id === repo) ?? { id: repo, vcs: "git", label: repo, status: "ok", observed_at: "" },
  generation: "1",
  nodes: [{ key: "a", commit_id: "a".padEnd(40, "0"), parents: [], description: "commit a", timestamp: "2026-10-01T00:00:00Z" }],
  workspaces: [],
  boundaries: [],
  warnings: [],
  stale: false,
});

let requests: URL[] = [];
const graphRequests = () => requests.filter((u) => u.pathname.startsWith("/workspace-graph"));
const snapshotRequests = () => requests.filter((u) => u.pathname === "/workspace-graph");

function answer(url: URL): unknown {
  switch (url.pathname) {
    case "/worktrees": return FIXTURE_ROWS;
    case "/config": return { privacy_mode: "balanced" };
    case "/attention": return { sessions: [], warnings: [] };
    case "/workspace-graph/repos": return REPOS;
    case "/workspace-graph": return snapshotFor(url.searchParams.get("repo_id") ?? "");
    case "/workspace-graph/timeline": return { events: [], has_more: false, order: "newest_first" };
    case "/workspace-graph/activity": return structuredClone(fixture);
  }
  throw new Error(`unexpected request ${url.pathname}`);
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const body = answer(url);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => {
  for (const p of panels.splice(0)) p.deactivate();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(initial?: Parameters<typeof createScope>[0]) {
  const store: ScopeStore = createScope(initial);
  const graph = createWorkspaceGraph(() => {}, store, { hosted: true, now: () => NOW });
  const panel = createProject({ store, go: vi.fn(), now: () => NOW, refreshMs: 15000, graph });
  document.body.append(panel.root);
  panels.push(panel);
  const chip = (e: string) => panel.root.querySelector<HTMLButtonElement>(`.project-chips [data-encoding="${e}"]`)!;
  return { store, graph, panel, chip };
}

describe("real hosted graph", () => {
  test("Graph shows it and requests a snapshot for scope.project; back on Lanes it is hidden and requests nothing", async () => {
    const { panel, graph, chip } = setup({ project: "repoA" });
    await panel.activate();
    await flush();
    expect(graphRequests()).toHaveLength(0);
    chip("graph").click();
    await flush();
    expect(graph.root.isConnected).toBe(true);
    expect(snapshotRequests().map((u) => u.searchParams.get("repo_id"))).toEqual(["repoA"]);
    chip("lanes").click();
    await flush();
    expect(graph.root.isConnected).toBe(false);
    const before = graphRequests().length;
    panel.onEvent({ id: "live-1", time: new Date(NOW).toISOString(), source: "codex", session_id: "s", category: "tool", name: "tool.completed", repo_id: "repoA", worktree_id: "wt-open" } as never);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(graphRequests()).toHaveLength(before);
  });

  test("Graph targets a registered-only scope.project (no lifetime rows) and never rewrites it", async () => {
    const { panel, store, graph, chip } = setup({ project: "reg-only" });
    await panel.activate();
    await flush();
    expect(FIXTURE_ROWS.some((r) => r.repo_id === "reg-only")).toBe(false);
    chip("graph").click();
    await flush();
    expect(snapshotRequests().map((u) => u.searchParams.get("repo_id"))).toEqual(["reg-only"]);
    expect(graph.currentRepo()).toBe("reg-only");
    expect(graph.registeredRepos()).toContain("reg-only");
    expect(store.get().project).toBe("reg-only");
  });
});
