import { describe, expect, test, vi } from "vitest";

import { FeedState } from "../../state";
import { TimelineState } from "../graph/model";
import type { FirehoseEvent } from "../../api";
import { liveSource, scopeEvents, timelineView, defaultEventPolicy, type EventRow } from "./model";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const t = (ms: number) => new Date(T0 + ms).toISOString();
function ev(id: string, ms: number, extra: Partial<FirehoseEvent> = {}): FirehoseEvent {
  return { id, time: t(ms), source: "codex", session_id: "s1", category: "tool", summary: id, ...extra } as FirehoseEvent;
}
const three = () => [ev("a", 0), ev("b", 1000, { source: "claude-code", session_id: "s2", category: "shell" }), ev("c", 2000, { category: "error" })];
function fields(r: EventRow) {
  return { key: r.key, id: r.event.id, time: r.time, source: r.source, sessionRef: r.sessionRef, category: r.category, summary: r.summary, count: r.count };
}
function viewOf(events: FirehoseEvent[], o: Partial<Parameters<typeof timelineView>[1]> = {}) {
  const s = new TimelineState();
  s.merge(events);
  return { s, v: timelineView(s, o) };
}

describe("event source adapters", () => {
  test("liveSource and timelineView map the same 3 events to equal EventRow fields", () => {
    const feed = new FeedState(10);
    for (const e of three()) feed.push(e);
    const live = liveSource(feed).rows({}).map(fields);
    const view = viewOf(three()).v.rows({}).map(fields);
    expect([...view].reverse()).toEqual(live);
    expect(live[0]).toEqual({ key: "a", id: "a", time: t(0), source: "codex", sessionRef: "codex\0s1", category: "tool", summary: "a", count: 1 });
  });

  test("coalesce: key stays first id while event is replaced; count 2", () => {
    const feed = new FeedState(10);
    const base = { session_id: "s1", turn_id: "t1", call_id: "c1", payload: { phase: "start", tool_name: "Read" } };
    feed.push(ev("hook", 0, base));
    feed.push(ev("rollout", 500, base));
    const rows = liveSource(feed).rows({});
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("hook");
    expect(rows[0].event.id).toBe("rollout");
    expect(rows[0].count).toBe(2);
  });

  test("order option: liveSource oldest-first, timelineView newest-first", () => {
    const feed = new FeedState(10);
    for (const e of three()) feed.push(e);
    const live = liveSource(feed);
    const { v } = viewOf(three());
    expect(live.order).toBe("oldest-first");
    expect(v.order).toBe("newest-first");
    expect(live.rows({}).map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(v.rows({}).map((r) => r.key)).toEqual(["c", "b", "a"]);
    expect(live.coalesce).toBe(true);
    expect(v.coalesce).toBe(false);
  });
});

describe("scope and default policy", () => {
  test("scopeEvents excludes other repo or worktree association and out-of-window or invalid-time events", () => {
    const events = [
      ev("in", 0, { repo_id: "r1", worktree_id: "w1" }),
      ev("otherRepo", 0, { repo_id: "r2", worktree_id: "w1" }),
      ev("otherWt", 0, { repo_id: "r1", worktree_id: "w2" }),
      ev("early", -3_600_000, { repo_id: "r1", worktree_id: "w1" }),
      ev("late", 3_600_000, { repo_id: "r1", worktree_id: "w1" }),
      { ...ev("bad", 0, { repo_id: "r1", worktree_id: "w1" }), time: "nope" },
    ];
    const window = { from: T0 - 60_000, to: T0 + 60_000 };
    expect(scopeEvents(events, { repo: "r1", workspace: "w1", window }).map((e) => e.id)).toEqual(["in"]);
    expect(scopeEvents(events, { repo: "r1" }).map((e) => e.id)).toEqual(["in", "otherWt", "early", "late", "bad"]);
    // jj ids associate too
    expect(scopeEvents([ev("jj", 0, { jj_repo_id: "r1", jj_workspace_id: "w1" })], { repo: "r1", workspace: "w1" })).toHaveLength(1);
  });

  test("default policy excludes meta events unless category filter set explicitly, applied before renderLimit, on both adapters and scopeEvents", () => {
    const events = [ev("m1", 0, { category: "meta" }), ev("a", 1000), ev("b", 2000), ev("m2", 3000, { category: "meta" })];
    expect(defaultEventPolicy(events[0])).toBe(false);
    expect(defaultEventPolicy(events[0], "meta")).toBe(true);
    expect(scopeEvents(events, {}).map((e) => e.id)).toEqual(["a", "b"]);
    expect(scopeEvents(events, { category: "meta" }).map((e) => e.id)).toEqual(["m1", "m2"]);

    const feed = new FeedState(10);
    for (const e of events) feed.push(e);
    const live = liveSource(feed, { renderLimit: 2 });
    expect(live.rows({}).map((r) => r.key)).toEqual(["a", "b"]);
    expect(live.rows({ category: "meta" }).map((r) => r.key)).toEqual(["m1", "m2"]);

    const { v } = viewOf(events, {});
    expect(v.rows({}).map((r) => r.key)).toEqual(["b", "a"]);
    expect(v.rows({ category: "meta" }).map((r) => r.key)).toEqual(["m2", "m1"]);
    const limited = timelineView(viewOf(events).s, { renderLimit: 2 });
    expect(limited.rows({}).map((r) => r.key)).toEqual(["b", "a"]);
  });
});

describe("unread, pause and resume", () => {
  test("unread(f,w) counts only arrivals matching repo, source, category and window (raw 3 vs scoped 1)", () => {
    const feed = new FeedState(10);
    const live = liveSource(feed, { scope: () => ({ repo: "r1" }) });
    live.pause();
    feed.push(ev("hit", 0, { repo_id: "r1" }));
    feed.push(ev("otherRepo", 0, { repo_id: "r2" }));
    feed.push(ev("outside", 3_600_000, { repo_id: "r1" }));
    expect(feed.unread).toBe(3);
    expect(live.unread({}, { from: T0 - 1000, to: T0 + 1000 })).toBe(1);
    expect(live.unread({ source: "claude-code" })).toBe(0);
    expect(live.unread({ category: "shell" })).toBe(0);
    expect(live.unread({})).toBe(2);

    const s = new TimelineState();
    const v = timelineView(s, { repo: "r1" });
    v.pause();
    s.merge([ev("hit", 0, { repo_id: "r1" }), ev("otherRepo", 0, { repo_id: "r2" }), ev("outside", 3_600_000, { repo_id: "r1" }), ev("meta", 0, { repo_id: "r1", category: "meta" })]);
    expect(s.unread).toBe(4);
    expect(v.unread({}, { from: T0 - 1000, to: T0 + 1000 })).toBe(1);
    expect(v.unread({})).toBe(2);
  });

  test("pause freezes rows; resume asks owner to reload head on timelineView", () => {
    const feed = new FeedState(10);
    feed.push(ev("a", 0));
    const live = liveSource(feed);
    live.pause();
    expect(live.paused).toBe(true);
    feed.push(ev("b", 1000));
    expect(live.rows({}).map((r) => r.key)).toEqual(["a"]);
    live.resume();
    expect(live.paused).toBe(false);
    expect(live.rows({}).map((r) => r.key)).toEqual(["a", "b"]);

    const reload = vi.fn(async () => {});
    const { s, v } = viewOf([ev("a", 0)], { reload });
    v.pause();
    s.merge([ev("b", 1000)]);
    expect(v.paused).toBe(true);
    expect(v.rows({}).map((r) => r.key)).toEqual(["a"]);
    expect(reload).not.toHaveBeenCalled();
    v.resume();
    expect(v.paused).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(v.rows({}).map((r) => r.key)).toEqual(["b", "a"]);
  });
});

describe("notice and setQuery", () => {
  test("notice() returns historyError and capture-gap text", () => {
    let msg = "Capture gaps reported; this feed may be incomplete.";
    const { v } = viewOf([], { notice: () => msg });
    expect(v.notice()).toBe(msg);
    msg = "History failed to load";
    expect(v.notice()).toBe("History failed to load");
    expect(timelineView(new TimelineState(), {}).notice()).toBe("");
    expect(liveSource(new FeedState(5)).notice()).toBe("");
  });

  test("setQuery on timelineView calls owner callback once per change", () => {
    const setQuery = vi.fn();
    const { v } = viewOf([], { setQuery });
    v.setQuery({ source: "codex" });
    v.setQuery({ source: "codex" });
    expect(setQuery).toHaveBeenCalledTimes(1);
    v.setQuery({ source: "codex", text: "x" });
    v.setQuery({});
    expect(setQuery).toHaveBeenCalledTimes(3);
    expect(setQuery).toHaveBeenLastCalledWith({});
  });

  test("hasOlder and loadOlder come from the owner", async () => {
    let more = true;
    const loadOlder = vi.fn(async () => {});
    const { v } = viewOf([], { hasMore: () => more, loadOlder });
    expect(v.hasOlder).toBe(true);
    await v.loadOlder!();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    more = false;
    expect(v.hasOlder).toBe(false);
    expect(liveSource(new FeedState(5)).hasOlder).toBe(false);
  });
});

describe("timelineView parity with TimelineState.rows", () => {
  test("rows equal the old timeline.rows() for the same state and filter", () => {
    const { s, v } = viewOf([
      ev("a", 0, { repo_id: "r1" }),
      ev("b", 1000, { repo_id: "r1", category: "shell" }),
      ev("c", 2000, { repo_id: "r2" }),
    ]);
    const old = s.rows({ repo: "r1", category: "shell" }).map((e) => e.id);
    const view = timelineView(s, { repo: "r1" });
    expect(view.rows({ category: "shell" }).map((r) => r.event.id)).toEqual(old);
    expect(view.rows({}).map((r) => r.event.id)).toEqual(s.rows({ repo: "r1" }).map((e) => e.id));
    void v;
  });
});
