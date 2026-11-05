// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createEventList, renderEventRows } from "./index";
import { liveSource, timelineView, type EventSource } from "./model";
import { FeedState } from "../../state";
import { TimelineState } from "../graph/model";
import { __resetKeysForTests, listKeys } from "../../keys";
import type { FirehoseEvent } from "../../api";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const ev = (id: string, ms: number, over: Record<string, unknown> = {}): FirehoseEvent =>
  ({ id, time: new Date(T0 + ms).toISOString(), source: "claude-code", category: "tool", summary: `ev ${id}`, session_id: "s", ...over }) as FirehoseEvent;
const press = (n: Element, key: string) => {
  const e = new KeyboardEvent("keydown", { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true });
  n.dispatchEvent(e);
  return e;
};
const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".feed-row")];
const keyOf = (n: Element) => n.getAttribute("data-key");


// Cases moved from the deleted ui/feed.ts: the shared list over the live ring.
function createFeed(feed: FeedState, onSelect: (ev: FirehoseEvent) => void, opts: { heading?: string | false; window?: () => { from?: number; to?: number } | undefined; resetWindow?: () => void } = {}) {
  const list = createEventList(liveSource(feed, { renderLimit: 1000 }), { onSelect, ...opts });
  return { root: list.root, refresh: list.refresh, setFilter: list.setFilter };
}
const renderEventList = renderEventRows;

interface Harness {
  name: string;
  make(events: FirehoseEvent[], o?: { loadOlder?: () => Promise<void>; hasMore?: boolean; notice?: string; pausable?: boolean; cap?: number }): { source: EventSource; push(e: FirehoseEvent): void; drop(id: string): void };
}
const live: Harness = {
  name: "live",
  make(events, o = {}) {
    const f = new FeedState(o.cap ?? 100);
    for (const e of events) f.push(e);
    return { source: liveSource(f), push: (e) => f.push(e), drop: () => {} };
  },
};
const timeline: Harness = {
  name: "timeline",
  make(events, o = {}) {
    const s = new TimelineState(o.cap);
    s.merge(events);
    return {
      source: timelineView(s, { hasMore: o.hasMore, loadOlder: o.loadOlder, notice: () => o.notice ?? "", pausable: o.pausable }),
      push: (e) => s.merge([e]),
      drop: () => {},
    };
  },
};

beforeEach(() => __resetKeysForTests());
afterEach(() => {
  document.body.replaceChildren();
  __resetKeysForTests();
});

function mount(source: EventSource, onSelect: (e: FirehoseEvent) => void = () => {}, extra: Partial<Parameters<typeof createEventList>[1]> = {}) {
  const list = createEventList(source, { onSelect, ...extra });
  document.body.append(list.root);
  list.refresh();
  return list;
}

