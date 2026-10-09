// @vitest-environment happy-dom
//
// The Workspaces screen's request discipline, measured where it matters: at fetch.
// On real data `/workspace-graph/timeline` was slow and every live-event burst, 15 s
// refresh and filter change started another request without cancelling the last, so
// hundreds of pending requests held every connection the webview allows per host and
// `/config`, `/repos` and the snapshot never went out. These tests pin what replaced it:
// history is fetched only when the view needs it, one request at a time, and every
// superseded request is aborted.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorkspaceGraph } from "./index";
import type { Repository, Snapshot } from "./api";
import { attention, getConfig } from "../../api";

vi.mock("../../api", () => ({
  DAEMON_URL: "http://daemon.test",
  attention: vi.fn(async () => ({ sessions: [] })),
  getConfig: vi.fn(async () => ({ privacy_mode: "balanced" })),
}));

// ---- a fake daemon at the fetch boundary ------------------------------------------------------

interface Call {
  path: string;
  params: URLSearchParams;
  signal?: AbortSignal;
  state: "pending" | "done" | "aborted";
  respond(body: unknown): void;
}
const net = {
  calls: [] as Call[],
  repos: [] as Repository[],
  snapshots: new Map<string, Snapshot>(),
  /** Requests matching this are held until the test answers them. */
  hold: (_c: Call): boolean => false,
  peakPending: 0,
  peakTimeline: 0,
};
const pending = (path?: string) => net.calls.filter((c) => c.state === "pending" && (!path || c.path === path));
const timelineCalls = () => net.calls.filter((c) => c.path === "/timeline");
const snapshotCalls = (repo: string) => net.calls.filter((c) => c.path === "/" && c.params.get("repo_id") === repo);
const emptyPage = { events: [], has_more: false, order: "newest_first" };

function bodyFor(c: Call): unknown {
  switch (c.path) {
    case "/repos":
      return net.repos;
    case "/":
      return net.snapshots.get(c.params.get("repo_id") ?? "");
    case "/timeline":
      return emptyPage;
    default:
      return { selected: "", target: "", selected_only: [], target_only: [], merge_bases: [], changed_files: [], disconnected: false, warnings: [] };
  }
}
function installFetch() {
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input));
        const call: Call = {
          path: url.pathname.slice("/workspace-graph".length) || "/",
          params: url.searchParams,
          signal: init?.signal ?? undefined,
          state: "pending",
          respond: (body) => {
            if (call.state !== "pending") return;
            call.state = "done";
            resolve({ ok: true, status: 200, json: async () => body } as Response);
          },
        };
        init?.signal?.addEventListener("abort", () => {
          if (call.state !== "pending") return;
          call.state = "aborted";
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
        net.calls.push(call);
        net.peakPending = Math.max(net.peakPending, pending().length);
        net.peakTimeline = Math.max(net.peakTimeline, pending("/timeline").length);
        if (!net.hold(call)) call.respond(bodyFor(call));
      }),
  );
}

// ---- fixtures ---------------------------------------------------------------------------------

const node = (key: string, parents: string[] = []) => ({
  key,
  commit_id: key.padEnd(40, "0"),
  parents,
  description: `commit ${key}`,
  timestamp: "2026-10-01T00:00:00Z",
});
function snapshotOf(id: string, label: string, workspaces: string[], warnings: string[] = []): Snapshot {
  return {
    repository: { id, vcs: "git", label, status: "ok", observed_at: "" },
    generation: "1",
    nodes: [node("a"), node("b", ["a"]), node("c", ["b"])],
    workspaces: workspaces.map((w, i) => ({
      id: w,
      repo_id: id,
      label: `${label}/${w}`,
      revision: ["a", "b", "c"][i % 3],
      refs: [`refs/heads/${w}`],
      dirty: false,
      conflicted: false,
      availability: "available",
      unborn: false,
    })),
    boundaries: [],
    warnings,
    stale: false,
  };
}
const repoOf = (s: Snapshot): Repository => ({ ...s.repository });

