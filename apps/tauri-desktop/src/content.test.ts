// @vitest-environment happy-dom
// Content targets and selection (MS-6, MS-11): every control the content draws is at least 24px
// tall, and a selected row is a neutral fill, never the accent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
/** Every declaration block whose selector list names this selector (a rule may share its block with others). */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1]!.split(",").map((x) => x.trim().replace(/\s+/g, " ")), body: m[2]! }));
const body = (selector: string): string => rules.filter((r) => r.sels.includes(selector)).map((r) => r.body).join(";");

describe("content targets (MS-11)", () => {
  // Each control the new content draws: its smallest allowed height in px.
  test.each([
    [".fleet-row-head", 28],
    [".fleet-fork", 24],
    [".fleet-need", 24],
    [".fleet-more", 24],
    [".fleet-enc", 24],
    [".fleet-retry", 24],
    [".unit-actions", 24],
    [".session-item", 40],
    [".worktree-item", 40],
    [".session-item .score-open", 24],
    [".session-item .loops-open", 24],
    [".sessions-needs", 24],
    [".sessions-back", 24],
    [".sessions-more", 24],
    [".sessions-cell button", 24],
    [".more-btn", 28],
    [".more-item", 28],
    [".inspector-open", 28],
    [".inspector-actions", 28],
    [".inspector-copy", 24],
    [".detail-close", 24],
  ])("%s is at least %ipx", (selector, min) => {
    const m = /min-height:\s*(\d+)px/.exec(body(selector));
    expect(m, selector).not.toBeNull();
    expect(Number(m![1]), selector).toBeGreaterThanOrEqual(min as number);
  });

  test("the More menu items are full-width and the pop-up is a floating surface above the content", () => {
    expect(body(".more-pop")).toMatch(/position:\s*absolute/);
    expect(body(".more-pop")).toContain("var(--shadow)");
    expect(body(".more-item")).toMatch(/width:\s*100%/);
  });

  test("keyboard focus is visible on every new control", () => {
    for (const sel of [".more-btn:focus-visible", ".more-item:focus-visible", ".inspector-open:focus-visible", ".inspector-copy:focus-visible"]) {
      expect(css, sel).toContain(sel);
    }
  });
});

describe("selection is neutral (MS-6)", () => {
  test.each([".fleet-row.selected", ".fleet-need.selected", ".fleet-fork.selected", ".session-item.picked", ".worktree-item.picked"])("%s is a neutral fill, not accent", (sel) => {
    const b = body(sel);
    expect(b, sel).toContain("var(--bg-hover)");
    expect(b, sel).not.toMatch(/--(?:accent|selected|needs)/);
  });

  test("the selected view segment and the More button naming a view are neutral", () => {
    expect(body('.fleet-enc[aria-selected="true"]')).not.toMatch(/--accent/);
    expect(body(".more-btn.current")).toContain("var(--bg-hover)");
  });

  test("an unknown value is drawn with its mark, in the dim colour, never as a state colour", () => {
    expect(css).toMatch(/\.cell\.state\.unknown::before\s*\{[^}]*content:\s*attr\(data-mark\)/);
    expect(body(".cell.unknown")).toContain("var(--text-dim)");
    expect(body(".inspector-status.unknown")).toContain("var(--text-dim)");
  });
});