describe.each([live, timeline])("event list over $name", (h) => {
  test("renders role=button rows with data-key and exactly one tab stop; Enter and Space select without pausing", () => {
    const { source } = h.make([ev("a", 0), ev("b", 1000)]);
    const onSelect = vi.fn();
    const list = mount(source, onSelect);
    expect(list.root.getAttribute("data-component")).toBe("event-list");
    const rows = rowsOf(list.root);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.getAttribute("role") === "button" && keyOf(r))).toBe(true);
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    rows[0].focus();
    press(rows[0], "Enter");
    press(rows[0], " ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(source.paused).toBe(false);
  });

  test("roving Up/Down/Home/End moves the stop and focus", () => {
    const { source } = h.make([ev("a", 0), ev("b", 1000), ev("c", 2000)]);
    const list = mount(source);
    const rows = rowsOf(list.root);
    rows[1].focus();
    press(rows[1], "Home");
    expect(document.activeElement).toBe(rows[0]);
    press(rows[0], "End");
    expect(document.activeElement).toBe(rows[2]);
    press(rows[2], "ArrowUp");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows.filter((r) => r.getAttribute("tabindex") === "0")).toEqual([rows[1]]);
  });

  test("focus survives a filter that removes the focused row and a pushed event", () => {
    const { source, push } = h.make([ev("a", 0), ev("b", 1000, { category: "shell" }), ev("c", 2000)]);
    const list = mount(source);
    rowsOf(list.root)[0].focus();
    const focused = document.activeElement as HTMLElement;
    push(ev("d", 3000));
    list.refresh();
    expect(document.activeElement).toBe(rowsOf(list.root).find((r) => keyOf(r) === keyOf(focused)));
    list.setFilter({ category: "shell" });
    expect(rowsOf(list.root).map(keyOf)).toEqual(["b"]);
    expect(document.activeElement).not.toBe(document.body);
    list.setFilter({ category: "error" });
    expect(document.activeElement).toBe(list.root.querySelector(".feed-rows"));
  });

  test("a focused row evicted by the owner's cap falls to the nearest surviving row, never body", () => {
    const { source, push } = h.make([ev("a", 0), ev("b", 1000), ev("c", 2000)], { cap: 3 });
    const list = mount(source);
    rowsOf(list.root).find((r) => keyOf(r) === "a")!.focus();
    push(ev("d", 3000)); // evicts the oldest, "a"
    list.refresh();
    const after = rowsOf(list.root);
    expect(after.map(keyOf).sort()).toEqual(["b", "c", "d"]);
    expect(document.activeElement).toBe(after.find((r) => keyOf(r) === "b"));
    expect(after.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  test("selected key highlights its row", () => {
    const { source } = h.make([ev("a", 0), ev("b", 1000)]);
    const list = mount(source, () => {}, { selectedKey: () => "b" });
    const sel = rowsOf(list.root).filter((r) => r.classList.contains("selected"));
    expect(sel.map(keyOf)).toEqual(["b"]);
  });

  test("rowAction is a sibling button; Enter on it does not select", () => {
    const { source } = h.make([ev("a", 0)]);
    const onSelect = vi.fn();
    const run = vi.fn();
    const list = mount(source, onSelect, { rowAction: () => ({ label: "Show in Graph", run }) });
    const row = rowsOf(list.root)[0];
    const btn = list.root.querySelector<HTMLButtonElement>(".feed-row-action")!;
    expect(row.contains(btn)).toBe(false);
    expect(btn.parentElement).toBe(row.parentElement);
    btn.focus();
    press(btn, "Enter");
    btn.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    list.refresh();
    expect(document.activeElement).toBe(list.root.querySelector(".feed-row-action"));
  });

  test("Load older only when hasOlder; a notice is a status region", async () => {
    const loadOlder = vi.fn(() => Promise.resolve());
    const none = mount(h.make([ev("a", 0)]).source);
    expect(none.root.textContent).not.toContain("Load older");
    document.body.replaceChildren();
    const { source } = h.make([ev("a", 0)], { hasMore: true, loadOlder, notice: "Capture gaps reported" });
    const list = mount(source);
    if (h.name === "timeline") {
      list.root.querySelector<HTMLButtonElement>(".feed-older")!.click();
      expect(loadOlder).toHaveBeenCalledTimes(1);
      const status = [...list.root.querySelectorAll('[role="status"]')].find((n) => n.textContent === "Capture gaps reported");
      expect(status).toBeTruthy();
    } else {
      expect(list.root.querySelector(".feed-older")).toBeNull();
    }
  });

  test("a retained window shows a note with Return to live", () => {
    const { source } = h.make([ev("old", -3_600_000), ev("in", 0), ev("new", 3_600_000)]);
    let range: { from?: number; to?: number } | undefined = { from: T0 - 60_000, to: T0 + 60_000 };
    const reset = vi.fn(() => { range = undefined; });
    const list = mount(source, () => {}, { window: () => range, resetWindow: reset });
    expect(rowsOf(list.root).map(keyOf)).toEqual(["in"]);
    list.root.querySelector<HTMLButtonElement>(".feed-window-live")!.click();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(rowsOf(list.root)).toHaveLength(3);
    expect(list.root.querySelector<HTMLElement>(".feed-window")!.hidden).toBe(true);
  });
});

describe("pausable", () => {
  test("pausable false: no pause control, Space does nothing and is not claimed", () => {
    const { source } = timeline.make([ev("a", 0)], { pausable: false });
    const list = mount(source);
    expect(list.root.querySelector("button.pause")).toBeNull();
    expect(listKeys().filter((r) => r.scope === "events")).toEqual([]);
    expect(press(list.root.querySelector(".feed-rows")!, " ").defaultPrevented).toBe(false);
    expect(source.paused).toBe(false);
  });

  test.each([live, timeline])("pausable true over $name: Space on the rows container or page pauses; not from siblings or fields", (h) => {
    const { source } = h.make([ev("a", 0)], { pausable: true });
    const list = mount(source);
    const box = list.root.querySelector<HTMLElement>(".feed-rows")!;
    press(box, " ");
    expect(source.paused).toBe(true);
    press(document.body, " ");
    expect(source.paused).toBe(false);
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(press(outside, " ").defaultPrevented).toBe(false);
    for (const sel of ["input", "select", "button"]) press(list.root.querySelector(sel)!, " ");
    const ta = document.createElement("textarea");
    list.root.append(ta);
    press(ta, " ");
    expect(source.paused).toBe(false);
    const row = rowsOf(list.root)[0];
    press(row, " ");
    expect(source.paused).toBe(false);
  });
});

describe("scroll and render rules", () => {
  const scrollable = (list: { root: HTMLElement }, top: number, height: number, client: number) => {
    const box = list.root.querySelector<HTMLElement>(".feed-rows")!;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => client });
    box.scrollTop = top;
    return box;
  };

  test("oldest-first live follows the bottom when already there", () => {
    const { source, push } = live.make([ev("a", 0)]);
    const list = mount(source);
    const box = scrollable(list, 100, 200, 100);
    push(ev("b", 1000));
    list.refresh();
    expect(box.scrollTop).toBe(200);
  });

  test("newest-first timeline never follows the bottom and loadOlder keeps the scroll anchor", async () => {
    const s = new TimelineState();
    s.merge([ev("a", 0), ev("b", 1000)]);
    let list!: ReturnType<typeof createEventList>;
    const loadOlder = vi.fn(async () => { s.merge([ev("z", -5000)]); });
    const source = timelineView(s, { hasMore: true, loadOlder });
    list = mount(source);
    const box = scrollable(list, 40, 100, 100);
    list.refresh();
    expect(box.scrollTop).toBe(40);
    list.root.querySelector<HTMLButtonElement>(".feed-older")!.click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(rowsOf(list.root).map(keyOf)).toEqual(["b", "a", "z"]);
    expect(box.scrollTop).toBe(40);
  });

  test("renderLimit applies to live only when set; the timeline renders what its owner supplies", () => {
    const feed = new FeedState(5000);
    for (let i = 0; i < 1200; i++) feed.push(ev(`e${i}`, i * 1000));
    const list = mount(liveSource(feed, { renderLimit: 1000 }));
    expect(rowsOf(list.root)).toHaveLength(1000);
    expect(keyOf(rowsOf(list.root)[999])).toBe("e1199");
    const s = new TimelineState();
    s.merge(Array.from({ length: 600 }, (_, i) => ev(`t${i}`, i * 1000)));
    document.body.replaceChildren();
    expect(rowsOf(mount(timelineView(s)).root)).toHaveLength(600);
  });
});

