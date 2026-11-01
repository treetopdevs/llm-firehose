// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BADGE, CLIP, DASH, HATCH, rejoinPath, ERROR_MARK, FORK_GLYPH, GLYPH_GROUPS, GONE_MARK, IDLE_BANG, IDLE_MARK, LANDED_UNKNOWN, LANE_MARK_SHAPES, NEEDS_MARK,
  NO_PROJECT_MARK, SESSION_STATE_MARKS, swatchSvg, COMMIT_TICK, laneMarkPath,
} from "./glyphs";
import type { GlyphEntry } from "./glyphs";
import * as fleetModel from "./ui/fleet/model";
import { FIXTURE_ROWS, NOW, iso, row } from "./ui/project/model.fixtures";
import { layoutLanes, resolveWindow } from "./ui/project/model";
import { stateGlyph } from "./ui/workspace/model";
import { createScope } from "./scope";
import { __resetKeysForTests } from "./keys";
import { createProject } from "./ui/project/index";
import type { ProjectPanel } from "./ui/project/index";
import { parseRules, stripComments } from "./tokens-helpers";

const { worktreesMock, worktreeMock } = vi.hoisted(() => ({ worktreesMock: vi.fn(), worktreeMock: vi.fn() }));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  worktrees: (s?: AbortSignal) => worktreesMock(s),
  worktree: (id: string, s?: AbortSignal) => worktreeMock(id, s),
}));

const D = 86_400_000;
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const panels: ProjectPanel[] = [];

async function mount(rows = FIXTURE_ROWS, repo = "repoA") {
  worktreesMock.mockImplementation(() => Promise.resolve(rows));
  worktreeMock.mockImplementation((id: string) => Promise.resolve({ ...(rows.find((r) => r.worktree_id === id) ?? row({ worktree_id: id })), commits: [] }));
  const store = createScope();
  const panel = createProject({ store, go: vi.fn(), now: () => NOW, refreshMs: 15000 });
  document.body.append(panel.root);
  panels.push(panel);
  store.narrow({ project: repo });
  await panel.activate();
  await flush();
  const lane = (id: string) => panel.root.querySelector<SVGElement>(`.project-lane[data-key="${id}"]`)!;
  return { panel, lane };
}

beforeEach(() => { __resetKeysForTests(); worktreesMock.mockReset(); worktreeMock.mockReset(); });
afterEach(() => {
  for (const p of panels.splice(0)) p.deactivate();
  __resetKeysForTests();
  document.body.replaceChildren();
});

const allEntries = GLYPH_GROUPS.flatMap((g) => g.entries);
const entryById = (gid: string, name: string): GlyphEntry =>
  GLYPH_GROUPS.find((g) => g.id === gid)!.entries.find((e) => e.name === name)!;

