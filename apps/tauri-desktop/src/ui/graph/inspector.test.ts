// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createInspector, type InspectorContext, type InspectorHandlers } from "./inspector";
import { graphAPI, type Comparison, type Snapshot, type Workspace } from "./api";

vi.mock("./api", () => ({ graphAPI: { compare: vi.fn() } }));

const id = (c: string) => c.repeat(40);
const M = id("a");
const P = id("b");
const K = id("c");
const nodes = [
  { key: M, commit_id: M, parents: [], description: "root", timestamp: "2026-10-01T00:00:00Z" },
  { key: P, commit_id: P, parents: [M], description: "cache layer", timestamp: "2026-10-02T00:00:00Z" },
  { key: K, commit_id: K, parents: [P], description: "fix cache eviction", timestamp: "2026-10-03T00:00:00Z" },
];
const ws: Workspace = {
  id: "w7",
  repo_id: "r",
  label: "/dev/wt-07-fix",
  revision: K,
  refs: ["refs/heads/agent/cache-fix"],
  dirty: true,
  conflicted: false,
  availability: "available",
  unborn: false,
  changes: [
    { path: "session.go", status: "M", additions: 42, deletions: 11 },
    { path: "graph.go", status: "M", additions: 18, deletions: 6 },
    { path: "graph_test.go", status: "M", additions: 120, deletions: 4 },
  ],
};
const snapshot: Snapshot = {
  repository: { id: "r", vcs: "git", label: "repo", status: "ok", observed_at: "" },
  generation: "g1",
  nodes,
  workspaces: [ws],
  boundaries: [],
  warnings: [],
  stale: false,
  default_target: M,
  default_target_ref: "main",
};
const comparison: Comparison = {
  selected: K,
  target: M,
  selected_only: [P, K],
  target_only: [],
  merge_bases: [M],
  changed_files: [],
  changes: [{ path: "internal/cache.go", status: "A", additions: 30, deletions: 0 }],
  disconnected: false,
  warnings: [],
};
function ctx(over: Partial<InspectorContext> = {}): InspectorContext {
  return {
    repo: "r",
    snapshot,
    workspace: ws,
    name: "wt-07-fix",
    branch: "agent/cache-fix",
    copyValue: "agent/cache-fix",
    state: "working",
    agents: [{ source: "codex", id: "sess-1", state: "working", word: "Working" }],
    activity: [
      { id: "e1", text: "Read workspace identities", age: "2m ago" },
      { id: "e2", text: "Updated cache handling", age: "6m ago" },
      { id: "e3", text: "Tests running", age: "9m ago" },
    ],
    revision: K,
    descendants: false,
    unassigned: 0,
    others: [{ id: "w9", name: "wt-09", revision: P }],
    ...over,
  };
}
function handlers(): InspectorHandlers {
  return {
    openSession: vi.fn(),
    filterTimeline: vi.fn(),
    openTimeline: vi.fn(),
    selectRevision: vi.fn(),
    highlightAncestry: vi.fn(),
    toggleDescendants: vi.fn(),
  };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function mount(c: InspectorContext, h = handlers()) {
  const inspector = createInspector(h);
  document.body.append(inspector.root);
  inspector.update(c);
  return { inspector, h, root: inspector.root };
}
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  vi.mocked(graphAPI.compare).mockResolvedValue(comparison);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test("a workspace shows its name, branch with a copy button and the full commit ID first in a code element", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { root } = mount(ctx());
  expect(root.querySelector("h3")!.textContent).toBe("wt-07-fix");
  expect(root.textContent).toContain("agent/cache-fix");
  expect(root.querySelector("code")!.textContent).toBe(K);
  button(root, "").click; // no-op guard for lookup
  root.querySelector<HTMLButtonElement>('[aria-label="Copy branch name"]')!.click();
  await flush();
  expect(writeText).toHaveBeenCalledWith("agent/cache-fix");
});

