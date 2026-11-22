// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { isEscapeEligible, isEscapeClaimed } from "../escape";
import { createMoreMenu } from "./more-menu";

const ITEMS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];
function rig(onPick = vi.fn()) {
  document.body.replaceChildren();
  const outside = document.createElement("button");
  const menu = createMoreMenu({ label: "More views", items: ITEMS, onPick });
  document.body.append(outside, menu.root);
  return { menu, onPick, outside };
}
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};
const pop = (m: ReturnType<typeof rig>["menu"]) => m.root.querySelector<HTMLElement>(".more-pop")!;
const items = (m: ReturnType<typeof rig>["menu"]) => [...m.root.querySelectorAll<HTMLButtonElement>(".more-item")];

afterEach(() => document.body.replaceChildren());

describe("More menu", () => {
  test("is a closed menu button until opened", () => {
    const { menu } = rig();
    expect(menu.trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(menu.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(menu.trigger.textContent).toContain("More views");
    expect(pop(menu).hidden).toBe(true);
    expect(pop(menu).getAttribute("role")).toBe("menu");
    expect(items(menu).map((b) => b.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio", "menuitemradio"]);
  });

  test("click opens and focuses the first item; click again closes and returns focus", () => {
    const { menu } = rig();
    menu.trigger.click();
    expect(menu.isOpen()).toBe(true);
    expect(menu.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items(menu)[0]);
    menu.trigger.click();
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(menu.trigger);
  });

  test("ArrowDown on the trigger opens on the first item, ArrowUp on the last", () => {
    const { menu } = rig();
    key(menu.trigger, "ArrowDown");
    expect(document.activeElement).toBe(items(menu)[0]);
    menu.close();
    key(menu.trigger, "ArrowUp");
    expect(document.activeElement).toBe(items(menu)[2]);
  });

  test("arrows wrap, Home and End jump", () => {
    const { menu } = rig();
    menu.trigger.click();
    const [a, b, c] = items(menu);
    key(a!, "ArrowDown");
    expect(document.activeElement).toBe(b);
    key(b!, "End");
    expect(document.activeElement).toBe(c);
    key(c!, "ArrowDown");
    expect(document.activeElement).toBe(a);
    key(a!, "ArrowUp");
    expect(document.activeElement).toBe(c);
    key(c!, "Home");
    expect(document.activeElement).toBe(a);
  });

  test("choosing an item reports it, closes the menu and returns focus to the trigger", () => {
    const { menu, onPick } = rig();
    menu.trigger.click();
    items(menu)[1]!.click();
    expect(onPick).toHaveBeenCalledWith("b");
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(menu.trigger);
  });

  test("Escape closes, returns focus, and is claimed so nothing else ascends on it", () => {
    const { menu } = rig();
    menu.trigger.click();
    expect(isEscapeEligible(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    const e = key(items(menu)[1]!, "Escape");
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(menu.trigger);
    expect(isEscapeClaimed(e)).toBe(true);
    expect(isEscapeEligible(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
  });

  test("Escape with the menu closed is left alone", () => {
    const { menu } = rig();
    const e = key(menu.trigger, "Escape");
    expect(isEscapeClaimed(e)).toBe(false);
  });

  test("Tab closes without stealing focus; a press outside closes", () => {
    const { menu, outside } = rig();
    menu.trigger.click();
    const e = key(items(menu)[0]!, "Tab");
    expect(menu.isOpen()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    menu.trigger.click();
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.isOpen()).toBe(false);
  });

  test("the current view marks its item and shows on the trigger", () => {
    const { menu } = rig();
    menu.setCurrent("b");
    expect(items(menu).map((x) => x.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(menu.trigger.textContent).toContain("Beta");
    expect(menu.trigger.classList.contains("current")).toBe(true);
    menu.setCurrent(undefined);
    expect(menu.trigger.textContent).toContain("More views");
    expect(menu.trigger.classList.contains("current")).toBe(false);
    expect(items(menu).every((x) => x.getAttribute("aria-checked") === "false")).toBe(true);
  });

  test("opening focuses the current item", () => {
    const { menu } = rig();
    menu.setCurrent("c");
    menu.trigger.click();
    expect(document.activeElement).toBe(items(menu)[2]);
  });

  test("item attributes come from the caller", () => {
    document.body.replaceChildren();
    const menu = createMoreMenu({ label: "More", items: ITEMS, onPick: () => {}, itemAttrs: (id) => ({ id: `view-${id}`, "data-view": id }) });
    document.body.append(menu.root);
    expect(menu.items.get("a")!.id).toBe("view-a");
    expect(menu.items.get("a")!.getAttribute("data-view")).toBe("a");
  });
});