describe("table integrity", () => {
  test("every entry names and explains itself and has a glyph or a swatch", () => {
    expect(allEntries.length).toBeGreaterThan(20);
    for (const e of allEntries) {
      expect(e.name.trim(), JSON.stringify(e)).not.toBe("");
      expect(e.meaning.trim(), e.name).not.toBe("");
      expect(Boolean(e.glyph) || Boolean(e.swatch), e.name).toBe(true);
    }
  });
  test("no duplicate glyph within a group, no duplicate group ids", () => {
    expect(new Set(GLYPH_GROUPS.map((g) => g.id)).size).toBe(GLYPH_GROUPS.length);
    for (const g of GLYPH_GROUPS) {
      const glyphs = g.entries.map((e) => e.glyph).filter((x): x is string => !!x);
      expect(new Set(glyphs).size, g.id).toBe(glyphs.length);
      const names = g.entries.map((e) => e.name);
      expect(new Set(names).size, g.id).toBe(names.length);
    }
  });
  test("groups cover every vocabulary family", () => {
    const has = (gid: string, glyphOrSwatch: string) =>
      GLYPH_GROUPS.find((g) => g.id === gid)!.entries.some((e) => e.glyph === glyphOrSwatch || e.swatch?.id === glyphOrSwatch);
    for (const s of ["open", "landed", "gone", "never_diverged", "unknown"] as const) expect(has("fork", FORK_GLYPH[s]), s).toBe(true);
    expect(has("idle", IDLE_MARK)).toBe(true);
    expect(has("idle", IDLE_BANG)).toBe(true);
    expect(has("needs", NEEDS_MARK)).toBe(true);
    expect(has("needs", ERROR_MARK)).toBe(true);
    for (const k of ["push", "pr_create", "pr_merge", "commit"]) expect(has("lane-marks", k), k).toBe(true);
    expect(has("rejoin", "rejoin")).toBe(true);
    expect(has("rejoin", LANDED_UNKNOWN)).toBe(true);
    for (const b of [BADGE.ahead, BADGE.behind, BADGE.dirty]) expect(has("badges", b), b).toBe(true);
    for (const d of ["solid", "tail", "flat", "hatched", "landgap"]) expect(has("lane-styles", d), d).toBe(true);
    for (const m of Object.values(SESSION_STATE_MARKS)) expect(has("session-state", m), m).toBe(true);
  });
});

describe("fleet and workspace read the table", () => {
  test("fleet/model re-exports the table objects", () => {
    expect(fleetModel.FORK_GLYPH).toBe(FORK_GLYPH);
    expect(fleetModel.IDLE_MARK).toBe(IDLE_MARK);
  });
  test("workspace stateGlyph returns the table marks", () => {
    expect(stateGlyph("needs_input")).toBe(SESSION_STATE_MARKS.needs_input);
    expect(stateGlyph("working")).toBe(SESSION_STATE_MARKS.working);
    expect(stateGlyph("idle")).toBe(SESSION_STATE_MARKS.idle);
    expect(stateGlyph("other")).toBe("");
    expect(SESSION_STATE_MARKS.needs_input).toBe(NEEDS_MARK);
  });
  test("buildFleet fork glyph per state equals the table", () => {
    const states = ["open", "landed", "gone", "never_diverged", "unknown"] as const;
    const rows = states.map((s) => row({ worktree_id: `w-${s}`, state: s, label: `/w/${s}`, last_time: iso(NOW - 1000), ahead: 1 }));
    const fleet = fleetModel.buildFleet({ worktrees: rows, sessions: [], now: NOW });
    const forks = fleet.rows.flatMap((r) => r.forks);
    expect(forks.length).toBeGreaterThan(0);
    for (const f of forks) expect(f.glyph).toBe(FORK_GLYPH[f.state as keyof typeof FORK_GLYPH]);
  });
});

describe("badges", () => {
  const cases: Array<[string, Partial<Parameters<typeof row>[0]>, string]> = [
    ["open ahead+behind+dirty", { state: "open", ahead: 3, behind: 1, dirty: true }, `${BADGE.ahead}3 ${BADGE.behind}1 ${BADGE.dirty}`],
    ["open ahead only", { state: "open", ahead: 2 }, `${BADGE.ahead}2`],
    ["open behind only", { state: "open", behind: 4 }, `${BADGE.behind}4`],
    ["open dirty only", { state: "open", dirty: true }, BADGE.dirty],
    ["open clean zero", { state: "open", ahead: 0, behind: 0 }, ""],
    ["landed dirty", { state: "landed", ahead: 2, behind: 2, dirty: true }, BADGE.dirty],
    ["landed clean", { state: "landed", ahead: 2, behind: 2 }, ""],
  ];
  test.each(cases)("badgeOf %s", (_n, over, expected) => {
    const w = row({ worktree_id: "w", first_time: iso(NOW - D), last_time: iso(NOW - 3600_000), ...over });
    const lanes = layoutLanes([w], ["w"], resolveWindow([w], NOW), 100, 700);
    expect(lanes[0]!.badge ?? "").toBe(expected);
    expect(BADGE.format(w.state === "open", w.ahead, w.behind, w.dirty)).toBe(expected);
  });
  test("the rendered Project badge equals the string built from the legend glyphs", async () => {
    const { lane } = await mount();
    const g = (n: string) => entryById("badges", n).glyph!;
    const text = lane("wt-open").querySelector(".project-badge")!.textContent;
    expect(text).toBe(`${g("ahead")}3 ${g("behind")}1 ${g("dirty")}`);
    expect(lane("wt-idle").querySelector(".project-badge")!.textContent).toBe(`${g("ahead")}2`);
  });
});

