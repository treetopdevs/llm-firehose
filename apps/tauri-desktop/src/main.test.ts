// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("Project is the landing view; live and the attention strip remain available", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", version: "test", schema_version: 1 }
              : url.endsWith("/attention")
                ? { sessions: [], warnings: [] }
                : [],
          ),
        ),
    ),
  );
  await import("./main");
  expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe("project");
  expect(document.querySelector(".content .project")).not.toBeNull();
  expect(document.querySelector(".attention-strip")).not.toBeNull();
  const btn = (n: string) =>
    document.querySelector<HTMLButtonElement>(`.nav-btn[data-panel=${n}]`)!;
  btn("attention").click();
  expect(document.querySelector(".attention-inbox")).not.toBeNull();
  expect(document.querySelector(".attention-strip")).not.toBeNull();
  btn("live").click();
  expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe("live");
  expect(document.querySelector(".content .project")).toBeNull();
  expect(document.querySelector(".content")?.children.length).toBeGreaterThan(0);
});

test("the score view is reachable from the sidebar and starts empty", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", version: "test", schema_version: 1 }
              : url.endsWith("/attention")
                ? { sessions: [], warnings: [] }
                : [],
          ),
        ),
    ),
  );
  await import("./main");
  const btn = document.querySelector<HTMLButtonElement>(".nav-btn[data-panel=session]")!;
  btn.click();
  document.querySelector<HTMLElement>("#session-tab-score")!.click();
  expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe("session");
  expect(document.querySelector(".score")).not.toBeNull();
  expect(document.querySelector(".score")?.textContent).toContain("open a session");
  const close=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext",class {state="running";resume=vi.fn().mockResolvedValue(undefined);close=close;onstatechange=null;});
  document.querySelector<HTMLButtonElement>('[aria-label="Enable replay sound"]')!.click();
  await Promise.resolve();
  expect(document.querySelector('[aria-label="Disable replay sound"]')).not.toBeNull();
  expect(document.querySelector(".score")?.textContent).toContain("Replay sound on");
  document.querySelector<HTMLButtonElement>(".nav-btn[data-panel=live]")!.click();
  expect(close).toHaveBeenCalledOnce();
  btn.click();
  expect(document.querySelector("#session-tab-score")?.getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector('[aria-label="Enable replay sound"]')).not.toBeNull();
});

test("the loops view is reachable from the sidebar and starts empty", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", version: "test", schema_version: 1 }
              : url.endsWith("/attention")
                ? { sessions: [], warnings: [] }
                : [],
          ),
        ),
    ),
  );
  await import("./main");
  const btn = document.querySelector<HTMLButtonElement>(".nav-btn[data-panel=session]")!;
  btn.click();
  document.querySelector<HTMLElement>("#session-tab-loops")!.click();
  expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe("session");
  expect(document.querySelector(".loops")).not.toBeNull();
  expect(document.querySelector(".loops")?.textContent).toContain("Choose a session");
});

test("entering Loom closes and empties the open shared detail pane", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal("EventSource", class { onopen = null; onerror = null; onmessage = null; close() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/health") ? { status: "ok", version: "test", schema_version: 1 }
      : url.endsWith("/attention") ? { sessions: [], warnings: [] } : [],
  ))));
  await import("./main");
  const { renderDetail } = await import("./ui/detail");
  const fixture = (await import("./ui/score/fixture.errsig.json")).default;
  const pane = document.querySelector<HTMLElement>(".detail")!;
  renderDetail(pane, fixture[0], () => {});
  expect(pane.classList.contains("open")).toBe(true);
  expect(pane.childElementCount).toBeGreaterThan(0);
  document.querySelector<HTMLButtonElement>(".nav-btn[data-panel=session]")!.click();
  document.querySelector<HTMLElement>("#session-tab-loom")!.click();
  expect(pane.classList.contains("open")).toBe(false);
  expect(pane.childElementCount).toBe(0);
  expect(document.querySelector(".loom")).not.toBeNull();
  expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe("session");
  expect(document.querySelector("#session-tab-loom")?.getAttribute("aria-selected")).toBe("true");
});

test("leaving Files aborts its pending history request", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  let fileSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/artifacts/files")) {
        fileSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return new Response(
        JSON.stringify(
          url.endsWith("/health")
            ? { status: "ok", schema_version: 1 }
            : url.endsWith("/attention")
              ? { sessions: [], warnings: [] }
              : [],
        ),
      );
    }),
  );
  await import("./main");
  const nav = (name: string) =>
    document.querySelector<HTMLButtonElement>(`.nav-btn[data-panel=${name}]`)!;
  nav("files").click();
  expect(fileSignal).toBeDefined();
  expect(fileSignal?.aborted).toBe(false);
  nav("live").click();
  expect(fileSignal?.aborted).toBe(true);
});

// ---------------------------------------------------------------------------
// Shared scope wiring
// ---------------------------------------------------------------------------

import type { ScopeResolver } from "./scope";
import type { ActivityResponse, EventPage } from "./ui/graph/api";
import activityJson from "./ui/activity/fixture.activity.json";
import scoreFixture from "./ui/score/fixture.session.json";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const S1 = scoreFixture[0].session_id as string;
const iso = (ms: number) => new Date(ms).toISOString();
const sessionRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  source: "codex",
  agent: "codex",
  repo: "alpha",
  cwd: "/w/alpha",
  first_time: iso(NOW - 600_000),
  last_time: iso(NOW - 5_000),
  events: 3,
  ...extra,
});
const repoOf = (id: string, label = id) => ({ id, vcs: "git", label, status: "ok", observed_at: "" });
const snapshotOf = (repo: string, workspaces: string[]) => ({
  repository: repoOf(repo),
  generation: "1",
  nodes: [{ key: "a", commit_id: "a", parents: [], description: "root", timestamp: "" }],
  workspaces: workspaces.map((w) => ({
    id: w, repo_id: repo, label: `ws ${w}`, revision: "a", refs: [], dirty: false,
    conflicted: false, availability: "available", unborn: false,
  })),
  boundaries: [],
  warnings: [],
  stale: false,
});

const activityFixture = (repo: string): ActivityResponse => ({ ...structuredClone(activityJson as ActivityResponse), repo_id: repo });
type Boot = {
  scope: typeof import("./scope").scope;
  urls: string[];
  keydownListeners: Array<[EventListenerOrEventListenerObject, unknown]>;
  nav: (name: string) => HTMLButtonElement;
  active: () => string | null | undefined;
  worktreeSignals: Array<AbortSignal | undefined>;
  sources: Array<{ onopen: (() => void) | null; onmessage: ((m: { data: string }) => void) | null }>;
};
let tracked: Boot["keydownListeners"] = [];

type BootOpts = {
  sessions?: unknown[]; repos?: unknown[]; snapshots?: Record<string, unknown>; attentionSessions?: unknown[];
  events?: unknown[]; sessionEvents?: unknown[];
  worktrees?: unknown[]; worktreesStatus?: number; worktreesFailFirst?: boolean; healthGate?: Promise<void>; worktreesGate?: Promise<void>;
  // /workspace-graph/timeline answers a valid EventPage; /workspace-graph/activity a valid ActivityResponse.
  timeline?: EventPage | ((q: URLSearchParams) => EventPage);
  activity?: ActivityResponse | ((q: URLSearchParams) => ActivityResponse);
  // Also fake setTimeout (live-event debounce tests).
  fakeTimeout?: boolean;
};
async function boot(opts: BootOpts = {}): Promise<Boot> {
  document.body.innerHTML = '<div id="app"></div>';
  vi.useFakeTimers({ toFake: opts.fakeTimeout ? ["Date", "setTimeout"] : ["Date"], now: NOW });
  vi.setSystemTime(NOW);
  vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  const sources: Boot["sources"] = [];
  vi.stubGlobal("EventSource", class { onopen: (() => void) | null = null; onerror = null; onmessage: ((m: { data: string }) => void) | null = null; constructor() { sources.push(this); } close() {} });
  const urls: string[] = [];
  const worktreeSignals: Array<AbortSignal | undefined> = [];
  let failNext = opts.worktreesFailFirst === true;
  const json = (b: unknown) => new Response(JSON.stringify(b));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    const u = new URL(url);
    const p = u.pathname;
    if (p === "/worktrees") {
      worktreeSignals.push(init?.signal ?? undefined);
      if (opts.worktreesGate) await opts.worktreesGate;
      if (failNext) { failNext = false; throw new TypeError("network down"); }
      if (opts.worktreesStatus && opts.worktreesStatus !== 200) return new Response("not found", { status: opts.worktreesStatus });
      return json(opts.worktrees ?? []);
    }
    if (p === "/health") {
      if (opts.healthGate) await opts.healthGate;
      return json({ status: "ok", version: "test", schema_version: 1 });
    }
    if (p === "/attention") return json({ sessions: opts.attentionSessions ?? [], warnings: [] });
    if (p === "/sessions") return json(opts.sessions ?? []);
    if (p.startsWith("/sessions/")) return json(opts.sessionEvents ?? scoreFixture);
    if (p === "/events") return json(opts.events ?? []);
    if (p === "/workspace-graph/repos") return json(opts.repos ?? []);
    if (p === "/workspace-graph/timeline") {
      const t = opts.timeline ?? { events: [], has_more: false, order: "newest_first" };
      return json(typeof t === "function" ? t(u.searchParams) : t);
    }
    if (p === "/workspace-graph/activity") {
      const a = opts.activity ?? activityFixture(u.searchParams.get("repo_id") ?? "");
      return json(typeof a === "function" ? a(u.searchParams) : a);
    }
    if (p === "/workspace-graph") return json(opts.snapshots?.[u.searchParams.get("repo_id") ?? ""] ?? {});
    if (p === "/config") return json({ privacy_mode: "balanced" });
    return json([]);
  }));
  tracked = [];
  const orig = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(((type: string, fn: EventListenerOrEventListenerObject, o?: unknown) => {
    if (type === "keydown") tracked.push([fn, o]);
    return orig(type, fn, o as AddEventListenerOptions);
  }) as typeof document.addEventListener);
  await import("./main");
  const { scope } = await import("./scope");
  expect(scope.get()).toEqual({ window: "live" });
  const nav = (name: string) =>
    document.querySelector<HTMLButtonElement>(`.nav-btn[data-panel=${name}]`)!;
  return { scope, urls, worktreeSignals, sources, keydownListeners: tracked, nav, active: () => document.querySelector(".nav-btn.active")?.getAttribute("data-panel") };
}