describe("coalesce", () => {
  test("focus and selection survive a coalesce replacement keyed by the logical row", () => {
    const feed = new FeedState(100);
    const hook = ev("hook-1", 0, { turn_id: "t", call_id: "c", payload: { phase: "post", tool_name: "Bash" } });
    const roll = ev("rollout-1", 1000, { source: "codex", turn_id: "t", call_id: "c", payload: { phase: "post", tool_name: "Bash" } });
    feed.push(hook);
    const list = mount(liveSource(feed), () => {}, { selectedKey: () => "hook-1" });
    rowsOf(list.root)[0].focus();
    feed.push(roll);
    list.refresh();
    const now = rowsOf(list.root);
    expect(now.map(keyOf)).toEqual(["hook-1"]);
    expect(now[0].querySelector(".summary")!.textContent).toMatch(/×2/);
    expect(now[0].classList.contains("selected")).toBe(true);
    expect(document.activeElement).toBe(now[0]);
  });
});

describe("key ownership", () => {
  test("owner-checked unregister: A on, B on, A off, B still works; repeated renders add no listeners", () => {
    const a = live.make([ev("a", 0)]).source;
    const b = live.make([ev("b", 0)]).source;
    const A = createEventList(a, { onSelect: () => {} });
    document.body.append(A.root);
    A.activate();
    const B = createEventList(b, { onSelect: () => {} });
    document.body.append(B.root);
    B.activate();
    A.deactivate();
    expect(listKeys().filter((r) => r.scope === "events")).toHaveLength(1);
    for (let i = 0; i < 5; i++) { B.refresh(); B.activate(); }
    expect(listKeys().filter((r) => r.scope === "events")).toHaveLength(1);
    press(document.body, " ");
    expect(b.paused).toBe(true);
    expect(a.paused).toBe(false);
    B.deactivate();
    expect(listKeys().filter((r) => r.scope === "events")).toEqual([]);
  });
});

