// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseRules, stripComments, type Rule } from "./tokens-helpers";

const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const rules: Rule[] = parseRules(css).filter((r) => !r.selector.startsWith("@"));
const items = (r: Rule): string[] => r.selector.split(",").map((s) => s.trim()).filter(Boolean);
const has = (body: string, prop: string): boolean => new RegExp(`(?:^|[;\\s])${prop}\\s*:`).test(body);
const outlineNone = (r: Rule): boolean => /(?:^|[;\s])outline\s*:\s*none\b/.test(r.body);
const usesRing = (body: string): boolean => /var\(\s*--(?:focus|selected)\s*\)/.test(body);
const ringProps = /(?:^|[;\s])(outline|stroke|box-shadow|border-color)\s*:\s*([^;]+)/g;

/** Strip trailing :hover/:focus/:focus-visible/:focus-within from a selector item. */
function base(sel: string): string {
  return sel.replace(/(?::hover|:focus-visible|:focus-within|:focus)+$/, "");
}

/** Selector items whose own ring replaces an outline:none on base B. */
function replacement(b: string): Rule | undefined {
  return rules.find(
    (r) =>
      usesRing(r.body) &&
      [...r.body.matchAll(ringProps)].some((m) => /var\(\s*--(?:focus|selected)\s*\)/.test(m[2])) &&
      items(r).some((s) => s === `${b}:focus-visible` || s === `${b}:focus-within` || s.startsWith(`${b}:focus-visible `)),
  );
}

// Ancestor :focus-within replacements, named explicitly.
const EXEMPT: Record<string, string> = { ".graph-search .graph-search-input": ".graph-search:focus-within" };

const offenders = (): string[] => {
  const out: string[] = [];
  for (const r of rules.filter(outlineNone)) {
    for (const s of items(r)) {
      const b = base(s);
      if (EXEMPT[b]) {
        const anc = rules.find((x) => items(x).includes(EXEMPT[b]) && usesRing(x.body) && has(x.body, "border-color"));
        if (!anc) out.push(`${s} (exempt ancestor ${EXEMPT[b]} missing)`);
      } else if (!replacement(b)) out.push(s);
    }
  }
  return out;
};

describe("focus visibility", () => {
  test("global rule", () => {
    const g = rules.find((r) => r.selector === ":focus-visible");
    expect(g, "top-level :focus-visible rule").toBeTruthy();
    expect(g!.body).toMatch(/outline\s*:\s*2px solid var\(--focus\)/);
    expect(g!.body).toMatch(/outline-offset\s*:\s*[12]px/);
    const lastRoot = Math.max(...rules.map((r, i) => (r.selector === ":root" ? i : -1)));
    expect(rules.indexOf(g!)).toBeGreaterThan(lastRoot);
  });

  test("outline:none has a per-element replacement", () => {
    expect(offenders()).toEqual([]);
  });

  test("cascade: nothing beats the global rule without a replacement", () => {
    // Every outline:none item with a class/attr/pseudo (specificity >= the global 0,1,0) is in the replacement set.
    const beating = rules.filter(outlineNone).flatMap(items).filter((s) => /[.[:#]/.test(s));
    const bad = beating.filter((s) => !EXEMPT[base(s)] && !replacement(base(s)));
    expect(bad).toEqual([]);
  });

  test("rings use --focus", () => {
    const bad: string[] = [];
    const graphScope = /\.workspace-graph|\.graph-search|\.graph-canvas|\.workspace-label|\.workspace-cluster|\.revision-node/;
    for (const r of rules.filter((x) => /:focus/.test(x.selector))) {
      for (const m of r.body.matchAll(ringProps)) {
        const val = m[2].trim();
        if (m[1] === "outline" && /^none\b/.test(val)) continue;
        if (/var\(\s*--focus\s*\)/.test(val)) continue;
        if (/var\(\s*--selected\s*\)/.test(val) && graphScope.test(r.selector)) continue;
        bad.push(`${r.selector} { ${m[1]}: ${val} }`);
      }
    }
    expect(bad).toEqual([]);
  });

  test.each([
    [".feed-row:focus-visible", "outline"],
    [".session-item:focus-visible", "outline"],
    [".project-bead:focus-visible", "stroke"],
    [".project-lane:focus-visible .project-hit", "stroke"],
  ])("%s sets %s with var(--focus)", (sel, prop) => {
    const r = rules.find((x) => items(x).includes(sel) && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*[^;]*var\\(--focus\\)`).test(x.body));
    expect(r).toBeTruthy();
  });

  test("stylesheet has no accent or currentColor ring", () => {
    expect(stripComments(css)).not.toMatch(/:focus[^{]*\{[^}]*outline\s*:[^;}]*(?:--accent|currentColor)/);
  });
});
