// @vitest-environment happy-dom
import { describe, expect, test, vi } from "vitest";
import { el, onActivate } from "./dom";

function key(target: Element, k: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

describe("onActivate", () => {
  test("fires once on click, Enter and Space; preventDefaults key activation; ignores other keys", () => {
    const node = el("div", { tabindex: "0" });
    const h = vi.fn();
    onActivate(node, h);
    node.click();
    expect(h).toHaveBeenCalledTimes(1);
    expect(key(node, "Enter").defaultPrevented).toBe(true);
    expect(h).toHaveBeenCalledTimes(2);
    expect(key(node, " ").defaultPrevented).toBe(true);
    expect(h).toHaveBeenCalledTimes(3);
    for (const k of ["a", "Tab", "Escape", "ArrowDown"]) expect(key(node, k).defaultPrevented).toBe(false);
    expect(h).toHaveBeenCalledTimes(3);
  });

  test("{self:true} ignores events from a descendant button and fires for the node itself", () => {
    const btn = el("button", {}, "inner");
    const text = el("span", {}, "label");
    const node = el("div", { tabindex: "0" }, text, btn);
    const h = vi.fn();
    onActivate(node, h, { self: true });
    btn.click();
    expect(key(btn, "Enter").defaultPrevented).toBe(false);
    expect(key(btn, " ").defaultPrevented).toBe(false);
    expect(h).not.toHaveBeenCalled();
    node.click();
    key(node, "Enter");
    text.click();
    key(text, " ");
    expect(h).toHaveBeenCalledTimes(4);
  });

  test("{stop:true} stops click and handled keydown reaching an ancestor listener", () => {
    const node = el("div", { tabindex: "0" });
    const parent = el("div", {}, node);
    const seen = vi.fn();
    parent.addEventListener("click", seen);
    parent.addEventListener("keydown", seen);
    const h = vi.fn();
    onActivate(node, h, { stop: true });
    node.click();
    key(node, "Enter");
    key(node, " ");
    expect(h).toHaveBeenCalledTimes(3);
    expect(seen).not.toHaveBeenCalled();
    key(node, "a");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  test("default (no opts) lets events reach ancestors", () => {
    const node = el("div");
    const parent = el("div", {}, node);
    const seen = vi.fn();
    parent.addEventListener("click", seen);
    onActivate(node, () => {});
    node.click();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