describe("renderEventRows", () => {
  test("renders compact coalesced rows into a caller-owned container", () => {
    const box = document.createElement("div");
    document.body.append(box);
    const pick = vi.fn();
    renderEventRows(box, [ev("x", 0), ev("y", 1000)], pick);
    const rows = rowsOf(box);
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".cell.source")).toBeNull();
    press(rows[1], "Enter");
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: "y" }));
  });
});

describe("moved from feed.test.ts", () => {

describe("feed rows", () => {
  test("label the workspace with what privacy allows and keep the full path in the title", () => {
    const feed = new FeedState(10);
    const digest = "aa43f1ff4abc3b9ab1e0a477140f68ea761e0384110aa530c6de08642f762655";
    feed.push({ id: "e1", time: new Date().toISOString(), source: "claude-code", category: "tool", summary: "ran Read", cwd: digest } as FirehoseEvent);
    feed.push({ id: "e2", time: new Date().toISOString(), source: "codex", category: "shell", summary: "ran ls", cwd: "/home/me/dev/app" } as FirehoseEvent);
    const panel = createFeed(feed, () => {});
    panel.refresh();
    const cwds = [...panel.root.querySelectorAll<HTMLElement>(".cell.cwd")];
    expect(cwds.map((c) => c.textContent)).toEqual(["aa43f1ff", "…/dev/app"]);
    expect(cwds[0].title).toBe(digest);
  });
});

describe("feed window", () => {
  test("a retained historical window hides rows outside it and offers a way back to live", () => {
    const feed = new FeedState(10);
    const t = (ms: number) => new Date(Date.parse("2026-11-01T12:00:00Z") + ms).toISOString();
    for (const [id, ms] of [["old", -3_600_000], ["in", 0], ["new", 3_600_000]] as const) feed.push({ id, time: t(ms), source: "codex", category: "tool", summary: id } as FirehoseEvent);
    let range: { from?: number; to?: number } | undefined = { from: Date.parse(t(-60_000)), to: Date.parse(t(60_000)) };
    const reset = vi.fn(() => { range = undefined; });
    const panel = createFeed(feed, () => {}, { window: () => range, resetWindow: reset });
    panel.refresh();
    expect([...panel.root.querySelectorAll(".feed-row .summary")].map((n) => n.textContent)).toEqual(["in"]);
    expect(panel.root.querySelector<HTMLElement>(".feed-window")!.hidden).toBe(false);
    panel.root.querySelector<HTMLButtonElement>(".feed-window-live")!.click();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(panel.root.querySelectorAll(".feed-row")).toHaveLength(3);
    expect(panel.root.querySelector<HTMLElement>(".feed-window")!.hidden).toBe(true);
  });
});

describe("feed heading", () => {
  test("opens with an h2 equal to the nav label", () => {
    const panel = createFeed(new FeedState(10), () => {});
    expect(panel.root.firstElementChild?.tagName).toBe("H2");
    expect(panel.root.firstElementChild?.textContent).toBe("Events");
  });

  test("heading:false renders no h2; a custom heading is used", () => {
    const hidden = createFeed(new FeedState(10), () => {}, { heading: false });
    expect(hidden.root.querySelector("h2")).toBeNull();
    const custom = createFeed(new FeedState(10), () => {}, { heading: "Stream" });
    expect(custom.root.querySelector("h2")?.textContent).toBe("Stream");
  });
});

const T0 = Date.parse("2026-11-01T12:00:00Z");
const mk = (id: string, over: Record<string, unknown> = {}): FirehoseEvent =>
  ({ id, time: new Date(T0 + Object.keys(over).length).toISOString(), source: "claude-code", category: "tool", summary: `ev ${id}`, ...over }) as FirehoseEvent;
/** A hook observation and the rollout observation of the same tool call (same correlation key). */
const hook = (): FirehoseEvent =>
  mk("hook-1", { session_id: "s", turn_id: "t", call_id: "c", payload: { phase: "post", tool_name: "Bash" }, time: new Date(T0).toISOString() });
const rollout = (): FirehoseEvent =>
  mk("rollout-1", { session_id: "s", turn_id: "t", call_id: "c", payload: { phase: "post", tool_name: "Bash" }, time: new Date(T0 + 1000).toISOString(), source: "codex" });

const press = (n: Element, key: string, code?: string) => {
  const e = new KeyboardEvent("keydown", { key, code: code ?? (key === " " ? "Space" : key), bubbles: true, cancelable: true });
  n.dispatchEvent(e);
  return e;
};
const rowsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".feed-row")];
const keyOf = (n: Element) => n.getAttribute("data-key");

