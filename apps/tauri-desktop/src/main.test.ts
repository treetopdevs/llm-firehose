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
  expect(document.querySelector(".nav-btn.active")?.textContent).toBe("project");
  expect(document.querySelector(".content .project")).not.toBeNull();
  expect(document.querySelector(".attention-strip")).not.toBeNull();
  const btn = (n: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find((b) => b.textContent === n)!;
  btn("attention").click();
  expect(document.querySelector(".attention-inbox")).not.toBeNull();
  expect(document.querySelector(".attention-strip")).not.toBeNull();
  btn("live").click();
  expect(document.querySelector(".nav-btn.active")?.textContent).toBe("live");
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
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find((b) => b.textContent === "score")!;
  btn.click();
  expect(document.querySelector(".score")).not.toBeNull();
  expect(document.querySelector(".score")?.textContent).toContain("open a session");
  const close=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext",class {state="running";resume=vi.fn().mockResolvedValue(undefined);close=close;onstatechange=null;});
  document.querySelector<HTMLButtonElement>('[aria-label="Enable replay sound"]')!.click();
  await Promise.resolve();
  expect(document.querySelector('[aria-label="Disable replay sound"]')).not.toBeNull();
  expect(document.querySelector(".score")?.textContent).toContain("Replay sound on");
  [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find(b=>b.textContent==="live")!.click();
  expect(close).toHaveBeenCalledOnce();
  btn.click();expect(document.querySelector('[aria-label="Enable replay sound"]')).not.toBeNull();
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
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find((b) => b.textContent === "loops")!;
  btn.click();
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
  [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find(b => b.textContent === "loom")!.click();
  expect(pane.classList.contains("open")).toBe(false);
  expect(pane.childElementCount).toBe(0);
  expect(document.querySelector(".loom")).not.toBeNull();
  expect(document.querySelector(".nav-btn.active")?.textContent).toBe("loom");

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
    [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find(
      (b) => b.textContent === name,
    )!;
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

type Boot = {
  scope: typeof import("./scope").scope;
  urls: string[];
  keydownListeners: Array<[EventListenerOrEventListenerObject, unknown]>;
  nav: (name: string) => HTMLButtonElement;
  active: () => string | null | undefined;
  worktreeSignals: Array<AbortSignal | undefined>;
  sources: Array<{ onopen: (() => void) | null }>;
};
let tracked: Boot["keydownListeners"] = [];

type BootOpts = {
  sessions?: unknown[]; repos?: unknown[]; snapshots?: Record<string, unknown>; attentionSessions?: unknown[];
  worktrees?: unknown[]; worktreesStatus?: number; worktreesFailFirst?: boolean; healthGate?: Promise<void>;
};
async function boot(opts: BootOpts = {}): Promise<Boot> {
  document.body.innerHTML = '<div id="app"></div>';
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  const sources: Array<{ onopen: (() => void) | null }> = [];
  vi.stubGlobal("EventSource", class { onopen: (() => void) | null = null; onerror = null; onmessage = null; constructor() { sources.push(this); } close() {} });
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
    if (p.startsWith("/sessions/")) return json(scoreFixture);
    if (p === "/workspace-graph/repos") return json(opts.repos ?? []);
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
    [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find((b) => b.textContent === name)!;
  return { scope, urls, worktreeSignals, sources, keydownListeners: tracked, nav, active: () => document.querySelector(".nav-btn.active")?.textContent };
}

const esc = (target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const resolverOf = (members: string[]): ScopeResolver => ({
  sessions: () => new Set(members),
  labels: () => ({}),
});

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
  expect(b.active()).toBe("score");
  await vi.waitFor(() => expect(document.querySelector(".score")?.textContent).not.toContain("open a session"));
  expect(b.urls.filter((u) => u.includes(`/sessions/${S1}?view=timeline`))).toHaveLength(1);
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>(".loops-open")).not.toBeNull());
  document.querySelector<HTMLElement>(".loops-open")!.click();
  expect(b.active()).toBe("loops");
  expect(b.scope.get().session).toEqual({ id: S1, source: "codex" });
});

test("F3: Score A, Loops B, then the Score nav button shows B; an unset scope.session does not reopen", async () => {
  const b = await boot();
  const A = S1;
  const B = "other-session";
  const { scope } = b;
  b.nav("score").click();
  expect(b.urls.filter((u) => u.includes("/sessions/"))).toHaveLength(0);
  scope.narrow({ session: { id: A } });
  b.nav("score").click();
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes(`/sessions/${A}?view=timeline`))).toBe(true));
  scope.narrow({ session: { id: B } });
  b.nav("loops").click();
  b.nav("score").click();
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes(`/sessions/${B}?view=timeline`))).toBe(true));
  const before = b.urls.length;
  scope.narrow({ session: undefined });
  b.nav("live").click();
  b.nav("score").click();
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
  expect(b.active()).toBe("sessions");
  scope.set({ project: "A", worktree: "wA", window: "live" });
  await openHistory("Y");
  expect(scope.get()).toMatchObject({ project: "A", worktree: "wA", session: { id: "Y", source: "codex" } });
  // With no resolver the membership is unknown: context is replaced.
  scope.setResolver(null);
  scope.set({ project: "A", worktree: "wA", window: "live" });
  await openHistory("Y");
  expect(scope.get().project).toBeUndefined();
});

