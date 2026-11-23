// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AttentionSession, WorktreeLifetimeView } from "../../api";
import { __resetKeysForTests } from "../../keys";
import { createScope } from "../../scope";
import type { Roots } from "../actions/roots";
import { createFleet } from "./index";
import type { FleetApi, FleetPanel } from "./index";
import { NOW, att, iso, row } from "./model.fixtures";
import { buildFleet, rangeBuckets, rowActiveIn } from "./model";

const H = 3_600_000;
const D = 24 * H;

const roots = (labels: Record<string, string>, loaded = true): Roots => ({
  refresh: async () => ({ ok: true, revision: 1, repos: [] }),
  loaded: () => loaded,
  resolved: (id) => id !== undefined && id in labels,
  rawLabel: (id) => (id === undefined ? undefined : labels[id]),
  view: () => undefined,
  list: () => Object.entries(labels).map(([id, label]) => ({ id, label })),
  subscribe: () => () => {},
});

const worked = (repo_id: string, agoMs: number, spanMs = H): WorktreeLifetimeView =>
  row({
    repo_id, worktree_id: `${repo_id}/wt`, last_time: iso(NOW - agoMs), first_time: iso(NOW - agoMs - spanMs), sessions_total: 1,
    sessions: [{ source: "claude-code", session_id: `${repo_id}-s`, first_time: iso(NOW - agoMs - spanMs), last_time: iso(NOW - agoMs), events: 2 }],
  });

describe("who needs you is one rule", () => {
  test("a request past the freshness limit is not a need in the list", () => {
    const old = att({ id: "old", repo_id: "repoA", waitMs: 27 * D, lastAgoMs: 27 * D });
    const r = buildFleet({ worktrees: [worked("repoA", H)], sessions: [old], now: NOW });
    expect(r.needs).toEqual([]);
    expect(r.rows[0]!.needsCount).toBe(0);
    expect(r.rows[0]!.failed).toBe(false);
  });
});

describe("the list and the sidebar name the same projects", () => {
  const input = { sessions: [] as AttentionSession[], now: NOW };

  test("only registered projects are tracked, plus anything live", () => {
    const r = buildFleet({ ...input, worktrees: [worked("reg", H), worked("/old/repo/.git", 9 * D), worked("/busy/.git", 9 * D)], sessions: [att({ id: "w", repo_id: "/busy/.git" })], isTracked: (id) => id === "reg" });
    const tracked = Object.fromEntries(r.rows.map((x) => [x.id, x.tracked]));
    expect(tracked).toEqual({ reg: true, "/old/repo/.git": false, "/busy/.git": true });
  });

  test("an untracked project sharing a name says where it lives; the registered one keeps its name", () => {
    const r = buildFleet({
      ...input, worktrees: [worked("/home/me/dev/app/.git", H), worked("/opt/htdocs/app/.git", 9 * D)],
      isTracked: (id) => id.startsWith("/home"),
      resolveLabel: () => "app",
      resolvePath: (id) => id,
    });
    expect(r.rows.find((x) => x.tracked)!.label).toBe("app");
    expect(r.rows.find((x) => !x.tracked)!.label).toBe("app · htdocs");
  });

  test("two tracked projects sharing a name are both told apart", () => {
    const r = buildFleet({
      ...input, worktrees: [worked("/a/one/app/.git", H), worked("/b/two/app/.git", 2 * H)],
      resolveLabel: () => "app", resolvePath: (id) => id,
    });
    expect(r.rows.map((x) => x.label).sort()).toEqual(["app · one", "app · two"]);
  });
});