let tick: (() => void) | undefined;
// microtask turns are enough: the fake daemon answers synchronously and fake timers may be on
const settle = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const q = <T extends Element = HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)!;
const qa = (root: HTMLElement, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const click = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === name)!.click();
const pill = (root: HTMLElement, id: string) => q(root, `[data-key="workspace:${id}"]`);
function change(select: HTMLSelectElement, value: string) {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}
const event = (id: string, workspace = "w1", repo = "ra") => ({
  id,
  time: new Date().toISOString(),
  source: "codex",
  session_id: "s",
  category: "tool",
  name: "tool.completed",
  summary: `summary ${id}`,
  repo_id: repo,
  worktree_id: workspace,
});

async function mount(opts: { timelineTab?: boolean } = {}) {
  const panel = createWorkspaceGraph(() => {});
  document.body.append(panel.root);
  await panel.refresh();
  await settle();
  if (opts.timelineTab) {
    click(panel.root, "Timeline");
    await settle();
  }
  return panel;
}

beforeEach(() => {
  net.calls = [];
  net.hold = () => false;
  net.peakPending = 0;
  net.peakTimeline = 0;
  const alpha = snapshotOf("ra", "/work/alpha", ["w1", "w2", "w3"], ["alpha warning"]);
  const beta = snapshotOf("rb", "/work/beta", ["x1", "x2"], ["beta warning"]);
  net.snapshots = new Map([
    ["ra", alpha],
    ["rb", beta],
  ]);
  net.repos = [repoOf(alpha), repoOf(beta)];
  tick = undefined;
  vi.stubGlobal("setInterval", (fn: () => void) => {
    tick = fn;
    return 0;
  });
  vi.mocked(getConfig).mockResolvedValue({ privacy_mode: "balanced" });
  vi.mocked(attention).mockResolvedValue({ sessions: [], warnings: [] });
  installFetch();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---- 1. live events never fetch history ---------------------------------------------------------

test("live-event bursts merge into the timeline and refresh attention, but never fetch history", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const panel = await mount({ timelineTab: true });
  const before = timelineCalls().length;
  expect(before).toBe(1);
  const attentionBefore = vi.mocked(attention).mock.calls.length;
  for (let burst = 0; burst < 4; burst++) {
    for (let i = 0; i < 30; i++) panel.onEvent(event(`e${burst}-${i}`));
    await vi.advanceTimersByTimeAsync(600);
  }
  expect(timelineCalls()).toHaveLength(before);
  expect(vi.mocked(attention).mock.calls.length).toBeGreaterThan(attentionBefore);
  expect(qa(panel.root, ".graph-events tbody tr")).toHaveLength(120);
});

test("on the Graph tab an event updates the selected workspace's activity without a request", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const panel = await mount();
  pill(panel.root, "w1").dispatchEvent(new MouseEvent("click"));
  await settle();
  const before = timelineCalls().length;
  expect(before).toBe(1);
  panel.onEvent(event("fresh"));
  await vi.advanceTimersByTimeAsync(600);
  expect(timelineCalls()).toHaveLength(before);
  expect(q(panel.root, ".graph-inspector .insp-activity").textContent).toContain("summary fresh");
});

// ---- 2. history is fetched only when the view needs it ------------------------------------------

test("the Graph tab without a selected workspace makes no timeline request, however often it refreshes", async () => {
  const panel = await mount();
  expect(tick).toBeTypeOf("function");
  const snapshots = snapshotCalls("ra").length;
  for (let i = 0; i < 3; i++) {
    tick!();
    await settle();
  }
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(snapshotCalls("ra").length).toBeGreaterThanOrEqual(snapshots + 4);
  expect(timelineCalls()).toHaveLength(0);
  void panel;
});