describe("geometry", () => {
  test("rendered lane marks use LANE_MARK_SHAPES and the legend swatch draws the same path", async () => {
    const { panel } = await mount();
    const seen = new Set<string>();
    for (const p of panel.root.querySelectorAll<SVGElement>(".project-glyph")) {
      const kind = p.getAttribute("data-kind")!;
      seen.add(kind);
      const g = p.parentElement!;
      // recover the lane y from the label baseline: shapes are anchored at (x, y)
      const y = Number(g.querySelector(".project-label")!.getAttribute("y")) - 4;
      const d = p.getAttribute("d")!;
      const first = Number(/^M ([\d.-]+) /.exec(d)![1]);
      const x = kind === "push" || kind === "pr_merge" ? first : first + 5;
      const shape = LANE_MARK_SHAPES[kind as keyof typeof LANE_MARK_SHAPES] ?? LANE_MARK_SHAPES.commit;
      expect(d).toBe(shape.path(x, y, 1));
    }
    expect([...seen].sort()).toEqual(expect.arrayContaining(["pr_merge", "push"]));
  });
  test("each shape produces the same path for a pinned centre", () => {
    expect(LANE_MARK_SHAPES.push.path(10, 20, 1)).toBe("M 10 14 L 15 24 L 5 24 Z");
    expect(LANE_MARK_SHAPES.pr_merge.path(10, 20, 1)).toBe("M 10 14 L 16 20 L 10 26 L 4 20 Z");
    expect(LANE_MARK_SHAPES.commit.path(10, 20, 1)).toBe("M 5 15 L 15 15 L 15 25 L 5 25 Z");
  });
  test("the commit swatch is the project tick, not a square; pr create is a square", () => {
    const commit = swatchSvg(entryById("lane-marks", "commit"))!;
    expect(commit.querySelector("path")).toBeNull();
    const line = commit.querySelector("line")!;
    const cy = Number(commit.getAttribute("data-cy"));
    expect(line.getAttribute("x1")).toBe(line.getAttribute("x2"));
    expect(Number(line.getAttribute("y1"))).toBe(cy - COMMIT_TICK.half);
    expect(Number(line.getAttribute("y2"))).toBe(cy + COMMIT_TICK.half);
    const pr = swatchSvg(entryById("lane-marks", "pr create"))!;
    expect(pr.querySelector("path")!.getAttribute("d")).toBe(laneMarkPath("pr_create", Number(pr.getAttribute("data-cx")), Number(pr.getAttribute("data-cy"))));
    expect(laneMarkPath("pr_create", 10, 20)).toBe("M 5 15 L 15 15 L 15 25 L 5 25 Z");
  });
  test("lane-mark meanings describe observed commands, not confirmed outcomes", () => {
    const text = (id: string) => entryById("lane-marks", id).meaning;
    expect(text("push")).toMatch(/observed/);
    expect(text("pr merge")).toMatch(/observed/);
    expect(text("pr create")).toMatch(/observed/);
    expect(entryById("fork", "never diverged").meaning).toMatch(/observed/);
    expect(entryById("fork", "landed").meaning).toMatch(/reachable/);
  });
  test("legend swatches draw the table path", () => {
    for (const kind of ["push", "pr_merge"] as const) {
      const svg = swatchSvg(entryById("lane-marks", kind === "push" ? "push" : "pr merge"))!;
      const d = svg.querySelector("path")!.getAttribute("d")!;
      const nums = /^M ([\d.-]+) ([\d.-]+)/.exec(d)!;
      expect(d.length).toBeGreaterThan(0);
      const cx = Number(svg.getAttribute("data-cx"));
      const cy = Number(svg.getAttribute("data-cy"));
      expect(d).toBe(LANE_MARK_SHAPES[kind].path(cx, cy, 1));
      expect(nums).toBeTruthy();
    }
  });
  test("lane dasharray values equal the DASH constants, and the swatches match", async () => {
    const rows = [
      ...FIXTURE_ROWS,
      row({
        worktree_id: "wt-nomerge", label: "/w/alpha-nomerge", state: "landed", outcome: "landed",
        first_time: iso(NOW - 4 * D), last_time: iso(NOW - 2 * D),
        marks: [{ kind: "commit", time: iso(NOW - 3 * D), event_id: "c1" }], marks_total: 1,
      }),
    ];
    const { lane, panel } = await mount(rows);
    expect(lane("wt-nomerge").querySelector(".project-rejoin")!.getAttribute("stroke-dasharray")).toBe(DASH.unknownRejoin);
    expect(lane("wt-nomerge").querySelector(".project-landed-unknown")!.textContent).toBe(LANDED_UNKNOWN);
    expect(lane("wt-landed").querySelector(".project-rejoin")!.getAttribute("stroke-dasharray")).toBeNull();
    const flat = panel.root.querySelector(".project-lane.flat .project-run");
    if (flat) expect(flat.getAttribute("stroke-dasharray")).toBe(DASH.flat);
    const tail = panel.root.querySelector(".project-tail");
    if (tail) expect(tail.getAttribute("stroke-dasharray")).toBe(DASH.tail);
    const gap = panel.root.querySelector(".project-landgap");
    if (gap) expect(gap.getAttribute("stroke-dasharray")).toBe(DASH.landgap);
    for (const [id, dash] of [["tail", DASH.tail], ["landgap", DASH.landgap], ["flat", DASH.flat], ["unknown_rejoin", DASH.unknownRejoin]] as const) {
      const e = GLYPH_GROUPS.flatMap((g) => g.entries).find((x) => x.swatch?.kind === "dash" && x.swatch.id === id)!;
      expect(e, id).toBeTruthy();
      expect(swatchSvg(e)!.querySelector("[stroke-dasharray]")!.getAttribute("stroke-dasharray")).toBe(dash);
    }
  });
  test("landed lane without a pr_merge shows the unknown mark; gone lane the gone mark; idle lane the bang", async () => {
    const rows = [
      ...FIXTURE_ROWS,
      row({
        worktree_id: "wt-nomerge", label: "/w/alpha-nomerge", state: "landed", outcome: "landed",
        first_time: iso(NOW - 4 * D), last_time: iso(NOW - 2 * D),
      }),
    ];
    const { lane } = await mount(rows);
    expect(lane("wt-nomerge").textContent).toContain(LANDED_UNKNOWN);
    expect(lane("wt-nomerge").querySelector(".project-rejoin.unknown-time")).toBeTruthy();
    expect(lane("wt-gone").querySelector(".project-gone")!.textContent).toBe(GONE_MARK);
    expect(lane("wt-idle").querySelector(".project-idle")!.lastChild!.textContent).toBe(IDLE_BANG);
  });
  test("fleet glyphs and the clip marks come from the table", () => {
    expect(GONE_MARK).toBe(FORK_GLYPH.gone);
    expect(NO_PROJECT_MARK).toBe("–");
    expect(CLIP).toEqual({ left: "‹", right: "›" });
  });
});

