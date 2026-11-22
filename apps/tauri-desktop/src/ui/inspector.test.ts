// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderDetail } from "./detail";
import { inspectorShowing, renderInspector } from "./inspector";
import type { Inspected } from "./inspector";

const subject = (over: Partial<Inspected> = {}): Inspected => ({
  kind: "session",
  key: "k1",
  title: "Fix the sample parser",
  status: { word: "needs you", mark: "?" },
  facts: [
    { label: "agent", value: "claude" },
    { label: "events", value: "42" },
  ],
  id: { label: "session id", value: "sess-1234" },
  open: { label: "Open session", run: vi.fn() },
  ...over,
});
const pane = () => {
  document.body.replaceChildren();
  const p = document.createElement("aside");
  p.className = "detail";
  document.body.append(p);
  return p;
};
afterEach(() => document.body.replaceChildren());

describe("inspector (MS-8)", () => {
  test("a selection fills the pane: kind, title, status in words, facts", () => {
    const p = pane();
    renderInspector(p, subject(), { onClose: vi.fn() });
    expect(p.classList.contains("open")).toBe(true);
    expect(p.getAttribute("data-inspector")).toBe("session");
    expect(p.querySelector(".inspector-kind")!.textContent).toBe("Session");
    expect(p.querySelector("h2")!.textContent).toBe("Fix the sample parser");
    expect(p.querySelector(".inspector-status")!.textContent).toBe("? needs you");
    expect([...p.querySelectorAll(".inspector-facts dt")].map((d) => d.textContent)).toEqual(["agent", "events"]);
    expect(inspectorShowing(p)).toBe(true);
  });

  test("selecting never takes focus, so arrow keys keep walking the list", () => {
    const p = pane();
    const row = document.createElement("button");
    document.body.append(row);
    row.focus();
    renderInspector(p, subject(), { onClose: vi.fn() });
    expect(document.activeElement).toBe(row);
  });

  test("an unknown status is drawn as unknown with its reason, never as idle", () => {
    const p = pane();
    renderInspector(p, subject({ status: { word: "unknown", mark: "◌", reason: "no activity time captured" } }), { onClose: vi.fn() });
    const st = p.querySelector(".inspector-status")!;
    expect(st.textContent).toBe("◌ unknown");
    expect(st.classList.contains("unknown")).toBe(true);
    expect(p.querySelector(".inspector-reason")!.textContent).toBe("no activity time captured");
    expect(p.textContent).not.toMatch(/idle/);
  });

  test("a fact with no value is shown as unknown, not left out or invented", () => {
    const p = pane();
    renderInspector(p, subject({ facts: [{ label: "started", value: undefined }] }), { onClose: vi.fn() });
    expect(p.querySelector(".inspector-facts dd")!.textContent).toBe("unknown");
    expect(p.querySelector(".inspector-facts dd")!.classList.contains("unknown")).toBe(true);
  });

  test("Open is the one primary button and runs the callback", () => {
    const p = pane();
    const s = subject();
    renderInspector(p, s, { onClose: vi.fn() });
    const open = p.querySelector<HTMLButtonElement>(".inspector-open")!;
    expect(open.textContent).toBe("Open session");
    expect(p.querySelectorAll(".primary")).toHaveLength(1);
    open.click();
    expect(s.open.run).toHaveBeenCalledTimes(1);
  });

  test("the id is a copyable field", async () => {
    const p = pane();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderInspector(p, subject(), { onClose: vi.fn() });
    expect(p.querySelector(".inspector-id-value")!.textContent).toBe("sess-1234");
    const copy = p.querySelector<HTMLButtonElement>(".inspector-copy")!;
    expect(copy.getAttribute("aria-label")).toBe("Copy session id");
    copy.click();
    expect(writeText).toHaveBeenCalledWith("sess-1234");
    await Promise.resolve();
    await Promise.resolve();
    expect(copy.textContent).toBe("Copied");
  });

  test("Actions opens the row's actions menu from the button, returning focus to it", () => {
    const p = pane();
    const openMenu = vi.fn();
    const actions = [{ id: "a", label: "Copy resume command", request: { type: "copy" as const, text: "x" } }];
    renderInspector(p, subject({ actions }), { onClose: vi.fn(), menu: { openMenu } });
    const btn = p.querySelector<HTMLButtonElement>(".inspector-actions")!;
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    btn.click();
    expect(openMenu).toHaveBeenCalledWith(actions, btn, { returnFocus: btn });
  });

  test("no actions, no Actions button", () => {
    const p = pane();
    renderInspector(p, subject(), { onClose: vi.fn(), menu: { openMenu: vi.fn() } });
    expect(p.querySelector(".inspector-actions")).toBeNull();
  });

  test("close runs the callback; null closes the pane and empties it", () => {
    const p = pane();
    const onClose = vi.fn();
    renderInspector(p, subject(), { onClose });
    p.querySelector<HTMLButtonElement>(".detail-close")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    renderInspector(p, null, { onClose });
    expect(p.classList.contains("open")).toBe(false);
    expect(p.childElementCount).toBe(0);
    expect(inspectorShowing(p)).toBe(false);
  });

  test("replacing the selection replaces the pane; an event detail takes it over cleanly", () => {
    const p = pane();
    renderInspector(p, subject({ title: "One" }), { onClose: vi.fn() });
    renderInspector(p, subject({ title: "Two" }), { onClose: vi.fn() });
    expect(p.querySelectorAll("h2")).toHaveLength(1);
    expect(p.querySelector("h2")!.textContent).toBe("Two");
    renderDetail(p, { id: "e", time: "2026-01-01T00:00:00Z", source: "s", category: "tool", summary: "an event" } as never, () => {});
    expect(inspectorShowing(p)).toBe(false);
  });
});