// The workspace graph is the Graph chip of Project (it has no sidebar entry any more).
const chip = (e: string) => document.querySelector<HTMLButtonElement>(`.project-chips [data-encoding=${e}]`)!;
const openGraph = (b: Boot) => {
  if (b.active() !== "project") b.nav("project").click();
  chip("graph").click();
};
const esc = (target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const resolverOf = (members: string[]): ScopeResolver => ({
  sessions: () => new Set(members),
  labels: () => ({}),
});

// Session altitude helpers: the six lenses are tabs of the "session" nav entry.
const tabBtn = (t: string) => document.querySelector<HTMLElement>(`#session-tab-${t}`)!;
const tabOn = (t: string) => tabBtn(t)?.getAttribute("aria-selected") === "true";
const openTab = (b: Boot, t: string) => {
  b.nav("session").click();
  tabBtn(t).click();
};
const visiblePanels = () => document.querySelectorAll(".session-panel [role='tabpanel']:not([hidden])");
const timelineCalls = (b: Boot, id = S1) => b.urls.filter((u) => u.includes(`/sessions/${id}?view=timeline`)).length;

afterEach(() => {
  for (const [fn, o] of tracked) document.removeEventListener("keydown", fn, o as EventListenerOptions);
  tracked = [];
  vi.useRealTimers();
});

test("openScore and openLoops narrow scope.session and show the panel; score opens once", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  await vi.waitFor(() => expect(document.querySelector(".nav-btn")).not.toBeNull());
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".score-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".score-open")!.click();
  expect(b.scope.get().session).toEqual({ id: S1, source: "codex" });
  expect(b.active()).toBe("session");
  expect(tabOn("score")).toBe(true);
  await vi.waitFor(() => expect(document.querySelector(".score")?.textContent).not.toContain("open a session"));
  expect(b.urls.filter((u) => u.includes(`/sessions/${S1}?view=timeline`))).toHaveLength(1);
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".loops-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".loops-open")!.click();
  expect(b.active()).toBe("session");
  expect(tabOn("loops")).toBe(true);
  expect(b.scope.get().session).toEqual({ id: S1, source: "codex" });
});

test("F3: Score A, Loops B, then the Score nav button shows B; an unset scope.session does not reopen", async () => {
  const b = await boot();
  const A = S1;
  const B = "other-session";
  const { scope } = b;
  openTab(b, "score");
  expect(b.urls.filter((u) => u.includes("/sessions/"))).toHaveLength(0);
  scope.narrow({ session: { id: A } });
  openTab(b, "score");
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes(`/sessions/${A}?view=timeline`))).toBe(true));
  scope.narrow({ session: { id: B } });
  openTab(b, "loops");
  openTab(b, "score");
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes(`/sessions/${B}?view=timeline`))).toBe(true));
  const before = b.urls.length;
  scope.narrow({ session: undefined });
  b.nav("live").click();
  openTab(b, "score");
  await Promise.resolve();
  expect(b.urls.slice(before).filter((u) => u.includes("?view=timeline"))).toHaveLength(0);
});

const attn = (id: string) => {
  const ev = { event_id: `e-${id}`, source: "codex", kind: "tool", summary: "x", time: iso(NOW - 1000), observed_at: iso(NOW - 1000) };
  return { id, source: "codex", agent: "codex", events: 1, state: "working", last: ev, last_observed_at: iso(NOW - 1000) };
};

test("F6: openSession outside the resolver membership replaces the context; inside keeps parents", async () => {
  const b = await boot({
    sessions: [sessionRow("X"), sessionRow("Y")],
    attentionSessions: [attn("X"), attn("Y")],
  });
  const { scope } = b;
  const cell = { where: "w", agent: "codex", label: "l" };
  const openHistory = async (id: string) => {
    b.nav("attention").click();
    await vi.waitFor(() => expect(document.querySelector(`[data-key^="history:"][data-key*="${id}"]`)).not.toBeNull());
    document.querySelector<HTMLElement>(`[data-key^="history:"][data-key*="${id}"]`)!.click();
  };
  scope.set({ project: "A", worktree: "wA", cell, window: "live" });
  scope.setResolver(resolverOf(["Y"]));
  await openHistory("X");
  expect(scope.get()).toMatchObject({ session: { id: "X", source: "codex" } });
  expect(scope.get().project).toBeUndefined();
  expect(scope.get().worktree).toBeUndefined();
  expect(scope.get().cell).toBeUndefined();
  expect(b.active()).toBe("session");
  expect(tabOn("score")).toBe(true);
  scope.set({ project: "A", worktree: "wA", window: "live" });
  await openHistory("Y");
  expect(scope.get()).toMatchObject({ project: "A", worktree: "wA", session: { id: "Y", source: "codex" } });
  // With no resolver the membership is unknown: context is replaced.
  scope.setResolver(null);
  scope.set({ project: "A", worktree: "wA", window: "live" });
  await openHistory("Y");
  expect(scope.get().project).toBeUndefined();
});

test("a sessions row click sets scope.session; the evidence court leaves scope unchanged", async () => {
  const b = await boot({ sessions: [sessionRow("r1")] });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector(".session-item[data-id='r1']")).not.toBeNull());
  document.querySelector<HTMLElement>(".session-item[data-id='r1']")!.click();
  expect(b.scope.get().session).toEqual({ id: "r1", source: "codex" });
  expect(b.active()).toBe("sessions");
  const before = b.scope.get();
  openTab(b, "court");
  expect(tabOn("court")).toBe(true);
  expect(b.scope.get()).toBe(before);
});

test("Escape ascends session, worktree, project from score; fleet is a no-op", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  b.scope.set({ project: "P", worktree: "W", session: { id: S1 }, window: "live" });
  openTab(b, "score");
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes("?view=timeline"))).toBe(true));
  const e1 = esc();
  expect(e1.defaultPrevented).toBe(true);
  expect(b.scope.get().session).toBeUndefined();
  expect(b.scope.get().worktree).toBe("W");
  expect(b.active()).toBe("sessions");
  expect(document.querySelector(".session-events-list")).toBeNull();
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
  expect(b.scope.get().project).toBe("P");
  esc();
  expect(b.scope.get().project).toBeUndefined();
  const e4 = esc();
  expect(e4.defaultPrevented).toBe(false);
  expect(b.active()).toBe("sessions");
});

test("a sessions row click only narrows scope: no refetch, the clicked row survives", async () => {
  const b = await boot({ sessions: [sessionRow("r1")] });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector(".session-item[data-id='r1']")).not.toBeNull());
  const row = document.querySelector<HTMLElement>(".session-item[data-id='r1']")!;
  const listCalls = () => b.urls.filter((u) => new URL(u).pathname === "/sessions").length;
  const before = listCalls();
  row.click();
  await Promise.resolve();
  expect(b.scope.get().session).toEqual({ id: "r1", source: "codex" });
  expect(listCalls()).toBe(before);
  expect(document.querySelector(".session-item[data-id='r1']")).toBe(row);
});

test("opening a session outside the scoped project/worktree clears them; a confirmed member keeps them", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  b.scope.set({ project: "A", worktree: "w1", window: "live" });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".score-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".score-open")!.click();
  expect(b.scope.get()).toMatchObject({ session: { id: S1 } });
  expect(b.scope.get().project).toBeUndefined();
  expect(b.scope.get().worktree).toBeUndefined();

  b.scope.set({ project: "A", worktree: "w1", window: "live" });
  b.scope.setResolver(resolverOf([S1]));
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".loops-open, .score-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".score-open")!.click();
  expect(b.scope.get()).toMatchObject({ project: "A", worktree: "w1", session: { id: S1 } });
});

test("Escape from loops returns to sessions and ascends; Escape on sessions refetches the list", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  b.scope.set({ project: "P", worktree: "W", session: { id: S1 }, window: "live" });
  openTab(b, "loops");
  expect(b.active()).toBe("session");
  expect(tabOn("loops")).toBe(true);
  esc();
  expect(b.active()).toBe("sessions");
  expect(b.scope.get().session).toBeUndefined();
  expect(b.scope.get().worktree).toBe("W");
  await vi.waitFor(() => expect(document.querySelector(".sessions")).not.toBeNull());
  const listCalls = () => b.urls.filter((u) => new URL(u).pathname === "/sessions").length;
  await vi.waitFor(() => expect(listCalls()).toBeGreaterThan(0));
  const before = listCalls();
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
  await vi.waitFor(() => expect(listCalls()).toBeGreaterThan(before));
});

test("Escape is a no-op on non-scope panels", async () => {
  const b = await boot();
  b.scope.set({ project: "P", window: "live" });
  for (const name of ["files", "doctor"]) {
    b.nav(name).click();
    const e = esc();
    expect(e.defaultPrevented).toBe(false);
    expect(b.scope.get().project).toBe("P");
  }
});

test("Escape yields to inputs, open menus, overlays, claimed and prevented events; a hidden menu does not block", async () => {
  const b = await boot();
  const set = () => b.scope.set({ project: "P", window: "live" });
  b.nav("sessions").click();
  set();
  const input = document.createElement("input");
  const select = document.createElement("select");
  const menu = document.createElement("div");
  menu.className = "graph-menu";
  const inMenu = document.createElement("button");
  menu.append(inMenu);
  document.body.append(input, select, menu);
  esc(input);
  esc(select);
  esc(inMenu);
  expect(b.scope.get().project).toBe("P");
  const overlay = document.createElement("div");
  overlay.className = "onboarding-overlay";
  document.body.append(overlay);
  esc();
  expect(b.scope.get().project).toBe("P");
  overlay.remove();
  const { claimEscape } = await import("./escape");
  const claimed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  claimEscape(claimed);
  document.body.dispatchEvent(claimed);
  expect(b.scope.get().project).toBe("P");
  const pre = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  pre.preventDefault();
  document.body.dispatchEvent(pre);
  expect(b.scope.get().project).toBe("P");
  // A hidden .graph-menu elsewhere in the DOM, with a body target, still ascends.
  menu.setAttribute("hidden", "");
  esc();
  expect(b.scope.get().project).toBeUndefined();
});

test("footer crumb sits between the status text and the event count and never asks for /worktrees", async () => {
  const b = await boot();
  const bar = document.querySelector(".status-bar")!;
  const kids = [...bar.children];
  const crumb = bar.querySelector(".scope-crumb")!;
  expect(kids.indexOf(crumb)).toBe(kids.indexOf(bar.querySelector(".status-text")!) + 1);
  expect(kids.indexOf(crumb)).toBe(kids.indexOf(bar.querySelector(".event-count")!) - 1);
  expect(crumb.textContent).toBe("");
  b.scope.narrow({ project: "repo-abcdef123456", worktree: "wt-0123456789ab" });
  // The Project panel's fallback resolver marks a project the lifetimes do not know as "(unknown)";
  // only the worktree stays an unresolved short id.
  expect(crumb.querySelectorAll(".unresolved")).toHaveLength(1);
  expect(crumb.textContent).toContain("(unknown)");
  b.scope.setResolver({ sessions: () => undefined, labels: () => ({ project: "Alpha", worktree: "main" }) });
  expect(crumb.textContent).toBe("Alpha › main");
  // Landing on Project issues the one /worktrees request; the crumb adds none.
  expect(b.urls.filter((u) => new URL(u).pathname === "/worktrees")).toHaveLength(1);
});

