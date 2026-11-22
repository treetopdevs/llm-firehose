// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { captureScroll, createHistory, placeKey, restoreScroll, samePlace, type Place } from "./history";

const fleet: Place = { panel: "fleet", view: "map" };
const projectA: Place = { panel: "project", view: "lanes", project: "A" };
const projectB: Place = { panel: "project", view: "lanes", project: "B" };
const session: Place = { panel: "session", view: "score", project: "A", session: { id: "s1", source: "codex" } };

describe("places", () => {
  test("a place is its panel, view and what is in scope; the range is not part of it", () => {
    expect(samePlace(projectA, { ...projectA })).toBe(true);
    expect(samePlace(projectA, projectB)).toBe(false);
    expect(samePlace(fleet, { panel: "fleet", view: "table" })).toBe(false);
    expect(samePlace(session, { ...session, session: { id: "s1", source: "claude-code" } })).toBe(false);
    expect(placeKey(projectA)).not.toBe(placeKey(projectB));
    expect(placeKey(projectA)).toBe(placeKey({ ...projectA }));
  });
});

describe("history", () => {
  test("record pushes a new place and only updates the state of the same place", () => {
    const h = createHistory<number>();
    expect(h.record(fleet, 1)).toBe(true);
    expect(h.record(fleet, 2)).toBe(false);
    expect(h.current()).toEqual({ place: fleet, state: 2 });
    expect(h.canBack()).toBe(false);
    expect(h.record(projectA, 3)).toBe(true);
    expect(h.canBack()).toBe(true);
    expect(h.canForward()).toBe(false);
  });

  test("back and forward walk the entries and return them; the ends return undefined", () => {
    const h = createHistory<number>();
    h.record(fleet, 1);
    h.record(projectA, 2);
    h.record(session, 3);
    expect(h.back()).toEqual({ place: projectA, state: 2 });
    expect(h.back()).toEqual({ place: fleet, state: 1 });
    expect(h.back()).toBeUndefined();
    expect(h.forward()).toEqual({ place: projectA, state: 2 });
    expect(h.canForward()).toBe(true);
    expect(h.forward()).toEqual({ place: session, state: 3 });
    expect(h.forward()).toBeUndefined();
  });

  test("recording a new place after going back drops the forward entries", () => {
    const h = createHistory<number>();
    h.record(fleet, 1);
    h.record(projectA, 2);
    h.record(session, 3);
    h.back();
    h.back();
    h.record(projectB, 4);
    expect(h.canForward()).toBe(false);
    expect(h.back()).toEqual({ place: fleet, state: 1 });
  });

  test("recording the place just arrived at by back does not push", () => {
    const h = createHistory<number>();
    h.record(fleet, 1);
    h.record(projectA, 2);
    h.back();
    expect(h.record(fleet, 9)).toBe(false);
    expect(h.canForward()).toBe(true);
    expect(h.current()?.state).toBe(9);
  });

  test("the stack is capped; the oldest entries fall off", () => {
    const h = createHistory<number>(3);
    for (let i = 0; i < 5; i++) h.record({ panel: "project", project: String(i) }, i);
    expect(h.back()?.state).toBe(3);
    expect(h.back()?.state).toBe(2);
    expect(h.back()).toBeUndefined();
  });

  test("scroll is remembered per place, not per entry", () => {
    const h = createHistory<number>();
    h.remember(fleet, [{ sel: ".fleet", top: 300 }]);
    h.remember(projectA, [{ sel: "", top: 40 }]);
    expect(h.recall({ ...fleet })).toEqual([{ sel: ".fleet", top: 300 }]);
    expect(h.recall(projectB)).toBeUndefined();
    h.remember(fleet, []);
    expect(h.recall(fleet)).toBeUndefined();
  });
});

// happy-dom has no layout: geometry is stubbed on the elements under test.
function box(el: Element, top: number, height = 20): void {
  (el as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) });
}
function scroller(cls: string, rows: string[]): { root: HTMLElement; list: HTMLElement } {
  const root = document.createElement("main");
  const list = document.createElement("div");
  list.className = cls;
  for (const k of rows) {
    const r = document.createElement("div");
    r.setAttribute("data-key", k);
    list.append(r);
  }
  root.append(list);
  return { root, list };
}

describe("scroll marks", () => {
  test("capture records each scrolled element by class, with the first visible keyed row and its offset", () => {
    const { root, list } = scroller("fleet other", ["a", "b", "c"]);
    list.scrollTop = 300;
    box(list, 100, 400);
    box(list.children[0], 40); // above the viewport of the list
    box(list.children[1], 92); // straddles the top edge: first visible
    box(list.children[2], 112);
    expect(captureScroll(root)).toEqual([{ sel: ".fleet", top: 300, key: "b", offset: -8 }]);
  });

  test("capture is empty when nothing is scrolled, and records the root itself with an empty selector", () => {
    const { root } = scroller("fleet", ["a"]);
    expect(captureScroll(root)).toEqual([]);
    root.scrollTop = 25;
    expect(captureScroll(root)).toEqual([{ sel: "", top: 25 }]);
  });

  test("restore scrolls the keyed row back to its offset, wherever the row now is", () => {
    const { root, list } = scroller("fleet", ["x", "a", "b"]); // a row arrived above since the capture
    list.scrollTop = 0;
    box(list, 100, 400);
    box(list.children[2], 150);
    restoreScroll(root, [{ sel: ".fleet", top: 300, key: "b", offset: -8 }], { frames: 0 });
    expect(list.scrollTop).toBe(58); // 150 - 100 - (-8)
  });

  test("without the row it falls back to the pixel position once the content is tall enough, and waits until then", () => {
    const { root, list } = scroller("fleet", []);
    let frame: (() => void) | undefined;
    const raf = (fn: () => void): number => { frame = fn; return 1; };
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 400, configurable: true });
    restoreScroll(root, [{ sel: ".fleet", top: 300, key: "gone", offset: 0 }], { frames: 5, raf });
    expect(list.scrollTop).toBe(0);
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    frame!();
    expect(list.scrollTop).toBe(300);
  });

  test("a cancelled restore does nothing more", () => {
    const { root, list } = scroller("fleet", []);
    let frame: (() => void) | undefined;
    const cancel = restoreScroll(root, [{ sel: ".fleet", top: 300 }], { frames: 5, raf: (fn) => { frame = fn; return 1; } });
    cancel();
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    frame?.();
    expect(list.scrollTop).toBe(0);
  });
});