const SRC = __dirname;
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}

describe("no stray vocabulary literals", () => {
  const MARKS = "●✓×·…?±↑↓!–‹›";
  // file:literal -> reason. Anything else that quotes a lone vocabulary mark must come from glyphs.ts.
  const ALLOWLIST: Record<string, string> = {
    "ui/sessions.ts:×": "close button label for the scope chip: a control, not a worktree-state mark",
    "ui/project/model.ts:?": "axis tick placeholder for a non-finite time",
    "keys.ts:?": "the key that opens the legend: a key name, not a glyph",
    "ui/airspace/map.ts:…": "text truncation ellipsis, not the idle mark",
    "ui/files.ts:…": "tests whether a stored path was truncated with an ellipsis",
    "ui/fleet/encodings.ts:…": "label truncation ellipsis, not the idle mark",
    "ui/graph/names.ts:…": "name truncation ellipsis, not the idle mark",
    "ui/detail.ts:×": "close button label for the detail drawer: a control, not a worktree-state mark",
    "ui/doctor.ts:✓": "doctor check pass mark: a check result, not a worktree state",
    "ui/onboarding.ts:✓": "onboarding check pass mark: a check result, not a worktree state",
    "ui/graph/api.ts:?": "git porcelain status code for an untracked file",
    "ui/graph/inspector.ts:?": "git porcelain status code for an untracked file",
    "ui/loom/map.ts:?": "minified prototype source; the literal is not a displayed mark",
  };
  test("only glyphs.ts (and the allowlist) quote single-character marks", () => {
    const re = new RegExp(`(["'\`])([${MARKS}])\\1`, "g");
    const hits: string[] = [];
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f);
      if (rel === "glyphs.ts") continue;
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(re)) {
        const key = `${rel}:${m[2]}`;
        if (!(key in ALLOWLIST)) hits.push(key);
      }
    }
    expect([...new Set(hits)]).toEqual([]);
  });
  test("every allowlist entry still matches a literal and carries a reason", () => {
    for (const [key, why] of Object.entries(ALLOWLIST)) {
      expect(why.length).toBeGreaterThan(10);
      const i = key.lastIndexOf(":");
      const text = readFileSync(join(SRC, key.slice(0, i)), "utf8");
      const lit = key.slice(i + 1);
      expect(new RegExp(`(["'\`])${lit.replace("?", "\\?")}\\1`).test(text), key).toBe(true);
    }
  });
});