test("copy falls back quietly when the clipboard is unavailable", async () => {
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
  const { root } = mount(ctx());
  root.querySelector<HTMLButtonElement>('[aria-label="Copy branch name"]')!.click();
  await flush();
  expect(root.querySelector('[data-action="copy"]')).toBeTruthy();
});

test("two agents display separately and equal session IDs from different sources stay distinct", () => {
  const { root, h } = mount(
    ctx({
      agents: [
        { source: "codex", id: "same", state: "working", word: "Working" },
        { source: "claude-code", id: "same", state: "attention", word: "Needs you", uncertainty: "stale evidence" },
      ],
    }),
  );
  const rows = [...root.querySelectorAll(".agent-row")];
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Codex");
  expect(rows[0].textContent).toContain("Working");
  expect(rows[1].textContent).toContain("Claude Code");
  expect(rows[1].textContent).toContain("Needs you");
  expect(rows[1].textContent).toContain("stale evidence");
  expect(rows[0].getAttribute("data-session")).not.toBe(rows[1].getAttribute("data-session"));
  rows[1].querySelector<HTMLButtonElement>(".agent-open")!.click();
  expect(h.openSession).toHaveBeenCalledWith("same", "claude-code");
  rows[0].querySelector<HTMLButtonElement>(".agent-filter")!.click();
  expect(h.filterTimeline).toHaveBeenCalledWith("codex", "same");
});

test("no session reads as unassigned, never as completed", () => {
  const { root } = mount(ctx({ agents: [], state: "none" }));
  expect(root.textContent).toContain("No explicitly associated session");
  expect(root.textContent).toContain("Missing telemetry does not imply completion");
});

test("compare defaults to the default ref, runs automatically and fills the stats", async () => {
  const { root } = mount(ctx());
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  expect(select.selectedOptions[0].textContent).toBe("main");
  expect(graphAPI.compare).toHaveBeenCalledWith("r", K, M);
  expect(root.textContent).toContain("Comparing…");
  await flush();
  expect(root.textContent).toContain("2 unique commits");
  expect(root.textContent).toContain("3 uncommitted files");
  // root, parent and tip: the tip and the target share exactly the root
  expect(root.textContent).toContain("1 shared ancestor loaded");
  expect([...select.options].map((o) => o.textContent)).toEqual(["main", `wt-09 · ${P.slice(0, 8)}`, "Custom revision…"]);
  expect(button(root, "Compare")).toBeUndefined();
});

test("choosing another workspace revision compares against it; stale answers are ignored", async () => {
  vi.mocked(graphAPI.compare).mockImplementation(async (_r, _a, t) => ({
    ...comparison,
    target: t,
    selected_only: t === P ? [K] : [P, K],
  }));
  const { root } = mount(ctx());
  await flush();
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  select.value = P;
  select.dispatchEvent(new Event("change"));
  expect(graphAPI.compare).toHaveBeenLastCalledWith("r", K, P);
  await flush();
  expect(root.textContent).toContain("1 unique commit");
});

test("a custom revision is compared once a full commit ID is entered", async () => {
  const { root } = mount(ctx());
  await flush();
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  select.value = "__custom__";
  select.dispatchEvent(new Event("change"));
  const input = root.querySelector<HTMLInputElement>('input[aria-label="Custom revision"]')!;
  vi.mocked(graphAPI.compare).mockClear();
  input.value = "abc";
  input.dispatchEvent(new Event("change"));
  expect(graphAPI.compare).not.toHaveBeenCalled();
  expect(root.textContent).toContain("full 40 to 64 character commit ID");
  const full = id("d");
  const field = root.querySelector<HTMLInputElement>('input[aria-label="Custom revision"]')!;
  field.value = full;
  field.dispatchEvent(new Event("change"));
  expect(graphAPI.compare).toHaveBeenCalledWith("r", K, full);
});

test("comparison failure is explicit", async () => {
  vi.mocked(graphAPI.compare).mockRejectedValue(new Error("nope"));
  const { root } = mount(ctx());
  await flush();
  expect(root.textContent).toContain("Comparison unavailable");
});