test("a selected workspace on the Graph tab loads one small scoped page for its captured activity", async () => {
  net.hold = (c) => c.path === "/timeline";
  const panel = await mount();
  net.calls = [];
  pill(panel.root, "w2").dispatchEvent(new MouseEvent("click"));
  await settle();
  expect(timelineCalls()).toHaveLength(1);
  const p = timelineCalls()[0].params;
  expect(p.get("limit")).toBe("20");
  expect(Object.fromEntries(p)).toEqual({ repo_id: "ra", workspace_id: "w2", limit: "20" });
  // the 15 s refresh and a window focus while it is in flight never queue another
  for (let i = 0; i < 3; i++) {
    tick!();
    await settle();
  }
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(timelineCalls()).toHaveLength(1);
  expect(net.peakTimeline).toBe(1);
  // once it has answered, the next refresh may reconcile again: still one at a time
  timelineCalls()[0].respond(emptyPage);
  await settle();
  tick!();
  await settle();
  expect(timelineCalls()).toHaveLength(2);
  expect(pending("/timeline")).toHaveLength(1);
});

test("the scoped page ignores the Timeline tab's filters and never disturbs its paging", async () => {
  const panel = await mount({ timelineTab: true });
  expect(timelineCalls()[0].params.get("limit")).toBe("250");
  change(q<HTMLSelectElement>(panel.root, '[aria-label="Workspace"]'), "w1");
  await settle();
  expect(Object.fromEntries(timelineCalls().at(-1)!.params)).toEqual({ repo_id: "ra", workspace_id: "w1", limit: "250" });
  click(panel.root, "Graph");
  await settle();
  expect(Object.fromEntries(timelineCalls().at(-1)!.params)).toEqual({ repo_id: "ra", workspace_id: "w1", limit: "20" });
});

test("Show in Graph, picking a result and leaving the selection each ask for exactly what the view needs", async () => {
  net.hold = (c) => c.path === "/timeline";
  const panel = await mount();
  pill(panel.root, "w1").dispatchEvent(new MouseEvent("click"));
  await settle();
  const first = timelineCalls().at(-1)!;
  expect(first.state).toBe("pending");
  // selecting a bare revision leaves no workspace: the scoped page is no longer needed
  q(panel.root, '[data-key="revision:b"]').dispatchEvent(new MouseEvent("click"));
  await settle();
  expect(first.state).toBe("aborted");
  expect(pending("/timeline")).toHaveLength(0);
  pill(panel.root, "w3").dispatchEvent(new MouseEvent("click"));
  await settle();
  const second = timelineCalls().at(-1)!;
  expect(second.state).toBe("pending");
  q(panel.root, ".graph-canvas").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  expect(second.state).toBe("aborted");
  expect(pending("/timeline")).toHaveLength(0);
});

test("leaving the Timeline tab for an unscoped Graph aborts the page it was waiting for", async () => {
  net.hold = (c) => c.path === "/timeline";
  const panel = await mount({ timelineTab: true });
  const waiting = timelineCalls()[0];
  expect(waiting.state).toBe("pending");
  expect(waiting.params.get("limit")).toBe("250");
  click(panel.root, "Graph");
  await settle();
  expect(waiting.state).toBe("aborted");
  expect(pending("/timeline")).toHaveLength(0);
});

// ---- 3. single flight with abort ----------------------------------------------------------------

