// @vitest-environment happy-dom
// Every custom (non-native) focusable or role=button element must be operable from the
// keyboard. Static half: each non-test onActivate caller is listed and callers whose element
// holds interactive descendants use { self: true }. Runtime half: mount the panels and press
// Enter on everything that is not a native control.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    sessions: vi.fn(),
    sessionEvents: vi.fn(),
    attention: vi.fn(),
    worktrees: vi.fn(),
    worktree: vi.fn(),
    errorSignatures: vi.fn(),
    capturedEvent: vi.fn(),
  },
}));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  DAEMON_URL: "http://127.0.0.1:4517",
  sessions: () => apiMock.sessions(),
  sessionEvents: (id: string) => apiMock.sessionEvents(id),
  attention: () => apiMock.attention(),
  worktrees: (s?: AbortSignal) => apiMock.worktrees(s),
  worktree: (id: string, s?: AbortSignal) => apiMock.worktree(id, s),
  errorSignatures: () => apiMock.errorSignatures(),
  capturedEvent: () => apiMock.capturedEvent(),
  getConfig: vi.fn(async () => ({ privacy_mode: "balanced" })),
}));
vi.mock("./ui/graph/api", () => ({
  graphAPI: { repos: vi.fn(), snapshot: vi.fn(), timeline: vi.fn(), activity: vi.fn(), compare: vi.fn(), register: vi.fn() },
}));

import type { FirehoseEvent, SessionSummary } from "./api";
import { createFeed } from "./ui/feed";
import { FeedState } from "./state";
import { createSessions } from "./ui/sessions";
import { createProject } from "./ui/project";
import { createFleet } from "./ui/fleet";
import { createWorkspaceGraph } from "./ui/graph";
import { graphAPI } from "./ui/graph/api";
import { createScope } from "./scope";
import { FIXTURE_ROWS, NOW, att, ev, iso } from "./ui/fleet/model.fixtures";
import { createActivityMap } from "./ui/activity";
import { createScore } from "./ui/score";
import { createTransport } from "./transport";
import { idChip } from "./ui/session-id";
import activityFixture from "./ui/activity/fixture.activity.json";
import scoreFixture from "./ui/score/fixture.session.json";

// ---------------------------------------------------------------- static audit

const SRC = __dirname;
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.fixtures\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** `file:firstArg#n` -> whether the activated element holds interactive descendants, and why. */
const ONACTIVATE_CALLERS: Record<string, { descendants: boolean; why: string }> = {
  "ui/graph/index.ts:row#1": { descendants: true, why: "timeline row holds the Show in Graph button" },
  "ui/project/index.ts:bead#1": { descendants: false, why: "SVG rect leaf; stop keeps it out of its lane" },
  "ui/project/index.ts:g#1": { descendants: true, why: "lane holds focusable beads" },
  "ui/sessions.ts:item#1": { descendants: true, why: "session card holds score, loops and the id chip" },
  "ui/feed.ts:line#1": { descendants: false, why: "text cells only (self:true kept so a future control cannot double-fire)" },
  "ui/fleet/encodings.ts:g#1": { descendants: false, why: "lane row: shapes and text only" },
  "ui/fleet/index.ts:head#1": { descendants: false, why: "row head: spans only" },
  "ui/fleet/index.ts:k.node#1": { descendants: false, why: "fork chip: spans only" },
  "ui/fleet/index.ts:k.node#2": { descendants: false, why: "need chip: spans only" },
  "ui/fleet/index.ts:n#1": { descendants: false, why: "dwell row: spans and bar only" },
  "ui/fleet/index.ts:head#2": { descendants: false, why: "matrix th: text only" },
  "ui/fleet/index.ts:needs#1": { descendants: false, why: "matrix td: text only" },
};

function callText(src: string, at: number): string {
  let depth = 0;
  for (let i = src.indexOf("(", at); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

describe("onActivate callers", () => {
  const found = new Map<string, string>();
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (rel === "dom.ts") continue;
    const src = readFileSync(file, "utf8");
    const seen = new Map<string, number>();
    for (const m of src.matchAll(/\bonActivate\(\s*([A-Za-z_][\w.]*)/g)) {
      const base = `${rel}:${m[1]}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      found.set(`${base}#${n}`, callText(src, m.index!));
    }
  }

  test("every non-test caller is listed, and the list has no stale entries", () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(ONACTIVATE_CALLERS).sort());
  });

  test.each(Object.entries(ONACTIVATE_CALLERS))("%s: elements with interactive descendants use self:true", (key, info) => {
    const text = found.get(key) ?? "";
    if (info.descendants) expect(text).toMatch(/self:\s*true/);
    if (key === "ui/project/index.ts:bead#1") expect(text).toMatch(/stop:\s*true/);
  });
});

// ---------------------------------------------------------------- runtime audit

const NATIVE = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const flush = async (): Promise<void> => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const keydown = (target: Element, key: string): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