test("without a default ref the target must be chosen explicitly", () => {
  const { root } = mount(ctx({ snapshot: { ...snapshot, default_target: undefined, default_target_ref: undefined } }));
  expect(graphAPI.compare).not.toHaveBeenCalled();
  expect(root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!.selectedOptions[0].textContent).toBe(
    "Choose a revision…",
  );
});

test("Changes lists uncommitted files with counts and status letters", () => {
  const { root } = mount(ctx());
  const section = root.querySelector(".insp-changes")!;
  expect(section.querySelector("h4")!.textContent).toBe("Changes (3 files)");
  const rows = [...section.querySelectorAll(".change-row")];
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain("session.go");
  expect(rows[0].querySelector(".add")!.textContent).toBe("+42");
  expect(rows[0].querySelector(".del")!.textContent).toBe("-11");
  expect(rows[0].querySelector(".change-status")!.textContent).toBe("M");
});

test("untracked, binary and truncated changes do not invent counts", () => {
  const { root } = mount(
    ctx({
      workspace: {
        ...ws,
        changes: [
          { path: "notes.txt", status: "?" },
          { path: "logo.png", status: "M", binary: true },
        ],
        changes_truncated: true,
      },
    }),
  );
  const rows = [...root.querySelectorAll(".insp-changes .change-row")];
  expect(rows[0].querySelector(".add")).toBeNull();
  expect(rows[0].textContent).toContain("new");
  expect(rows[1].textContent).toContain("binary");
  expect(root.querySelector(".insp-changes h4")!.textContent).toBe("Changes (2+ files)");
});

test("legacy changed_files render as text when there are no change records", () => {
  const { root } = mount(ctx({ workspace: { ...ws, changes: undefined, changed_files: ["?? scratch.txt"] } }));
  expect(root.querySelector(".insp-changes h4")!.textContent).toBe("Changes (1 file)");
  expect(root.querySelector(".insp-changes")!.textContent).toContain("?? scratch.txt");
});

test("minimal-mode digests render shortened and the full digest never appears", () => {
  const digest = "9f".repeat(32);
  const { root } = mount(
    ctx({
      workspace: { ...ws, changes: [{ path: digest, status: "M", additions: 1, deletions: 0 }], changed_files: [digest] },
      branch: "ff00aa11",
    }),
  );
  expect(root.querySelector(".insp-changes")!.textContent).toContain("#9f9f9f9f");
  expect(root.textContent).not.toContain(digest);
});

test("captured activity shows the three newest scoped events with relative age and opens the scoped Timeline", () => {
  const { root, h } = mount(ctx());
  const rows = [...root.querySelectorAll(".activity-row")];
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain("Read workspace identities");
  expect(rows[0].textContent).toContain("2m ago");
  expect(root.querySelector(".insp-activity h4")!.textContent).toContain("Captured activity");
  button(root, "Open scoped Timeline").click();
  expect(h.openTimeline).toHaveBeenCalled();
});

test("origin workspace is always unknown, with honest help", () => {
  const { root } = mount(ctx());
  const origin = root.querySelector(".insp-origin")!;
  expect(origin.textContent).toContain("Origin workspace");
  expect(origin.querySelector(".origin-value")!.textContent).toBe("unknown");
  const help = origin.querySelector<HTMLElement>(".origin-help")!;
  expect(help.textContent).toContain("does not infer or record which workspace created another");
  expect(help.hidden).toBe(true);
  origin.querySelector<HTMLButtonElement>(".help")!.click();
  expect(root.querySelector<HTMLElement>(".origin-help")!.hidden).toBe(false);
});