beforeEach(() => __resetKeysForTests());
afterEach(() => {
  document.body.replaceChildren();
  __resetKeysForTests();
});

function mount(events: FirehoseEvent[], onSelect: (ev: FirehoseEvent) => void = () => {}) {
  const feed = new FeedState(100);
  for (const e of events) feed.push(e);
  const panel = createFeed(feed, onSelect);
  document.body.append(panel.root);
  panel.refresh();
  return { feed, panel };
}

describe("feed rows are keyboard operable", () => {
  test("Enter and Space on a focused row call onSelect once each (createFeed and renderEventList); role=button with a name", () => {
    const onSelect = vi.fn();
    const { panel } = mount([mk("a"), mk("b")], onSelect);
    const row = rowsOf(panel.root)[0];
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-label")).toMatch(/ev a/);
    row.focus();
    press(row, "Enter");
    expect(onSelect).toHaveBeenCalledTimes(1);
    press(row, " ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    row.click();
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));

    const box = document.createElement("div");
    document.body.append(box);
    const pick = vi.fn();
    renderEventList(box, [mk("x"), mk("y")], pick);
    const r = rowsOf(box)[1];
    expect(r.getAttribute("role")).toBe("button");
    expect(r.getAttribute("aria-label")).toMatch(/ev y/);
    press(r, "Enter");
    press(r, " ");
    expect(pick).toHaveBeenCalledTimes(2);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ id: "y" }));
  });

  test("the rows container is a labelled tab stop", () => {
    const { panel } = mount([mk("a")]);
    const box = panel.root.querySelector(".feed-rows")!;
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("aria-label")).toBe("Events");
  });

  test("roving tabindex: exactly one tab stop; arrows move it and focus", () => {
    const { panel } = mount([mk("a"), mk("b"), mk("c")]);
    const stops = () => rowsOf(panel.root).filter((r) => r.getAttribute("tabindex") === "0");
    expect(stops()).toHaveLength(1);
    const rows = rowsOf(panel.root);
    rows[1].focus();
    expect(stops()).toEqual([rows[1]]);
    const up = press(rows[1], "ArrowUp");
    expect(up.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows[0]);
    expect(stops()).toEqual([rows[0]]);
    press(rows[0], "ArrowDown");
    press(rows[1], "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
    expect(stops()).toEqual([rows[2]]);
    press(rows[2], "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
  });
});

