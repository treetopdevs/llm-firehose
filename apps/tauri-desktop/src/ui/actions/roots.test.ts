// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { createRoots } from "./roots";

const repo = (id: string, label: string) => ({ id, vcs: "git", label, status: "ok", observed_at: "t" });

describe("roots store", () => {
  test("an older response completing after a newer one is discarded", async () => {
    const pending: Array<(l: ReturnType<typeof repo>[]) => void> = [];
    const roots = createRoots({ repos: () => new Promise((res) => { pending.push(res); }) });
    const first = roots.refresh();
    const second = roots.refresh();
    pending[1]!([repo("r1", "/w/a")]);
    await second;
    pending[0]!([]);
    await first;
    expect(roots.resolved("r1")).toBe(true);
    expect(roots.rawLabel("r1")).toBe("/w/a");
  });
  test("refresh reads repos once without a Graph panel; resolved/rawLabel", async () => {
    const repos = vi.fn(async () => [repo("r1", "/w/main"), repo("r2", "/w/other")]);
    const roots = createRoots({ repos });
    expect(roots.resolved("r1")).toBe(false);
    await roots.refresh();
    expect(repos).toHaveBeenCalledTimes(1);
    expect(roots.resolved("r1")).toBe(true);
    expect(roots.resolved("nope")).toBe(false);
    expect(roots.rawLabel("r2")).toBe("/w/other");
    expect(roots.rawLabel("nope")).toBeUndefined();
  });
  test("refresh again picks up newly registered repos", async () => {
    let list = [repo("r1", "/w/a")];
    const roots = createRoots({ repos: async () => list });
    await roots.refresh();
    list = [...list, repo("r2", "/w/b")];
    expect(roots.resolved("r2")).toBe(false);
    await roots.refresh();
    expect(roots.resolved("r2")).toBe(true);
  });
  test("rejection keeps last good data and does not throw", async () => {
    let fail = false;
    const roots = createRoots({ repos: async () => { if (fail) throw new Error("down"); return [repo("r1", "/w/a")]; } });
    await roots.refresh();
    fail = true;
    await expect(roots.refresh()).resolves.toBeUndefined();
    expect(roots.resolved("r1")).toBe(true);
    expect(roots.rawLabel("r1")).toBe("/w/a");
  });
  test("a repo whose root is a linked worktree still reports registered", async () => {
    const roots = createRoots({ repos: async () => [repo("r1", "/w/linked-worktree")] });
    await roots.refresh();
    expect(roots.resolved("r1")).toBe(true);
  });
  test("loaded() is false until a fetch succeeds; failed first fetch stays unknown, later success loads", async () => {
    let fail = true;
    const roots = createRoots({ repos: async () => { if (fail) throw new Error("down"); return [repo("r1", "/w/a")]; } });
    await roots.refresh();
    expect(roots.loaded()).toBe(false);
    fail = false;
    await roots.refresh();
    expect(roots.loaded()).toBe(true);
    expect(roots.resolved("r1")).toBe(true);
  });
});