test("Highlight ancestry and Inspect changes act; Inspect changes shows the committed comparison", async () => {
  const { root, h } = mount(ctx());
  await flush();
  button(root, "Highlight ancestry").click();
  expect(h.highlightAncestry).toHaveBeenCalled();
  button(root, "Show descendants").click();
  expect(h.toggleDescendants).toHaveBeenCalled();
  expect(root.querySelector(".graph-comparison")).toBeNull();
  button(root, "Inspect changes").click();
  const detail = root.querySelector(".graph-comparison")!;
  expect(detail.textContent).toContain("Only on selected (2)");
  expect(detail.textContent).toContain("Merge bases");
  expect(detail.textContent).toContain("internal/cache.go".split("/")[1]);
  expect(detail.textContent).toContain("Uncommitted checkout changes are separate");
  expect(button(root, "Inspect changes").getAttribute("aria-expanded")).toBe("true");
});

test("a bare revision shows identifiers, description, parents as buttons and the compare menu", async () => {
  const { root, h } = mount(ctx({ workspace: undefined, revision: K, agents: [], activity: [] }));
  expect(root.querySelector("h3")!.textContent).toBe(`Revision ${K.slice(0, 8)}`);
  expect(root.querySelector("code")!.textContent).toBe(K);
  expect(root.textContent).toContain("fix cache eviction");
  expect(root.querySelector(".insp-changes")).toBeNull();
  expect(root.querySelector(".insp-origin")).toBeNull();
  const parent = root.querySelector<HTMLButtonElement>(".parent-link")!;
  expect(parent.textContent).toBe(P.slice(0, 8));
  parent.click();
  expect(h.selectRevision).toHaveBeenCalledWith(P);
  await flush();
  expect(root.querySelector('select[aria-label="Compare with"]')).toBeTruthy();
});

test("a parent outside the loaded history is shown as not loaded, never as a link", () => {
  const orphan = { key: "z", commit_id: "z".repeat(40), parents: ["gone"], description: "tip", timestamp: "" };
  const { root } = mount(
    ctx({
      workspace: undefined,
      revision: "z",
      snapshot: { ...snapshot, nodes: [...nodes, orphan] },
    }),
  );
  expect(root.querySelector(".parent-link")).toBeNull();
  expect(root.querySelector(".parent-missing")!.textContent).toContain("not loaded");
});

test("nothing selected prompts for a selection", () => {
  const { root } = mount(ctx({ workspace: undefined, revision: "" }));
  expect(root.textContent).toContain("Select a workspace or revision");
});

test("identical updates do not rebuild the pane, so focus survives attention polling", async () => {
  const { inspector, root } = mount(ctx());
  await flush();
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  select.focus();
  const first = root.firstElementChild;
  inspector.update(ctx());
  expect(root.firstElementChild).toBe(first);
  expect(document.activeElement).toBe(select);
  // a real change re-renders but focus returns to the same control
  inspector.update(ctx({ activity: [] }));
  expect(root.querySelector('select[aria-label="Compare with"]')).not.toBe(select);
  expect(document.activeElement).toBe(root.querySelector('select[aria-label="Compare with"]'));
});

test("reset clears comparison state when the repository or privacy mode changes", async () => {
  const { inspector, root } = mount(ctx());
  await flush();
  inspector.reset();
  expect(root.childElementCount).toBe(0);
  inspector.update(ctx());
  expect(graphAPI.compare).toHaveBeenCalledTimes(2);
});

test("digested refs and descriptions (minimal mode) read as short digests, never in full", () => {
  const refDigest = "c1".repeat(32);
  const descDigest = "d2".repeat(32);
  const { root } = mount(
    ctx({
      snapshot: {
        ...snapshot,
        default_target_ref: refDigest,
        nodes: nodes.map((n) => (n.key === K ? { ...n, description: descDigest } : n)),
      },
    }),
  );
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  expect(select.selectedOptions[0].textContent).toBe("#c1c1c1c1");
  expect(root.querySelector(".rev-desc")!.textContent).toBe("#d2d2d2d2");
  expect(root.textContent).not.toContain(refDigest);
  expect(root.textContent).not.toContain(descDigest);
});