describe("Space pauses the feed only from the page or the feed", () => {
  test("Space on a focused row selects and does not pause", () => {
    const onSelect = vi.fn();
    const { feed, panel } = mount([mk("a")], onSelect);
    const row = rowsOf(panel.root)[0];
    row.focus();
    press(row, " ");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(feed.paused).toBe(false);
  });

  test("Space on .feed-rows or body pauses then resumes; e.key and e.code both count", () => {
    const { feed, panel } = mount([mk("a")]);
    const box = panel.root.querySelector<HTMLElement>(".feed-rows")!;
    press(box, " ");
    expect(feed.paused).toBe(true);
    press(document.body, " ");
    expect(feed.paused).toBe(false);
    // key only, and code only
    box.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(feed.paused).toBe(true);
    box.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }));
    expect(feed.paused).toBe(false);
  });

  test("Space from a sibling outside the feed, or on INPUT/SELECT/TEXTAREA/BUTTON, does not pause", () => {
    const { feed, panel } = mount([mk("a")]);
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(press(outside, " ").defaultPrevented).toBe(false);
    expect(feed.paused).toBe(false);
    for (const sel of ["input", "select", "button"]) {
      press(panel.root.querySelector(sel)!, " ");
      expect(feed.paused).toBe(false);
    }
    const ta = document.createElement("textarea");
    panel.root.append(ta);
    press(ta, " ");
    expect(feed.paused).toBe(false);
  });
});

