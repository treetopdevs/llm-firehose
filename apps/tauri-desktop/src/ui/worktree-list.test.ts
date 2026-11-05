// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { createScope } from "../scope";
import { BADGE } from "../glyphs";
import { createProject } from "./project";
import { NOW, iso, row } from "./project/model.fixtures";
import { describeWorktree, orderWorktrees } from "./worktree-list";

describe("orderWorktrees", () => {
  test("newest activity first, ties by id, an unreadable time last", () => {
    const ids = orderWorktrees([
      row({ worktree_id: "b", last_time: iso(NOW - 5) }),
      row({ worktree_id: "bad", last_time: "not a time" }),
      row({ worktree_id: "c", last_time: iso(NOW) }),
      row({ worktree_id: "a", last_time: iso(NOW - 5) }),
    ]).map((r) => r.worktree_id);
    expect(ids).toEqual(["c", "a", "b", "bad"]);
  });
});

describe("describeWorktree", () => {
  const state = (over: Parameters<typeof row>[0]) => describeWorktree(row(over), NOW).stateText;

  test("says what the API classified and nothing more", () => {
    expect(state({ state: "open" })).toBe("open");
    expect(state({ state: "landed", outcome: "landed" })).toBe("landed");
    expect(state({ state: "never_diverged" })).toBe("never diverged");
    expect(state({ state: "unknown" })).toBe("unknown");
    expect(state({ state: "gone", outcome: "abandoned" })).toBe("gone · abandoned");
    expect(state({ state: "gone", outcome: "landed" })).toBe("gone · landed");
    expect(state({ state: "gone" })).toBe("gone · removed");
  });

  test("a landed row carries no landing time, even with a pr_merge mark", () => {
    const merged = iso(NOW - 1000);
    const d = describeWorktree(row({ state: "landed", marks: [{ kind: "pr_merge", time: merged, event_id: "m" }], last_time: iso(NOW - 60_000) }), NOW);
    expect(JSON.stringify(d)).not.toContain(merged);
    expect(d.ageText).toBe("1m");
    expect(Object.keys(d).join(" ")).not.toMatch(/land/i);
  });

  test("names the folder and keeps the path for the title; no label stays a short id", () => {
    const named = describeWorktree(row({ worktree_id: "a".repeat(64), label: "/w/alpha-open/.git" }), NOW);
    expect(named.name).toBe("alpha-open");
    expect(named.title).toContain("/w/alpha-open");
    const bare = describeWorktree(row({ worktree_id: "a".repeat(64) }), NOW);
    expect(bare.name.length).toBeLessThan(64);
  });

  test("session count and activity facts, never NaN", () => {
    expect(describeWorktree(row({ sessions_total: 3 }), NOW).sessionsText).toBe("3 sessions captured");
    expect(describeWorktree(row({ sessions_total: 1 }), NOW).sessionsText).toBe("1 session captured");
    expect(describeWorktree(row({ sessions_total: 0 }), NOW).sessionsText).toBe("0 sessions captured");
    expect(describeWorktree(row({ last_time: iso(NOW - 30 * 60_000) }), NOW).ageText).toBe("30m");
    expect(describeWorktree(row({ last_time: "nope" }), NOW).ageText).toBe("no activity time");
  });

  test("the badge is the Project lane's", () => {
    const r = row({ state: "open", ahead: 2, behind: 1, dirty: true });
    expect(describeWorktree(r, NOW).badge).toBe(BADGE.format(true, 2, 1, true));
  });
});

describe("the Project resolver's lifetime rows", () => {
  const rows = [
    row({ repo_id: "r1", worktree_id: "w1", label: "/w/one", sessions: [{ source: "codex", session_id: "s1", first_time: iso(NOW), last_time: iso(NOW), events: 1 }], sessions_total: 1 }),
    row({ repo_id: "r1", worktree_id: "w2", label: "/w/two" }),
    row({ repo_id: "r2", worktree_id: "w3" }),
  ];
  const loaded = async () => {
    const store = createScope();
    createProject({ store, go: vi.fn(), api: { worktrees: async () => rows, worktree: vi.fn() } });
    await store.resolver()!.refresh!();
    return store;
  };

  test("are the project's rows only, whatever worktree is selected", async () => {
    const store = await loaded();
    const ids = (worktree?: string) => store.resolver()!.lifetimes!({ project: "r1", worktree, window: "live" })?.map((r) => r.worktree_id);
    expect(ids()).toEqual(["w1", "w2"]);
    expect(ids("w1")).toEqual(["w1", "w2"]);
  });

  test("answer undefined for no project or a project with no rows", async () => {
    const store = await loaded();
    expect(store.resolver()!.lifetimes!({ window: "live" })).toBeUndefined();
    expect(store.resolver()!.lifetimes!({ project: "nobody", window: "live" })).toBeUndefined();
  });

  test("every listed row resolves after activation: a label and a membership", async () => {
    const store = await loaded();
    for (const r of store.resolver()!.lifetimes!({ project: "r1", window: "live" })!) {
      const sc = { project: "r1", worktree: r.worktree_id, window: "live" as const };
      expect(store.resolver()!.matcher!(sc), r.worktree_id).toBeDefined();
      expect(store.resolver()!.labels(sc).worktree, r.worktree_id).toBeDefined();
    }
  });
});
