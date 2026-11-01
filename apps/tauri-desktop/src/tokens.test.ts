import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  contrast,
  hexToRgb,
  isOklchContext,
  oklchToHex,
  parseOklch,
  parseRules,
  parseTokens,
  sampleRamp,
  stripComments,
} from "./tokens-helpers";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string): string => readFileSync(SRC + rel, "utf8");
const css = read("styles.css");
const tokens = parseTokens(css);
const rules = parseRules(css);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = dir + name;
    if (statSync(p).isDirectory()) out.push(...walk(p + "/"));
    else out.push(p);
  }
  return out;
}
// Non-test application TypeScript. tokens-helpers.ts is test-only support and is not shipped.
const TEST_ONLY = ["tokens-helpers.ts"];
const appTs = walk(SRC)
  .filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))
  .map((p) => p.slice(SRC.length))
  .filter((p) => !TEST_ONLY.includes(p));

// ---- the contract --------------------------------------------------------------------------

const NEUTRALS = ["--bg", "--bg-panel", "--bg-hover", "--border", "--text", "--text-dim"];
const ROLES = ["--accent", "--needs", "--selected", "--focus", "--stale", "--fog", "--ok", "--warn", "--err"];
const FILLS = ["--on-err", "--on-fill"];
const STATUS = ["--attention", "--working", "--observed", "--none"];
const SERIES = [1, 2, 3, 4, 5].map((n) => `--series-${n}`);
const TYPE = ["--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg", "--font-sans"];
const COLOUR_TOKENS = [...NEUTRALS, ...ROLES, ...FILLS, ...STATUS, ...SERIES];
// Status tokens stay equal to ui/graph/names.ts in hex; they carry no oklch override.
const NEEDS_OKLCH = [...NEUTRALS, ...ROLES, ...FILLS];

// Properties set locally on an element (not on :root); everything else must resolve on :root.
const LOCAL_PROPS = ["--hue"]; // ui/sessions.ts:181 sets --hue per band row

// Slice 9 owns these files; they keep their literals until its follow-up migrates them.
// ui/graph/names.ts pins the four graph state hues that the parity test compares against :root.
const OFFLIMITS_TS = ["ui/graph/names.ts"];
// The per-session identity colour is data, not theme: the only literal allowed besides tokens.
const IDENTITY_HUE_CSS = "hsl(var(--hue) 55% 55%)";
const IDENTITY_HUE_TS = /hsl\(\$\{sessionHue\([^)]*\)\} 55% 55%\)/g;