test("graph round trip: a second project scope loads that repository; sessions filter only through the resolver", async () => {
  // The hidden graph answers no membership, so the resolver is Project's lifetime rows.
  const inRepo = wtRow({ repo_id: "r1", worktree_id: "wt-r1", sessions: [{ source: "codex", session_id: "s-in", first_time: iso(NOW - 600_000), last_time: iso(NOW - 5_000), events: 3 }], sessions_total: 1 });
  const b = await boot({
    worktrees: [inRepo],
    sessions: [sessionRow("s-in"), sessionRow("s-out")],
    repos: [repoOf("r1"), repoOf("r2")],
    snapshots: { r1: snapshotOf("r1", ["w1"]), r2: snapshotOf("r2", ["w2"]) },
    attentionSessions: [{ ...attn("s-in"), repo_id: "r1" }, { ...attn("s-out"), repo_id: "r2" }],
  });
  b.scope.narrow({ project: "nobody" });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelectorAll(".session-item")).toHaveLength(2));
  b.scope.reset();
  openGraph(b);
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes("repo_id=r1"))).toBe(true));
  b.scope.narrow({ project: "r2" });
  // Encodings are remembered per repository: r2 opens in Lanes, where the hidden graph fetches nothing.
  expect(selectedChip()).toBe("lanes");
  chip("graph").click();
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes("repo_id=r2"))).toBe(true));
  expect(b.scope.get().project).toBe("r2");
  b.scope.narrow({ project: "r1" });
  await vi.waitFor(() => expect(b.urls.filter((u) => u.includes("repo_id=r1")).length).toBeGreaterThan(1));
  b.nav("sessions").click();
  await vi.waitFor(() => expect([...document.querySelectorAll(".session-item")].map((i) => i.getAttribute("data-id"))).toEqual(["s-in"]));
});

test("Escape in the real graph clears the selection first and leaves the project; the second ascends", async () => {
  const b = await boot({
    sessions: [sessionRow("s1")],
    repos: [repoOf("r1")],
    snapshots: { r1: snapshotOf("r1", ["w1"]) },
  });
  openGraph(b);
  await vi.waitFor(() => expect(document.querySelector(".workspace-label")).not.toBeNull());
  document.querySelector<SVGGElement>(".workspace-label")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(b.scope.get().worktree).toBe("w1"));
  const project = b.scope.get().project;
  expect(project).toBe("r1");
  esc();
  expect(b.scope.get().project).toBe("r1");
  esc();
  await vi.waitFor(() => expect(b.scope.get().project).toBeUndefined());
  expect(b.scope.get().worktree).toBeUndefined();
  expect(document.querySelector(".workspace-label.selected, .workspace-label[aria-selected='true']")).toBeNull();
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelectorAll(".session-item")).toHaveLength(1));
});

// ---------------------------------------------------------------------------
// Project altitude (landing view)
// ---------------------------------------------------------------------------

const wtRow = (over: Record<string, unknown> = {}) => ({
  repo_id: "repoA", worktree_id: "wt-open", label: "/w/alpha-open",
  first_time: iso(NOW - 2 * 86_400_000), last_time: iso(NOW - 30 * 60_000),
  sessions: [{ source: "codex", session_id: "s-o1", first_time: iso(NOW - 2 * 86_400_000), last_time: iso(NOW - 30 * 60_000), events: 5 }],
  sessions_total: 1, paths: [], paths_total: 0, signal_events: 5, meta_events: 0,
  marks: [], marks_total: 0, marks_available: true, state: "open", ahead: 1, ...over,
});
const laneOrEmpty = () => document.querySelector(".project-lane, .project-empty");

test("sidebar groups altitudes, lenses and housekeeping; the folded panels are gone", async () => {
  const b = await boot();
  const names = [...document.querySelectorAll(".nav-btn")].map((x) => x.textContent);
  expect(names).toEqual(["Fleet", "Project", "Sessions", "Session", "Live", "Needs you", "Session stratigraphy", "Patch ecosystem", "Files", "Doctor", "Settings"]);
  const heads = [...document.querySelectorAll(".sidebar .nav-heading")];
  expect(heads.map((h) => h.textContent)).toEqual(["Altitudes", "Lenses", "Housekeeping"]);
  const first = ["fleet", "live", "files"];
  heads.forEach((h, i) => expect(h.nextElementSibling).toBe(b.nav(first[i]!)));
  expect(b.nav("workspace")).toBeNull();
  for (const gone of ["dwell", "matrix", "lanes", "airspace", "score", "loops", "loom", "replay", "handoffs", "court"]) expect(b.nav(gone)).toBeNull();
  expect(b.active()).toBe("project");
});

test.each([
  ["rows", [wtRow()], ".project-lane"],
  ["no rows", [], ".project-empty"],
])("landing requests /worktrees once, does not write scope, aborts on leaving (%s)", async (_n, worktrees, sel) => {
  const b = await boot({ worktrees });
  expect(b.worktreeSignals).toHaveLength(1);
  expect(b.worktreeSignals[0]?.aborted).toBe(false);
  await vi.waitFor(() => expect(laneOrEmpty()).not.toBeNull());
  expect(document.querySelector(sel)).not.toBeNull();
  expect(b.scope.get()).toEqual({ window: "live" });
  expect(b.worktreeSignals).toHaveLength(1);
  b.nav("live").click();
  expect(b.worktreeSignals[0]?.aborted).toBe(true);
  b.nav("project").click();
  expect(b.worktreeSignals).toHaveLength(2);
  expect(b.worktreeSignals[1]?.aborted).toBe(false);
});

function expectProjectInert(b: Boot) {
  // Resolver refreshes fetch without a signal; the panel's own loads always carry one.
  const own = b.worktreeSignals.filter((x) => x !== undefined);
  expect(own[own.length - 1]?.aborted).toBe(true);
  const before = b.scope.get();
  const n = b.worktreeSignals.length;
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(b.scope.get()).toEqual(before);
  expect(b.worktreeSignals).toHaveLength(n);
}

test("SSE reconnect refreshes Project only while it is the active panel", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  expect(b.sources.length).toBeGreaterThan(0);
  const n = b.worktreeSignals.length;
  b.sources.forEach((s) => s.onopen?.());
  await vi.waitFor(() => expect(b.worktreeSignals.length).toBe(n + 1));
  b.nav("live").click();
  const m = b.worktreeSignals.length;
  b.sources.forEach((s) => s.onopen?.());
  await Promise.resolve();
  expect(b.worktreeSignals).toHaveLength(m);
});

test("lane click scopes the sessions list", async () => {
  const b = await boot({
    worktrees: [wtRow()],
    sessions: [sessionRow("s-o1"), sessionRow("s-x")],
  });
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  document.querySelector<SVGGElement>(".project-lane")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(b.scope.get()).toMatchObject({ project: "repoA", worktree: "wt-open" });
  expect(b.active()).toBe("sessions");
  expectProjectInert(b);
  await vi.waitFor(() => expect([...document.querySelectorAll(".session-item")].map((i) => i.getAttribute("data-id"))).toEqual(["s-o1"]));
  expect(document.querySelector(".scope-crumb")?.textContent).toContain("/w/alpha-open");
  expect(document.querySelector(".scope-crumb")?.textContent).not.toMatch(/wt-open/);
  expect(b.urls.some((u) => new URL(u).pathname === "/workspace-graph")).toBe(false);
});

test("bead click opens Score", async () => {
  const b = await boot({ worktrees: [wtRow()], sessions: [sessionRow("s-o1")] });
  b.nav("live").click();
  b.nav("project").click();
  await vi.waitFor(() => expect(document.querySelector(".project-bead")).not.toBeNull());
  document.querySelector<SVGRectElement>(".project-bead")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(b.scope.get().session).toEqual({ id: "s-o1", source: "codex" });
  expect(b.active()).toBe("session");
  expect(tabOn("score")).toBe(true);
  expectProjectInert(b);
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes("/sessions/s-o1?view=timeline"))).toBe(true));
});

test("older daemon: /worktrees 404 renders the unsupported notice without touching scope", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const b = await boot({ worktreesStatus: 404 });
  await vi.waitFor(() => expect(document.querySelector(".project-unsupported")).not.toBeNull());
  b.nav("live").click();
  expect(b.active()).toBe("live");
  expect(b.scope.get()).toEqual({ window: "live" });
  await new Promise((r) => setTimeout(r, 0));
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  expect(errors).not.toHaveBeenCalled();
});

test("cold start recovery: a failed first load shows Connecting, then lanes once the daemon is healthy", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await boot({ worktrees: [wtRow()], worktreesFailFirst: true, healthGate: gate });
  await vi.waitFor(() => expect(document.querySelector(".project-connecting")).not.toBeNull());
  expect(document.querySelector(".project-error")).toBeNull();
  release();
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  expect(document.querySelector(".project-connecting")).toBeNull();
});

test("Escape ascends Project: worktree to project stays on Project, project to fleet lands on Live (one repo); inputs are excluded", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  await vi.waitFor(() => expect(document.querySelector("select.project-repo")).not.toBeNull());
  b.scope.narrow({ project: "repoA", worktree: wtRow().worktree_id });
  const before = b.scope.get();
  const e1 = esc(document.querySelector("select.project-repo")!);
  expect(e1.defaultPrevented).toBe(false);
  expect(b.scope.get()).toEqual(before);
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
  expect(b.scope.get().project).toBe("repoA");
  expect(b.active()).toBe("project");
  const e3 = esc();
  expect(e3.defaultPrevented).toBe(true);
  expect(b.scope.get().project).toBeUndefined();
  expect(b.active()).toBe("live");
});

test("detail pane is cleared on entering Project", async () => {
  const b = await boot();
  const { renderDetail } = await import("./ui/detail");
  const fixture = (await import("./ui/score/fixture.errsig.json")).default;
  b.nav("files").click();
  const pane = document.querySelector<HTMLElement>(".detail")!;
  renderDetail(pane, fixture[0], () => {});
  expect(pane.childElementCount).toBeGreaterThan(0);
  b.nav("project").click();
  expect(pane.classList.contains("open")).toBe(false);
  expect(pane.childElementCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Fleet altitude
// ---------------------------------------------------------------------------

const twoRepos = () => [wtRow(), wtRow({ repo_id: "repoB", worktree_id: "wt-b", label: "/w/beta", sessions: [{ source: "codex", session_id: "s-b1", first_time: iso(NOW - 3_600_000), last_time: iso(NOW - 60_000), events: 2 }] })];
const needy = (id: string, repoId: string | undefined, over: Record<string, unknown> = {}) => {
  const ev = (kind: string, summary: string, ago: number) => ({ event_id: `e-${id}-${kind}`, source: "codex", kind, summary, time: iso(NOW - ago), observed_at: iso(NOW - ago) });
  return {
    id, source: "codex", agent: "codex", events: 2, state: "needs_input", ...(repoId ? { repo_id: repoId, repo: `name-${repoId}` } : {}),
    last: ev("activity", "ran tests", 30_000), pending: ev("request", "may I run this?", 60_000), ...over,
  };
};
const fleetRows = () => [...document.querySelectorAll(".fleet-row")];

test("landing: one repository stays on Project", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 0));
  expect(b.active()).toBe("project");
});

