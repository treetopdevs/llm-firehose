import { describe, expect, test } from "vitest";
import type { WorktreeCommit } from "../../api";
import { FIXTURE_ROWS, NOW, ROW_ORDER_A, iso, row } from "./model.fixtures";
import {
  IDLE_AFTER_MS, LIVE_SPAN_MS, MIN_BEAD_PX, MIN_BRUSH_PX, axisTicks, brushWindow, isIdleWorker,
  LABEL_PAD, LABEL_X, labelMaxChars, labelMaxWidth, layoutLanes, orderLanes, pickRepo, repoIds, resolveWindow, timeToX, viewX, xToTime,
} from "./model";
import type { TimeRange } from "./model";

const D = 86_400_000;
const H = 3_600_000;
const MIN = 60_000;
const live: TimeRange = { from: NOW - LIVE_SPAN_MS, to: NOW };
const X0 = 100;
const X1 = 1000;
const rowsA = FIXTURE_ROWS.filter((r) => r.repo_id === "repoA");
const byId = (id: string) => FIXTURE_ROWS.find((r) => r.worktree_id === id)!;
const lay = (rows = rowsA, range = live, commits?: Record<string, WorktreeCommit[]>) =>
  layoutLanes(rows, orderLanes(undefined, rows), range, X0, X1, NOW, commits);
const lane = (id: string, range = live, commits?: Record<string, WorktreeCommit[]>) =>
  lay(rowsA, range, commits).find((l) => l.id === id)!;

describe("window and coordinates", () => {
  test("constants", () => {
    expect(LIVE_SPAN_MS).toBe(7 * D);
    expect(IDLE_AFTER_MS).toBe(4 * H);
    expect(MIN_BEAD_PX).toBe(6);
    expect(MIN_BRUSH_PX).toBe(4);
  });

  test("resolveWindow live follows now; explicit is unchanged", () => {
    expect(resolveWindow("live", NOW)).toEqual({ from: NOW - 7 * D, to: NOW });
    expect(resolveWindow("live", NOW + 60000)).toEqual({ from: NOW + 60000 - 7 * D, to: NOW + 60000 });
    expect(resolveWindow({ from: 5, to: 9 }, NOW)).toEqual({ from: 5, to: 9 });
  });

  test("resolveWindow live follows the live span", () => {
    expect(resolveWindow("live", NOW, 2 * H)).toEqual({ from: NOW - 2 * H, to: NOW });
    expect(resolveWindow({ from: 5, to: 9 }, NOW, 2 * H)).toEqual({ from: 5, to: 9 });
  });

  test("timeToX and xToTime", () => {
    expect(timeToX(NOW, live, X0, X1)).toBe(1000);
    expect(timeToX(NOW - 7 * D, live, X0, X1)).toBe(100);
    expect(timeToX(NOW - 3.5 * D, live, X0, X1)).toBe(550);
    expect(xToTime(550, live, X0, X1)).toBe(NOW - 3.5 * D);
    expect(xToTime(0, live, X0, X1)).toBe(live.from);
    expect(xToTime(5000, live, X0, X1)).toBe(live.to);
  });

  test("viewX maps client pixels into viewBox units", () => {
    expect(viewX(250, { left: 10, width: 480 }, 960)).toBe(480);
    expect(viewX(250, { left: 10, width: 0 }, 960)).toBe(240);
  });

  test("brushWindow sorts, rejects tiny drags and clamps", () => {
    expect(brushWindow(550, 325, live, X0, X1)).toEqual({ from: xToTime(325, live, X0, X1), to: xToTime(550, live, X0, X1) });
    expect(brushWindow(550, 552, live, X0, X1)).toBeNull();
    expect(brushWindow(50, 550, live, X0, X1)).toEqual({ from: live.from, to: xToTime(550, live, X0, X1) });
    expect(brushWindow(550, 5000, live, X0, X1)).toEqual({ from: xToTime(550, live, X0, X1), to: live.to });
  });
});