const resolveHex = (name: string, mode: "base" | "oklch"): string | undefined => {
  const v = mode === "oklch" ? (tokens.oklch[name] ?? tokens.base[name]) : tokens.base[name];
  if (v === undefined) return undefined;
  return v.startsWith("oklch(") ? parseOklch(v) : v;
};
const hexOf = (name: string, mode: "base" | "oklch"): string => {
  const v = resolveHex(name, mode);
  if (!v || !/^#[0-9a-fA-F]{3,6}$/.test(v)) throw new Error(`${name} (${mode}) is not a resolvable colour: ${v}`);
  return v;
};
const MODES = ["base", "oklch"] as const;

describe("token contract", () => {
  test.each([...COLOUR_TOKENS, ...TYPE])("%s is declared on :root", (name) => {
    expect(tokens.base[name], `${name} missing from :root`).toBeDefined();
  });

  test.each(COLOUR_TOKENS)("%s has a hex fallback", (name) => {
    expect(tokens.base[name]).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test.each(NEEDS_OKLCH)("%s has an oklch override under @supports", (name) => {
    expect(tokens.oklch[name], `${name} missing from the @supports oklch block`).toMatch(/^oklch\(/);
  });

  test("the oklch override sits in a single @supports block that tests oklch support", () => {
    const blocks = rules.filter((r) => r.selector === ":root" && isOklchContext(r));
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("names kept for TypeScript survive and the old palettes are gone", () => {
    for (const name of ["--border", "--map-heat", "--map-zero"]) expect(tokens.base[name]).toBeDefined();
    expect(css).not.toMatch(/--g-[a-z-]+\s*:/);
    expect(css).not.toMatch(/var\(--g-/);
    expect(css).not.toMatch(/--muted/);
  });
});

describe("resolvability", () => {
  const declared = new Set([...Object.keys(tokens.base), ...Object.keys(tokens.oklch)]);
  const used = (text: string): string[] => [...stripComments(text).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);

  test("every var(--x) in styles.css has a :root declaration", () => {
    const missing = [...new Set(used(css))].filter((n) => !declared.has(n) && !LOCAL_PROPS.includes(n));
    expect(missing).toEqual([]);
  });

  test("every var(--x) in application TypeScript has a :root declaration", () => {
    const missing: string[] = [];
    for (const f of appTs) {
      for (const n of used(read(f))) if (!declared.has(n) && !LOCAL_PROPS.includes(n)) missing.push(`${f}: ${n}`);
    }
    expect(missing).toEqual([]);
  });

  test("the custom properties TypeScript reads are on :root", () => {
    for (const name of ["--map-heat", "--map-zero", "--border"]) expect(declared.has(name), name).toBe(true);
  });

  test("the only locally set property is the allowlisted one", () => {
    const local = new Set<string>();
    for (const r of rules) {
      if (r.selector === ":root") continue;
      for (const m of r.body.matchAll(/(?:^|[;\s])(--[\w-]+)\s*:/g)) local.add(m[1]);
    }
    expect([...local].filter((n) => !LOCAL_PROPS.includes(n))).toEqual([]);
  });
});

describe("no colour literals outside the token layer", () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/g;
  const withoutUrls = (s: string): string => s.replace(/url\([^)]*\)/g, "");

  test("styles.css has none outside :root and the @supports oklch block", () => {
    const bad: string[] = [];
    for (const r of rules) {
      if (r.selector === ":root" || isOklchContext(r)) continue;
      const body = withoutUrls(r.body).split(IDENTITY_HUE_CSS).join("");
      const hits = body.match(LITERAL);
      if (hits) bad.push(`${r.selector} -> ${[...new Set(hits)].join(" ")}`);
    }
    expect(bad).toEqual([]);
  });

  test("application TypeScript has none (off-limits files excepted until the slice 9 follow-up)", () => {
    const bad: string[] = [];
    for (const f of appTs) {
      if (OFFLIMITS_TS.some((p) => f === p || (p.endsWith("/") && f.startsWith(p)))) continue;
      const text = stripComments(read(f).replace(/\/\/[^\n]*/g, "")).replace(IDENTITY_HUE_TS, "");
      const hits = text.match(LITERAL);
      if (hits) bad.push(`${f} -> ${[...new Set(hits)].join(" ")}`);
    }
    expect(bad).toEqual([]);
  });

  test("the identity hue expression is still in place", () => {
    expect(read("ui/fleet/encodings.ts")).toMatch(IDENTITY_HUE_TS);
    expect(css).toContain(IDENTITY_HUE_CSS);
  });
});

describe("graph state parity with ui/graph/names.ts", () => {
  const names = read("ui/graph/names.ts").split("\n").slice(14, 20).join("\n"); // lines 15-20
  const fromNames = (state: string): string => {
    const m = names.match(new RegExp(`${state}:\\s*"(#[0-9a-fA-F]{6})"`));
    if (!m) throw new Error(`names.ts lost ${state}`);
    return m[1].toLowerCase();
  };

  test.each(["attention", "working", "observed", "none"])("--%s equals the names.ts constant", (state) => {
    expect((tokens.base[`--${state}`] ?? "").toLowerCase()).toBe(fromNames(state));
  });

  const stateRules = rules.filter((r) => /\.state-(attention|working|observed|none)\b/.test(r.selector));

  test("dot rules exist for all four states and ring rules for the three live ones", () => {
    for (const s of ["attention", "working", "observed", "none"]) {
      expect(stateRules.some((r) => r.selector.includes(`.agent-dot.state-${s}`)), `dot ${s}`).toBe(true);
    }
    for (const s of ["attention", "working", "observed"]) {
      expect(stateRules.some((r) => r.selector.includes(`.revision-node.ring.state-${s}`)), `ring ${s}`).toBe(true);
    }
  });

  test("every state selector paints with its own token and nothing else", () => {
    const wrong: string[] = [];
    for (const r of stateRules) {
      const state = r.selector.match(/\.state-(attention|working|observed|none)\b/)![1];
      const vars = [...r.body.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
      if (vars.length === 0 || vars.some((v) => v !== `--${state}`)) wrong.push(`${r.selector} uses ${vars.join(",") || "no token"}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("oklch agrees with the hex fallback", () => {
  const TOL = 6; // per sRGB channel, of 255
  test.each(NEEDS_OKLCH)("%s", (name) => {
    const hex = tokens.base[name];
    const ok = tokens.oklch[name];
    expect(hex, `${name} hex`).toBeDefined();
    expect(ok, `${name} oklch`).toBeDefined();
    const a = hexToRgb(hex);
    const b = hexToRgb(parseOklch(ok));
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i]), `${name} channel ${i}: ${hex} vs ${ok}`).toBeLessThanOrEqual(TOL);
  });

  test("the converter is right on known values", () => {
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
    expect(oklchToHex(0.628, 0.2577, 29.23)).toBe("#ff0000");
  });
});

describe("contrast (WCAG AA)", () => {
  const SURFACES = ["--bg", "--bg-panel", "--bg-hover"];
  const TEXTS = ["--text", "--text-dim", "--accent", "--needs", "--ok", "--warn", "--err", "--stale"];
  const cases = MODES.flatMap((m) => TEXTS.flatMap((t) => SURFACES.map((s) => [m, t, s] as const)));

  test.each(cases)("[%s] %s on %s >= 4.5", (mode, fg, bg) => {
    expect(contrast(hexOf(fg, mode), hexOf(bg, mode)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test.each(MODES)("[%s] --on-err on --err >= 4.5", (mode) => {
    expect(contrast(hexOf("--on-err", mode), hexOf("--err", mode))).toBeGreaterThanOrEqual(4.5);
  });

  // The map ramp runs --map-zero -> --map-heat on a sqrt scale (ui/activity/model.ts colour()).
  test.each(MODES)("[%s] --on-fill >= 4.5 on both ends and the middle of the heat ramp", (mode) => {
    const zero = hexOf("--map-zero", mode);
    const heat = hexOf("--map-heat", mode);
    const fg = hexOf("--on-fill", mode);
    for (const t of [0, 0.01, 0.25, 0.5, 1]) {
      expect(contrast(fg, sampleRamp(zero, heat, t)), `--on-fill at heat fraction ${t}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.each(MODES)("[%s] the cold-tile label (--text-dim) reads on --map-zero", (mode) => {
    expect(contrast(hexOf("--text-dim", mode), hexOf("--map-zero", mode))).toBeGreaterThanOrEqual(4.5);
  });

  test.each(MODES.flatMap((m) => ["--border", "--focus"].map((t) => [m, t] as const)))("[%s] %s >= 3:1 on --bg and --bg-panel", (mode, t) => {
    for (const s of ["--bg", "--bg-panel"]) {
      expect(contrast(hexOf(t, mode), hexOf(s, mode)), `${t} on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("the fills are the ones actually used for text on those surfaces", () => {
    const body = (sel: string): string => rules.filter((r) => r.selector === sel).map((r) => r.body).join(";");
    expect(body(".badge.err")).toMatch(/color\s*:\s*var\(--on-err\)/);
    expect(body(".map-tile > text")).toMatch(/fill\s*:\s*var\(--on-fill\)/);
  });

  test("the ramp sampler matches color-mix at its anchors", () => {
    expect(sampleRamp("#000000", "#ffffff", 0)).toBe("#000000");
    expect(sampleRamp("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(sampleRamp("#000000", "#ffffff", 0.25)).toBe("#969696"); // 59% of 255
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("type scale", () => {
  const SIZE = /(?:^|[;{\s])font-size\s*:\s*([^;}]+)/g;
  const sizes: { where: string; value: string }[] = [];
  for (const r of rules) {
    for (const m of r.body.matchAll(SIZE)) sizes.push({ where: r.selector, value: m[1].trim() });
  }

  test("every font-size is a --fs-* step or inherit", () => {
    const bad = sizes.filter((s) => !/^(?:var\(--fs-(?:xs|sm|base|md|lg)\)|inherit)$/.test(s.value));
    expect(bad.map((s) => `${s.where}: ${s.value}`)).toEqual([]);
  });

  test("at most five steps are in use", () => {
    const steps = new Set(sizes.map((s) => s.value).filter((v) => v.startsWith("var(")));
    expect(steps.size).toBeLessThanOrEqual(5);
    expect(Object.keys(tokens.base).filter((k) => k.startsWith("--fs-")).length).toBeLessThanOrEqual(5);
  });
});

describe("accent policy", () => {
  // Accent-family colour is for: needs you, selection, the focus ring, the primary action, errors.
  const ACCENT_USERS = /var\(\s*--(?:accent|needs|selected|focus)\s*[,)]/;
  const ALLOWED = [
    /:focus(?:-visible|-within)?\b/, // focus ring
    /\.focus\b/,
    /\.selected\b/, // selection
    /\[aria-(?:pressed|selected|current)="?(?:true|page)"?\]/,
    /\.active\b/,
    /\.current\b/,
    /\.primary\b/, // primary action
    /\.needs\b/, // needs you
    /\.attention(?:-kind)?\b/,
    /\.err(?:or)?\b/, // errors
    /\.failed\b/,
  ];
  const selectors = (sel: string): string[] => sel.split(/,(?![^(]*\))/).map((s) => s.trim());

  test("accent-family colour appears only on needs, selection, focus, primary action and errors", () => {
    const bad: string[] = [];
    for (const r of rules) {
      if (r.selector === ":root" || !ACCENT_USERS.test(r.body)) continue;
      for (const s of selectors(r.selector)) {
        if (!ALLOWED.some((re) => re.test(s))) bad.push(s);
      }
    }
    expect(bad).toEqual([]);
  });

  test("TypeScript never emits accent-family colours outside the policy (ordinary history uses series/state tokens)", () => {
    const bad = appTs.filter((f) => !OFFLIMITS_TS.some((o) => f.startsWith(o) || f === o) && ACCENT_USERS.test(read(f)));
    expect(bad).toEqual([]);
  });

  test("the feed source column is not accent coloured", () => {
    const hit = rules.filter((r) => /\.cell\.source\b/.test(r.selector) && ACCENT_USERS.test(r.body));
    expect(hit.map((r) => r.selector)).toEqual([]);
  });

  test("Activity captured marks are not accent coloured", () => {
    const hit = rules.filter((r) => /captured/.test(r.selector) && !/\.workspace-graph\s*$/.test(r.selector) && ACCENT_USERS.test(r.body));
    expect(hit.map((r) => r.selector)).toEqual([]);
  });

  test("the attention kind label is not accent coloured (the inbox row, not its colour, carries state)", () => {
    const hit = rules.filter((r) => /\.attention-kind\b/.test(r.selector) && ACCENT_USERS.test(r.body));
    expect(hit.map((r) => r.selector)).toEqual([]);
  });
});

describe("text is dimmed by token, not by opacity", () => {
  const TEXT_SELECTORS = [".nav-heading", ".scope-crumb .unresolved", ".fleet-need.stale", ".fleet-band.zero"];
  test.each(TEXT_SELECTORS)("%s sets no opacity", (sel) => {
    const hit = rules.filter((r) => r.selector.split(",").map((x) => x.trim()).includes(sel) && /(^|[;\s])opacity\s*:/.test(r.body));
    expect(hit.map((r) => r.selector)).toEqual([]);
  });
});

describe("DESIGN.md", () => {
  const design = readFileSync(SRC + "../../../DESIGN.md", "utf8");
  test("lists every :root token", () => {
    const missing = Object.keys(tokens.base).filter((k) => !design.includes("`" + k + "`"));
    expect(missing).toEqual([]);
  });
  test.each(["Token table", "Type scale", "Accent rules", "Graph", "Adding a token", "Browser baseline", "PRODUCT.md"])(
    "has the %s section",
    (h) => {
      expect(design).toMatch(new RegExp("^#{1,3} .*" + h, "m"));
    },
  );
  test("colour-mix() is guaranteed by a bundle minimum macOS and documented", () => {
    const conf = JSON.parse(readFileSync(SRC + "../src-tauri/tauri.conf.json", "utf8"));
    const [maj, min] = String(conf.bundle.macOS.minimumSystemVersion).split(".").map(Number);
    expect(maj * 100 + min).toBeGreaterThanOrEqual(1301);
    expect(design).toContain("minimumSystemVersion");
  });
  test("PRODUCT.md links DESIGN.md", () => {
    expect(readFileSync(SRC + "../../../PRODUCT.md", "utf8")).toContain("DESIGN.md");
  });
});

describe("open spans and keyboard focus", () => {
  const css = read("styles.css");
  const decl = (sel: string, prop: string): string => {
    const esc = sel.replace(/[.]/g, "\\.");
    const m = css.match(new RegExp("(?:^|\\n)" + esc + "\\s*\\{([^}]*)\\}"));
    return (m?.[1].match(new RegExp(prop + ":\\s*([^;]+)")) ?? [])[1]?.trim() ?? "";
  };
  test.each([["lane"], ["score"]])("%s open span is visibly distinct from a closed span", (k) => {
    const closed = parseFloat(decl(`.${k}-span`, "opacity"));
    const open = parseFloat(decl(`.${k}-span.open`, "opacity"));
    expect(open - closed).toBeGreaterThan(0.2);
    expect(decl(`.${k}-span.open`, "fill")).not.toContain("--accent");
  });
  test.each([
    ".matrix-cell:focus-visible",
    ".dwell-row:focus-visible",
    ".lane-row:focus-visible .lane-hit",
    ".fleet-lane-row:focus-visible .lane-hit",
    ".score-track:focus-visible .score-hit",
  ])("%s draws a --focus indicator", (sel) => {
    const line = css.split("\n").find((l) => l.includes(sel) && l.includes("var(--focus)"));
    expect(line).toBeTruthy();
  });
});