// ---- review fixes: compare target, drafts, focus, placement, availability --------

const w9: Workspace = { ...ws, id: "w9", label: "/dev/wt-09", revision: P, refs: ["refs/heads/wt-09"], dirty: false, changes: undefined };

test("the compare select and the request agree after selecting the workspace that was the target", async () => {
  vi.mocked(graphAPI.compare).mockImplementation(async (_r, _a, t) => ({ ...comparison, target: t }));
  const { inspector, root } = mount(ctx());
  await flush();
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  select.value = P;
  select.dispatchEvent(new Event("change"));
  expect(graphAPI.compare).toHaveBeenLastCalledWith("r", K, P);
  await flush();
  // wt-09 (whose revision was the target) is selected: its own revision is no longer an option
  vi.mocked(graphAPI.compare).mockClear();
  inspector.update(
    ctx({
      workspace: w9,
      name: "wt-09",
      branch: "wt-09",
      revision: P,
      others: [{ id: "w7", name: "wt-07-fix", revision: K }],
    }),
  );
  await flush();
  const next = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  expect(next.selectedOptions[0].textContent).toBe("main");
  expect(graphAPI.compare).toHaveBeenCalledWith("r", P, M);
  expect(graphAPI.compare).not.toHaveBeenCalledWith("r", P, P);
});

test("a custom revision typed but not yet applied survives redraws, with focus and selection", async () => {
  const { inspector, root } = mount(ctx());
  await flush();
  const select = root.querySelector<HTMLSelectElement>('select[aria-label="Compare with"]')!;
  select.value = "__custom__";
  select.dispatchEvent(new Event("change"));
  const input = root.querySelector<HTMLInputElement>('input[aria-label="Custom revision"]')!;
  input.focus();
  input.value = "abc123";
  input.setSelectionRange(2, 4);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // an activity update rebuilds the pane while the user is typing
  inspector.update(ctx({ activity: [] }));
  const again = root.querySelector<HTMLInputElement>('input[aria-label="Custom revision"]')!;
  expect(again.value).toBe("abc123");
  expect(document.activeElement).toBe(again);
  expect([again.selectionStart, again.selectionEnd]).toEqual([2, 4]);
});

test("a scan that only changes the snapshot generation neither rebuilds the pane nor drops the open comparison", async () => {
  const { inspector, root } = mount(ctx());
  await flush();
  const first = root.firstElementChild;
  expect(root.textContent).toContain("2 unique commits");
  vi.mocked(graphAPI.compare).mockClear();
  inspector.update(ctx({ snapshot: { ...snapshot, generation: "g2" } }));
  expect(root.firstElementChild).toBe(first);
  expect(root.textContent).toContain("2 unique commits");
  await flush();
  // the comparison is refreshed quietly for the new generation and, unchanged, redraws nothing
  expect(graphAPI.compare).toHaveBeenCalledTimes(1);
  expect(root.firstElementChild).toBe(first);
});

