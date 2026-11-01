// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { createRunner, type ActionStatus, type RunnerDeps } from "./runner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));

function harness(over: Partial<RunnerDeps> = {}) {
  const statuses: ActionStatus[] = [];
  const calls: string[] = [];
  const invoke = vi.fn(async (cmd: string, _args?: Record<string, unknown>) => { calls.push(cmd); return undefined as unknown; });
  const deps: RunnerDeps = {
    invoke,
    clipboard: { writeText: vi.fn(async () => {}) },
    registerRoot: vi.fn(async () => {}),
    confirm: vi.fn(async () => { calls.push("confirm"); return true; }),
    onStatus: (s) => statuses.push(s),
    onChanged: vi.fn(),
    ...over,
  };
  return { deps, statuses, calls, invoke, runner: createRunner(deps) };
}
const last = (s: ActionStatus[]) => s[s.length - 1];

describe("open", () => {
  test("invokes open_path once and reports ok", async () => {
    const h = harness();
    await h.runner.run({ type: "open", kind: "editor", path: "/w/a" });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("open_path", { kind: "editor", path: "/w/a" });
    expect(last(h.statuses)).toMatchObject({ kind: "ok", message: "Opened in editor" });
  });
  test("rejection becomes error status, nothing thrown", async () => {
    const h = harness({ invoke: vi.fn(async () => { throw "not a git dir"; }) });
    await expect(h.runner.run({ type: "open", kind: "terminal", path: "/w/a" })).resolves.toBeUndefined();
    expect(last(h.statuses)).toMatchObject({ kind: "error" });
    expect(last(h.statuses).message).toContain("not a git dir");
  });
});

describe("default bridge", () => {
  test("outside Tauri: needs desktop app, invoke never called", async () => {
    const core = await import("@tauri-apps/api/core");
    const statuses: ActionStatus[] = [];
    const r = createRunner({ registerRoot: async () => {}, confirm: async () => true, onStatus: (s) => statuses.push(s), onChanged: () => {}, clipboard: { writeText: async () => {} } });
    await r.run({ type: "open", kind: "reveal", path: "/w/a" });
    expect(last(statuses)).toMatchObject({ kind: "error", message: "Actions need the desktop app." });
    expect(core.invoke).not.toHaveBeenCalled();
  });
});