describe("the time range", () => {
  test("a row is active in a range its session spans overlap", () => {
    const [x] = buildFleet({ worktrees: [worked("repoA", 2 * D, H)], sessions: [], now: NOW }).rows;
    expect(rowActiveIn(x!, NOW - 2 * D - 30 * 60_000, NOW - 2 * D + 30 * 60_000)).toBe(true);
    expect(rowActiveIn(x!, NOW - 5 * D, NOW - 4 * D)).toBe(false);
  });

  test("a capped session list falls back to the worktree's first and last activity", () => {
    const capped = { ...worked("repoA", H), first_time: iso(NOW - 9 * D), sessions_total: 40 };
    const [x] = buildFleet({ worktrees: [capped], sessions: [], now: NOW }).rows;
    expect(rowActiveIn(x!, NOW - 5 * D, NOW - 4 * D)).toBe(true);
  });

  test("the sparkline spans the range", () => {
    const [x] = buildFleet({ worktrees: [worked("repoA", 2 * D, H)], sessions: [], now: NOW }).rows;
    const counts = rangeBuckets(x!, NOW - 3 * D, NOW - D);
    expect(counts).toHaveLength(14);
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(rangeBuckets(x!, NOW - 6 * D, NOW - 5 * D).every((n) => n === 0)).toBe(true);
  });
});

describe("the All projects list", () => {
  const panels: FleetPanel[] = [];
  function mount(rows: WorktreeLifetimeView[], store = createScope(), r?: Roots, sessions: AttentionSession[] = []) {
    const api = { worktrees: async () => rows, attention: async () => ({ sessions, warnings: [] }), sessions: async () => [] } as unknown as FleetApi;
    const panel = createFleet({ store, go: vi.fn() as never, events: () => [], api, now: () => NOW, refreshMs: 15_000, loadTimeoutMs: 5_000, roots: r });
    document.body.append(panel.root);
    panels.push(panel);
    const names = () => [...panel.root.querySelectorAll(".fleet-row-label")].map((n) => n.textContent);
    return { panel, store, names, q: (s: string) => panel.root.querySelector<HTMLElement>(s) };
  }
  beforeEach(() => { __resetKeysForTests(); vi.useFakeTimers(); });
  afterEach(() => { for (const p of panels.splice(0)) p.deactivate(); document.body.replaceChildren(); __resetKeysForTests(); vi.useRealTimers(); });

  const three = () => [worked("reg", H), worked("/old/one/.git", 9 * D), worked("/old/two/.git", 10 * D)];
  const reg = { reg: "/home/me/dev/reg" };

  test("older unregistered projects wait behind one line", async () => {
    const { panel, names, q } = mount(three(), createScope(), roots(reg));
    await panel.activate();
    expect(names()).toEqual(["reg"]);
    expect(q(".fleet-older")!.textContent).toContain("2 more from older history");
    q(".fleet-older button")!.click();
    expect(names()).toEqual(["reg", "one", "two"]);
    q(".fleet-older button")!.click();
    expect(names()).toEqual(["reg"]);
  });

  test("nothing is hidden before the registered list is known, or when none is registered", async () => {
    const before = mount(three(), createScope(), roots(reg, false));
    await before.panel.activate();
    expect(before.names()).toHaveLength(3);
    before.panel.deactivate();
    const none = mount(three(), createScope(), roots({}));
    await none.panel.activate();
    expect(none.names()).toHaveLength(3);
    expect(none.q(".fleet-older")).toBeNull();
  });

  test("hiding the older rows drops a selection inside them", async () => {
    const { panel, q } = mount(three(), createScope(), roots(reg));
    await panel.activate();
    q(".fleet-older button")!.click();
    panel.selectKey("row:/old/one/.git");
    expect(panel.selectedKey()).toBe("row:/old/one/.git");
    q(".fleet-older button")!.click();
    expect(panel.selectedKey()).toBeUndefined();
    expect(panel.selectableKeys()).not.toContain("row:/old/one/.git");
  });

  test("a range lists only the projects active in it and says so", async () => {
    const rows = [worked("in", 2 * D, H), worked("out", H)];
    const store = createScope();
    const { panel, names, q } = mount(rows, store);
    await panel.activate();
    expect(names()).toHaveLength(2);
    store.narrow({ window: { from: NOW - 2 * D - H, to: NOW - 2 * D } });
    expect(names()).toEqual(["in"]);
    expect(q(".fleet-range-note")!.textContent).toBe("1 of 2 projects active in this range");
    store.narrow({ window: "live" });
    expect(names()).toHaveLength(2);
    expect(q(".fleet-range-note")).toBeNull();
  });

  test("Live with a chosen span reads the same way the session list does", async () => {
    const store = createScope();
    const { panel, names, q } = mount([worked("recent", H), worked("quiet", 3 * D)], store);
    await panel.activate();
    store.narrow({ window: "live", liveSpanMs: 8 * H });
    expect(names()).toEqual(["recent"]);
    expect(q(".fleet-range-note")!.textContent).toBe("1 of 2 projects active in this range");
  });

  test("a project known only from a working session stays listed in a live span", async () => {
    const store = createScope();
    const { panel, names } = mount([worked("quiet", 3 * D)], store, undefined, [att({ id: "w", repo_id: "repoZ", repo: "zeta" })]);
    await panel.activate();
    store.narrow({ window: "live", liveSpanMs: 8 * H });
    expect(names()).toEqual(["zeta"]);
  });

  test("a row that ages out of a live span leaves on the next refresh", async () => {
    const store = createScope({ window: "live", liveSpanMs: 2 * H });
    let now = NOW;
    const rows = [worked("aging", H)];
    const api = { worktrees: async () => rows, attention: async () => ({ sessions: [], warnings: [] }), sessions: async () => [] } as unknown as FleetApi;
    const panel = createFleet({ store, go: vi.fn() as never, events: () => [], api, now: () => now, refreshMs: 15_000, loadTimeoutMs: 5_000 });
    document.body.append(panel.root);
    panels.push(panel);
    await panel.activate();
    expect(panel.root.querySelectorAll(".fleet-row")).toHaveLength(1);
    now = NOW + 2 * H;
    await panel.refresh();
    expect(panel.root.querySelectorAll(".fleet-row")).toHaveLength(0);
    expect(panel.root.querySelector(".fleet-range-note")!.textContent).toBe("No project activity in this range");
  });

  test("a range with nothing in it says so", async () => {
    const store = createScope();
    const { panel, names, q } = mount([worked("x", H)], store);
    await panel.activate();
    store.narrow({ window: { from: NOW - 9 * D, to: NOW - 8 * D } });
    expect(names()).toEqual([]);
    expect(q(".fleet-range-note")!.textContent).toBe("No project activity in this range");
  });

  test("something that needs you stays listed outside the range", async () => {
    const store = createScope();
    const { panel, names } = mount([worked("waiting", 5 * D)], store, undefined, [att({ id: "n", repo_id: "waiting", waitMs: 60_000 })]);
    await panel.activate();
    store.narrow({ window: { from: NOW - 9 * D, to: NOW - 8 * D } });
    expect(names()).toEqual(["waiting"]);
  });
});