describe("feed focus survives a rebuild", () => {
  test("coalescing keeps the logical row key: focus stays, count increments, one tab stop", () => {
    const feed = new FeedState(100);
    feed.push(mk("before"));
    feed.push(hook());
    feed.push(mk("after"));
    const panel = createFeed(feed, () => {});
    document.body.append(panel.root);
    panel.refresh();
    const target = rowsOf(panel.root).find((r) => /hook-1/.test(keyOf(r) ?? ""))!;
    expect(target).toBeTruthy();
    expect(feed.rows().find((r) => r.event.id === "hook-1")!.key).toBe("hook-1");
    target.focus();
    expect(document.activeElement).toBe(target);
    feed.push(rollout());
    panel.refresh();
    const rows = feed.rows();
    const merged = rows.find((r) => r.count > 1)!;
    expect(merged.event.id).toBe("rollout-1");
    expect(merged.key).toBe("hook-1");
    const now = rowsOf(panel.root).find((r) => keyOf(r) === "hook-1")!;
    expect(document.activeElement).toBe(now);
    expect(now.querySelector(".summary")!.textContent).toMatch(/×2/);
    expect(rowsOf(panel.root).filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(now.getAttribute("tabindex")).toBe("0");
  });

  test("a focused row that is filtered out hands focus to the nearest survivor, else the container, never body", () => {
    const { feed, panel } = mount([
      mk("a", { category: "tool" }),
      mk("b", { category: "shell" }),
      mk("c", { category: "tool" }),
    ]);
    const rows = rowsOf(panel.root);
    rows[1].focus();
    panel.setFilter({ category: "tool" });
    panel.refresh();
    const after = rowsOf(panel.root);
    expect(after.map(keyOf)).toEqual(["a", "c"]);
    expect(document.activeElement).toBe(after[1]);
    after[1].focus();
    panel.setFilter({ category: "error" });
    panel.refresh();
    expect(rowsOf(panel.root)).toHaveLength(0);
    expect(document.activeElement).toBe(panel.root.querySelector(".feed-rows"));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("a focused row evicted from the buffer falls to the nearest surviving row", () => {
    const feed = new FeedState(3);
    for (const id of ["a", "b", "c"]) feed.push(mk(id));
    const panel = createFeed(feed, () => {});
    document.body.append(panel.root);
    panel.refresh();
    rowsOf(panel.root)[0].focus();
    feed.push(mk("d"));
    panel.refresh();
    expect(rowsOf(panel.root).map(keyOf)).toEqual(["b", "c", "d"]);
    expect(document.activeElement).toBe(rowsOf(panel.root)[0]);
  });
});

describe("Space goes through the shared key map", () => {
  test("the events-scope binding is listed and fires only while the feed root is connected", () => {
    const feed = new FeedState(10);
    const panel = createFeed(feed, () => {});
    // Not mounted yet: not listed, and Space does nothing.
    expect(listKeys().filter((r) => r.scope === "events")).toEqual([]);
    expect(press(document.body, " ").defaultPrevented).toBe(false);
    expect(feed.paused).toBe(false);
    document.body.append(panel.root);
    expect(listKeys().filter((r) => r.scope === "events")).toEqual([{ scope: "events", display: "Space", label: "pause or resume the feed" }]);
    expect(press(document.body, " ").defaultPrevented).toBe(true);
    expect(feed.paused).toBe(true);
    panel.root.remove();
    expect(listKeys().filter((r) => r.scope === "events")).toEqual([]);
    press(document.body, " ");
    expect(feed.paused).toBe(true);
  });

  test("a guard that bails returns false so the key falls through to later bindings", () => {
    const feed = new FeedState(10);
    const panel = createFeed(feed, () => {});
    document.body.append(panel.root);
    const outside = document.createElement("div");
    document.body.append(outside);
    const e = press(outside, " ");
    expect(e.defaultPrevented).toBe(false);
    expect(feed.paused).toBe(false);
  });
});

});

describe("search debounce", () => {
  afterEach(() => vi.useRealTimers());

  test("typing filters locally at once but asks the owner to refetch once, after a pause; selects stay immediate", () => {
    vi.useFakeTimers();
    const { source } = timeline.make([ev("a", 0, { summary: "alpha" }), ev("b", 1000, { summary: "beta" })]);
    const setQuery = vi.spyOn(source, "setQuery");
    const list = mount(source);
    const input = list.root.querySelector<HTMLInputElement>("input[type=search]")!;
    for (const text of ["b", "be", "bet"]) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      vi.advanceTimersByTime(100);
    }
    expect(setQuery).not.toHaveBeenCalled();
    expect(rowsOf(list.root).map(keyOf)).toEqual(["b"]);
    vi.advanceTimersByTime(250);
    expect(setQuery).toHaveBeenCalledTimes(1);
    expect(setQuery).toHaveBeenLastCalledWith(expect.objectContaining({ text: "bet" }));
    const cat = list.root.querySelector<HTMLSelectElement>("select[title='category filter']")!;
    cat.value = "tool";
    cat.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setQuery).toHaveBeenCalledTimes(2);
    expect(setQuery).toHaveBeenLastCalledWith(expect.objectContaining({ text: "bet", category: "tool" }));
  });

  test("the filter controls carry data-key so a host rebuild can restore focus", () => {
    const { source } = live.make([ev("a", 0)]);
    const list = mount(source);
    for (const sel of ["input[type=search]", "select[title='category filter']", "select[title='source filter']"]) {
      expect(list.root.querySelector(sel)!.getAttribute("data-key")).toBeTruthy();
    }
  });
});

describe("programmatic filters", () => {
  test("setFilter shows a session the source does not list yet, and keeps it across refresh", () => {
    const { source } = timeline.make([ev("a", 0)]);
    const list = createEventList(source, { onSelect: () => {}, sessionLabel: (r) => r });
    document.body.append(list.root);
    list.setFilter({ session: "claude-code\0later" });
    const sel = list.root.querySelector<HTMLSelectElement>("select[title='session filter']")!;
    expect(sel.value).toBe("claude-code\0later");
    list.refresh();
    expect(sel.value).toBe("claude-code\0later");
  });

  test("pending() reports an edit inside the debounce and clears once it fires", () => {
    vi.useFakeTimers();
    try {
      const { source } = timeline.make([ev("a", 0)]);
      const list = createEventList(source, { onSelect: () => {} });
      const input = list.root.querySelector<HTMLInputElement>("input[type=search]")!;
      expect(list.pending()).toBeUndefined();
      input.value = "x";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(list.pending()).toMatchObject({ text: "x" });
      vi.advanceTimersByTime(300);
      expect(list.pending()).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
