// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFeed, renderEventList } from "./feed";
import { FeedState } from "../state";
import { __resetKeysForTests, listKeys } from "../keys";
import type { FirehoseEvent } from "../api";

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
    feed.setFilter({ category: "tool" });
    panel.refresh();
    const after = rowsOf(panel.root);
    expect(after.map(keyOf)).toEqual(["a", "c"]);
    expect(document.activeElement).toBe(after[1]);
    after[1].focus();
    feed.setFilter({ category: "error" });
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