describe("styles.css hooks", () => {
  test("the lane hook selectors appear in the stylesheet", () => {
    const css = stripComments(readFileSync(join(process.cwd(), "src/styles.css"), "utf8"));
    const selectors = parseRules(css).map((r) => r.selector).join("\n");
    for (const hook of [".project-lane.flat", ".project-rejoin", ".project-landgap", ".project-tail", ".project-lane.hatched"]) {
      expect(selectors, hook).toContain(hook);
    }
    for (const e of allEntries) if (e.hook) expect(css, e.hook).toContain(e.hook);
  });
});

describe("swatch geometry is the lane geometry", () => {
  test("rejoin swatches use rejoinPath, and the hatched swatch tiles HATCH", () => {
    const find = (id: string) => GLYPH_GROUPS.flatMap((g) => g.entries).find((x) => x.swatch?.kind === "dash" && x.swatch.id === id)!;
    const d = swatchSvg(find("rejoin"))!.querySelector("path")!.getAttribute("d");
    expect(d).toBe(rejoinPath(2, 8, 20, 14));
    expect(rejoinPath(1, 2, 3, 4)).toBe("M 1 2 C 3 2, 3 2, 3 4");
    const hatch = swatchSvg(find("hatched"))!;
    const pat = hatch.querySelector("pattern")!;
    expect(pat.getAttribute("width")).toBe(String(HATCH.size));
    expect(pat.querySelector("path")!.getAttribute("d")).toBe(HATCH.d);
  });
  test("the stylesheet no longer carries a dasharray the glyph table owns", () => {
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(css).not.toMatch(/\.project-lane\.flat \.project-run\s*\{[^}]*stroke-dasharray/);
  });
});