/** Custom focusables: tabindex 0 or role=button that the browser does not activate by itself. */
function customFocusables(root: Element): Element[] {
  const sel = '[tabindex="0"], [role="button"]';
  const all = [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)];
  return all.filter((n) => !NATIVE.has(n.tagName));
}

const at = (iso: string, over: Partial<FirehoseEvent> = {}): FirehoseEvent =>
  ({ id: `e-${iso}`, time: iso, source: "claude-code", category: "tool", summary: "ran Read", ...over }) as FirehoseEvent;
const summaryRow = (id: string): SessionSummary =>
  ({ id, source: "codex", agent: "codex", first_time: new Date(NOW - 600_000).toISOString(), last_time: new Date(NOW - 5_000).toISOString(), events: 3, state: "working" }) as SessionSummary;

const mounted: Array<{ name: string; root: HTMLElement }> = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  mounted.length = 0;
  apiMock.sessions.mockReset().mockResolvedValue([summaryRow("s1"), summaryRow("s2")]);
  apiMock.sessionEvents.mockReset().mockResolvedValue([]);
  apiMock.attention.mockReset().mockResolvedValue({ sessions: [], gaps: [], warnings: [] });
  apiMock.errorSignatures.mockReset().mockResolvedValue([]);
  apiMock.capturedEvent.mockReset().mockRejectedValue(new Error("404"));
  apiMock.worktrees.mockReset().mockResolvedValue(FIXTURE_ROWS);
  apiMock.worktree.mockReset().mockImplementation((id: string) => Promise.resolve({ ...FIXTURE_ROWS.find((r) => r.worktree_id === id)!, commits: [] }));
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mountAll(): Promise<void> {
  const keep = (name: string, root: HTMLElement) => { document.body.append(root); mounted.push({ name, root }); };

  const feedState = new FeedState(50);
  feedState.push(at("2026-11-01T12:00:00Z"));
  feedState.push(at("2026-11-01T12:00:10Z", { source: "codex", category: "shell", summary: "ran ls" }));
  const feed = createFeed(feedState, () => {});
  keep("feed", feed.root);
  feed.refresh();

  const sessions = createSessions(() => {}, () => [], () => {}, () => {}, createScope());
  keep("sessions", sessions.root);
  await sessions.refresh();

  const projStore = createScope();
  projStore.narrow({ project: "repoA" });
  const project = createProject({ store: projStore, go: vi.fn() as never, now: () => NOW, refreshMs: 15000 });
  keep("project", project.root);
  await project.activate();
  await flush();
  cleanups.push(() => project.deactivate());

  for (const enc of ["map", "dwell", "matrix", "lanes", "airspace"]) {
    const store = createScope();
    const fleet = createFleet({
      store,
      go: vi.fn() as never,
      events: () => [
        ev({ id: "1", source: "claude-code", session_id: "s", call_id: "c", time: iso(NOW - 40_000), payload: { phase: "start" } }),
        ev({ id: "2", source: "codex", session_id: "s", call_id: "c", time: iso(NOW - 20_000), payload: { phase: "end" } }),
      ],
      api: {
        worktrees: () => Promise.resolve(FIXTURE_ROWS),
        attention: () => Promise.resolve({ sessions: [att({ id: "sa", repo_id: "repoA", worktree_id: "wt-open", waitMs: 480_000 }), att({ id: "sw", repo_id: "repoB", worktree_id: "wt-b1" })], gaps: [], warnings: [] }),
        sessions: () => Promise.resolve([]),
      } as never,
      now: () => NOW,
      refreshMs: 15_000,
      loadTimeoutMs: 5_000,
    });
    keep(`fleet:${enc}`, fleet.root);
    await fleet.activate();
    await flush();
    fleet.encoding = enc as never;
    await flush();
    cleanups.push(() => fleet.deactivate());
  }

  vi.stubGlobal("setInterval", () => 0);
  vi.mocked(graphAPI.repos).mockResolvedValue([{ id: "r", vcs: "git", label: "repo", status: "ok", observed_at: "" }]);
  vi.mocked(graphAPI.snapshot).mockResolvedValue({
    repository: { id: "r", vcs: "git", label: "repo", status: "ok", observed_at: "" },
    generation: "1",
    nodes: [{ key: "a", commit_id: "a", parents: [], description: "root", timestamp: "" }, { key: "b", commit_id: "b", parents: ["a"], description: "next", timestamp: "" }],
    workspaces: [{ id: "w", repo_id: "r", label: "workspace one", revision: "b", refs: [], dirty: false, conflicted: false, availability: "available", unborn: false }],
    boundaries: [],
    warnings: [],
    stale: false,
  } as never);
  vi.mocked(graphAPI.timeline).mockResolvedValue({
    events: [{ id: "e", time: "2026-10-04T00:00:00Z", source: "codex", session_id: "s", category: "tool", name: "tool.completed", summary: "captured", repo_id: "r", worktree_id: "w" }],
    has_more: false,
    order: "newest_first",
  } as never);
  const graph = createWorkspaceGraph(() => {});
  keep("graph", graph.root);
  await graph.refresh();
  await flush();
  [...graph.root.querySelectorAll("button")].find((b) => b.textContent === "Timeline")?.click();
  await flush();
  mounted.push({ name: "graph:timeline", root: graph.root });

  const canvasGraph = createWorkspaceGraph(() => {});
  keep("graph:canvas", canvasGraph.root);
  await canvasGraph.refresh();
  await flush();

  vi.mocked(graphAPI.activity).mockImplementation(async () => structuredClone(activityFixture) as never);
  const map = createActivityMap();
  keep("activity", map.root);
  map.update("repo-1", [{ id: "w1", name: "main" }], "balanced");
  await flush();

  apiMock.sessionEvents.mockResolvedValue(scoreFixture);
  const score = createScore(() => {});
  keep("score", score.root);
  await score.open((scoreFixture as Array<{ session_id: string }>)[0].session_id);
  await flush();

  const transport = createTransport({ store: createScope(), now: () => NOW, effectiveLiveSpan: () => 3_600_000 });
  keep("transport", transport.root);

  const chipHost = document.createElement("div");
  chipHost.append(idChip("abc"));
  keep("session-id", chipHost);
}