describe("repos and order", () => {
  test("pickRepo", () => {
    expect(pickRepo(FIXTURE_ROWS, "repoA")).toBe("repoA");
    expect(pickRepo(FIXTURE_ROWS)).toBe("repoB");
    expect(pickRepo(FIXTURE_ROWS, "zzz")).toBe("repoB");
    expect(pickRepo([], undefined)).toBeUndefined();
    expect(pickRepo([], "x")).toBeUndefined();
    const tie = [row({ repo_id: "rb", worktree_id: "a" }), row({ repo_id: "ra", worktree_id: "b" })];
    expect(pickRepo(tie)).toBe("ra");
  });

  test("repoIds distinct newest first", () => {
    expect(repoIds(FIXTURE_ROWS)).toEqual(["repoB", "repoA"]);
  });

  test("orderLanes initial order", () => {
    expect(orderLanes(undefined, rowsA)).toEqual(ROW_ORDER_A);
  });

  test("orderLanes is stable against mutation and appends new rows", () => {
    const prev = orderLanes(undefined, rowsA);
    const mutated = rowsA.map((r) => (r.worktree_id === "wt-open" ? { ...r, last_time: iso(NOW + D) } : r));
    const early = row({ worktree_id: "wt-early", first_time: iso(NOW - 30 * D) });
    expect(orderLanes(prev, [...mutated, early])).toEqual([...ROW_ORDER_A, "wt-early"]);
    const gone = mutated.filter((r) => r.worktree_id !== "wt-landed");
    const after = orderLanes(prev, gone);
    expect(after).toEqual(ROW_ORDER_A.filter((i) => i !== "wt-landed"));
    expect(orderLanes(after, [...gone, byId("wt-landed")])).toEqual([...after, "wt-landed"]);
  });
});

describe("isIdleWorker", () => {
  test("cases", () => {
    expect(isIdleWorker(byId("wt-idle"), NOW)).toBe(true);
    expect(isIdleWorker(byId("wt-open"), NOW)).toBe(false);
    expect(isIdleWorker(row({ ahead: 0, last_time: iso(NOW - 2 * D) }), NOW)).toBe(false);
    expect(isIdleWorker(row({ last_time: iso(NOW - 2 * D) }), NOW)).toBe(false);
    expect(isIdleWorker({ ...byId("wt-landed"), ahead: 2 }, NOW)).toBe(false);
    expect(isIdleWorker(row({ ahead: 1, sessions: [], sessions_total: 5, last_time: iso(NOW - H) }), NOW)).toBe(false);
    const edge = (t: number) => row({
      ahead: 1, last_time: iso(NOW - 2 * D),
      sessions: [{ source: "codex", session_id: "s", first_time: iso(t), last_time: iso(t), events: 1 }], sessions_total: 1,
    });
    expect(isIdleWorker(edge(NOW - 4 * H), NOW)).toBe(false);
    expect(isIdleWorker(edge(NOW - 4 * H - 1), NOW)).toBe(true);
    expect(isIdleWorker(row({ ahead: 1, last_time: "garbage" }), NOW)).toBe(true);
  });
});

