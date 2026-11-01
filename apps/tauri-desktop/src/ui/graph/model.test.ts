import { expect, test } from "vitest";
import {
  relatives,
  sharedAncestorCount,
  TimelineState,
  eventWorkspace,
  orderBy,
  TIMELINE_CAP,
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

const T0 = Date.UTC(2026, 10, 1, 12);
const at = (n: number) => new Date(T0 + n * 1000).toISOString();
function ranged() {
  const t = new TimelineState();
  t.merge([1, 2, 3, 4, 5].map((n) => event(`e${n}`, "claude", "w1", at(n))));
  return t;
}
test("rows honours an inclusive from/to range, newest first", () => {
  const t = ranged();
  const ids = (f: { from?: number; to?: number }) => t.rows(f).map((e) => e.id);
  expect(ids({ from: T0 + 2000, to: T0 + 4000 })).toEqual(["e4", "e3", "e2"]);
  expect(ids({ from: T0 + 4000 })).toEqual(["e5", "e4"]);
  expect(ids({ to: T0 + 2000 })).toEqual(["e2", "e1"]);
});
test("unparsable time is excluded when a bound is set, included otherwise", () => {
  const t = ranged();
  t.merge([event("bad", "claude", "w1", "not-a-time")]);
  expect(t.rows({}).map((e) => e.id)).toContain("bad");
  expect(t.rows({ from: 0 }).map((e) => e.id)).not.toContain("bad");
  expect(t.rows({ to: T0 + 9e6 }).map((e) => e.id)).not.toContain("bad");
});
test("older page merged after newer page stays reachable (uncapped)", () => {
  const t = new TimelineState();
  const e = (n: number) => event(`e${n}`, "claude", "w1", at(n));
  t.merge([e(5), e(4)]);
  t.merge([e(2), e(1)]);
  expect(t.rows({ to: T0 + 2000 }).map((x) => x.id)).toEqual(["e2", "e1"]);
  expect(t.rows({})).toHaveLength(4);
});
test("orderBy ranks by first index, keeps unranked after in order", () => {
  const items = ["a", "b", "d", "c"];
  const id = (s: string) => s;
  expect(orderBy(["c", "a"], items, id)).toEqual(["c", "a", "b", "d"]);
  expect(orderBy(["c", "a", "c"], items, id)).toEqual(["c", "a", "b", "d"]);
  for (const o of [undefined, []] as const) {
    const r = orderBy(o, items, id);
    expect(r).toEqual(items);
    expect(r).not.toBe(items);
  }
});

// D110: the Events timeline is bounded. Tiny caps keep these fast; TIMELINE_CAP matches the feed ring.
const tick = (n: number) => event(`t${n}`, "claude", "w1", at(n));
test("TIMELINE_CAP bounds the default state at the live feed's ring size", () => {
  expect(TIMELINE_CAP).toBe(5000);
  const t = new TimelineState();
  for (let n = 0; n < TIMELINE_CAP + 50; n++) t.merge([tick(n)]);
  expect(t.all()).toHaveLength(TIMELINE_CAP);
  expect(t.event("t0")).toBeUndefined();
  expect(t.event(`t${TIMELINE_CAP + 49}`)).toBeDefined();
});
test("live appends past the cap evict the oldest, keep the newest and leave older history pageable", () => {
  const t = new TimelineState(3);
  expect(t.olderEvicted).toBe(false);
  for (let n = 1; n <= 3; n++) expect(t.merge([tick(n)]).older).toBe(0);
  expect(t.olderEvicted).toBe(false);
  for (let n = 4; n <= 10; n++) t.merge([tick(n)]);
  expect(t.all()).toHaveLength(3);
  expect(t.rows({}).map((e) => e.id)).toEqual(["t10", "t9", "t8"]);
  expect(t.event("t7")).toBeUndefined();
  expect(t.olderEvicted).toBe(true);
  // Exact-ID replays never count against the cap.
  expect(t.merge([tick(10), tick(9)]).older).toBe(0);
  expect(t.all()).toHaveLength(3);
});
test("eviction is by event time, not arrival order, and drops evicted associations and arrivals", () => {
  const t = new TimelineState(2);
  t.merge([tick(5)], { t5: { repo_id: "r", workspace_id: "w" } });
  t.merge([tick(9)]);
  t.pause();
  t.merge([tick(1)]); // older than both: it is the one evicted
  expect(t.all().map((e) => e.id).sort()).toEqual(["t5", "t9"]);
  expect(t.unreadFor({})).toBe(0);
  t.merge([tick(7)], { t7: { repo_id: "r", workspace_id: "w" } });
  expect(t.all().map((e) => e.id).sort()).toEqual(["t7", "t9"]);
  expect(t.association(tick(5)).repo_id).toBe("repo");
});
test("an older page at the cap evicts the newest instead, so paging back stays visible", () => {
  const t = new TimelineState(3);
  for (let n = 7; n <= 10; n++) t.merge([tick(n)]);
  const r = t.merge([tick(6), tick(5)], {}, { older: true });
  expect(r).toEqual({ older: 0, newer: 2 });
  // Held t8..t10 (t7 evicted live); the older page keeps itself and drops the newest two.
  expect(t.rows({}).map((e) => e.id)).toEqual(["t8", "t6", "t5"]);
});
