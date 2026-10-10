import { expect, test } from "vitest";
import {
  relatives,
  sharedAncestorCount,
  TimelineState,
  eventWorkspace,
} from "./model";
const nodes = [
  { key: "merge", parents: ["a", "b"] },
  { key: "a", parents: ["root"] },
  { key: "b", parents: ["root"] },
  { key: "root", parents: ["omitted"] },
].map((n) => ({ ...n, commit_id: n.key, description: "", timestamp: "" }));
test("relatives follow actual parents and children, merge parents included, never beyond loaded nodes", () => {
  expect(relatives(nodes, "a")).toEqual(new Set(["a", "root"]));
  expect(relatives(nodes, "a", true)).toEqual(new Set(["a", "merge"]));
  expect(relatives(nodes, "merge")).toEqual(
    new Set(["merge", "a", "b", "root"]),
  );
  expect(relatives(nodes, "root", true)).toEqual(
    new Set(["root", "a", "b", "merge"]),
  );
});
const dag = [
  { key: "root", parents: [] as string[] },
  { key: "m1", parents: ["root"] },
  { key: "m2", parents: ["m1"] },
  { key: "f1", parents: ["m1"] },
  { key: "f2", parents: ["f1"] },
  { key: "g1", parents: ["m2"] },
  { key: "join", parents: ["f2", "g1"] },
  { key: "far", parents: ["gone"] },
].map((n) => ({ ...n, commit_id: n.key, description: "", timestamp: "" }));
test("shared ancestors count the common loaded history of two revisions", () => {
  // f2: f2 f1 m1 root; g1: g1 m2 m1 root -> m1, root
  expect(sharedAncestorCount(dag, "f2", "g1")).toBe(2);
  expect(sharedAncestorCount(dag, "g1", "f2")).toBe(2);
  // ancestors include the revision itself, so an ancestor counts itself
  expect(sharedAncestorCount(dag, "join", "f2")).toBe(4);
  expect(sharedAncestorCount(dag, "m1", "m1")).toBe(2);
  expect(sharedAncestorCount(dag, "join", "root")).toBe(1);
});
test("shared ancestors ignore omitted history and unknown revisions", () => {
  expect(sharedAncestorCount(dag, "far", "join")).toBe(0);
  expect(sharedAncestorCount(dag, "far", "far")).toBe(1);
  expect(sharedAncestorCount(dag, "missing", "join")).toBe(0);
  expect(sharedAncestorCount(dag, "join", "missing")).toBe(0);
  expect(sharedAncestorCount([], "a", "b")).toBe(0);
});
const event = (
  id: string,
  source = "claude",
  workspace = "w1",
  time = "2026-10-04T00:00:00Z",
) => ({
  id,
  source,
  session_id: "same",
  category: "tool",
  time,
  repo_id: "repo",
  worktree_id: workspace,
});
test("timeline reconciles exact IDs, source scoped sessions, historical workspace and deterministic newest order", () => {
  const t = new TimelineState();
  t.merge([event("a"), event("c", "codex"), event("b")]);
  t.merge([event("a")]);
  expect(
    t.rows({ repo: "repo", session: "claude\0same" }).map((e) => e.id),
  ).toEqual(["b", "a"]);
  t.merge([event("d", "claude", "w2")]);
  expect(t.rows({ repo: "repo", workspace: "w1" })).toHaveLength(3);
  expect(eventWorkspace(event("a"), [{ id: "w2" }])).toBeUndefined();
});
test("pause freezes rendering, counts exact arrivals and retains selected event across pages", () => {
  const t = new TimelineState();
  t.merge([event("a")]);
  t.select("a");
  t.pause();
  t.merge([event("b"), event("b")]);
  expect(t.unread).toBe(1);
  expect(t.rows({})).toHaveLength(1);
  t.resume();
  expect(t.rows({})).toHaveLength(2);
  expect(t.selected?.id).toBe("a");
});

test("durable associations preserve privacy transitions without rewriting captured identities", () => {
  const t = new TimelineState();
  const e = event("historic");
  t.merge([e], {
    historic: { repo_id: "current-hash", workspace_id: "workspace-hash" },
  });
  expect(t.rows({ repo: "current-hash", workspace: "workspace-hash" })).toEqual(
    [e],
  );
  expect(t.rows({ repo: "current-hash" })[0].repo_id).toBe("repo");
});

test("timeline sorts actual instants with nanoseconds and timezone offsets, not timestamp spellings", () => {
  const t = new TimelineState();
  t.merge([
    event("z", "claude", "w1", "2026-10-04T01:00:00+01:00"),
    event("a", "claude", "w1", "2026-10-04T00:00:00.000000001Z"),
  ]);
  expect(t.rows({}).map((e) => e.id)).toEqual(["a", "z"]);
});

test("captured timeline excludes ephemeral transition frames and counts paused arrivals only in scope", () => {
  const t = new TimelineState();
  t.pause();
  t.merge([
    { ...event("transition", "firehose"), name: "state.transition" },
    event("captured"),
    event("elsewhere", "codex", "w2"),
  ]);
  expect(t.all().map((e) => e.id)).toEqual(["captured", "elsewhere"]);
  expect(t.unreadFor({ repo: "repo", workspace: "w1", source: "claude" })).toBe(
    1,
  );
  t.merge([event("captured")]);
  expect(t.unreadFor({ workspace: "w1" })).toBe(1);
  t.resume();
  expect(t.unreadFor({})).toBe(0);
});