describe("layoutLanes", () => {
  test("landed lane rejoins", () => {
    const l = lane("wt-landed");
    expect(l.end).toBe("rejoin");
    expect(l.forkX).toBe(timeToX(NOW - 5 * D - H, live, X0, X1));
    expect(l.endX).toBe(timeToX(NOW - 3 * D, live, X0, X1));
    expect(l.tailX).toBeUndefined();
    expect(l.beads).toHaveLength(2);
    expect(l.beads[0].session).toBe("s-l1");
    expect(l.beads[0].source).toBe("codex");
    expect(l.beads[0].x).toBe(timeToX(NOW - 5 * D, live, X0, X1));
    expect(l.beads.every((b) => b.w >= MIN_BEAD_PX)).toBe(true);
    expect(l.ticks.filter((t) => t.kind === "commit_mark")).toHaveLength(1);
    expect(l.glyphs.map((g) => g.kind)).toEqual(["push", "pr_create", "pr_merge"]);
    expect(l.state).toBe("landed");
    expect(l.repoId).toBe("repoA");
  });

  test("open, idle, gone, flat, hatched", () => {
    const o = lane("wt-open");
    expect(o.end).toBe("open");
    expect(o.tailX).toBe(X1);
    expect(o.badge).toBe("↑3 ↓1 ±");
    expect(o.idle).toBe(false);
    expect(lane("wt-idle").idle).toBe(true);
    const g = lane("wt-gone");
    expect(g.end).toBe("gone");
    expect(g.tooltip).toContain("gone");
    expect(g.tooltip).toContain("abandoned");
    const n = lane("wt-never");
    expect(n.end).toBe("flat");
    expect(n.forkX).toBe(timeToX(NOW - D, live, X0, X1));
    expect(n.badge).toBe("");
    const u = lane("wt-unk");
    expect(u.end).toBe("hatched");
    expect(u.tooltip).toContain("repository not registered");
  });

  test("forkT uses the earlier of worktree_add mark and first_time", () => {
    const noMark = layoutLanes([row({ worktree_id: "a", first_time: iso(NOW - 2 * D) })], ["a"], live, X0, X1, NOW)[0];
    expect(noMark.forkX).toBe(timeToX(NOW - 2 * D, live, X0, X1));
    const later = row({
      worktree_id: "b", first_time: iso(NOW - 2 * D),
      marks: [{ kind: "worktree_add", time: iso(NOW - D), event_id: "e" }],
    });
    expect(layoutLanes([later], ["b"], live, X0, X1, NOW)[0].forkX).toBe(timeToX(NOW - 2 * D, live, X0, X1));
  });

  test("clipping", () => {
    const day: TimeRange = { from: NOW - D, to: NOW };
    const ids = lay(rowsA, day).map((l) => l.id);
    expect(ids).not.toContain("wt-landed");
    expect(ids).not.toContain("wt-gone");
    const idle = lane("wt-idle", day);
    expect(idle.clippedLeft).toBe(true);
    expect(idle.forkX).toBe(X0);
    const o = lane("wt-open", live);
    expect(o.clippedLeft).toBe(false);
    expect(o.clippedRight).toBe(false);
    // out-of-range ticks/glyphs dropped
    const win: TimeRange = { from: NOW - 4 * D, to: NOW - 3.4 * D };
    const l = lane("wt-landed", win);
    expect(l.glyphs.map((g) => g.kind)).toEqual(["push"]);
    expect(l.ticks).toHaveLength(0);
    expect(l.clippedLeft).toBe(true);
    expect(l.clippedRight).toBe(true);
    const past: TimeRange = { from: NOW - 6 * D, to: NOW - 5 * D };
    const pi = lane("wt-idle", past);
    expect(pi.tailX).toBe(X1);
    expect(pi.clippedRight).toBe(true);
  });

  test("commit ticks are a separate time join", () => {
    const commits: Record<string, WorktreeCommit[]> = {
      "wt-open": [
        { commit_id: "c1", time: iso(NOW - H), session_id: "s-o1", attribution: "time_join" },
        { commit_id: "c2", attribution: "time_join" },
      ],
    };
    const l = lane("wt-open", live, commits);
    const ticks = l.ticks.filter((t) => t.kind === "commit");
    expect(ticks).toHaveLength(1);
    expect(ticks[0].id).toBe("c1");
    expect(ticks[0].x).toBe(timeToX(NOW - H, live, X0, X1));
    expect(l.tooltip).toContain("time join");
    expect(l.tooltip).toContain("1 commit without time");
    const lm = lane("wt-landed", live, { "wt-landed": [{ commit_id: "c9", time: iso(NOW - 4.5 * D), attribution: "time_join" }] });
    expect(lm.ticks.map((t) => t.kind).sort()).toEqual(["commit", "commit_mark"]);
  });

  test("path-id lane without a label reads as its tail", () => {
    const id = "/Users/nicholas/develop/browser-life/.claude/worktrees/foo";
    const g = layoutLanes([row({ worktree_id: id, first_time: iso(NOW - D) })], [id], live, X0, X1, NOW)[0];
    expect(g.label).toBe("worktrees/foo");
    expect(g.ariaLabel).toBe("worktrees/foo, open");
    expect(g.tooltip.split("\n")[0]).toBe("worktrees/foo");
  });

  test("label column leaves a gutter before x0", () => {
    expect(LABEL_PAD).toBeGreaterThanOrEqual(8);
    for (const x0 of [100, 170, 300]) {
      expect(LABEL_X + labelMaxWidth(x0) + LABEL_PAD).toBeLessThanOrEqual(x0);
      expect(labelMaxChars(x0)).toBeGreaterThan(1);
    }
  });

  test("labels", () => {
    expect(lane("wt-open").label).toBe("/w/alpha-open");
    expect(lane("wt-unk").label).toBe("wt-unk");
    expect(lane("wt-unk").ariaLabel).toBe("wt-unk, unknown");
    expect(lane("wt-open").ariaLabel).toBe("/w/alpha-open, open");
    const long = row({ worktree_id: "abcdefghijkl", first_time: iso(NOW - D) });
    expect(layoutLanes([long], ["abcdefghijkl"], live, X0, X1, NOW)[0].label).toBe("abcdefgh");
  });

  test("tooltip content and meta confinement (D95)", () => {
    const o = lane("wt-open");
    for (const s of ["/w/alpha-open", "state: open", "ahead 3", "behind 1", "sessions 2", "signal events 50"]) expect(o.tooltip).toContain(s);
    const lines = o.tooltip.split("\n");
    expect(lines.filter((x) => x.includes("12"))).toEqual(["cost (meta events): 12"]);
    const { tooltip: _t, ...rest } = o;
    expect(JSON.stringify(rest)).not.toMatch(/meta|12\b/);
    expect(o.tooltip).not.toContain("exact lifecycle marks unavailable");
    const off = layoutLanes([row({ worktree_id: "w", marks_available: false })], ["w"], live, X0, X1, NOW)[0];
    expect(off.tooltip).toContain("exact lifecycle marks unavailable in this privacy mode");
  });
});

