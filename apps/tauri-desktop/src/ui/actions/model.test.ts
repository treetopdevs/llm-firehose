import { describe, expect, test } from "vitest";
import { wt, wtUnregistered } from "./fixtures";
import {
  actionsForRepo, actionsForSession, actionsForWorktree, diffCommand, isAbsPath, isSafeRef,
  repoRootOf, resumeCommand, shellQuote, worktreePath,
} from "./model";

describe("isAbsPath", () => {
  test("accepts absolute posix", () => expect(isAbsPath("/Users/a/repo")).toBe(true));
  test.each(["", "repo", "./x", "C:\\w\\x", "a".repeat(64), undefined])("rejects %j", (v) => expect(isAbsPath(v)).toBe(false));
  test.each(["\n", "\r", "\t", "\x1b[201~", "\x7f", "\u202e", "\u0085"])("rejects control %j", (c) =>
    expect(isAbsPath(`/w/a${c}b`)).toBe(false));
});

describe("shellQuote / isSafeRef", () => {
  test("safe unquoted", () => expect(shellQuote("/w/a-b_c.d")).toBe("/w/a-b_c.d"));
  test("spaces and $()", () => {
    expect(shellQuote("/w/a b")).toBe("'/w/a b'");
    expect(shellQuote("/w/$(x)")).toBe("'/w/$(x)'");
  });
  test("single quote", () => expect(shellQuote("/w/a'b")).toBe("'/w/a'\\''b'"));
  test.each(["main", "origin/main", "release/1.2", "refs/remotes/origin/main", "feature/x_y"])("accepts %s", (r) =>
    expect(isSafeRef(r)).toBe(true));
  test.each(["", "-x", "a b", "a..b", "main;ls", "$(x)"])("rejects %j", (r) => expect(isSafeRef(r)).toBe(false));
});

describe("diffCommand", () => {
  test("exact", () =>
    expect(diffCommand("/w/a", "main")).toBe(
      "git --no-pager -c core.fsmonitor=false -c diff.external= -C /w/a diff --no-ext-diff --no-textconv --submodule=short main...HEAD"));
  test("quotes spaces", () => expect(diffCommand("/w/a b", "main")).toContain("-C '/w/a b' diff"));
  test("undefined for unsafe", () => {
    expect(diffCommand("/w/a", "-x")).toBeUndefined();
    expect(diffCommand("/w/a", "a;b")).toBeUndefined();
    expect(diffCommand("rel", "main")).toBeUndefined();
    expect(diffCommand("/w/a\nb", "main")).toBeUndefined();
    expect(diffCommand("/w/a", undefined)).toBeUndefined();
  });
  test("injection label is quoted", () =>
    expect(diffCommand("/w/a; rm -rf ~", "main")).toContain("-C '/w/a; rm -rf ~' diff"));
});

describe("resumeCommand", () => {
  test("agents", () => {
    expect(resumeCommand("claude-code", "abc-1")).toBe("claude --resume abc-1");
    expect(resumeCommand("codex", "abc-1")).toBe("codex resume abc-1");
    expect(resumeCommand("opencode", "abc-1")).toBeUndefined();
  });
  test.each(["a b", "a;b", "a\nb", ""])("rejects id %j", (id) => expect(resumeCommand("codex", id)).toBeUndefined());
});

describe("worktreePath", () => {
  test("label wins", () => expect(worktreePath(wt({ label: "/x/l", worktree_id: "/x/i" }))).toBe("/x/l"));
  test("falls back to id", () => expect(worktreePath(wt({ label: "short", worktree_id: "/x/i" }))).toBe("/x/i"));
  test("digest without label", () => expect(worktreePath(wt({ label: undefined, worktree_id: "f".repeat(64) }))).toBeUndefined());
});

