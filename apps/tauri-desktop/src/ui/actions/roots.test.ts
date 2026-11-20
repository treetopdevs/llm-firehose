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
    await expect(roots.refresh()).resolves.toMatchObject({ ok: false });
    expect(roots.resolved("r1")).toBe(true);
    expect(roots.rawLabel("r1")).toBe("/w/a");
  });
  test("a project id resolves to its label through any registration; only the second view is marked", async () => {
    const git = { ...repo("git-id", "/w/app"), project_id: "git-id", project_label: "/w/app" };
    const jj = { ...repo("jj-id", "/w/app"), vcs: "jj", project_id: "git-id", project_label: "/w/app" };
    const jjOnly = { ...repo("jj-solo", "/w/solo"), vcs: "jj", project_id: "solo-git", project_label: "/w/solo" };
    const dead = { ...repo("synthetic", "/w/dead"), status: "unavailable", project_id: "dead-git", project_label: "/w/dead" };
    const roots = createRoots({ repos: async () => [git, jj, jjOnly, dead] });
    await roots.refresh();
    expect(roots.rawLabel("git-id")).toBe("/w/app");
    expect(roots.rawLabel("solo-git")).toBe("/w/solo");
    expect(roots.rawLabel("dead-git")).toBe("/w/dead");
    expect(roots.view?.("git-id")).toBeUndefined();
    expect(roots.view?.("jj-id")).toBe("jj");
    expect(roots.view?.("jj-solo")).toBe("jj");
    expect(roots.view?.("synthetic")).toBeUndefined();
    // Registered means a registration of its own, not merely a known project.
    expect(roots.resolved("solo-git")).toBe(false);
    expect(roots.resolved("jj-solo")).toBe(true);
  });
  test("a project is named after its main checkout, not the worktree that registered it", async () => {
    const linked = { ...repo("git-id", "/w/app-feature"), project_id: "git-id", project_label: "/w/app" };
    const roots = createRoots({ repos: async () => [linked, repo("old", "/w/old-daemon")] });
    const result = await roots.refresh();
    expect(roots.rawLabel("git-id")).toBe("/w/app");
    expect(result.repos.find((r) => r.id === "git-id")?.label).toBe("/w/app");
    // A daemon without project_label still names the repository by label.
    expect(roots.rawLabel("old")).toBe("/w/old-daemon");
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

  test("refresh resolves {ok,revision,repos} on success; list() returns id,label,vcs", async () => {
    const roots = createRoots({ repos: async () => [repo("r1", "/w/a"), { ...repo("r2", "/w/b"), vcs: "jj" }] });
    const r = await roots.refresh();
    expect(r.ok).toBe(true);
    expect(r.revision).toBeGreaterThan(0);
    expect(r.repos).toEqual([{ id: "r1", label: "/w/a", vcs: "git" }, { id: "r2", label: "/w/b", vcs: "jj" }]);
    expect(roots.list()).toEqual(r.repos);
  });
  test("a failed fetch resolves ok:false and keeps the cache", async () => {
    let fail = false;
    const roots = createRoots({ repos: async () => { if (fail) throw new Error("down"); return [repo("r1", "/w/a")]; } });
    const first = await roots.refresh();
    fail = true;
    const r = await roots.refresh();
    expect(r.ok).toBe(false);
    expect(r.revision).toBe(first.revision);
    expect(roots.list().map((x) => x.id)).toEqual(["r1"]);
  });
  test("a superseded call resolves ok:false", async () => {
    const pending: Array<(l: ReturnType<typeof repo>[]) => void> = [];
    const roots = createRoots({ repos: () => new Promise((res) => { pending.push(res); }) });
    const first = roots.refresh();
    const second = roots.refresh();
    pending[1]!([repo("r2", "/w/b")]);
    pending[0]!([repo("r1", "/w/a")]);
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
    expect(roots.list().map((x) => x.id)).toEqual(["r2"]);
  });
  test("subscribe fires after each applied refresh only, and unsubscribes", async () => {
    let fail = false;
    const roots = createRoots({ repos: async () => { if (fail) throw new Error("down"); return [repo("r1", "/w/a")]; } });
    const fn = vi.fn();
    const off = roots.subscribe(fn);
    await roots.refresh();
    expect(fn).toHaveBeenCalledTimes(1);
    fail = true;
    await roots.refresh();
    expect(fn).toHaveBeenCalledTimes(1);
    fail = false;
    off();
    await roots.refresh();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
