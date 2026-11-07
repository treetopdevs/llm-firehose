// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { createToolbar, type SearchResult, type ToolbarHandlers } from "./toolbar";

afterEach(() => document.body.replaceChildren());

const hit: SearchResult = { kind: "workspace", id: "w1", title: "wt-1", detail: "main" };
/** Mount a toolbar with spy handlers and type a query, so one result is listed. */
function mount() {
  const h: ToolbarHandlers = {
    selectRepo: vi.fn(),
    setTab: vi.fn(),
    fit: vi.fn(),
    all: vi.fn(),
    search: vi.fn(() => [hit]),
    pick: vi.fn(),
    register: vi.fn(async () => {}),
    refresh: vi.fn(),
  };
  const bar = createToolbar(h);
  document.body.append(bar.root);
  const input = bar.root.querySelector<HTMLInputElement>(".graph-search-input")!;
  input.focus();
  input.value = "wt";
  input.dispatchEvent(new Event("input"));
  return { h, bar, input };
}

// The camera pans only for a pointer pick; a keyboard pick lands in one frame.
test("clicking a search result picks it as a pointer action", () => {
  const { h, bar } = mount();
  bar.root.querySelector<HTMLElement>(".graph-search-option")!.dispatchEvent(new MouseEvent("click", { detail: 1 }));
  expect(h.pick).toHaveBeenCalledWith(hit, "pointer");
});

test("Enter on a search result picks it as a keyboard action", () => {
  const { h, input } = mount();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  expect(h.pick).toHaveBeenCalledWith(hit, "keyboard");
});
