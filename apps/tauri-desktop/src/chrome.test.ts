// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createSidebar, createToolbar } from "./chrome";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const body = (selector: string): string => {
  const esc = selector.replace(/[.[\]()]/g, "\\$&");
  // The selector may end a comma list: the rule is the one whose last selector is this one.
  const re = new RegExp(`(?:^|\\}|,)\\s*${esc}\\s*\\{([^}]*)\\}`, "m");
  return re.exec(css)?.[1] ?? "";
};

describe("chrome targets (MS-11, MS-12)", () => {
  // Every interactive control in the chrome is at least 24px tall; toolbar controls are 28px.
  test.each([
    [".nav-btn", 28],
    [".legend-btn", 28],
    [".toolbar-btn", 28],
    [".transport-trigger", 28],
    [".transport-hold", 28],
    [".transport-track", 24],
    [".toolbar-views button", 28],
  ])("%s is tall enough", (selector, min) => {
    const m = /(?:min-)?height:\s*(\d+)px/.exec(body(selector));
    expect(m, selector).not.toBeNull();
    expect(Number(m![1]), selector).toBeGreaterThanOrEqual(min as number);
  });

  test("every chrome control has a visible focus ring", () => {
    for (const sel of [".nav-btn:focus-visible", ".toolbar-btn:focus-visible", ".legend-btn:focus-visible", ".transport-trigger:focus-visible"]) {
      expect(css, sel).toContain(sel);
    }
    expect(css).toMatch(/\.nav-btn:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  });

  test("the sidebar collapses under 900px and the inspector overlays under 1100px", () => {
    expect(css).toMatch(/@media \(max-width: 899px\)[\s\S]*\.sidebar \{ position: absolute/);
    expect(css).toMatch(/@media \(max-width: 1099px\)[\s\S]*\.detail\.open \{ position: absolute/);
  });

  test("selection is a neutral fill; colour is only for needs you", () => {
    const active = body(".nav-btn.active");
    expect(active).toContain("var(--selected)");
    expect(active).not.toMatch(/--(?:accent|needs)/);
    expect(body(".nav-count.needs")).toContain("var(--needs)");
  });
});

describe("sidebar", () => {
  const make = () => {
    const onSelect = vi.fn();
    const sb = createSidebar({ onSelect, onLegend: vi.fn() });
    document.body.append(sb.root);
    return { sb, onSelect };
  };

  test("marks exactly the current item with aria-current", () => {
    const { sb } = make();
    sb.setProjects([{ id: "p1", label: "alpha", needs: 0, active: 0 }]);
    sb.setCurrent({ project: "p1" });
    expect(sb.root.querySelectorAll("[aria-current]")).toHaveLength(1);
    expect(sb.root.querySelector(".nav-project")!.getAttribute("aria-current")).toBe("page");
    sb.setCurrent("fleet");
    expect(sb.root.querySelector(".nav-project")!.hasAttribute("aria-current")).toBe(false);
    expect(sb.root.querySelector('[data-panel=fleet]')!.getAttribute("aria-current")).toBe("page");
    sb.setCurrent(undefined);
    expect(sb.root.querySelectorAll("[aria-current]")).toHaveLength(0);
  });

  test("states are words with counts, never a bare dot", () => {
    const { sb } = make();
    sb.setProjects([{ id: "p1", label: "alpha", needs: 2, active: 3 }, { id: "p2", label: "beta", needs: 0, active: 0 }]);
    const rows = sb.root.querySelectorAll(".nav-project");
    expect(rows[0]!.querySelector(".nav-sub")!.textContent).toBe("2 needs you · 3 active");
    expect(rows[1]!.querySelector(".nav-sub")).toBeNull();
    expect(sb.root.querySelector(".nav-empty")!.hasAttribute("hidden")).toBe(true);
  });

  test("selecting an item sends its target and an empty list says so", () => {
    const { sb, onSelect } = make();
    expect(sb.root.querySelector<HTMLElement>(".nav-empty")!.hidden).toBe(false);
    sb.setProjects([{ id: "p1", label: "alpha", needs: 0, active: 0 }]);
    sb.root.querySelector<HTMLElement>(".nav-project")!.click();
    sb.root.querySelector<HTMLElement>("[data-panel=needs]")!.click();
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual([{ kind: "project", id: "p1" }, { kind: "needs" }]);
  });

  test("a redraw keeps focus on the project row", () => {
    const { sb } = make();
    const rows = [{ id: "p1", label: "alpha", needs: 0, active: 0 }];
    sb.setProjects(rows);
    sb.root.querySelector<HTMLElement>(".nav-project")!.focus();
    sb.setProjects([{ ...rows[0]!, needs: 1 }]);
    expect(document.activeElement).toBe(sb.root.querySelector(".nav-project"));
  });
});

describe("toolbar", () => {
  test("history buttons are named, disabled until there is somewhere to go, and call back", () => {
    const deps = { onBack: vi.fn(), onForward: vi.fn(), onToggleSidebar: vi.fn() };
    const tb = createToolbar(deps);
    document.body.append(tb.root);
    const back = tb.root.querySelector<HTMLButtonElement>(".toolbar-back")!;
    const forward = tb.root.querySelector<HTMLButtonElement>(".toolbar-forward")!;
    expect(back.getAttribute("aria-label")).toBe("Back");
    expect(forward.getAttribute("aria-label")).toBe("Forward");
    const off = (b: HTMLElement) => b.getAttribute("aria-disabled") === "true";
    expect([off(back), off(forward)]).toEqual([true, true]);
    back.click();
    expect(deps.onBack).not.toHaveBeenCalled();
    tb.setHistory(true, false);
    expect([off(back), off(forward)]).toEqual([false, true]);
    back.click();
    expect(deps.onBack).toHaveBeenCalledOnce();
    tb.setPlace("All projects");
    expect(tb.root.querySelector(".toolbar-place")!.textContent).toBe("All projects");
  });
});