describe("copy", () => {
  test("writes exact text", async () => {
    const h = harness();
    await h.runner.run({ type: "copy", text: "git diff x" }, "diff command");
    expect(h.deps.clipboard!.writeText).toHaveBeenCalledWith("git diff x");
    expect(last(h.statuses)).toMatchObject({ kind: "ok", message: "Copied diff command" });
  });
  test("clipboard failure includes the text", async () => {
    const h = harness({ clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    await h.runner.run({ type: "copy", text: "claude --resume abc" });
    expect(last(h.statuses).kind).toBe("error");
    expect(last(h.statuses).message).toContain("Could not copy");
    expect(last(h.statuses).message).toContain("claude --resume abc");
  });
  test("missing clipboard", async () => {
    const h = harness({ clipboard: null });
    await h.runner.run({ type: "copy", text: "zzz" });
    expect(last(h.statuses).message).toContain("Could not copy");
    expect(last(h.statuses).message).toContain("zzz");
  });
});

describe("completion after cancelAll", () => {
  test("register finishing after cancelAll still calls onChanged but reports nothing", async () => {
    let release!: () => void;
    const registerRoot = vi.fn(() => new Promise<void>((r) => (release = r)));
    const h = harness({ registerRoot });
    const p = h.runner.run({ type: "register", path: "/w/a" });
    h.runner.cancelAll();
    release();
    await p;
    expect(h.deps.onChanged).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual([]);
  });
  test("prune_apply finishing after cancelAll still calls onChanged but reports nothing", async () => {
    let release!: (v: unknown) => void;
    const invoke = vi.fn(async (cmd: string) => (cmd === "prune_preview" ? preview() : new Promise((r) => (release = r))));
    const h = harness({ invoke });
    const p = h.runner.run({ type: "prune", root: "/w/main" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("prune_apply", expect.anything()));
    h.runner.cancelAll();
    release({ removed: ["a"], remaining: [], skipped: [] });
    await p;
    expect(h.deps.onChanged).toHaveBeenCalledTimes(1);
    expect(h.statuses).toEqual([]);
  });
});

describe("register", () => {
  test("registerRoot then onChanged once", async () => {
    const h = harness();
    await h.runner.run({ type: "register", path: "/w/a" });
    expect(h.deps.registerRoot).toHaveBeenCalledWith("/w/a");
    expect(h.deps.onChanged).toHaveBeenCalledTimes(1);
    expect(last(h.statuses)).toMatchObject({ kind: "ok", message: "Registered repository root" });
  });
  test("rejection: error, no onChanged", async () => {
    const h = harness({ registerRoot: vi.fn(async () => { throw new Error("nope"); }) });
    await h.runner.run({ type: "register", path: "/w/a" });
    expect(last(h.statuses).kind).toBe("error");
    expect(h.deps.onChanged).not.toHaveBeenCalled();
  });
});

const preview = (o: Record<string, unknown> = {}) => ({
  token: "tok", root: "/w/main", common_dir: "/w/main/.git",
  entries: [{ id: "a", line: "Removing worktrees/a: gone", gitdir_path: "/w/main/.git/worktrees/a" }],
  skipped: [], ...o,
});
function pruneInvoke(prev: unknown, apply: unknown | (() => unknown), calls: string[] = [], seen: unknown[][] = []) {
  return vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push(cmd); seen.push([cmd, args]);
    if (cmd === "prune_preview") return prev;
    if (typeof apply === "function") return (apply as () => unknown)();
    if (apply instanceof Error) throw apply;
    return apply;
  });
}

describe("prune", () => {
  test("confirm yes: order, payloads, status, onChanged", async () => {
    const calls: string[] = []; const seen: unknown[][] = [];
    const invoke = pruneInvoke(preview(), { removed: ["a", "b"], remaining: [], skipped: [] }, calls, seen);
    const h = harness({ invoke, confirm: vi.fn(async () => { calls.push("confirm"); return true; }) });
    await h.runner.run({ type: "prune", root: "/w/main" });
    expect(calls).toEqual(["prune_preview", "confirm", "prune_apply"]);
    expect(seen[0]).toEqual(["prune_preview", { root: "/w/main" }]);
    expect(seen[1]).toEqual(["prune_apply", { root: "/w/main", token: "tok" }]);
    expect(h.deps.confirm).toHaveBeenCalledWith({
      root: "/w/main", commonDir: "/w/main/.git", entries: preview().entries, skipped: [],
    });
    expect(last(h.statuses)).toMatchObject({ kind: "ok", message: "Pruned 2 stale worktree entries" });
    expect(h.deps.onChanged).toHaveBeenCalledTimes(1);
  });
  test("remaining non-empty: warning naming count and ids; onChanged on removal", async () => {
    const invoke = pruneInvoke(preview(), { removed: ["a"], remaining: ["x", "y"], skipped: [] });
    const h = harness({ invoke });
    await h.runner.run({ type: "prune", root: "/w/main" });
    const s = last(h.statuses);
    expect(s.kind).toBe("warn");
    expect(s.message).toContain("2");
    expect(s.message).toContain("x");
    expect(s.message).toContain("y");
    expect(h.deps.onChanged).toHaveBeenCalledTimes(1);
  });
  test("confirm no: apply never called", async () => {
    const calls: string[] = [];
    const h = harness({ invoke: pruneInvoke(preview(), {}, calls), confirm: vi.fn(async () => false) });
    await h.runner.run({ type: "prune", root: "/w/main" });
    expect(calls).toEqual(["prune_preview"]);
    expect(last(h.statuses).message).toBe("Prune cancelled");
    expect(h.deps.onChanged).not.toHaveBeenCalled();
  });
  test("empty preview: no confirm", async () => {
    const h = harness({ invoke: pruneInvoke(preview({ entries: [], token: "" }), {}) });
    await h.runner.run({ type: "prune", root: "/w/main" });
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(last(h.statuses).message).toBe("Nothing to prune");
  });
  test("only skipped: no confirm, explains", async () => {
    const h = harness({ invoke: pruneInvoke(preview({ entries: [], token: "", skipped: [{ id: "s", reason: "symlink" }] }), {}) });
    await h.runner.run({ type: "prune", root: "/w/main" });
    expect(h.deps.confirm).not.toHaveBeenCalled();
    expect(last(h.statuses).message).toContain("skipped");
    expect(last(h.statuses).message).toContain("plain admin director");
  });
  test("apply rejection: error, no onChanged", async () => {
    const h = harness({ invoke: pruneInvoke(preview(), new Error("changed")) });
    await h.runner.run({ type: "prune", root: "/w/main" });
    expect(last(h.statuses).kind).toBe("error");
    expect(last(h.statuses).message).toContain("changed");
    expect(h.deps.onChanged).not.toHaveBeenCalled();
  });
  test("commands are a subset of prune_preview/prune_apply", async () => {
    const calls: string[] = [];
    const h = harness({ invoke: pruneInvoke(preview(), { removed: ["a"], remaining: [], skipped: [] }, calls) });
    await h.runner.run({ type: "prune", root: "/w/main" });
    for (const c of calls) expect(["prune_preview", "prune_apply"]).toContain(c);
  });
});

describe("single flight / cancel", () => {
  test("second run while busy is refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = vi.fn(async () => { await gate; });
    const h = harness({ invoke: slow });
    const first = h.runner.run({ type: "open", kind: "editor", path: "/w/a" });
    await h.runner.run({ type: "open", kind: "editor", path: "/w/b" });
    expect(last(h.statuses).message).toBe("Another action is in progress");
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
  test("cancelAll resolves pending confirm false, frees busy, no late apply", async () => {
    const calls: string[] = [];
    let resolveConfirm!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => (resolveConfirm = r)));
    const h = harness({ invoke: pruneInvoke(preview(), { removed: ["a"], remaining: [], skipped: [] }, calls), confirm });
    const p = h.runner.run({ type: "prune", root: "/w/main" });
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
    h.runner.cancelAll();
    resolveConfirm(true); // late yes must not matter
    await p;
    expect(calls).toEqual(["prune_preview"]);
    expect(h.deps.onChanged).not.toHaveBeenCalled();
    await h.runner.run({ type: "copy", text: "x" });
    expect(last(h.statuses).message).not.toBe("Another action is in progress");
  });
});
