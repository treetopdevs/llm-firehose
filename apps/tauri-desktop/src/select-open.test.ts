// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { onSelectOpen } from "./select-open";

function rig(n = 3) {
  document.body.replaceChildren();
  const list = document.createElement("div");
  const rows = Array.from({ length: n }, (_, i) => {
    const r = document.createElement("div");
    r.tabIndex = 0;
    r.dataset.i = String(i);
    const inner = document.createElement("button");
    r.append(inner);
    list.append(r);
    return r;
  });
  document.body.append(list);
  const calls: string[] = [];
  rows.forEach((r, i) => onSelectOpen(r, { select: () => calls.push(`select ${i}`), open: () => calls.push(`open ${i}`) }, { self: true, siblings: () => rows }));
  return { rows, calls };
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

describe("select and open (MS-8)", () => {
  beforeEach(() => document.body.replaceChildren());

  test("a single click selects and never opens", () => {
    const { rows, calls } = rig();
    rows[1]!.click();
    expect(calls).toEqual(["select 1"]);
  });

  test("a double click opens", () => {
    const { rows, calls } = rig();
    rows[2]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(calls).toEqual(["open 2"]);
  });

  test("Enter and Space open; other keys do nothing", () => {
    const { rows, calls } = rig();
    key(rows[0]!, "Enter");
    key(rows[0]!, " ");
    key(rows[0]!, "a");
    expect(calls).toEqual(["open 0", "open 0"]);
  });

  test("arrows select the neighbour and move focus to it", () => {
    const { rows, calls } = rig();
    rows[0]!.focus();
    key(rows[0]!, "ArrowDown");
    expect(calls).toEqual(["select 1"]);
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1]!, "ArrowUp");
    expect(calls).toEqual(["select 1", "select 0"]);
    expect(document.activeElement).toBe(rows[0]);
  });

  test("arrows stop at the ends", () => {
    const { rows, calls } = rig();
    key(rows[0]!, "ArrowUp");
    key(rows[2]!, "ArrowDown");
    expect(calls).toEqual([]);
  });

  test("a click, key or double click that starts in the row's own control is not the row's", () => {
    const { rows, calls } = rig();
    const inner = rows[0]!.querySelector("button")!;
    inner.click();
    inner.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    key(inner, "Enter");
    key(inner, "ArrowDown");
    expect(calls).toEqual([]);
  });

  test("a rowselect event selects without moving focus", () => {
    const { rows, calls } = rig();
    const spy = vi.spyOn(rows[1]!, "focus");
    rows[1]!.dispatchEvent(new Event("rowselect"));
    expect(calls).toEqual(["select 1"]);
    expect(spy).not.toHaveBeenCalled();
  });
});