test("openCell sets the cell, clears the rest and shows sessions", async () => {
  const b = await boot({ sessions: [sessionRow("m1")] });
  b.scope.set({ project: "A", worktree: "wA", session: { id: "z" }, window: "live" });
  b.nav("matrix").click();
  await vi.waitFor(() => expect(document.querySelector<HTMLElement>("td.matrix-cell")).not.toBeNull());
  document.querySelector<HTMLElement>("td.matrix-cell")!.click();
  const s = b.scope.get();
  expect(s.cell?.agent).toBe("codex");
  expect(s.project).toBeUndefined();
  expect(s.worktree).toBeUndefined();
  expect(s.session).toBeUndefined();
  expect(b.active()).toBe("sessions");
});

test("a sessions row click sets scope.session; the evidence court leaves scope unchanged", async () => {
  const b = await boot({ sessions: [sessionRow("r1")] });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelector(".session-item[data-id='r1']")).not.toBeNull());
  document.querySelector<HTMLElement>(".session-item[data-id='r1']")!.click();
  expect(b.scope.get().session).toEqual({ id: "r1", source: "codex" });
  expect(b.active()).toBe("sessions");
  const before = b.scope.get();
  b.nav("court").click();
  expect(b.scope.get()).toBe(before);
});

test("Escape ascends session, worktree, project from score; fleet is a no-op", async () => {
  const b = await boot({ sessions: [sessionRow(S1)] });
  b.scope.set({ project: "P", worktree: "W", session: { id: S1 }, window: "live" });
  b.nav("score").click();
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
  b.nav("loops").click();
  expect(b.active()).toBe("loops");
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
  for (const name of ["files", "court", "doctor"]) {
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
  expect(crumb.querySelectorAll(".unresolved")).toHaveLength(2);
  b.scope.setResolver({ sessions: () => undefined, labels: () => ({ project: "Alpha", worktree: "main" }) });
  expect(crumb.textContent).toBe("Alpha › main");
  // Landing on Project issues the one /worktrees request; the crumb adds none.
  expect(b.urls.filter((u) => new URL(u).pathname === "/worktrees")).toHaveLength(1);
});

test("graph round trip: a second project scope loads that repository; sessions filter only through the resolver", async () => {
  const b = await boot({
    sessions: [sessionRow("s-in"), sessionRow("s-out")],
    repos: [repoOf("r1"), repoOf("r2")],
    snapshots: { r1: snapshotOf("r1", ["w1"]), r2: snapshotOf("r2", ["w2"]) },
    attentionSessions: [{ ...attn("s-in"), repo_id: "r1" }, { ...attn("s-out"), repo_id: "r2" }],
  });
  b.scope.narrow({ project: "nobody" });
  b.nav("sessions").click();
  await vi.waitFor(() => expect(document.querySelectorAll(".session-item")).toHaveLength(2));
  b.scope.reset();
  b.nav("workspace").click();
  await vi.waitFor(() => expect(b.urls.some((u) => u.includes("repo_id=r1"))).toBe(true));
  b.scope.narrow({ project: "r2" });
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
  b.nav("workspace").click();
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

test("sidebar lists project first then the 19 previous panels unchanged", async () => {
  const b = await boot();
  const names = [...document.querySelectorAll(".nav-btn")].map((x) => x.textContent);
  expect(names).toEqual(["project", "live", "attention", "dwell", "workspace", "matrix", "lanes", "sessions", "score", "loops", "strata", "court", "handoffs", "airspace", "loom", "ecosystem", "replay", "files", "doctor", "settings"]);
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
  expect(b.active()).toBe("score");
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

test("Escape ascends Project: worktree to project stays on Project, project to fleet lands on Live; inputs are excluded", async () => {
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