test("at most one timeline request is in flight: every new load aborts the previous one", async () => {
  net.hold = (c) => c.path === "/timeline";
  const panel = await mount({ timelineTab: true });
  for (const workspace of ["w1", "w2", "w3", ""]) {
    change(q<HTMLSelectElement>(panel.root, '[aria-label="Workspace"]'), workspace);
    await settle();
  }
  const calls = timelineCalls();
  expect(calls).toHaveLength(5);
  expect(calls.slice(0, 4).map((c) => c.state)).toEqual(["aborted", "aborted", "aborted", "aborted"]);
  expect(calls.slice(0, 4).every((c) => c.signal?.aborted)).toBe(true);
  expect(calls[4].state).toBe("pending");
  expect(calls[4].signal?.aborted).toBe(false);
  expect(net.peakTimeline).toBe(1);
  // the refresh timer does not stack another on top of the one in flight
  tick!();
  await settle();
  expect(timelineCalls()).toHaveLength(5);
  // aborted requests are not errors, and the survivor fills the table
  expect(q(panel.root, ".graph-timeline").textContent).not.toContain("Durable history unavailable");
  calls[4].respond({ events: [event("late")], has_more: false, order: "newest_first" });
  await settle();
  expect(qa(panel.root, ".graph-events tbody tr")).toHaveLength(1);
  expect(q(panel.root, ".graph-timeline").textContent).not.toContain("Durable history unavailable");
});

test("a real failure of the current request is still reported on the Timeline tab", async () => {
  net.hold = (c) => c.path === "/timeline";
  const panel = await mount({ timelineTab: true });
  const stale = timelineCalls()[0];
  change(q<HTMLSelectElement>(panel.root, '[aria-label="Workspace"]'), "w1");
  await settle();
  expect(stale.state).toBe("aborted");
  const fetchMock = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("/timeline") ? ({ ok: false, status: 500, json: async () => ({}) } as Response) : fetchMock(input, init),
  );
  click(panel.root, "Reconcile durable history");
  await settle();
  expect(q(panel.root, ".graph-timeline").textContent).toContain("Durable history unavailable");
});

// ---- 4. repository switches stay prompt ---------------------------------------------------------

test("switching repository aborts in-flight history and goes straight to the new repository's snapshot", async () => {
  net.hold = (c) => c.path === "/timeline" || (c.path === "/" && c.params.get("repo_id") === "rb");
  const panel = await mount({ timelineTab: true });
  const waiting = timelineCalls()[0];
  expect(waiting.state).toBe("pending");
  const configCalls = vi.mocked(getConfig).mock.calls.length;
  const repoCalls = net.calls.filter((c) => c.path === "/repos").length;

  change(q<HTMLSelectElement>(panel.root, ".graph-repo select"), "rb");
  // synchronously: the old history is cancelled and config and repos are already on the wire
  expect(waiting.state).toBe("aborted");
  expect(waiting.signal?.aborted).toBe(true);
  expect(vi.mocked(getConfig).mock.calls.length).toBe(configCalls + 1);
  expect(net.calls.filter((c) => c.path === "/repos")).toHaveLength(repoCalls + 1);
  await settle();
  expect(snapshotCalls("rb")).toHaveLength(1);
  expect(snapshotCalls("rb")[0].state).toBe("pending");
  expect(pending("/timeline")).toHaveLength(0);
  expect(panel.root.textContent).not.toContain("Durable history unavailable");

  snapshotCalls("rb")[0].respond(net.snapshots.get("rb"));
  await settle();
  // history for the new repository is requested once its snapshot is in (Timeline tab)
  expect(timelineCalls().at(-1)!.params.get("repo_id")).toBe("rb");
});

test("a storm of events, refreshes and filter changes never exhausts the connections a repository switch needs", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  net.hold = (c) => c.path === "/timeline" || (c.path === "/" && c.params.get("repo_id") === "rb");
  const panel = await mount({ timelineTab: true });
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 20; i++) panel.onEvent(event(`s${round}-${i}`));
    await vi.advanceTimersByTimeAsync(600);
    tick!();
    window.dispatchEvent(new Event("focus"));
    change(q<HTMLSelectElement>(panel.root, '[aria-label="Workspace"]'), round % 2 ? "w1" : "w2");
    await vi.advanceTimersByTimeAsync(0);
  }
  // browsers allow about six connections per host; one timeline request is all this screen may hold
  expect(net.peakTimeline).toBe(1);
  expect(net.peakPending).toBeLessThan(6);
  change(q<HTMLSelectElement>(panel.root, ".graph-repo select"), "rb");
  await vi.advanceTimersByTimeAsync(0);
  expect(pending("/timeline")).toHaveLength(0);
  expect(snapshotCalls("rb")).toHaveLength(1);
});