test("landing: two repositories move to Fleet once; the project request is aborted, the fleet request is live", async () => {
  const b = await boot({ worktrees: twoRepos() });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  expect(document.querySelector(".content .fleet")).not.toBeNull();
  expect(b.worktreeSignals[0]?.aborted).toBe(true);
  expect(b.worktreeSignals[1]?.aborted).toBe(false);
  expect(b.scope.get()).toEqual({ window: "live" });
  // Decided once: a later visit to Project stays on Project after its load.
  b.nav("project").click();
  await vi.waitFor(() => expect(document.querySelector(".project-lane, select.project-repo")).not.toBeNull());
  await new Promise((r) => setTimeout(r, 0));
  expect(b.active()).toBe("project");
});

test("landing: navigating away before the load lands cancels the move", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const b = await boot({ worktrees: twoRepos(), worktreesGate: gate });
  b.nav("live").click();
  release();
  await new Promise((r) => setTimeout(r, 0));
  expect(b.active()).toBe("live");
  // Positive signal: a full two-repository load completes, and still nothing moves the user.
  b.nav("project").click();
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  expect(b.active()).toBe("project");
});

test("landing: narrowing the scope before the load lands cancels the move", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const b = await boot({ worktrees: twoRepos(), worktreesGate: gate });
  b.scope.narrow({ project: "repoA" });
  release();
  // Positive signal: the Project load landed (its lanes are drawn).
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  expect(b.active()).toBe("project");
  expect(b.scope.get().project).toBe("repoA");
});

test("landing: a failed first load does not leave a redirect armed for a later recovery", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const b = await boot({ worktrees: twoRepos(), worktreesFailFirst: true, healthGate: gate });
  await vi.waitFor(() => expect(document.querySelector(".project-connecting")).not.toBeNull());
  release();
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  expect(b.active()).toBe("project");
});

test("landing: an older daemon (404) stays on Project", async () => {
  const b = await boot({ worktreesStatus: 404 });
  await vi.waitFor(() => expect(document.querySelector(".project-unsupported")).not.toBeNull());
  expect(b.active()).toBe("project");
});

test("Escape: Project ascends to Fleet when there is more than one repository; Fleet clears the project and an empty scope claims nothing", async () => {
  const b = await boot({ worktrees: twoRepos() });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  b.nav("project").click();
  await vi.waitFor(() => expect(document.querySelector("select.project-repo")).not.toBeNull());
  b.scope.narrow({ project: "repoA" });
  expect(esc().defaultPrevented).toBe(true);
  expect(b.scope.get().project).toBeUndefined();
  expect(b.active()).toBe("fleet");
  b.scope.narrow({ project: "repoB" });
  expect(esc().defaultPrevented).toBe(true);
  expect(b.scope.get().project).toBeUndefined();
  expect(b.active()).toBe("fleet");
  const e = esc();
  expect(e.defaultPrevented).toBe(false);
  expect(b.active()).toBe("fleet");
});

test("Fleet descents carry the window; row, fork and need open project, sessions (project+worktree) and score", async () => {
  const win = { from: NOW - 86_400_000, to: NOW - 3_600_000 };
  const b = await boot({ worktrees: twoRepos(), sessions: [sessionRow("s-n1")], attentionSessions: [needy("s-n1", "repoA", { worktree_id: "wt-open" })] });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  await vi.waitFor(() => expect(document.querySelector(".fleet-need")).not.toBeNull());
  b.scope.set({ project: "repoA", window: win });
  const label = (r: Element) => r.querySelector(".fleet-row-label")!.textContent!;
  expect(fleetRows().length).toBe(2);
  // Row head -> Project, window kept, no stale worktree/session.
  const rowB = fleetRows().find((r) => label(r) !== label(fleetRows().find((x) => x.querySelector(".fleet-need"))!))!;
  rowB.querySelector<HTMLElement>(".fleet-row-head")!.click();
  expect(b.active()).toBe("project");
  expect(b.scope.get()).toMatchObject({ project: "repoB", window: win });
  expect(b.scope.get().worktree).toBeUndefined();
  expect(b.scope.get().session).toBeUndefined();
  b.nav("fleet").click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-fork")).not.toBeNull());
  const forkA = [...document.querySelectorAll<HTMLElement>(".fleet-fork")].find((f) => f.closest(".fleet-row")?.querySelector(".fleet-need"))!;
  forkA.click();
  // Changed (fleet-altitude item 3): a fork narrows project+worktree and descends to Sessions, not Project.
  expect(b.active()).toBe("sessions");
  expect(b.scope.get()).toMatchObject({ project: "repoA", worktree: "wt-open", window: win });
  b.nav("fleet").click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-need")).not.toBeNull());
  document.querySelector<HTMLElement>(".fleet-need")!.click();
  expect(b.active()).toBe("session");
  expect(tabOn("score")).toBe(true);
  expect(b.scope.get().session).toEqual({ id: "s-n1", source: "codex" });
});

test("Escape from Sessions reached by a Fleet fork returns to Project, then Fleet (not stuck on Sessions)", async () => {
  const b = await boot({ worktrees: twoRepos() });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  await vi.waitFor(() => expect(document.querySelector(".fleet-fork")).not.toBeNull());
  document.querySelector<HTMLElement>(".fleet-fork")!.click();
  expect(b.active()).toBe("sessions");
  expect(b.scope.get().worktree).toBeDefined();
  expect(esc().defaultPrevented).toBe(true);
  expect(b.active()).toBe("project");
  expect(b.scope.get().worktree).toBeUndefined();
  expect(b.scope.get().project).toBeDefined();
  expect(esc().defaultPrevented).toBe(true);
  expect(b.active()).toBe("fleet");
  expect(b.scope.get().project).toBeUndefined();
});

test("Fleet is inert off-screen: keys, stream reconnects and events cause no requests or scope writes", async () => {
  const b = await boot({ worktrees: twoRepos() });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  b.nav("live").click();
  const before = b.scope.get();
  const n = b.worktreeSignals.length;
  const own = b.worktreeSignals.filter((x) => x !== undefined);
  expect(own[own.length - 1]?.aborted).toBe(true);
  for (const key of ["1", "n", "N", " ", "Enter", "ArrowDown"]) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  }
  b.sources.forEach((src) => src.onopen?.());
  await new Promise((r) => setTimeout(r, 0));
  expect(b.scope.get()).toEqual(before);
  expect(b.worktreeSignals).toHaveLength(n);
  expect(b.active()).toBe("live");
});

test("Fleet labels rows from attention when /worktrees is a 404, and says so", async () => {
  const b = await boot({ worktreesStatus: 404, attentionSessions: [needy("s-f1", "repoZ")] });
  b.nav("fleet").click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-row-label")).not.toBeNull());
  expect(document.querySelector(".fleet-row-label")!.textContent).toBe("name-repoZ");
  expect(document.querySelector(".fleet-unsupported")).not.toBeNull();
  expect(document.querySelector(".fleet-row-head")!.getAttribute("aria-disabled")).toBe("true");
});

// ---------------------------------------------------------------------------
// Session altitude: six lenses as tabs over one session and one transport
// ---------------------------------------------------------------------------

import errsigFixture from "./ui/score/fixture.errsig.json";

const T0 = Date.parse(scoreFixture[0].time);
const S1_SOURCE = scoreFixture[0].source as string;
const scoreView = () => document.querySelector(".score-overview .score-view");
const viewW = () => Number(scoreView()!.getAttribute("width"));
const loadedScore = () => vi.waitFor(() => expect(scoreView(), document.querySelector(".score-chart")?.textContent).not.toBeNull());
const ERR_SID = "019fd182-8513-7461-a816-e786f1fe439e";
const errEvents = (errsigFixture as Array<Record<string, any>>).filter((e) => e.session_id === ERR_SID);

test.each(["court", "loom", "replay", "handoffs"])("Escape on the %s tab neither ascends nor is prevented", async (t) => {
  const b = await boot();
  b.scope.set({ project: "P", worktree: "W", session: { id: S1 }, window: "live" });
  openTab(b, t);
  const before = b.scope.get();
  const e = esc(tabBtn(t));
  expect(e.defaultPrevented).toBe(false);
  expect(b.scope.get()).toBe(before);
  expect(b.active()).toBe("session");
  expect(tabOn(t)).toBe(true);
});

test("Escape from the Loom Source input is not prevented", async () => {
  const b = await boot();
  b.scope.set({ project: "P", session: { id: S1 }, window: "live" });
  openTab(b, "loom");
  const source = document.querySelector<HTMLInputElement>('[aria-label="Source"]')!;
  expect(source).not.toBeNull();
  expect(esc(source).defaultPrevented).toBe(false);
  expect(b.scope.get().session).toEqual({ id: S1 });
  expect(b.active()).toBe("session");
  expect(tabOn("loom")).toBe(true);
});

test("Escape round trip: Session -> Sessions clears the session, keeps the worktree; the score button returns with the window live", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  b.scope.set({ project: "P", worktree: "W", session: { id: S1 }, window: "live" });
  b.nav("session").click();
  expect(esc().defaultPrevented).toBe(true);
  expect(b.active()).toBe("sessions");
  expect(b.scope.get().session).toBeUndefined();
  expect(b.scope.get().worktree).toBe("W");
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".score-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".score-open")!.click();
  expect(b.active()).toBe("session");
  expect(tabOn("score")).toBe(true);
  expect(b.scope.get().window).toBe("live");
  expect(b.scope.get().session).toEqual({ id: S1, source: "codex" });
});

test("tab keyboard: ArrowRight, End and Home move the selected tab, focus and the one visible tabpanel", async () => {
  const b = await boot();
  b.nav("session").click();
  const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  tabBtn("score").focus();
  press("ArrowRight");
  expect(tabOn("loops")).toBe(true);
  expect(document.activeElement?.id).toBe("session-tab-loops");
  expect(visiblePanels()).toHaveLength(1);
  expect(visiblePanels()[0]!.id).toBe("session-panel-loops");
  press("End");
  expect(tabOn("court")).toBe(true);
  expect(document.activeElement?.id).toBe("session-tab-court");
  expect(visiblePanels()[0]!.id).toBe("session-panel-court");
  press("Home");
  expect(tabOn("score")).toBe(true);
  expect(document.activeElement?.id).toBe("session-tab-score");
  expect(visiblePanels()).toHaveLength(1);
  expect(visiblePanels()[0]!.id).toBe("session-panel-score");
});

test("the tab is remembered per session across nav away and back; openers naming no tab land on Score", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  b.scope.set({ session: { id: S1, source: "codex" }, window: "live" });
  openTab(b, "loops");
  b.nav("live").click();
  b.nav("session").click();
  expect(tabOn("loops")).toBe(true);
  b.nav("live").click();
  b.scope.narrow({ session: { id: "other-session" } });
  b.nav("session").click();
  expect(tabOn("score")).toBe(true);
  b.nav("live").click();
  b.scope.narrow({ session: { id: S1, source: "codex" } });
  b.nav("session").click();
  expect(tabOn("loops")).toBe(true);
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".score-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".score-open")!.click();
  expect(b.active()).toBe("session");
  expect(tabOn("score")).toBe(true);
});