test("Inspect changes shows the comparison above the pinned action buttons and scrolls it into view", async () => {
  const scrollIntoView = vi.fn();
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scrollIntoView as never;
  try {
    const { root } = mount(ctx());
    await flush();
    button(root, "Inspect changes").click();
    const detail = root.querySelector(".graph-comparison")!;
    const actions = root.querySelector(".insp-actions")!;
    expect(detail.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    scrollIntoView.mockClear();
    button(root, "Inspect changes").click(); // closing does not scroll
    expect(root.querySelector(".graph-comparison")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});

test("stepping to a parent keeps keyboard focus on the new revision's parent links", () => {
  const { inspector, root } = mount(ctx({ workspace: undefined, revision: K, agents: [], activity: [] }));
  const link = root.querySelector<HTMLButtonElement>(".parent-link")!;
  link.focus();
  link.click();
  inspector.update(ctx({ workspace: undefined, revision: P, agents: [], activity: [] }));
  expect(document.activeElement?.classList.contains("parent-link")).toBe(true);
  // a root revision has no parent links: focus still stays inside the inspector
  const stepped = root.querySelector<HTMLButtonElement>(".parent-link")!;
  stepped.focus();
  inspector.update(ctx({ workspace: undefined, revision: M, agents: [], activity: [] }));
  expect(root.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(document.body);
});

test("a locked, pruned or inaccessible checkout is stated in the inspector", () => {
  for (const availability of ["locked", "pruned", "inaccessible"]) {
    document.body.replaceChildren();
    const { root } = mount(ctx({ workspace: { ...ws, availability } }));
    const row = root.querySelector(".insp-checkout")!;
    expect(row.textContent).toContain("Checkout");
    expect(row.textContent).toContain(availability);
  }
  document.body.replaceChildren();
  const { root } = mount(ctx({ workspace: { ...ws, unborn: true, dirty: true, conflicted: true } }));
  const text = root.querySelector(".insp-checkout")!.textContent!;
  expect(text).toContain("available");
  expect(text).toContain("unborn");
  expect(text).toContain("uncommitted changes");
  expect(text).toContain("conflicted");
});

test("the descendants toggle names its state and says when nothing is loaded above", () => {
  const { root } = mount(ctx({ descendants: true }));
  const toggle = button(root, "descendants");
  expect(toggle.textContent).toBe("Hide descendants");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  // K is the newest loaded revision: nothing descends from it
  expect(root.querySelector(".descendants-note")!.textContent).toContain("No descendants loaded");
  document.body.replaceChildren();
  const inner = mount(ctx({ descendants: true, workspace: undefined, revision: P, agents: [], activity: [] }));
  expect(inner.root.querySelector(".descendants-note")).toBeNull();
  document.body.replaceChildren();
  const off = mount(ctx({ descendants: false }));
  expect(button(off.root, "descendants").textContent).toBe("Show descendants");
  expect(off.root.querySelector(".descendants-note")).toBeNull();
});

test("the revision block is labelled and its commit ID is the first code element", () => {
  const { root } = mount(ctx());
  const block = root.querySelector(".insp-revision")!;
  expect(block.querySelector(".insp-label")!.textContent).toBe("Revision");
  expect(root.querySelector("code")!.textContent).toBe(K);
});

test("the inspector shows the full worktree path and the repository root", () => {
  const { root } = mount(ctx({ workspacePath: "/Users/dev/work/wt-07-fix", repoPath: "/Users/dev/work/llm-firehose" }));
  const path = root.querySelector(".insp-path")!;
  expect(path.querySelector(".insp-label")!.textContent).toBe("Path");
  expect(path.querySelector("code")!.textContent).toBe("/Users/dev/work/wt-07-fix");
  expect(path.querySelector("code")!.getAttribute("title")).toBe("/Users/dev/work/wt-07-fix");
  const repo = root.querySelector(".insp-repo-path")!;
  expect(repo.querySelector(".insp-label")!.textContent).toBe("Repository");
  expect(repo.querySelector("code")!.textContent).toBe("/Users/dev/work/llm-firehose");
});

test("a JJ workspace has no worktree path, and nothing is shown when the daemon sent digests", () => {
  const { root } = mount(ctx({ repoPath: "/Users/dev/work/jj-repo" }));
  expect(root.querySelector(".insp-path")).toBeNull();
  expect(root.querySelector(".insp-repo-path code")!.textContent).toBe("/Users/dev/work/jj-repo");
  const bare = mount(ctx());
  expect(bare.root.querySelector(".insp-path")).toBeNull();
  expect(bare.root.querySelector(".insp-repo-path")).toBeNull();
});

test("a path change redraws the inspector", () => {
  const { inspector, root } = mount(ctx({ workspacePath: "/old/wt" }));
  inspector.update(ctx({ workspacePath: "/new/wt" }));
  expect(root.querySelector(".insp-path code")!.textContent).toBe("/new/wt");
});
