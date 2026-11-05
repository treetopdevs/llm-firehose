import { describe, expect, test } from "vitest";
import { remapScope } from "./privacy-remap";
import { createScope } from "./scope";
import type { Scope } from "./scope";

const repo = (id: string, label: string, vcs = "git") => ({ id, label, vcs });
const before = { repos: [repo("/Users/n/a", "alpha"), repo("/Users/n/b", "beta"), repo("/Users/n/c", "gamma", "jj")] };
const after = { repos: [repo("sha256-aaa", "alpha"), repo("sha256-bbb", "beta"), repo("sha256-ccc", "gamma", "jj")] };
const FROZEN = { from: 1000, to: 5000 };

describe("remapScope", () => {
  test("project remaps to the new id and carries the current window explicitly", () => {
    const sc: Scope = { project: "/Users/n/a", worktree: "w1", session: { id: "s1" }, window: FROZEN };
    const r = remapScope(sc, before, after);
    expect(r.kind).toBe("remapped");
    if (r.kind !== "remapped") return;
    expect(r.patch).toMatchObject({ project: "sha256-aaa", worktree: undefined, session: undefined, window: FROZEN });
    expect("worktree" in r.patch && "session" in r.patch).toBe(true);
    expect(r.note.toLowerCase()).toContain("privacy");
    expect(r.note.toLowerCase()).toContain("worktree");
    const live = remapScope({ project: "/Users/n/a", window: "live" }, before, after);
    expect(live.kind === "remapped" && live.patch.window).toBe("live");
  });
  test("the note shows the folder name, not a path label", () => {
    const b = { repos: [repo("/Users/n/develop/proj", "/Users/n/develop/proj")] };
    const a = { repos: [repo("sha256-ppp", "/Users/n/develop/proj")] };
    const r = remapScope({ project: "/Users/n/develop/proj", window: "live" }, b, a);
    expect(r.kind).toBe("remapped");
    if (r.kind !== "remapped") return;
    expect(r.note).toContain("project kept as proj.");
    expect(r.note).not.toContain("/Users");
  });
  test("duplicate label+vcs in after is cleared with a note", () => {
    const dup = { repos: [repo("x1", "alpha"), repo("x2", "alpha")] };
    const r = remapScope({ project: "/Users/n/a", window: "live" }, before, dup);
    expect(r.kind).toBe("cleared");
    expect(r.kind === "cleared" && r.note).toMatch(/privacy/i);
  });
  test("same label but a different vcs is not a match", () => {
    const r = remapScope({ project: "/Users/n/c", window: "live" }, before, { repos: [repo("z", "gamma", "git")] });
    expect(r.kind).toBe("cleared");
  });
  test("label missing from after is cleared with a note", () => {
    const r = remapScope({ project: "/Users/n/a", window: "live" }, before, { repos: [repo("q", "other")] });
    expect(r.kind).toBe("cleared");
    expect(r.kind === "cleared" && r.note.length).toBeGreaterThan(0);
  });
  test("old id still present in after is unchanged", () => {
    const same = { repos: [repo("/Users/n/a", "alpha")] };
    expect(remapScope({ project: "/Users/n/a", worktree: "w", window: "live" }, before, same)).toEqual({ kind: "unchanged" });
  });
  test("no project and nothing else is unchanged", () => {
    expect(remapScope({ window: FROZEN }, before, after)).toEqual({ kind: "unchanged" });
  });
  test("a project with no before label is cleared", () => {
    expect(remapScope({ project: "/never/seen", window: "live" }, before, after).kind).toBe("cleared");
  });
  test("worktree/session only is cleared with a note", () => {
    const r = remapScope({ worktree: "w1", session: { id: "s" }, window: "live" }, before, after);
    expect(r.kind).toBe("cleared");
    expect(r.kind === "cleared" && r.note).toMatch(/worktree/i);
  });
  test("a selected session and a frozen range survive both the remapped and the cleared patch via scope.narrow", () => {
    const store = createScope();
    store.narrow({ project: "/Users/n/a", worktree: "w1", window: FROZEN });
    store.narrow({ session: { id: "s1" } });
    // selecting a session resets the window; re-freeze it as the user would
    store.narrow({ window: FROZEN });
    expect(store.get().window).toEqual(FROZEN);
    const r = remapScope(store.get(), before, after);
    if (r.kind !== "remapped") throw new Error("expected remapped");
    store.narrow(r.patch);
    expect(store.get()).toMatchObject({ project: "sha256-aaa", window: FROZEN });
    expect(store.get().worktree).toBeUndefined();
    expect(store.get().session).toBeUndefined();

    const s2 = createScope();
    s2.narrow({ project: "/Users/n/a", worktree: "w1", session: { id: "s1" } });
    s2.narrow({ window: FROZEN });
    const cur = s2.get();
    const c = remapScope(cur, before, { repos: [] });
    expect(c.kind).toBe("cleared");
    s2.narrow({ project: undefined, worktree: undefined, session: undefined, window: cur.window });
    expect(s2.get().window).toEqual(FROZEN);
    expect(s2.get().project).toBeUndefined();
    expect(s2.get().session).toBeUndefined();
  });
});