test("scope.window drives Score and the filter lenses; the panel only writes through the reset chip", async () => {
  const b = await boot();
  b.scope.set({ session: { id: S1, source: S1_SOURCE }, window: "live" });
  b.nav("session").click();
  await loadedScore();
  const full = viewW();
  const narrow = { from: T0 + 100_000, to: T0 + 200_000 };
  b.scope.narrow({ window: narrow });
  expect(viewW()).toBeLessThan(full);
  expect(b.scope.get().window).toEqual(narrow);
  const wide = { from: T0, to: T0 + 600_000 };
  const narrowBeforeWiden = viewW();
  b.scope.narrow({ window: wide });
  expect(viewW()).toBeGreaterThan(narrowBeforeWiden);
  expect(viewW()).toBeLessThanOrEqual(full);
  expect(b.scope.get().window).toEqual(wide);
  b.scope.narrow({ window: narrow });
  const narrowW = viewW();
  b.scope.narrow({ window: wide });
  expect(viewW()).toBeGreaterThan(narrowW);
  expect(timelineCalls(b)).toBe(1);

  tabBtn("loops").click();
  const head = (t: string) => document.querySelector<HTMLElement>(`#session-panel-${t} .session-lens-head`)!;
  const reset = head("loops").querySelector<HTMLButtonElement>("button")!;
  expect(reset).not.toBeNull();
  expect(head("loops").textContent).toContain("→");
  reset.click();
  expect(b.scope.get().window).toBe("live");
  expect(head("loops").querySelector("button")).toBeNull();
  b.scope.narrow({ window: wide });
  for (const t of ["handoffs", "court"]) {
    tabBtn(t).click();
    expect(head(t).textContent).toContain("does not apply");
    expect(head(t).querySelector("button")).toBeNull();
  }
  expect(b.scope.get().window).toEqual(wide);
});

test("late-event consistency: a live window shows an event after the former bounds on Loops", async () => {
  const ts = errEvents.map((e) => Date.parse(e.time));
  const lateTime = new Date(Math.max(...ts) + 86_400_000).toISOString();
  const late = { ...errEvents[errEvents.length - 1], id: "late-event-1", time: lateTime };
  const b = await boot({ sessionEvents: [...errEvents, late] });
  const win = { from: Math.min(...ts), to: Math.max(...ts) };
  b.scope.set({ session: { id: ERR_SID, source: errEvents[0]!.source }, window: win });
  openTab(b, "loops");
  await vi.waitFor(() => expect(document.querySelector(".loops")?.textContent).toContain("2 of 3 occurrences in window"));
  document.querySelector<HTMLButtonElement>("#session-panel-loops .session-window-reset")!.click();
  expect(b.scope.get().window).toBe("live");
  await vi.waitFor(() => expect(document.querySelectorAll(".loop-occurrence")).toHaveLength(3));
  expect(document.querySelector(".loops")?.textContent).not.toContain("occurrences in window");
});

test("a disjoint window is left unchanged by Score, and survives Session -> Fleet -> Session", async () => {
  const b = await boot();
  const disjoint = { from: T0 - 10 * 86_400_000, to: T0 - 9 * 86_400_000 };
  b.scope.set({ session: { id: S1, source: S1_SOURCE }, window: disjoint });
  openTab(b, "score");
  await loadedScore();
  expect(b.scope.get().window).toEqual(disjoint);
  b.nav("fleet").click();
  b.nav("session").click();
  expect(b.scope.get().window).toEqual(disjoint);
  await loadedScore();
  expect(b.scope.get().window).toEqual(disjoint);
});

test("empty scope: every tab opens without error or session fetch and says no session in scope", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const b = await boot();
  expect(b.scope.get().session).toBeUndefined();
  for (const t of ["score", "loops", "loom", "replay", "handoffs", "court"]) {
    openTab(b, t);
    expect(tabOn(t)).toBe(true);
    expect(document.querySelector(`#session-panel-${t} .session-lens-title`)?.textContent).toBe("no session in scope");
    expect(document.querySelector(`#session-panel-${t} .session-lens-head`)?.textContent).not.toMatch(/window|whole session/);
    // Lens roots are attached in the active panel only; handoffs and court keep standalone behaviour.
    expect(document.querySelector(`#session-panel-${t}`)!.children.length).toBeGreaterThan(1);
  }
  await new Promise((r) => setTimeout(r, 0));
  expect(b.urls.filter((u) => new URL(u).pathname.startsWith("/sessions/"))).toHaveLength(0);
  expect(errors).not.toHaveBeenCalled();
});

test("Use in Evidence Court opens the Court tab with the event id carried over", async () => {
  const ev = scoreFixture[0];
  const b = await boot({ events: [ev] });
  b.nav("live").click();
  await vi.waitFor(() => expect(document.querySelector(".feed-row")).not.toBeNull());
  document.querySelector<HTMLElement>(".feed-row")!.click();
  const offer = [...document.querySelectorAll<HTMLButtonElement>("aside.detail button")].find((x) => x.textContent === "Use in Evidence Court")!;
  expect(offer).toBeTruthy();
  offer.click();
  expect(tabOn("court")).toBe(true);
  expect(b.active()).toBe("session");
  expect(document.querySelector<HTMLInputElement>('[aria-label="Event ID"]')!.value).toBe(ev.id);
});

test("late-event consistency: a live window shows an event after the former bounds in Fleet lanes", async () => {
  const b = await boot({ worktrees: twoRepos(), sessions: [sessionRow(S1, { source: S1_SOURCE })] });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  await vi.waitFor(() => expect(b.sources.length).toBeGreaterThan(0));
  const bounds = { from: NOW - 3_600_000, to: NOW - 1_800_000 };
  b.scope.set({ window: bounds });
  const late = { ...scoreFixture[0], id: "late-fleet-1", session_id: S1, source: S1_SOURCE, time: iso(NOW - 10_000) };
  b.sources.forEach((s) => (s as unknown as { onmessage: ((m: { data: string }) => void) | null }).onmessage?.({ data: JSON.stringify(late) }));
  document.querySelector<HTMLElement>('[data-enc="lanes"]')!.click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-lanes")).not.toBeNull());
  expect(document.querySelectorAll("rect.lane-tick")).toHaveLength(0);
  b.scope.narrow({ window: "live" });
  await vi.waitFor(() => expect(document.querySelectorAll("rect.lane-tick")).toHaveLength(1));
});

// ---------------------------------------------------------------------------
// Shell-owned transport (D94-D98): one time control read by Project, Fleet, Session
// ---------------------------------------------------------------------------

import { windowLabel } from "./ui/session/context";

const DAY_MS = 86_400_000;
const tp = () => document.querySelector<HTMLElement>('[aria-label="Time window"]')!;
const tpAll = () => document.querySelectorAll('[aria-label="Time window"]');
// The faked Date keeps advancing with real time; pin it each time a control is fetched
// for an action so the window arithmetic is exact.
const pin = () => vi.setSystemTime(NOW);
const tpPreset = (id: string) => (pin(), tp().querySelector<HTMLButtonElement>(`[data-preset="${id}"]`)!);
const tpLive = () => (pin(), tp().querySelector<HTMLButtonElement>(".transport-live")!);
const tpHold = () => (pin(), tp().querySelector<HTMLButtonElement>(".transport-hold")!);
const tpTrack = () => (pin(), tp().querySelector<HTMLElement>(".transport-track")!);
const tpRange = () => tp().querySelector<HTMLElement>(".transport-range")!.textContent;
const tpKey = (target: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const mouseClick = (b: HTMLElement) => b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
const stubTrack = () => {
  tpTrack().getBoundingClientRect = () => ({ width: 1000, height: 14, left: 0, top: 0, right: 1000, bottom: 14, x: 0, y: 0, toJSON() {} }) as DOMRect;
};
const tpEvent = (id: string, ago: number) => ({ ...scoreFixture[0], id, session_id: S1, source: scoreFixture[0].source, time: iso(NOW - ago) });
const tickLabels = () => [...document.querySelectorAll(".lane-axis text, .lanes-axis text, .fleet-lanes text")].map((t) => t.textContent ?? "");

test("transport: mounted once between strip and layout, same node across navigation, no boot writes", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  const seen = vi.fn();
  b.scope.subscribe(seen);
  expect(tpAll()).toHaveLength(1);
  const node = tp();
  expect(node.parentElement?.id).toBe("app");
  expect(node.previousElementSibling?.classList.contains("attention-strip")).toBe(true);
  expect(node.nextElementSibling?.classList.contains("layout")).toBe(true);
  for (const n of ["live", "fleet", "session", "project"]) b.nav(n).click();
  expect(tpAll()).toHaveLength(1);
  expect(tp()).toBe(node);
  expect(seen).not.toHaveBeenCalled();
  expect(b.scope.get()).toEqual({ window: "live" });
});

test("transport: visible only where consumed; the window persists while hidden", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  const { TRANSPORT_PANELS } = await import("./main");
  expect([...TRANSPORT_PANELS].sort()).toEqual(["fleet", "project", "session"]);
  for (const n of ["fleet", "project", "session"]) {
    b.nav(n).click();
    expect(tp().hidden, n).toBe(false);
  }
  b.nav("project").click();
  tpPreset("24h").click();
  const win = b.scope.get().window;
  for (const n of ["live", "settings"]) {
    b.nav(n).click();
    expect(tp().hidden, n).toBe(true);
    expect(b.scope.get().window).toEqual(win);
  }
  b.nav("project").click();
  expect(tp().hidden).toBe(false);
  expect(b.scope.get().window).toEqual(win);
});

test("transport: a preset reaches Project and Fleet", async () => {
  const b = await boot({
    worktrees: twoRepos(), sessions: [sessionRow(S1, { source: S1_SOURCE })],
    events: [tpEvent("tp-1h", 3_600_000), tpEvent("tp-36h", 36 * 3_600_000)],
  });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  document.querySelector<HTMLElement>('[data-enc="lanes"]')!.click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-lanes")).not.toBeNull());
  tpPreset("24h").click();
  expect(b.scope.get().window).toEqual({ from: NOW - DAY_MS, to: NOW });
  expect(b.scope.get().liveSpanMs).toBe(DAY_MS);
  await vi.waitFor(() => expect(document.querySelectorAll("rect.lane-tick")).toHaveLength(1));
  b.nav("project").click();
  expect(document.querySelector("button.project-live")).toBeNull();
  tpLive().click();
  expect(b.scope.get().window).toBe("live");
  expect(tpRange()).toBe("Live · last 1 d");
  void tickLabels;
});

test("transport: default Fleet hold uses the lanes span, not 7 d", async () => {
  const b = await boot({ worktrees: twoRepos() });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  document.querySelector<HTMLElement>('[data-enc="lanes"]')!.click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-lanes")).not.toBeNull());
  tpHold().click();
  expect(b.scope.get().window).toEqual({ from: NOW - 300_000, to: NOW });
  tpLive().click();
  expect(b.scope.get().window).toBe("live");
  tpKey(tpTrack(), "ArrowLeft");
  expect(b.scope.get().window).toEqual({ from: NOW - 330_000, to: NOW - 30_000 });
});

