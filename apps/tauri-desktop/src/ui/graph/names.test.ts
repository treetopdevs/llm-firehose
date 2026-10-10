import { expect, test } from "vitest";
import type { AttentionSession } from "../../api";
import {
  aggregateState,
  branchName,
  displayText,
  fileName,
  fullPath,
  relativeAge,
  repoName,
  repoNames,
  sessionState,
  sessionStateWord,
  shortDigest,
  sourceName,
  truncateName,
  workspaceName,
  workspacePath,
} from "./names";

const digest = "ab12cd34" + "0".repeat(56);
const ws = (over: Partial<Parameters<typeof workspaceName>[0]> = {}) => ({
  label: "/Users/dev/work/wt-07-fix",
  refs: ["refs/heads/agent/cache-fix"],
  unborn: false,
  ...over,
});

test("Git full mode names a workspace after its checkout folder", () => {
  expect(workspaceName(ws(), "git", "full")).toBe("wt-07-fix");
  expect(workspaceName(ws({ label: "C:\\work\\wt-02" }), "git", "full")).toBe("wt-02");
});

test("Git without a path label uses the branch with refs/heads stripped", () => {
  expect(workspaceName(ws({ label: digest }), "git", "balanced")).toBe("agent/cache-fix");
  expect(workspaceName(ws({ label: digest, refs: ["main"] }), "git", "balanced")).toBe("main");
});

test("detached and unborn Git checkouts get honest names", () => {
  const detached = ws({ label: digest, refs: ["detached"] });
  expect(workspaceName(detached, "git", "balanced", "abcdef0123456789")).toBe("det abcdef0");
  expect(workspaceName(detached, "git", "balanced")).toBe("detached");
  expect(workspaceName(ws({ label: digest, refs: [] }), "git", "balanced", "1234567890")).toBe("det 1234567");
  expect(workspaceName(ws({ label: digest, refs: [], unborn: true }), "git", "balanced")).toBe("unborn");
});

test("minimal mode digests become their first eight hex characters and never more", () => {
  const refDigest = "ff00aa11" + "7".repeat(56);
  const name = workspaceName(ws({ label: digest, refs: [refDigest] }), "git", "minimal");
  expect(name).toBe("ff00aa11");
  expect(name).not.toContain(digest.slice(8));
  expect(workspaceName(ws({ label: digest, refs: [] }), "jj", "minimal")).toBe("ab12cd34");
  expect(workspaceName(ws({ label: `sha256:${digest}`, refs: [] }), "jj", "minimal")).toBe("ab12cd34");
});

test("JJ workspace names are shown as the label says", () => {
  expect(workspaceName(ws({ label: "default", refs: ["main"] }), "jj", "full")).toBe("default");
  expect(workspaceName(ws({ label: "wt-xyz" }), "jj", "balanced")).toBe("wt-xyz");
});

test("branchName strips refs/heads and keeps non-branch refs", () => {
  expect(branchName(["refs/heads/feature/x"])).toBe("feature/x");
  expect(branchName(["detached"])).toBeUndefined();
  expect(branchName([])).toBeUndefined();
  expect(branchName(["main", "release"])).toBe("main");
});

test("repoName uses the folder name in full mode and repo plus eight hex otherwise", () => {
  expect(repoName("/Users/dev/llm-firehose", "full")).toBe("llm-firehose");
  expect(repoName(digest, "balanced")).toBe(`repo ab12cd34`);
  expect(repoName(digest, "minimal")).toBe("repo ab12cd34");
  expect(repoName("plain-name", "balanced")).toBe("plain-name");
});

test("sourceName maps known agents and leaves others alone", () => {
  expect(sourceName("codex")).toBe("Codex");
  expect(sourceName("claude-code")).toBe("Claude Code");
  expect(sourceName("claude")).toBe("Claude Code");
  expect(sourceName("opencode")).toBe("OpenCode");
  expect(sourceName("aider")).toBe("aider");
});

const base: AttentionSession = {
  id: "s",
  source: "codex",
  events: 1,
  state: "idle",
  last: { event_id: "e", source: "codex", kind: "x", summary: "", time: "2026-10-08T00:00:00Z", observed_at: "" },
};
const now = Date.parse("2026-10-08T00:01:00Z");

test("session state: needs attention beats working beats observed", () => {
  const working = { ...base, state: "working" };
  const needs = {
    ...base,
    state: "needs_input",
    pending: { ...base.last, kind: "request", time: "2026-10-08T00:00:30Z" },
  };
  expect(sessionState(working, now)).toBe("working");
  expect(sessionState(needs, now)).toBe("attention");
  expect(sessionState(base, now)).toBe("observed");
  expect(aggregateState(["observed", "working", "attention"])).toBe("attention");
  expect(aggregateState(["observed", "working"])).toBe("working");
  expect(aggregateState(["observed"])).toBe("observed");
  expect(aggregateState([])).toBe("none");
  expect(sessionStateWord(working, now)).toBe("Working");
  expect(sessionStateWord(needs, now)).toBe("Needs you");
  expect(sessionStateWord(base, now)).toBe("Idle");
});

