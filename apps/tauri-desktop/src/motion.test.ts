import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseRules, type Rule } from "./tokens-helpers";

// Press feedback and focus fills live in plain CSS, so these tests read the
// stylesheet: jsdom neither runs transitions nor matches :active or :focus-visible.
const all: Rule[] = parseRules(readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8"));
/** A rule's selector list, split and trimmed. */
const items = (r: Rule): string[] => r.selector.split(",").map((s) => s.trim());
const top = all.filter((r) => r.context.length === 0);
const reduced = all.filter((r) => r.context.some((c) => /prefers-reduced-motion:\s*reduce/.test(c)));
/** Every declaration block among `rules` whose selector list contains `sel` exactly, joined. */
const body = (rules: Rule[], sel: string): string => rules.filter((r) => items(r).includes(sel)).map((r) => r.body).join(";");

describe("motion tokens", () => {
  test("strong easing curves are defined on :root", () => {
    const root = body(top, ":root");
    expect(root).toMatch(/--ease-out:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
    expect(root).toMatch(/--ease-in-out:\s*cubic-bezier\(0\.77,\s*0,\s*0\.175,\s*1\)/);
  });
});

describe("detail pane", () => {
  test("opens in one frame: it opens on every row click, and animating width reflows the feed", () => {
    expect(body(top, ".detail")).not.toMatch(/transition/);
    expect(body(top, ".detail.open")).not.toMatch(/transition/);
  });
});

describe("press feedback", () => {
  // The `scale` property, not `transform`, so positioned buttons (graph edge hints
  // use translate) keep their offset and still get feedback.
  test("buttons scale subtly on press with a fast ease-out", () => {
    expect(body(top, "button")).toMatch(/transition:\s*scale\s+1[0-6]0ms\s+var\(--ease-out\)/);
    expect(body(top, "button:active")).toMatch(/(?:^|[;\s])scale:\s*0\.97/);
  });

  test.each([".nav-btn:active", ".session-tabs button:active"])("%s stays still: switched constantly", (sel) => {
    expect(body(top, sel)).toMatch(/(?:^|[;\s])scale:\s*none/);
  });

  test("reduced motion drops the press scale", () => {
    expect(body(reduced, "button:active")).toMatch(/(?:^|[;\s])scale:\s*none/);
  });
});

describe("focus fills", () => {
  // A bare :focus fill sticks after a mouse click, so a clicked row looks hovered
  // until focus moves. Only keyboard focus (:focus-visible) keeps the fill.
  test.each([
    [".matrix-cell:focus", ".matrix-cell:focus-visible"],
    [".dwell-row:focus", ".dwell-row:focus-visible"],
    [".lane-row:focus .lane-hit", ".lane-row:focus-visible .lane-hit"],
    [".score-track:focus .score-hit", ".score-track:focus-visible .score-hit"],
    [".fleet-lane-row:focus .lane-hit", ".fleet-lane-row:focus-visible .lane-hit"],
  ])("%s does not paint the hover fill; %s does", (bare, visible) => {
    expect(body(top, bare)).not.toMatch(/(background|fill):\s*var\(--bg-hover\)/);
    expect(body(top, visible)).toMatch(/(background|fill):\s*var\(--bg-hover\)/);
  });
});
