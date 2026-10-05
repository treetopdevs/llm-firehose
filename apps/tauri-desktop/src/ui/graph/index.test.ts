// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createWorkspaceGraph } from "./index";
import { graphAPI } from "./api";
import { getConfig } from "../../api";
vi.mock("../../api", () => ({
  DAEMON_URL: "http://127.0.0.1:4517",
  attention: async () => ({ sessions: [] }),
  getConfig: vi.fn(async () => ({ privacy_mode: "balanced" })),
}));
vi.mock("./api", () => ({
  graphAPI: {
    repos: vi.fn(),
    snapshot: vi.fn(),
    timeline: vi.fn(),
    compare: vi.fn(),
  },
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
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
    expect.objectContaining({ cursor: "older", workspace_id: "w" }),
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
test("explicit Fit includes deep history without the readable initial-view scale floor", async () => {
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
  click(panel.root, "Fit");
  const transform = panel.root
    .querySelector(".graph-canvas > g")!
    .getAttribute("transform")!;
  expect(Number(transform.match(/scale\(([^)]+)/)![1])).toBeLessThan(0.1);
});