test("a stale working session is only observed", () => {
  const old = { ...base, state: "working", last: { ...base.last, time: "2026-10-07T00:00:00Z" } };
  expect(sessionState(old, now)).toBe("observed");
});

test("relativeAge reads like the mockup", () => {
  expect(relativeAge("2026-10-08T00:00:00Z", now)).toBe("1m ago");
  expect(relativeAge("2026-10-07T21:00:00Z", now)).toBe("3h ago");
  expect(relativeAge("2026-10-08T00:01:00Z", now)).toBe("just now");
  expect(relativeAge("not a date", now)).toBe("");
  expect(relativeAge(undefined, now)).toBe("");
});

test("truncateName, shortDigest and fileName", () => {
  expect(truncateName("short")).toBe("short");
  expect(truncateName("a".repeat(30))).toBe("a".repeat(23) + "…");
  expect(shortDigest(digest)).toBe("ab12cd34");
  expect(shortDigest("plain")).toBe("plain");
  expect(fileName("internal/graph/session.go")).toBe("session.go");
  expect(fileName(digest)).toBe("#ab12cd34");
});

test("displayText shortens digests and leaves ordinary text alone", () => {
  expect(displayText(digest)).toBe("#ab12cd34");
  expect(displayText("fix cache eviction")).toBe("fix cache eviction");
});

// ---- readable names: the daemon sends absolute paths in every privacy mode -----------------

test("a Git worktree is named after its directory in every privacy mode, with the branch ignored", () => {
  const path = "/Users/nicholas/develop/llm-firehose-graph-mockup";
  for (const mode of ["minimal", "balanced", "full", undefined])
    expect(workspaceName(ws({ label: path }), "git", mode), String(mode)).toBe("llm-firehose-graph-mockup");
  expect(workspaceName(ws({ label: "C:\\work\\wt-02\\" }), "git", "balanced")).toBe("wt-02");
  expect(workspaceName(ws({ label: path, refs: ["detached"] }), "git", "balanced")).toBe("llm-firehose-graph-mockup");
});

test("a JJ workspace is named by its workspace name, which is never mistaken for a path", () => {
  expect(workspaceName(ws({ label: "default" }), "jj", "balanced")).toBe("default");
  expect(workspaceName(ws({ label: "agent-7" }), "jj", "minimal")).toBe("agent-7");
});

test("a digest label from an older daemon still falls back to the branch, and never to the full digest", () => {
  const name = workspaceName(ws({ label: digest, refs: ["refs/heads/agent/cache-fix"] }), "git", "full");
  expect(name).toBe("agent/cache-fix");
  expect(workspaceName(ws({ label: digest, refs: [] }), "git", "full", "abcdef0123")).toBe("det abcdef0");
});

test("fullPath returns an absolute path as sent and nothing for digests or plain names", () => {
  expect(fullPath("/Users/dev/llm-firehose")).toBe("/Users/dev/llm-firehose");
  expect(fullPath("C:\\work\\repo")).toBe("C:\\work\\repo");
  expect(fullPath(digest)).toBeUndefined();
  expect(fullPath(`sha256:${digest}`)).toBeUndefined();
  expect(fullPath("default")).toBeUndefined();
  expect(fullPath("")).toBeUndefined();
});

test("workspacePath is the worktree path for Git only", () => {
  expect(workspacePath(ws({ label: "/work/wt-1" }), "git")).toBe("/work/wt-1");
  expect(workspacePath(ws({ label: "/work/wt-1" }), "jj")).toBeUndefined();
  expect(workspacePath(ws({ label: digest }), "git")).toBeUndefined();
});

test("repoNames show the root folder and add the parent directory only where two roots share a name", () => {
  const repo = (label: string, vcs = "git") => ({ label, vcs });
  expect(repoNames([repo("/Users/dev/llm-firehose")])).toEqual(["llm-firehose"]);
  expect(
    repoNames([repo("/work/fixtures/main"), repo("/work/other/main"), repo("/work/llm-firehose")]),
  ).toEqual(["fixtures/main", "other/main", "llm-firehose"]);
  // identical parents keep widening until the names differ
  expect(repoNames([repo("/a/x/main"), repo("/b/x/main"), repo("/b/y/main")])).toEqual(["a/x/main", "b/x/main", "y/main"]);
  expect(repoNames([repo("C:\\one\\app"), repo("C:\\two\\app")])).toEqual(["one/app", "two/app"]);
});

test("the same root registered under two VCSs is told apart by VCS", () => {
  expect(repoNames([{ label: "/w/app", vcs: "git" }, { label: "/w/app", vcs: "jj" }])).toEqual(["app · git", "app · jj"]);
});

test("repoNames keep the digest fallback for older daemons", () => {
  expect(repoNames([{ label: digest, vcs: "git" }, { label: "/w/app", vcs: "git" }])).toEqual(["repo ab12cd34", "app"]);
  expect(repoNames([{ label: digest, vcs: "git" }, { label: digest, vcs: "jj" }])).toEqual([
    "repo ab12cd34 · git",
    "repo ab12cd34 · jj",
  ]);
  expect(repoNames([{ label: "plain-name", vcs: "git" }])).toEqual(["plain-name"]);
});