/**
 * Custom focusables that do not answer Enter, each with the key they do answer (or why none).
 * Every entry is asserted: it must match something that was mounted, and its key must be
 * claimed (preventDefault) by the element's own keydown handler.
 */
const EXCEPTIONS: Array<{ where: string; selector: string; key?: string; why: string }> = [
  { where: "feed", selector: ".feed-rows", why: "scrollable region tab stop with an aria-label; rows inside it are the buttons" },
  { where: "graph:canvas", selector: ".graph-canvas", key: "ArrowRight", why: "canvas: arrows pan, +/-/0 zoom; nodes inside it rove with arrows and answer Enter" },
  { where: "activity", selector: ".map-strip", key: "ArrowRight", why: "slider: arrows move the brushed range" },
  { where: "transport", selector: ".transport-track", key: "ArrowLeft", why: "slider: arrows shift the window" },
  { where: "score", selector: ".score", key: "ArrowRight", why: "score container: arrows step events, Space plays" },
];

describe("custom focusables are keyboard operable", () => {
  test("everything mounted is exercised", async () => {
    await mountAll();
    const names = mounted.map((m) => m.name);
    for (const want of ["feed", "sessions", "project", "fleet:map", "fleet:dwell", "fleet:matrix", "fleet:lanes", "fleet:airspace", "graph:timeline", "activity", "score", "transport", "session-id"]) {
      expect(names).toContain(want);
    }
    // the airspace band is read-only; the session-id chip is a native button
    for (const m of mounted) if (m.name !== "session-id" && m.name !== "fleet:airspace") expect(customFocusables(m.root).length, m.name).toBeGreaterThan(0);
  });

  test("every non-native [tabindex=0] / [role=button] answers Enter, or is a documented exception", async () => {
    await mountAll();
    const matchedExceptions = new Set<number>();
    for (const { name, root } of mounted) {
      for (const n of customFocusables(root)) {
        const answered = keydown(n, "Enter").defaultPrevented;
        if (answered) continue;
        const idx = EXCEPTIONS.findIndex((x) => name.startsWith(x.where) && n.matches(x.selector));
        const label = `${name} <${n.tagName.toLowerCase()} class="${n.getAttribute("class") ?? ""}" role=${n.getAttribute("role")}>`;
        expect(idx, `${label} does not answer Enter and is not a documented exception`).toBeGreaterThanOrEqual(0);
        matchedExceptions.add(idx);
        const ex = EXCEPTIONS[idx];
        if (ex.key) expect(keydown(n, ex.key).defaultPrevented, `${label} should claim ${ex.key}`).toBe(true);
        else expect(n.getAttribute("aria-label"), label).toBeTruthy();
      }
    }
    expect([...matchedExceptions].sort(), "stale exception entries").toEqual(EXCEPTIONS.map((_, i) => i));
  });

  test("Space also activates the row-like buttons that answer Enter", async () => {
    await mountAll();
    for (const { name, root } of mounted) {
      if (!/^(feed|sessions|project|fleet)/.test(name)) continue;
      for (const n of customFocusables(root)) {
        if (n.getAttribute("role") !== "button") continue;
        expect(keydown(n, " ").defaultPrevented, `${name} ${n.getAttribute("class")}`).toBe(true);
      }
    }
  });

  test("native controls count as operable by construction", async () => {
    await mountAll();
    const chip = mounted.find((m) => m.name === "session-id")!.root.querySelector(".session-id")!;
    expect(chip.tagName).toBe("BUTTON");
  });
});