test("transport: altitude follows the displayed panel, not scope.session", async () => {
  const b = await boot({ worktrees: twoRepos(), sessions: [sessionRow(S1, { source: S1_SOURCE })] });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  b.scope.set({ session: { id: S1, source: S1_SOURCE }, window: "live" });
  b.nav("session").click();
  expect(tpTrack().getAttribute("aria-disabled")).toBe("true");
  expect(tpPreset("24h").getAttribute("aria-disabled")).toBe("true");
  tpPreset("24h").click();
  expect(b.scope.get().window).toBe("live");
  expect(b.scope.get().liveSpanMs).toBeUndefined();
  for (const n of ["project", "fleet"]) {
    b.nav(n).click();
    expect(tpTrack().getAttribute("aria-disabled"), n).toBe("false");
    tpPreset("8h").click();
    expect(b.scope.get().window).toEqual({ from: NOW - 8 * 3_600_000, to: NOW });
    expect(tpRange(), n).not.toContain("whole session");
    tpLive().click();
  }
  tpPreset("24h").click();
  b.nav("session").click();
  expect(tpTrack().getAttribute("aria-disabled")).toBe("true");
  const before = b.scope.get().window;
  tpPreset("2h").click();
  expect(b.scope.get().window).toEqual(before);
  const chip = document.querySelector<HTMLButtonElement>("#session-panel-score .session-lens-head button")!;
  expect(chip).not.toBeNull();
  chip.click();
  expect(b.scope.get().window).toBe("live");
  expect(b.scope.get().liveSpanMs).toBe(DAY_MS);
  expect(tpRange()).toBe("Live · whole session");
});

test("transport: preset carry rules", async () => {
  const b = await boot({
    worktrees: twoRepos(), sessions: [sessionRow("s-n1")],
    attentionSessions: [needy("s-n1", "repoA", { worktree_id: "wt-open" })],
  });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  await vi.waitFor(() => expect(document.querySelector(".fleet-need")).not.toBeNull());
  tpPreset("24h").click();
  const win = b.scope.get().window;
  expect(win).toEqual({ from: NOW - DAY_MS, to: NOW });
  document.querySelector<HTMLElement>(".fleet-need")!.click();
  expect(b.active()).toBe("session");
  expect(b.scope.get().window).toEqual(win);
  const head = document.querySelector<HTMLElement>("#session-panel-score .session-lens-head")!;
  expect(head.textContent).toContain(windowLabel(win));
  expect(head.querySelector("button")).not.toBeNull();
  const { selectSession } = await import("./scope");
  selectSession(b.scope, { id: "s-other", source: "codex" });
  expect(b.scope.get().window).toBe("live");
  expect(b.scope.get().liveSpanMs).toBe(DAY_MS);
});

test("transport: keys act on the track only; Escape still ascends", async () => {
  const b = await boot({ worktrees: [wtRow()], sessions: [sessionRow(S1, { source: S1_SOURCE })] });
  await vi.waitFor(() => expect(document.querySelector("select.project-repo")).not.toBeNull());
  tpPreset("2h").click();
  const win = b.scope.get().window;
  const e0 = tpKey(document.body, "ArrowLeft");
  expect(e0.defaultPrevented).toBe(false);
  expect(b.scope.get().window).toEqual(win);
  const hold = tpKey(tpHold(), "ArrowLeft");
  tpKey(tpPreset("2h"), "ArrowLeft");
  expect(hold.defaultPrevented).toBe(false);
  expect(b.scope.get().window).toEqual(win);
  tpKey(tpTrack(), "ArrowLeft");
  const w = b.scope.get().window as { from: number; to: number };
  expect(w.to - w.from).toBe(2 * 3_600_000);
  expect(w.to).toBe(NOW - 720_000);
  // Escape on the track with a scoped session ascends it.
  b.scope.set({ session: { id: S1, source: S1_SOURCE }, window: "live" });
  b.nav("session").click();
  await loadedScore();
  const full = viewW();
  tpKey(document.body, "ArrowLeft");
  expect(viewW()).toBe(full);
  expect(b.scope.get().window).toBe("live");
  tpKey(tpTrack(), "Escape");
  expect(b.scope.get().session).toBeUndefined();
  expect(b.active()).not.toBe("session");
});

test("transport: a drag Escape beats the panel Escape, then the panel clears its cursor", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  b.scope.narrow({ project: "repoA" });
  tpPreset("24h").click();
  const start = b.scope.get().window;
  stubTrack();
  tpKey(document.body, "1");
  const picked = () => document.querySelector(".project-lane.selected");
  expect(picked()).not.toBeNull();
  const ptr = (target: EventTarget, type: string, x: number) =>
    target.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, button: 0 }));
  ptr(tpTrack(), "pointerdown", 500);
  ptr(tpTrack(), "pointermove", 400);
  await vi.waitFor(() => expect(b.scope.get().window).not.toEqual(start));
  const e = esc(document.body);
  expect(b.scope.get().window).toEqual(start);
  expect(picked()).not.toBeNull();
  expect(b.scope.get().project).toBe("repoA");
  expect(e.defaultPrevented).toBe(false);
  esc(document.body);
  expect(picked()).toBeNull();
  expect(b.scope.get().project).toBe("repoA");
});

test("transport: Escape and ArrowLeft in body-appended inputs leave scope unchanged", async () => {
  const b = await boot({ worktrees: [wtRow()] });
  await vi.waitFor(() => expect(document.querySelector("select.project-repo")).not.toBeNull());
  tpPreset("8h").click();
  b.scope.narrow({ project: "repoA" });
  const before = b.scope.get();
  const input = document.createElement("input");
  const select = document.createElement("select");
  document.body.append(input, select);
  for (const t of [input, select]) {
    esc(t);
    tpKey(t, "ArrowLeft");
  }
  expect(b.scope.get()).toEqual(before);
});

test("transport: a mouse click blurs the button so Project and Fleet keys still act", async () => {
  const b = await boot({ worktrees: twoRepos() });
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  await vi.waitFor(() => expect(fleetRows().length).toBe(2));
  tpPreset("8h").focus();
  mouseClick(tpPreset("8h"));
  expect(document.activeElement).not.toBe(tpPreset("8h"));
  expect(b.scope.get().liveSpanMs).toBe(8 * 3_600_000);
  tpKey(document.body, "1");
  expect(document.querySelector(".fleet-row.selected, .fleet-row[aria-selected='true'], .fleet-row.sel")).not.toBeNull();
  b.nav("project").click();
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
  tpPreset("2h").focus();
  mouseClick(tpPreset("2h"));
  tpKey(document.body, "1");
  expect(document.querySelector(".project-lane.selected")).not.toBeNull();
});

test("transport: older daemon (404) mounts, presets work, no extra /worktrees requests", async () => {
  const b = await boot({ worktreesStatus: 404, attentionSessions: [needy("s-f1", "repoZ")] });
  b.nav("fleet").click();
  await vi.waitFor(() => expect(document.querySelector(".fleet-row-label")).not.toBeNull());
  expect(document.querySelector(".fleet-unsupported")).not.toBeNull();
  const n = b.urls.filter((u) => u.includes("/worktrees")).length;
  const sets = vi.fn();
  b.scope.subscribe(sets);
  tpPreset("24h").click();
  expect(sets).toHaveBeenCalledTimes(1);
  expect(tpRange()).toContain("1 d");
  expect(b.scope.get().window).toEqual({ from: NOW - DAY_MS, to: NOW });
  expect(document.querySelector(".fleet-row-label")!.textContent).toBe("name-repoZ");
  expect(document.querySelector(".fleet-unsupported")).not.toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(b.urls.filter((u) => u.includes("/worktrees")).length).toBe(n);
});

test("transport: a window change does not restart the cold-start retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const b = await boot({ worktrees: [wtRow()], worktreesFailFirst: true, healthGate: gate });
  await vi.waitFor(() => expect(document.querySelector(".project-connecting")).not.toBeNull());
  const n = b.worktreeSignals.length;
  const sets = vi.fn();
  b.scope.subscribe(sets);
  tpPreset("8h").click();
  expect(sets).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".project-connecting")).not.toBeNull();
  expect(b.worktreeSignals.length).toBe(n);
  release();
  await vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
});

// ---------------------------------------------------------------------------
// Project encodings: the workspace graph, activity map and events are chips of Project
// ---------------------------------------------------------------------------

const gp = (u: string) => new URL(u).pathname;
const hits = (b: Boot, path: string) => b.urls.filter((u) => gp(u) === path);
const graphHits = (b: Boot) => b.urls.filter((u) => gp(u).startsWith("/workspace-graph"));
const param = (u: string, k: string) => new URL(u).searchParams.get(k);
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const tlEvent = (id: string, ageMs: number, over: Record<string, unknown> = {}) => ({
  id, time: iso(NOW - ageMs), source: "codex", session_id: "s-o1", category: "tool", name: "tool.completed",
  summary: `summary ${id}`, repo_id: "r1", worktree_id: "w1", ...over,
});
const tlPage = (events: unknown[], next?: string): EventPage => ({
  events: events as EventPage["events"], has_more: !!next, ...(next ? { next_cursor: next } : {}), order: "newest_first",
});
const R1_ROWS = [wtRow({ repo_id: "r1", worktree_id: "wt-a" })];
const projectLoaded = () => vi.waitFor(() => expect(document.querySelector(".project-lane")).not.toBeNull());
const bootProject = async (extra: BootOpts = {}) => {
  const b = await boot({
    worktrees: R1_ROWS,
    repos: [repoOf("r1")],
    snapshots: { r1: snapshotOf("r1", ["w1", "w2"]) },
    ...extra,
  });
  await projectLoaded();
  return b;
};
const selectedChip = () => document.querySelector(".project-chips [aria-selected=true]")?.getAttribute("data-encoding");

test("the Graph chip reaches the real graph inside Project; nothing graph-related is requested before it", async () => {
  const b = await bootProject();
  expect(graphHits(b)).toHaveLength(0);
  expect(document.querySelector(".workspace-graph")).toBeNull();
  chip("graph").click();
  await vi.waitFor(() => expect(b.urls.some((u) => gp(u) === "/workspace-graph" && param(u, "repo_id") === "r1")).toBe(true));
  expect(document.querySelector(".content .project .workspace-graph")).not.toBeNull();
  expect(document.querySelector(".graph-repo")).toBeNull();
  expect(document.querySelector(".graph-tabs")).toBeNull();
  expect(b.active()).toBe("project");
  expect(selectedChip()).toBe("graph");
});