describe("axisTicks", () => {
  test("six evenly spaced labelled ticks", () => {
    const t = axisTicks(live, X0, X1);
    expect(t).toHaveLength(6);
    expect(t[0].x).toBe(X0);
    expect(t[5].x).toBe(X1);
    expect(t[0].t).toBe(live.from);
    expect(t[5].t).toBe(live.to);
    for (let i = 1; i < t.length; i++) {
      expect(t[i].x).toBeGreaterThan(t[i - 1].x);
      expect(t[i].t - t[i - 1].t).toBeCloseTo((live.to - live.from) / 5, 3);
    }
    expect(t.every((x) => x.label.length > 0)).toBe(true);
    expect(axisTicks({ from: NOW - 2 * H, to: NOW }, X0, X1).every((x) => x.label.length > 0)).toBe(true);
  });
});

describe("review regressions: landing, outcome, dirty", () => {
  const week = 7 * 24 * 3_600_000;
  const win = { from: NOW - week, to: NOW };
  test("last_time is activity, never a landing time", () => {
    const r = row({ worktree_id: "x", state: "landed", first_time: iso(NOW - 5 * 86_400_000), last_time: iso(NOW - 4 * 86_400_000) });
    const [l] = layoutLanes([r], ["x"], win, 0, 100, NOW);
    expect(l!.rejoinKnown).toBe(false);
    expect(l!.rejoinX).toBe(l!.endX);
    expect(l!.tooltip).toContain("landed (time unknown)");
    // Friday-only window: activity ended Monday, no merge mark, so nothing claims a landing in it.
    const friday = { from: NOW - 86_400_000, to: NOW };
    expect(layoutLanes([r], ["x"], friday, 0, 100, NOW)).toHaveLength(0);
    const merged = row({ worktree_id: "x", state: "landed", first_time: iso(NOW - 5 * 86_400_000), last_time: iso(NOW - 4 * 86_400_000),
      marks: [{ kind: "pr_merge", time: iso(NOW - 3_600_000), event_id: "pm" }], marks_total: 1 });
    const [m] = layoutLanes([merged], ["x"], friday, 0, 100, NOW);
    expect(m!.rejoinKnown).toBe(true);
    expect(m!.rejoinX).toBeGreaterThan(m!.endX);
    expect(m!.tooltip).toContain("pr_merge mark time");
  });
  test("outcome is carried into the geometry", () => {
    const [l] = layoutLanes([row({ worktree_id: "g", state: "gone", outcome: "landed" })], ["g"], win, 0, 100, NOW);
    expect(l!.outcome).toBe("landed");
  });
  test("dirty shows regardless of state", () => {
    for (const state of ["landed", "never_diverged", "gone", "unknown"] as const) {
      const [l] = layoutLanes([row({ worktree_id: "d", state, dirty: true })], ["d"], win, 0, 100, NOW);
      expect(l!.badge).toBe("±");
      expect(l!.tooltip).toContain("dirty");
    }
    const [c] = layoutLanes([row({ worktree_id: "c", state: "landed", dirty: false })], ["c"], win, 0, 100, NOW);
    expect(c!.badge).toBe("");
  });
});

describe("lane aria label carries idle", () => {
  test("idle lane ends ', idle'; others do not", () => {
    const idle = layoutLanes(FIXTURE_ROWS.filter((r) => r.worktree_id === "wt-idle"), ["wt-idle"], live, X0, X1, NOW)[0]!;
    expect(idle.idle).toBe(true);
    expect(idle.ariaLabel).toBe(`${idle.label}, ${"open"}, idle`);
    expect(lane("wt-open").ariaLabel).toBe("/w/alpha-open, open");
  });
});