test("while the new snapshot loads the header shows a loading state, never the previous repository's data", async () => {
  net.hold = (c) => c.path === "/" && c.params.get("repo_id") === "rb";
  const panel = await mount();
  expect(q(panel.root, ".graph-count").textContent).toBe("3 worktrees");
  expect(q(panel.root, ".graph-status").textContent).toContain("alpha warning");
  change(q<HTMLSelectElement>(panel.root, ".graph-repo select"), "rb");
  await settle();
  expect(snapshotCalls("rb")[0].state).toBe("pending");
  const header = q(panel.root, ".graph-toolbar").textContent!;
  expect(header).not.toContain("3 worktrees");
  expect(q(panel.root, ".graph-count").textContent).toBe("Loading…");
  expect(q(panel.root, ".graph-status").textContent).toBe("");
  expect(panel.root.textContent).not.toContain("alpha warning");
  expect(panel.root.querySelector(".graph-canvas")).toBeNull();
  expect(q(panel.root, ".graph-empty").textContent).toContain("Loading repository topology");
  expect(q<HTMLSelectElement>(panel.root, ".graph-repo select").value).toBe("rb");

  snapshotCalls("rb")[0].respond(net.snapshots.get("rb"));
  await settle();
  expect(q(panel.root, ".graph-count").textContent).toBe("2 worktrees");
  expect(q(panel.root, ".graph-status").textContent).toContain("beta warning");
  expect(panel.root.querySelector(".graph-canvas")).not.toBeNull();
});

test("a failed scan for the new repository leaves no loading state or old data behind", async () => {
  const panel = await mount();
  net.hold = () => false;
  net.snapshots.delete("rb");
  change(q<HTMLSelectElement>(panel.root, ".graph-repo select"), "rb");
  await settle();
  expect(q(panel.root, ".graph-count").hidden).toBe(true);
  expect(q(panel.root, ".graph-status").textContent).toContain("Topology scan unavailable");
  expect(panel.root.textContent).not.toContain("alpha warning");
  expect(q(panel.root, ".graph-empty").textContent).not.toContain("Loading");
});

test("switching privacy mode aborts in-flight history and discards the old data while it reloads", async () => {
  net.hold = (c) => c.path === "/timeline";
  const panel = await mount({ timelineTab: true });
  const waiting = timelineCalls()[0];
  expect(waiting.state).toBe("pending");
  vi.mocked(getConfig).mockResolvedValueOnce({ privacy_mode: "minimal" });
  net.hold = (c) => c.path === "/timeline" || c.path === "/";
  void panel.refresh();
  await settle();
  expect(waiting.state).toBe("aborted");
  expect(q(panel.root, ".graph-count").textContent).toBe("Loading…");
  expect(q(panel.root, ".graph-status").textContent).toBe("");
  expect(panel.root.textContent).not.toContain("Durable history unavailable");
});

// ---- 5. leaving the view --------------------------------------------------------------------------

test("leaving the view aborts in-flight history, and returning loads it again", async () => {
  net.hold = (c) => c.path === "/timeline";
  const content = document.createElement("main");
  document.body.append(content);
  const panel = createWorkspaceGraph(() => {});
  content.append(panel.root);
  await panel.refresh();
  await settle();
  click(panel.root, "Timeline");
  await settle();
  const waiting = timelineCalls()[0];
  expect(waiting.state).toBe("pending");

  // the shell swaps panels by clearing its content area
  content.replaceChildren();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(waiting.state).toBe("aborted");
  expect(pending()).toHaveLength(0);

  content.append(panel.root);
  await panel.refresh();
  await settle();
  expect(timelineCalls()).toHaveLength(2);
  expect(timelineCalls()[1].state).toBe("pending");
  expect(panel.root.textContent).not.toContain("Durable history unavailable");
});