test("scope: Graph, Map and Events write only the default repo; repos[0] differing does not flip-flop or add requests", async () => {
  const b = await bootProject({
    repos: [repoOf("rX"), repoOf("r1")],
    snapshots: { rX: snapshotOf("rX", ["x1"]), r1: snapshotOf("r1", ["w1", "w2"]) },
    timeline: tlPage([tlEvent("e1", 3_600_000)]),
  });
  expect(b.scope.get()).toEqual({ window: "live" });
  for (const e of ["graph", "map", "events"]) {
    chip(e).click();
    await settle();
    expect(b.scope.get()).toEqual({ window: "live", project: "r1" });
    expect(selectedChip()).toBe(e);
  }
  await vi.waitFor(() => expect(hits(b, "/workspace-graph/timeline").length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(hits(b, "/workspace-graph/activity").length).toBeGreaterThan(0));
  for (const u of graphHits(b)) {
    if (gp(u) === "/workspace-graph/repos") continue;
    expect(param(u, "repo_id")).toBe("r1");
  }
  expect(b.urls.some((u) => u.includes("repo_id=rX"))).toBe(false);
  const n = graphHits(b).length;
  await settle();
  expect(graphHits(b)).toHaveLength(n);
  expect(b.scope.get()).toEqual({ window: "live", project: "r1" });
});

test("scope: Graph then away then back leaves scope unchanged", async () => {
  const b = await bootProject();
  chip("graph").click();
  await settle();
  const before = b.scope.get();
  b.nav("live").click();
  b.nav("project").click();
  await settle();
  expect(b.scope.get()).toEqual(before);
  b.nav("live").click();
  b.nav("project").click();
  await settle();
  expect(b.scope.get()).toEqual(before);
});

test("an explicit scope.project absent from /worktrees rows is preserved across every chip", async () => {
  const b = await boot({
    worktrees: R1_ROWS,
    repos: [repoOf("r1"), repoOf("reg-only")],
    snapshots: { r1: snapshotOf("r1", ["w1"]), "reg-only": snapshotOf("reg-only", ["z1"]) },
    timeline: tlPage([]),
  });
  await projectLoaded();
  b.scope.narrow({ project: "reg-only" });
  for (const e of ["graph", "map", "events", "lanes", "graph"]) {
    chip(e).click();
    await settle();
    expect(b.scope.get().project).toBe("reg-only");
  }
  await vi.waitFor(() => expect(b.urls.some((u) => gp(u) === "/workspace-graph" && param(u, "repo_id") === "reg-only")).toBe(true));
  expect(b.urls.some((u) => gp(u) === "/workspace-graph" && param(u, "repo_id") === "r1")).toBe(false);
  const picker = document.querySelector<HTMLSelectElement>("select.project-repo")!;
  expect([...picker.options].map((o) => o.value)).toContain("reg-only");
  expect(picker.value).toBe("reg-only");
});

test("a frozen window survives a Project lane pick and then the Graph and Map chips", async () => {
  const b = await bootProject();
  const win = { from: NOW - 6 * 3_600_000, to: NOW - 3_600_000 };
  b.scope.narrow({ window: win });
  await settle();
  document.querySelector<SVGGElement>(".project-lane")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(b.active()).toBe("sessions");
  expect(b.scope.get().window).toEqual(win);
  b.nav("project").click();
  await settle();
  for (const e of ["graph", "map", "events"]) {
    chip(e).click();
    await settle();
    expect(b.scope.get().window).toEqual(win);
  }
});

test("Escape in the real graph (Graph chip) behaves as before: selection first, then leaves the project", async () => {
  const b = await bootProject();
  openGraph(b);
  await vi.waitFor(() => expect(document.querySelector(".workspace-label")).not.toBeNull());
  document.querySelector<SVGGElement>(".workspace-label")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(b.scope.get().worktree).toBe("w1"));
  esc();
  expect(b.scope.get().project).toBe("r1");
  esc();
  await vi.waitFor(() => expect(b.scope.get().project).toBeUndefined());
});

test.each(["map", "events"])("Escape from %s ascends worktree then project", async (e) => {
  const b = await bootProject({ timeline: tlPage([tlEvent("e1", 3_600_000)]) });
  chip(e).click();
  await settle();
  b.scope.narrow({ project: "r1", worktree: "wt-a" });
  await settle();
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
  expect(b.scope.get().project).toBe("r1");
  expect(selectedChip()).toBe(e);
  esc();
  expect(b.scope.get().project).toBeUndefined();
});

// Map brush harness: the strip needs a measurable width (happy-dom has no layout).
const STRIP_W = 1000;
const spyRect = () => vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: STRIP_W, height: 72, right: STRIP_W, bottom: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
const bucketAt = (bucket: number) => ({ clientX: (bucket + 0.5) * (STRIP_W / activityJson.buckets), clientY: 10, bubbles: true, pointerId: 1 });
const mapDown = (bucket: number) => document.querySelector(".map-strip")!.dispatchEvent(new PointerEvent("pointerdown", bucketAt(bucket)));
const mapMove = (bucket: number) => window.dispatchEvent(new PointerEvent("pointermove", bucketAt(bucket)));
const mapUp = (bucket: number) => window.dispatchEvent(new PointerEvent("pointerup", bucketAt(bucket)));
const openMap = async (b: Boot) => {
  chip("map").click();
  await vi.waitFor(() => expect(document.querySelector(".map-strip")).not.toBeNull());
  await settle();
  expect(b.scope.get().project).toBe("r1");
};

test("Escape mid Map drag cancels the brush and does not ascend; pointerup afterwards commits nothing", async () => {
  spyRect();
  const b = await bootProject();
  await openMap(b);
  b.scope.narrow({ worktree: "wt-a" });
  await settle();
  await vi.waitFor(() => expect(document.querySelector(".map-strip")).not.toBeNull());
  const before = b.scope.get();
  mapDown(100);
  mapMove(120);
  const e = esc();
  expect(e.defaultPrevented).toBe(true);
  expect(b.scope.get()).toEqual(before);
  mapUp(120);
  await settle();
  expect(b.scope.get()).toEqual(before);
  expect(b.scope.get().window).toBe("live");
  expect(document.querySelectorAll(".map-bar.in")).toHaveLength(0);
  // With the drag gone, Escape ascends again.
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
});

test("a completed Map drag narrows the shared window, and leaving mid-drag leaves it unchanged", async () => {
  spyRect();
  const b = await bootProject();
  await openMap(b);
  mapDown(100);
  mapMove(120);
  chip("events").click();
  mapUp(120);
  await settle();
  expect(b.scope.get().window).toBe("live");
  expect(selectedChip()).toBe("events");
  chip("map").click();
  await vi.waitFor(() => expect(document.querySelector(".map-strip")).not.toBeNull());
  await settle();
  mapDown(100);
  mapMove(120);
  mapUp(120);
  await settle();
  expect(b.scope.get().window).not.toBe("live");
});

test("Escape from inputs, menus and dialogs never changes scope; the body Escape then ascends", async () => {
  const b = await bootProject({ timeline: tlPage([tlEvent("e1", 3_600_000), tlEvent("e2", 1_800_000, { worktree_id: "w2" })]) });
  b.scope.narrow({ project: "r1", worktree: "wt-a" });
  const before = b.scope.get();
  const stays = (target: EventTarget, ownsKey = false) => {
    const e = esc(target);
    // The graph search box and the More menu claim the key themselves (preventDefault).
    if (!ownsKey) expect(e.defaultPrevented).toBe(false);
    expect(b.scope.get()).toEqual(before);
  };
  stays(document.querySelector("select.project-repo")!);
  chip("events").click();
  await vi.waitFor(() => expect(document.querySelector('input[aria-label="Search captured events"]')).not.toBeNull());
  stays(document.querySelector('input[aria-label="Search captured events"]')!);
  const wsSelect = document.querySelector<HTMLSelectElement>('.workspace-graph select[aria-label="Worktree"]');
  expect(wsSelect).not.toBeNull();
  stays(wsSelect!);
  stays(document.querySelector("select.project-repo")!);
  chip("graph").click();
  await vi.waitFor(() => expect(document.querySelector(".graph-search-input")).not.toBeNull());
  stays(document.querySelector(".graph-search-input")!, true);
  stays(document.querySelector("select.project-repo")!);
  // A dialog owns Escape.
  const dlg = document.createElement("div");
  dlg.setAttribute("role", "dialog");
  document.body.append(dlg);
  stays(document.body);
  dlg.remove();
  // An open More menu owns Escape; the second Escape ascends.
  document.querySelector<HTMLButtonElement>(".graph-more-button")!.click();
  stays(document.body, true);
  expect(document.querySelector<HTMLElement>(".graph-menu")!.hidden).toBe(true);
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
  expect(b.scope.get().project).toBe("r1");
});

test("More open, then a keyboard encoding switch, then Escape is not swallowed by a stale menu", async () => {
  const b = await bootProject();
  chip("graph").click();
  await vi.waitFor(() => expect(document.querySelector(".graph-more-button")).not.toBeNull());
  b.scope.narrow({ project: "r1", worktree: "wt-a" });
  document.querySelector<HTMLButtonElement>(".graph-more-button")!.click();
  expect(document.querySelector<HTMLElement>(".graph-menu")!.hidden).toBe(false);
  chip("graph").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  expect(selectedChip()).toBe("map");
  expect(document.querySelector(".graph-menu:not([hidden])")).toBeNull();
  esc();
  expect(b.scope.get().worktree).toBeUndefined();
});

const crumbText = () => document.querySelector(".scope-crumb")?.textContent ?? "";
const LONG_REPO = "repo-0123456789abcdef0123456789abcdef";

test("the footer crumb names the project on every chip and after a project switch while the graph is hidden", async () => {
  const b = await bootProject({
    worktrees: [wtRow({ repo_id: LONG_REPO, worktree_id: "wt-a" })],
    repos: [repoOf(LONG_REPO, "alpha-repo")],
    snapshots: { [LONG_REPO]: { ...snapshotOf(LONG_REPO, ["w1"]), repository: repoOf(LONG_REPO, "alpha-repo") } },
    timeline: tlPage([]),
  });
  const ok = (full: string) => {
    expect(crumbText()).not.toBe("");
    expect(crumbText()).not.toContain(full);
    // A resolved name when the graph is shown, otherwise the short id; never the raw full id.
    expect(crumbText().includes("alpha-repo") || crumbText().includes(full.slice(0, 8))).toBe(true);
  };
  for (const e of ["graph", "map", "events", "lanes"]) {
    chip(e).click();
    await settle();
    ok(LONG_REPO);
  }
  // Switch project while the graph is hidden (Lanes): unknown to the rows, marked, never blank.
  const other = "other-repo-abcdef0123456789";
  b.scope.narrow({ project: other });
  await settle();
  ok(other);
  expect(crumbText()).toContain("(unknown)");
  for (const e of ["graph", "map", "events"]) {
    chip(e).click();
    await settle();
    ok(other);
  }
});

test("a historical session of a removed worktree stays in scope after the Graph is shown then hidden", async () => {
  // The lifetime view still lists the removed worktree; the graph snapshot does not.
  const gone = wtRow({ repo_id: "r1", worktree_id: "wt-removed", state: "removed", sessions: [{ source: "codex", session_id: "s-hist", first_time: iso(NOW - 86_400_000), last_time: iso(NOW - 80_000_000), events: 2 }] });
  const b = await bootProject({ worktrees: [...R1_ROWS, gone] });
  const session = { id: "s-hist", source: "codex" };
  b.scope.narrow({ project: "r1", worktree: "wt-removed", session });
  await settle();
  const before = b.scope.get();
  chip("graph").click();
  await settle();
  chip("lanes").click();
  await settle();
  expect(b.scope.get()).toEqual(before);
  expect(b.scope.get().session).toEqual(session);
  expect(b.scope.get().worktree).toBe("wt-removed");
});

