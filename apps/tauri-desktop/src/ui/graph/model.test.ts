import { expect, test } from "vitest";
import { layoutGraph, relatives, TimelineState, eventWorkspace } from "./model";
const nodes = [
  { key: "merge", parents: ["a", "b"] },
  { key: "a", parents: ["root"] },
  { key: "b", parents: ["root"] },
  { key: "root", parents: ["omitted"] },
].map((n) => ({ ...n, commit_id: n.key, description: "", timestamp: "" }));
test("layout retains actual merge parents and marks omitted parents without invented links", () => {
  const layout = layoutGraph(nodes, []);
  expect(layout.edges.map((e) => [e.child, e.parent])).toEqual([
    ["merge", "a"],
    ["merge", "b"],
    ["a", "root"],
    ["b", "root"],
  ]);
  expect(layout.boundaries).toEqual(["root"]);
  expect(layout.points.get("root")!.y).toBeGreaterThan(
    layout.points.get("a")!.y,
  );
  expect(relatives(nodes, "a")).toEqual(new Set(["a", "root"]));
  expect(relatives(nodes, "a", true)).toEqual(new Set(["a", "merge"]));
});
test("crowded labels reserve space for every shared anchor", () => {
  const workspaces = Array.from({ length: 25 }, (_, i) => ({
    id: `w${i}`,
    revision_key: "root",
  }));
  const l = layoutGraph(nodes, workspaces);
  expect(l.labels.size).toBe(25);
  expect(new Set([...l.labels.values()].map((p) => `${p.x},${p.y}`)).size).toBe(
    25,
  );
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
