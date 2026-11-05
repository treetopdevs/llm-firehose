// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createGraphCanvas, type AgentInfo, type CanvasState } from "./canvas";
import { createInspector, type InspectorContext } from "./inspector";
import { createToolbar, type SearchResult } from "./toolbar";
import { stateDescription } from "./names";
import { node } from "./layout.fixtures";
import type { Workspace } from "./api";

// State is never colour alone: every agent dot names its state to assistive tech.

vi.mock("./api", () => ({ graphAPI: { compare: vi.fn(async () => ({})) } }));
afterEach(() => document.body.replaceChildren());

const STATES = ["attention", "working", "observed", "none"] as const;

function named(dot: Element, within?: Element): void {
  const cls = [...dot.classList].find((c) => c.startsWith("state-"))!;
  const state = cls.slice(6) as (typeof STATES)[number];
  if (dot.getAttribute("aria-hidden") === "true") {
    expect(within, "aria-hidden dot needs a named group").toBeTruthy();
    expect(within!.getAttribute("aria-label")).toContain(stateDescription(state));
    return;
  }
  expect(dot.getAttribute("role")).toBe("img");
  expect(dot.getAttribute("aria-label")).toBe(stateDescription(state));
}

test("toolbar search results name the state", () => {
  const results: SearchResult[] = STATES.map((s) => ({ kind: "workspace", id: s, title: s, detail: "", state: s }));
  const tb = createToolbar({
    selectRepo: vi.fn(), setTab: vi.fn(), fit: vi.fn(), all: vi.fn(), search: () => results, pick: vi.fn(),
    register: vi.fn(async () => {}), refresh: vi.fn(),
  });
  document.body.append(tb.root);
  tb.input.focus();
  tb.input.value = "x";
  tb.input.dispatchEvent(new Event("input"));
  const dots = [...tb.root.querySelectorAll(".agent-dot")];
  expect(dots).toHaveLength(STATES.length);
  dots.forEach((d) => named(d));
});

test("inspector header dot and per-agent dots name the state", () => {
  const ws = { id: "w", repo_id: "r", label: "/d/w", revision: "a".repeat(40), refs: [], dirty: false, conflicted: false, availability: "available", unborn: false, changes: [] } as unknown as Workspace;
  const insp = createInspector({
    openSession: vi.fn(), filterTimeline: vi.fn(), openTimeline: vi.fn(), selectRevision: vi.fn(), highlightAncestry: vi.fn(), toggleDescendants: vi.fn(),
  });
  document.body.append(insp.root);
  const ctx = {
    repo: "r", snapshot: { nodes: [], workspaces: [ws], boundaries: [], warnings: [], stale: false, repository: { id: "r" }, generation: "g" },
    workspace: ws, name: "w", branch: "b", copyValue: "b", state: "attention",
    agents: [
      { source: "codex", id: "s1", state: "working", word: "Working" },
      { source: "codex", id: "s2", state: "attention", word: "Needs you" },
    ],
    activity: [], revision: "a".repeat(40), descendants: false, unassigned: 0, others: [],
  } as unknown as InspectorContext;
  insp.update(ctx);
  const dots = [...insp.root.querySelectorAll(".agent-dot")];
  expect(dots.length).toBe(3);
  dots.forEach((d) => named(d));
});

test("canvas label and cluster dots are named by their group", () => {
  const canvas = createGraphCanvas({
    selectWorkspace: vi.fn(), selectRevision: vi.fn(), toggleCluster: vi.fn(), clearSelection: vi.fn(), expandHistory: vi.fn(), fit: vi.fn(),
  });
  document.body.append(canvas.root);
  const cw = (id: string, rev: string) => ({ id, revision_key: rev, name: id, fullName: id, badges: [] });
  canvas.setGraph({
    nodes: [node("a"), node("z")], workspaces: [cw("w", "z"), ...["a1", "a2", "a3", "a4"].map((i) => cw(i, "a"))],
    expanded: new Set(), hasMore: false, boundaryCount: 0,
  });
  const state: CanvasState = {
    workspace: "", revision: "", descendants: false, matches: null,
    agents: new Map<string, AgentInfo>([["w", { state: "attention", count: 1 }], ["a1", { state: "working", count: 1 }]]),
  };
  canvas.setState(state);
  const groups = [...canvas.root.querySelectorAll("[data-key^='workspace:'], [data-key^='cluster:']")];
  expect(groups.length).toBeGreaterThan(1);
  for (const g of groups) {
    const dot = g.querySelector(".agent-dot")!;
    expect(dot).not.toBeNull();
    named(dot, g);
  }
});