const sendEvent = (b: Boot, e: unknown) => b.sources[0]!.onmessage!({ data: JSON.stringify(e) });

test("live events do not reach the graph on Lanes or Map, and a shown Graph refreshes attention once per 500 ms", async () => {
  const b = await bootProject({ fakeTimeout: true, timeline: tlPage([tlEvent("e1", 3_600_000)]) });
  const counts = () => [hits(b, "/attention").length, hits(b, "/workspace-graph/timeline").length];
  await vi.advanceTimersByTimeAsync(1000);
  let base = counts();
  sendEvent(b, tlEvent("live-1", 10));
  await vi.advanceTimersByTimeAsync(1000);
  expect(counts()).toEqual(base);
  chip("map").click();
  await vi.advanceTimersByTimeAsync(1000);
  base = counts();
  sendEvent(b, tlEvent("live-2", 10));
  await vi.advanceTimersByTimeAsync(1000);
  expect(counts()).toEqual(base);

  chip("graph").click();
  await vi.advanceTimersByTimeAsync(1000);
  base = counts();
  sendEvent(b, tlEvent("live-3", 10));
  await vi.advanceTimersByTimeAsync(499);
  expect(hits(b, "/attention")).toHaveLength(base[0]!);
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(hits(b, "/attention")).toHaveLength(base[0]! + 1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(hits(b, "/attention")).toHaveLength(base[0]! + 1);
  expect(hits(b, "/workspace-graph/timeline").length).toBe(base[1]);
  vi.useRealTimers();
});

test("Events chip hide and show with more than 250 missed events restarts pagination at the head", async () => {
  const b = await bootProject({
    fakeTimeout: true,
    timeline: (q) =>
      q.get("cursor")
        ? tlPage([tlEvent("old-1", 5 * 3_600_000)])
        : tlPage([tlEvent("h1", 3_600_000), tlEvent("h2", 1_800_000)], `c-head-${hits(b, "/workspace-graph/timeline").length}`),
  });
  chip("events").click();
  await vi.advanceTimersByTimeAsync(1000);
  const tl = () => hits(b, "/workspace-graph/timeline");
  expect(tl().length).toBeGreaterThan(0);
  expect(param(tl()[0]!, "cursor")).toBeNull();
  chip("lanes").click();
  await vi.advanceTimersByTimeAsync(10);
  for (let i = 0; i < 260; i++) sendEvent(b, tlEvent(`burst-${i}`, 10));
  await vi.advanceTimersByTimeAsync(1000);
  const before = tl().length;
  chip("events").click();
  await vi.advanceTimersByTimeAsync(1000);
  expect(tl().length).toBeGreaterThan(before);
  const head = tl()[tl().length - 1]!;
  expect(param(head, "cursor")).toBeNull();
  const older = [...document.querySelectorAll<HTMLButtonElement>(".workspace-graph button")].find((x) => x.textContent === "Load older events");
  expect(older).toBeDefined();
  older!.click();
  await vi.advanceTimersByTimeAsync(1000);
  const last = tl()[tl().length - 1]!;
  expect(param(last, "cursor")).toMatch(/^c-head-/);
  expect(param(last, "cursor")).not.toBe(param(tl()[0]!, "cursor"));
  vi.useRealTimers();
});

test("the shell window reaches Map and Events", async () => {
  const b = await bootProject({ timeline: tlPage([tlEvent("in-1", 4 * 3_600_000), tlEvent("out-1", 3 * 86_400_000), tlEvent("in-2", 5 * 3_600_000)]) });
  const win = { from: NOW - 6 * 3_600_000, to: NOW - 3_600_000 };
  b.scope.narrow({ window: win });
  await settle();
  chip("map").click();
  await vi.waitFor(() => expect(hits(b, "/workspace-graph/activity").length).toBeGreaterThan(0));
  const req = hits(b, "/workspace-graph/activity").pop()!;
  expect(param(req, "from")).toBe(new Date(win.from).toISOString());
  expect(param(req, "to")).toBe(new Date(win.to).toISOString());
  expect(document.querySelector(".map-presets")).toBeNull();
  expect(document.querySelector(".map-live")).toBeNull();
  chip("events").click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("summary in-1"));
  expect(document.body.textContent).toContain("summary in-2");
  expect(document.body.textContent).not.toContain("summary out-1");
  expect([...document.querySelectorAll("button")].some((x) => /pause|resume/i.test(x.textContent ?? ""))).toBe(false);
});

test("older daemon: /worktrees 404 still renders the graph for repos[0], and Map works with scope.project", async () => {
  const b = await boot({
    worktreesStatus: 404,
    repos: [repoOf("r1")],
    snapshots: { r1: snapshotOf("r1", ["w1"]) },
  });
  await vi.waitFor(() => expect(document.querySelector(".project-unsupported")).not.toBeNull());
  chip("graph").click();
  await vi.waitFor(() => expect(b.urls.some((u) => gp(u) === "/workspace-graph" && param(u, "repo_id") === "r1")).toBe(true));
  expect(document.querySelector(".workspace-graph")).not.toBeNull();
  b.scope.narrow({ project: "r1" });
  chip("map").click();
  await vi.waitFor(() => expect(hits(b, "/workspace-graph/activity").some((u) => param(u, "repo_id") === "r1")).toBe(true));
  expect(document.querySelector(".map-strip, .map-summary, .map-notice")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Slice 11: sentence-case nav, aria-current, matching h2
// ---------------------------------------------------------------------------
const sidebarCurrent = () => [...document.querySelectorAll<HTMLElement>(".sidebar [aria-current]")];
const expectOneCurrent = (where: string) => {
  const cur = sidebarCurrent();
  expect(cur, where).toHaveLength(1);
  expect(cur[0]!.getAttribute("aria-current"), where).toBe("page");
  expect(cur[0]!.getAttribute("data-panel"), where).toBe(document.querySelector(".nav-btn.active")?.getAttribute("data-panel"));
};

test("exactly one sidebar button carries aria-current=page after every show() path", async () => {
  const b = await boot({
    worktrees: [wtRow({ repo_id: "r1", worktree_id: "a" }), wtRow({ repo_id: "r2", worktree_id: "b" })],
    sessions: [sessionRow(S1)],
    attentionSessions: [attn(S1)],
  });
  expectOneCurrent("boot");
  // Boot landing redirect to Fleet (two repositories).
  await vi.waitFor(() => expect(b.active()).toBe("fleet"));
  expectOneCurrent("landing redirect");
  for (const name of ["live", "attention", "settings", "fleet", "session", "sessions", "project", "doctor"]) {
    b.nav(name).click();
    expectOneCurrent(`click ${name}`);
    expect(b.active()).toBe(name);
  }
  // Attention strip actions.
  b.nav("live").click();
  await vi.waitFor(() => expect(document.querySelector(".attention-strip [data-key=inbox]")).not.toBeNull());
  document.querySelector<HTMLButtonElement>(".attention-strip [data-key=inbox]")!.click();
  expect(b.active()).toBe("attention");
  expectOneCurrent("onOpenInbox");
  document.querySelector<HTMLButtonElement>(".attention-strip [data-key=doctor]")!.click();
  expect(b.active()).toBe("doctor");
  expectOneCurrent("onDoctor");
  // Escape ascent session -> sessions.
  b.scope.set({ project: "r1", window: "live" });
  b.nav("sessions").click();
  b.scope.narrow({ session: { id: S1, source: "codex" } });
  b.nav("session").click();
  esc();
  expect(b.active()).toBe("sessions");
  expectOneCurrent("escape ascent");
  // Lens tabs inside Session (score/loops) keep Session current.
  b.nav("session").click();
  tabBtn("score").click();
  expectOneCurrent("score tab");
  tabBtn("loops").click();
  expectOneCurrent("loops tab");
});

test("every panel opens with a visible h2 equal to its nav label", async () => {
  const b = await boot();
  const panels = ["fleet", "project", "sessions", "session", "live", "attention", "strata", "ecosystem", "files", "doctor", "settings"];
  for (const name of panels) {
    b.nav(name).click();
    const h2 = document.querySelector(".content h2");
    expect(h2, name).not.toBeNull();
    expect(h2!.textContent, name).toBe(b.nav(name).textContent);
    expect(h2!.hasAttribute("hidden"), name).toBe(false);
  }
  b.nav("files").click();
  expect(document.querySelector(".content h2")!.getAttribute("tabindex")).toBe("-1");
});

const TITLED = "2385e3bc-aaaa-bbbb-cccc-111122223333";
const UNTITLED = "bbbbbbbb-aaaa-bbbb-cccc-111122223333";
const namedRows = () => [
  sessionRow(TITLED, { title: "Fix login bug" }),
  sessionRow(UNTITLED, { cwd: "/Users/n/develop/llm-firehose", repo: undefined }),
];

test("names not ids: the scope crumb names a session the sessions list has loaded", async () => {
  const b = await boot({ sessions: namedRows() });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelectorAll(".session-item")).toHaveLength(2));
  b.scope.narrow({ session: { id: TITLED, source: "codex" } });
  const crumb = document.querySelector(".scope-crumb")!;
  expect(crumb.textContent).toBe("Fix login bug");
  expect(crumb.querySelector(".unresolved")).toBeNull();
  expect(crumb.querySelector("[title]")!.getAttribute("title")).toBe(TITLED);
});

test("names not ids: the attention inbox feeds the directory, so the lens head is named", async () => {
  const attn = (id: string, extra: Record<string, unknown>) => ({
    id, source: "codex", agent: "codex", events: 1, state: "working",
    last: { event_id: "e", source: "codex", kind: "activity", summary: "", time: iso(NOW - 1000), observed_at: iso(NOW - 1000) },
    ...extra,
  });
  const b = await boot({ attentionSessions: [attn(TITLED, { title: "Fix login bug" })] });
  b.nav("attention").click();
  await vi.waitFor(() => expect(document.querySelector(".attention-row h3")?.textContent).toBe("Fix login bug"));
  b.scope.narrow({ session: { id: TITLED, source: "codex" } });
  b.nav("session").click();
  expect(document.querySelector(".session-lens-head .session-lens-name")?.textContent).toBe("Fix login bug");
});

test("names not ids: a same-id pair under two sources leaves a source-less ref a short id", async () => {
  const b = await boot({ sessions: [sessionRow(TITLED, { title: "A" }), sessionRow(TITLED, { title: "B", source: "claude-code", agent: "claude" })] });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelectorAll(".session-item")).toHaveLength(2));
  b.scope.narrow({ session: { id: TITLED } });
  const crumb = document.querySelector(".scope-crumb")!;
  expect(crumb.textContent).toBe("2385e3bc");
  expect(crumb.querySelector(".unresolved")).not.toBeNull();
});