describe("actionsForWorktree", () => {
  test("open fork", () => {
    const a = actionsForWorktree(wt({ worktree_id: "/w/a" }));
    expect(a.map((x) => x.id)).toEqual(["open-terminal", "open-editor", "reveal", "copy-diff"]);
    expect(a.map((x) => x.label)).toEqual(["Open in terminal", "Open in editor (VS Code)", "Reveal in Finder", "Copy diff command"]);
    expect(a[0].request).toEqual({ type: "open", kind: "terminal", path: "/w/a" });
    expect(a[1].request).toEqual({ type: "open", kind: "editor", path: "/w/a" });
    expect(a[2].request).toEqual({ type: "open", kind: "reveal", path: "/w/a" });
    expect(a[3].request).toEqual({ type: "copy", text: diffCommand("/w/a", "main") });
  });
  test("no target ref drops copy-diff", () =>
    expect(actionsForWorktree(wt({ default_target_ref: undefined })).map((x) => x.id)).toEqual(["open-terminal", "open-editor", "reveal"]));
  test("gone and pathless are empty", () => {
    expect(actionsForWorktree(wt({ state: "gone" }))).toEqual([]);
    expect(actionsForWorktree(wt({ worktree_id: "f".repeat(64) }))).toEqual([]);
  });
  test("unknown/repo_unregistered still opens", () => {
    const a = actionsForWorktree(wtUnregistered({ worktree_id: "/w/feat" }));
    expect(a.map((x) => x.id)).toEqual(["open-terminal", "open-editor", "reveal"]);
  });
  test("hostile label flows verbatim into open requests but quoted in diff", () => {
    const a = actionsForWorktree(wt({ label: "/w/a; rm -rf ~" }));
    expect(a[0].request).toEqual({ type: "open", kind: "terminal", path: "/w/a; rm -rf ~" });
    expect(a[3].request).toEqual({ type: "copy", text: expect.stringContaining("-C '/w/a; rm -rf ~' diff") });
  });
});

describe("actionsForSession", () => {
  test("claude-code and codex", () => {
    expect(actionsForSession({ source: "claude-code", id: "s1" }).map((x) => x.id)).toEqual(["copy-resume"]);
    expect(actionsForSession({ source: "codex", id: "s1" })[0].request).toEqual({ type: "copy", text: "codex resume s1" });
  });
  test("unknown agent absent", () => {
    expect(actionsForSession({ source: "opencode", id: "s1" })).toEqual([]);
    expect(actionsForSession({ source: "weird", id: "s1" })).toEqual([]);
  });
});

describe("repoRootOf", () => {
  test("strips .git", () => expect(repoRootOf("/x/repo/.git", undefined)).toBe("/x/repo"));
  test("digest + abs label", () => expect(repoRootOf("f".repeat(64), "/x/repo")).toBe("/x/repo"));
  test("digest + short label", () => expect(repoRootOf("f".repeat(64), "repo")).toBeUndefined());
  test("abs id preferred", () => expect(repoRootOf("/a/b", "/c/d")).toBe("/a/b"));
  test("windows and spaces", () => {
    expect(repoRootOf("f".repeat(64), "C:\\w\\x")).toBeUndefined();
    expect(repoRootOf("f".repeat(64), "/my repo/x")).toBe("/my repo/x");
  });
});

describe("actionsForRepo", () => {
  const digest = "f".repeat(64);
  test("register offered for unregistered with unknown fork", () => {
    const a = actionsForRepo({ repoId: digest, registered: false, forks: [wtUnregistered({ worktree_id: "/w/feat" })] });
    expect(a).toEqual([{ id: "register-root", label: "Register root: /w/feat", request: { type: "register", path: "/w/feat" } }]);
  });
  test("registered never offers register", () =>
    expect(actionsForRepo({ repoId: digest, registered: true, forks: [wt()] }).map((x) => x.id)).toEqual([]));
  test("gone forks / unsafe paths do not supply register", () => {
    expect(actionsForRepo({ repoId: digest, registered: false, forks: [wt({ state: "gone" })] })).toEqual([]);
    expect(actionsForRepo({ repoId: digest, registered: false, forks: [wt({ worktree_id: "/w/a\nb" })] })).toEqual([]);
  });
  test("skips gone fork, uses next", () => {
    const a = actionsForRepo({ repoId: digest, registered: false, forks: [wt({ state: "gone", worktree_id: "/g" }), wt({ worktree_id: "/ok" })] });
    expect(a[0].request).toEqual({ type: "register", path: "/ok" });
  });
  test("prune is repo-level, root only", () => {
    const a = actionsForRepo({ repoId: "/x/repo/.git", registered: true, forks: [] });
    expect(a).toEqual([{ id: "prune-stale", label: "Prune stale worktrees", request: { type: "prune", root: "/x/repo" } }]);
  });
  test("prune absent without root", () =>
    expect(actionsForRepo({ repoId: digest, rawLabel: "short", registered: true, forks: [] })).toEqual([]));
  test("digest repo with abs raw label", () =>
    expect(actionsForRepo({ repoId: digest, rawLabel: "/x/repo", registered: true, forks: [] })[0].request).toEqual({ type: "prune", root: "/x/repo" }));
});