test("a landed worktree is quiet: only its mark stays green", () => {
  const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
  expect(css).toMatch(/\.fleet-fork\.state-landed \{ color: var\(--text-dim\); \}/);
  expect(css).toMatch(/\.fleet-fork\.state-landed \.fleet-fork-mark \{ color: var\(--ok\); \}/);
});

test("the list can read the shell's shared needs-you snapshot", async () => {
  const shared = vi.fn(async () => ({ sessions: [att({ id: "n", repo_id: "repoA", waitMs: 60_000 })], warnings: [] }));
  const own = vi.fn(async () => ({ sessions: [], warnings: [] }));
  const api = { worktrees: async () => [worked("repoA", H)], attention: own, sessions: async () => [] } as unknown as FleetApi;
  const panel = createFleet({ store: createScope(), go: vi.fn() as never, events: () => [], api, attention: shared, now: () => NOW, refreshMs: 15_000, loadTimeoutMs: 5_000 });
  document.body.append(panel.root);
  await panel.activate();
  expect(shared).toHaveBeenCalled();
  expect(own).not.toHaveBeenCalled();
  expect(panel.root.querySelectorAll(".fleet-need")).toHaveLength(1);
  panel.deactivate();
  panel.root.remove();
});

test("a gone worktree is muted: red is for faults", () => {
  const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
  for (const sel of [".fleet-fork.state-gone", ".project-lane.state-gone"]) {
    const rule = css.match(new RegExp(`${sel.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule, sel).toContain("var(--text-dim)");
    expect(rule, sel).not.toContain("--err");
  }
});
