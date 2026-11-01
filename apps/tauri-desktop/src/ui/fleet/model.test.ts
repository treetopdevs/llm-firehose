import { describe, expect, test } from "vitest";
import type { AttentionSession, WorktreeLifetimeView } from "../../api";
import { FIXTURE_ROWS, NOW, att, iso, row } from "./model.fixtures";
import {
  ENCODINGS, FORK_GLYPH, GLYPH_CAP, IDLE_MARK, NOREPO_KEY, buildFleet, displayRepoLabel, forkOf, longestWaiting, nextNeed, orderIds, repoBuckets, signature, stripOf,
} from "./model";
import type { FleetInput, FleetNeed } from "./model";
import { forkAriaLabel } from "./model";

const MIN = 60_000;
const key = (source: string, id: string) => JSON.stringify([source, id]);
const input = (over: Partial<FleetInput> = {}): FleetInput => ({ worktrees: FIXTURE_ROWS, sessions: [], now: NOW, ...over });
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};

describe("buildFleet rows", () => {
  test("groups /worktrees by repo_id", () => {
    const r = buildFleet(input());
    expect(r.rows.map((x) => [x.id, x.forks.length, x.known])).toEqual([["repoB", 1, true], ["repoA", 6, true]]);
  });

  test("row order is stable across refreshes; new rows append; a vanished repo drops and the rest keep order", () => {
    const first = buildFleet(input());
    expect(first.rows.map((x) => x.id)).toEqual(["repoB", "repoA"]);
    // repoA becomes the newest, but positions persist
    const bumped = FIXTURE_ROWS.map((w) => (w.repo_id === "repoA" ? { ...w, last_time: iso(NOW) } : w));
    const second = buildFleet(input({ worktrees: bumped, order: first.order }));
    expect(second.rows.map((x) => x.id)).toEqual(["repoB", "repoA"]);
    const withC = [...bumped, row({ repo_id: "repoC", worktree_id: "wt-c", last_time: iso(NOW - 5 * 24 * 60 * MIN) })];
    const third = buildFleet(input({ worktrees: withC, order: second.order }));
    expect(third.rows.map((x) => x.id)).toEqual(["repoB", "repoA", "repoC"]);
    const dropped = buildFleet(input({ worktrees: withC.filter((w) => w.repo_id !== "repoB"), order: third.order }));
    expect(dropped.rows.map((x) => x.id)).toEqual(["repoA", "repoC"]);
  });

  test("fork order is stable inside a row", () => {
    const first = buildFleet(input());
    const ids = first.rows.find((x) => x.id === "repoA")!.forks.map((f) => f.id);
    const reversed = [...FIXTURE_ROWS].reverse();
    const second = buildFleet(input({ worktrees: reversed, order: first.order }));
    expect(second.rows.find((x) => x.id === "repoA")!.forks.map((f) => f.id)).toEqual(ids);
    const added = [...FIXTURE_ROWS, row({ worktree_id: "wt-new", first_time: iso(NOW - 1000) })];
    const third = buildFleet(input({ worktrees: added, order: first.order }));
    expect(third.rows.find((x) => x.id === "repoA")!.forks.map((f) => f.id)).toEqual([...ids, "wt-new"]);
  });

  test("lastMs is the newest fork activity", () => {
    const a = buildFleet(input()).rows.find((x) => x.id === "repoA")!;
    expect(a.lastMs).toBe(NOW - 30 * MIN);
  });
});

describe("forkOf", () => {
  const open = FIXTURE_ROWS.find((w) => w.worktree_id === "wt-open")!;
  const idle = FIXTURE_ROWS.find((w) => w.worktree_id === "wt-idle")!;

  test("glyph, state, idle and ariaLabel mirror Project", () => {
    const f = forkOf(open, NOW);
    expect(f.glyph).toBe(FORK_GLYPH.open);
    expect(f.state).toBe("open");
    expect(f.idle).toBe(false);
    expect(f.ariaLabel).toBe("/w/alpha-open, open");
    const i = forkOf(idle, NOW);
    expect(i.idle).toBe(true);
    expect(IDLE_MARK).not.toBe("");
    expect(i.glyph).toBe(FORK_GLYPH.open);
    for (const s of ["open", "landed", "gone", "never_diverged", "unknown"] as const) expect(FORK_GLYPH[s]).toBeTruthy();
  });

  test("cost (meta events) is only in the tooltip, never the aria label", () => {
    const f = forkOf(open, NOW);
    expect(f.tooltip).toContain("cost (meta events): 12");
    expect(f.ariaLabel).not.toContain("cost");
    expect(f.ariaLabel).not.toContain("12");
  });

  test("an unlabelled fork is named by its short id", () => {
    expect(forkOf(row({ worktree_id: "0123456789abcdef" }), NOW).label).toBe("01234567");
  });
});

describe("needs and counts", () => {
  const sessions: AttentionSession[] = [
    att({ id: "n1", repo_id: "repoA", worktree_id: "wt-open", waitMs: 2 * MIN }),
    att({ id: "n2", source: "codex", repo_id: "repoA", waitMs: 9 * MIN }),
    att({ id: "old", repo_id: "repoA", waitMs: 3 * 24 * 60 * MIN, lastAgoMs: 3 * 24 * 60 * MIN }),
    att({ id: "fail", repo_id: "repoB", state: "failed", waitMs: MIN, pending: undefined }),
    att({ id: "w1", repo_id: "repoA", state: "working" }),
    att({ id: "i1", repo_id: "repoA", state: "idle", lastAgoMs: 2 * MIN }),
    att({ id: "i-stale", repo_id: "repoA", state: "idle", lastAgoMs: 30 * MIN }),
  ];

  test("needs-you count and longest dwell, sorted longest first, keyed by [source,id]", () => {
    const r = buildFleet(input({ sessions }));
    const a = r.rows.find((x) => x.id === "repoA")!;
    // The stale "old" request is included (item 6), so it is the longest wait and leads.
    expect(a.needsCount).toBe(3);
    expect(a.longestDwellMs).toBe(3 * 24 * 60 * MIN);
    expect(a.needs.map((n) => n.key)).toEqual([key("claude-code", "old"), key("codex", "n2"), key("claude-code", "n1")]);
    expect(r.needs.map((n) => n.key)[0]).toBe(key("claude-code", "old"));
    // Changed (fleet-altitude item 6): a days-old pending request is no longer dropped, because the
    // attention strip counts it; the row shows it flagged stale instead of silently disagreeing.
    expect(r.needs.find((n) => n.id === "old")!.stale).toBe(true);
    expect(r.needs.find((n) => n.id === "n2")!.stale).toBe(false);
  });

  test("a failure sets failed on the row", () => {
    const r = buildFleet(input({ sessions: [att({ id: "f", repo_id: "repoB", waitMs: MIN, pending: undefined, state: "failed" }), att({ id: "fp", repo_id: "repoB", waitMs: MIN, pending: { event_id: "x", source: "claude-code", kind: "failure", summary: "boom", time: iso(NOW - MIN), observed_at: iso(NOW - MIN) } })] }));
    const b = r.rows.find((x) => x.id === "repoB")!;
    expect(b.failed).toBe(true);
    expect(b.needs.find((n) => n.id === "fp")!.failed).toBe(true);
    expect(buildFleet(input({ sessions })).rows.find((x) => x.id === "repoA")!.failed).toBe(false);
  });

  test("working and idle counts use liveSessions; stale idle is excluded", () => {
    const a = buildFleet(input({ sessions })).rows.find((x) => x.id === "repoA")!;
    expect(a.working).toBe(1);
    expect(a.idle).toBe(1);
  });

  test("a need carries its fork when the session names a worktree", () => {
    const a = buildFleet(input({ sessions })).rows.find((x) => x.id === "repoA")!;
    expect(a.forks.find((f) => f.id === "wt-open")!.needs).toBe(1);
    expect(a.needs.find((n) => n.id === "n1")!.worktreeId).toBe("wt-open");
  });
});

describe("fog and mismatched snapshots", () => {
  test("an attention repo absent from worktrees is a fog row, after known rows", () => {
    const r = buildFleet(input({ sessions: [att({ id: "g", repo_id: "ghost-repo-id-123", repo: "ghosty", waitMs: MIN })] }));
    expect(r.rows.map((x) => x.id)).toEqual(["repoB", "repoA", "ghost-repo-id-123"]);
    const fog = r.rows[2];
    expect(fog.known).toBe(false);
    expect(fog.forks).toEqual([]);
    expect(fog.label).toBe("ghosty");
    expect(fog.needsCount).toBe(1);
    expect(buildFleet(input({ sessions: [att({ id: "g", repo_id: "ghost-repo-id-123", waitMs: MIN })] })).rows[2].label).toBe("ghost-re");
  });

  test("a refresh that gains the repo keeps the slot and becomes known", () => {
    const sessions = [att({ id: "g", repo_id: "repoZ", repo: "zed", waitMs: MIN }), att({ id: "h", repo_id: "repoY", repo: "why", waitMs: MIN })];
    const first = buildFleet(input({ sessions }));
    expect(first.rows.map((x) => [x.id, x.known])).toEqual([["repoB", true], ["repoA", true], ["repoY", false], ["repoZ", false]]);
    const gained = [...FIXTURE_ROWS, row({ repo_id: "repoZ", worktree_id: "wt-z", last_time: iso(NOW) })];
    const second = buildFleet(input({ worktrees: gained, sessions, order: first.order }));
    expect(second.rows.map((x) => [x.id, x.known])).toEqual([["repoB", true], ["repoA", true], ["repoY", false], ["repoZ", true]]);
    expect(second.rows[3].forks.map((f) => f.id)).toEqual(["wt-z"]);
  });

  test("worktrees unavailable makes every attention repo a fog row", () => {
    const r = buildFleet(input({ worktrees: undefined, sessions: [att({ id: "a", repo_id: "repoA", waitMs: MIN }), att({ id: "b", repo_id: "repoB", state: "working" })] }));
    expect(r.rows.map((x) => [x.id, x.known, x.forks.length])).toEqual([["repoA", false, 0], ["repoB", false, 0]]);
  });

  test("an attention worktree absent from the fork list does not invent a fork", () => {
    const r = buildFleet(input({ sessions: [att({ id: "a", repo_id: "repoA", worktree_id: "wt-unseen", waitMs: MIN })] }));
    expect(r.rows.find((x) => x.id === "repoA")!.forks.map((f) => f.id)).not.toContain("wt-unseen");
    expect(r.rows.find((x) => x.id === "repoA")!.needsCount).toBe(1);
  });
});

describe("sessions without a repo id", () => {
  const sessions = [att({ id: "p", waitMs: 3 * MIN }), att({ id: "w", state: "working" })];

  test("a pending one lands in the NOREPO row, last; non-pending ones only in unattributed", () => {
    const r = buildFleet(input({ sessions }));
    const last = r.rows[r.rows.length - 1];
    expect(last.id).toBe(NOREPO_KEY);
    expect(last.label).toBe("No project");
    expect(last.noRepo).toBe(true);
    expect(last.known).toBe(false);
    expect(last.needsCount).toBe(1);
    expect(r.needs.map((n) => n.id)).toEqual(["p"]);
    expect(r.unattributed.map((s) => s.id)).toEqual(["w"]);
  });

  test("no pending session means no NOREPO row", () => {
    const r = buildFleet(input({ sessions: [sessions[1]] }));
    expect(r.rows.some((x) => x.noRepo)).toBe(false);
    expect(r.unattributed.map((s) => s.id)).toEqual(["w"]);
  });
});

describe("labels", () => {
  const s = [att({ id: "g", repo_id: "ghost-repo-id-123", repo: "ghosty", state: "working" })];
  test("resolveLabel wins, then attention.repo, then the short id", () => {
    expect(buildFleet(input({ sessions: s, resolveLabel: (id) => (id === "ghost-repo-id-123" ? "Resolved" : undefined) })).rows[2].label).toBe("Resolved");
    expect(buildFleet(input({ sessions: s, resolveLabel: () => undefined })).rows[2].label).toBe("ghosty");
    expect(buildFleet(input({ sessions: [att({ id: "g", repo_id: "ghost-repo-id-123", state: "working" })] })).rows[2].label).toBe("ghost-re");
    expect(buildFleet(input()).rows[0].label).toBe("repoB".slice(0, 8));
  });
  test("raw-path ids (full privacy) fall back to their last two segments, never an eight-character prefix", () => {
    const raw = "/Users/me/develop/proj";
    const r = buildFleet(input({ sessions: [att({ id: "p", repo_id: raw, state: "working" })] }));
    expect(r.rows.find((x) => x.id === raw)!.label).toBe("develop/proj");
    const fork = forkOf({ ...FIXTURE_ROWS[0]!, label: undefined, worktree_id: "/w/x/alpha-open" } as WorktreeLifetimeView, NOW);
    expect(fork.label).toBe("x/alpha-open");
  });
  test("a throwing resolver is tolerated", () => {
    const r = buildFleet(input({ sessions: s, resolveLabel: () => { throw new Error("nope"); } }));
    expect(r.rows[2].label).toBe("ghosty");
  });
});

describe("repoBuckets", () => {
  test("counts session spans overlapping each bucket, oldest first, ending at now", () => {
    const rows: WorktreeLifetimeView[] = [row({
      repo_id: "r",
      sessions: [{ source: "codex", session_id: "s", first_time: iso(NOW - 3_600_000), last_time: iso(NOW - 1000), events: 1 }],
    })];
    const f = buildFleet({ worktrees: rows, sessions: [], now: NOW }).rows[0];
    const b = repoBuckets(f, NOW);
    expect(b).toHaveLength(14);
    expect(b[13]).toBe(1);
    expect(b.slice(0, 13).every((n) => n === 0)).toBe(true);
    expect(repoBuckets(f, NOW, 7, 24 * 60 * MIN)).toHaveLength(7);
  });
  test("a fog row has no buckets of activity", () => {
    const f = buildFleet({ worktrees: undefined, sessions: [att({ id: "a", repo_id: "x", state: "working" })], now: NOW }).rows[0];
    expect(repoBuckets(f, NOW).every((n) => n === 0)).toBe(true);
  });
});

describe("needs navigation", () => {
  const n = (id: string, dwellMs: number): FleetNeed => ({ key: key("claude-code", id), id, source: "claude-code", repoId: "r", label: id, dwellMs, failed: false, summary: "" });
  const needs = [n("a", 5), n("b", 3), n("c", 1)];
  test("cycles forward with wrap and reverse", () => {
    expect(nextNeed(needs, undefined)?.id).toBe("a");
    expect(nextNeed(needs, needs[0].key)?.id).toBe("b");
    expect(nextNeed(needs, needs[2].key)?.id).toBe("a");
    expect(nextNeed(needs, needs[0].key, -1)?.id).toBe("c");
    expect(nextNeed(needs, undefined, -1)?.id).toBe("c");
    expect(nextNeed(needs, "gone")?.id).toBe("a");
    expect(nextNeed([], undefined)).toBeUndefined();
  });
  test("longestWaiting breaks ties by key", () => {
    expect(longestWaiting([n("b", 5), n("a", 5), n("c", 1)])?.id).toBe("a");
    expect(longestWaiting([])).toBeUndefined();
  });
});

describe("orderIds", () => {
  test("kept ids keep their slot; new known rows by newest, then fog, then no-repo", () => {
    const rows = [
      { id: "fog", known: false, lastMs: 9 },
      { id: NOREPO_KEY, known: false, noRepo: true, lastMs: 9 },
      { id: "new-old", known: true, lastMs: 1 },
      { id: "new-new", known: true, lastMs: 5 },
      { id: "kept", known: true, lastMs: 0 },
    ];
    expect(orderIds(["kept", "gone"], rows)).toEqual(["kept", "new-new", "new-old", "fog", NOREPO_KEY]);
  });
});

describe("signature and purity", () => {
  const sessions = [att({ id: "n", repo_id: "repoA", waitMs: MIN })];
  test("equal for equal derived state, ignoring dwell time", () => {
    const a = buildFleet(input({ sessions }));
    const b = buildFleet(input({ sessions, now: NOW + 5_000 }));
    expect(signature(a)).toBe(signature(b));
  });
  test("differs when fork state, need set, counts or order change", () => {
    const base = signature(buildFleet(input({ sessions })));
    const landed = FIXTURE_ROWS.map((w) => (w.worktree_id === "wt-open" ? { ...w, state: "landed" as const } : w));
    expect(signature(buildFleet(input({ worktrees: landed, sessions })))).not.toBe(base);
    expect(signature(buildFleet(input({ sessions: [...sessions, att({ id: "m", repo_id: "repoA", waitMs: 2 * MIN })] })))).not.toBe(base);
    expect(signature(buildFleet(input({ sessions: [att({ id: "n", repo_id: "repoA", state: "working" })] })))).not.toBe(base);
    const first = buildFleet(input({ sessions }));
    expect(signature(buildFleet(input({ sessions, order: { rows: ["repoB", "repoA"], forks: first.order.forks } })))).not.toBe(base);
  });
  test("buildFleet does not mutate deep-frozen input", () => {
    const frozen = deepFreeze(structuredClone({ worktrees: FIXTURE_ROWS, sessions: [...sessions, att({ id: "u", state: "working" })], now: NOW }));
    expect(() => buildFleet(frozen)).not.toThrow();
  });
  test("ENCODINGS lists the views of the altitude", () => {
    expect(ENCODINGS.length).toBeGreaterThan(1);
    expect(new Set(ENCODINGS).size).toBe(ENCODINGS.length);
  });
});

describe("fork counts (item 2)", () => {
  test("open, idle and needs counts come from forks and needs, not session states", () => {
    const r = buildFleet(input({ sessions: [att({ id: "n1", repo_id: "repoA", worktree_id: "wt-open", waitMs: 2 * MIN })] }));
    const a = r.rows.find((x) => x.id === "repoA")!;
    // wt-open and wt-idle are open; wt-idle is idle (ahead, quiet for a day).
    expect(a.openForks).toBe(2);
    expect(a.idleForks).toBe(1);
    expect(a.needsCount).toBe(1);
    expect(a.goneRecent).toBe(1);
    expect(r.rows.find((x) => x.id === "repoB")!.openForks).toBe(1);
  });

  test("a repo with many open forks and no sessions is not zero", () => {
    const wts = Array.from({ length: 56 }, (_, i) => row({ repo_id: "big", worktree_id: `w${i}`, state: "open", last_time: iso(NOW - MIN) }));
    expect(buildFleet(input({ worktrees: wts })).rows[0]!.openForks).toBe(56);
  });

  test("gone counts only forks that went away in the last seven days", () => {
    const D = 24 * 60 * MIN;
    const wts = [
      row({ repo_id: "g", worktree_id: "g1", state: "gone", last_time: iso(NOW - 2 * D), last_observed: iso(NOW - 2 * D) }),
      row({ repo_id: "g", worktree_id: "g2", state: "gone", last_time: iso(NOW - 9 * D), last_observed: iso(NOW - 9 * D) }),
    ];
    const g = buildFleet(input({ worktrees: wts })).rows[0]!;
    expect(g.goneRecent).toBe(1);
    expect(g.forks.find((f) => f.id === "g2")!.old).toBe(true);
    expect(g.forks.find((f) => f.id === "g1")!.old).toBe(false);
  });
});

describe("glyph strip (item 1)", () => {
  const D = 24 * 60 * MIN;
  const mk = (id: string, state: WorktreeLifetimeView["state"], extra: Partial<WorktreeLifetimeView> = {}) =>
    row({ repo_id: "r", worktree_id: id, label: `/Users/x/proj/.claude/worktrees/${id}`, state, last_time: iso(NOW - MIN), ...extra });
  const wts = [
    mk("gone-recent", "gone", { last_time: iso(NOW - D), last_observed: iso(NOW - D) }),
    mk("gone-old", "gone", { last_time: iso(NOW - 8 * D), last_observed: iso(NOW - 8 * D) }),
    mk("unk", "unknown"),
    mk("never", "never_diverged"),
    mk("open", "open"),
    mk("idle", "open", { ahead: 2, last_time: iso(NOW - D) }),
    mk("landed", "landed"),
  ];
  const fork = (r: ReturnType<typeof buildFleet>["rows"][number]) => r.forks;

  test("order is open+idle, open, landed, never_diverged, unknown, gone; old gone sits behind the overflow", () => {
    const r = buildFleet(input({ worktrees: wts })).rows[0]!;
    const s = stripOf(fork(r), false);
    expect(s.shown.map((f) => f.id)).toEqual(["idle", "open", "landed", "never", "unk", "gone-recent"]);
    expect(s.more).toBe(1);
    expect(s.hidden.map((f) => f.id)).toEqual(["gone-old"]);
  });

  test("expanded shows everything, in the same order", () => {
    const r = buildFleet(input({ worktrees: wts })).rows[0]!;
    const s = stripOf(fork(r), true);
    const ids = s.shown.map((f) => f.id);
    expect(ids.slice(0, 5)).toEqual(["idle", "open", "landed", "never", "unk"]);
    expect(ids.slice(5).sort()).toEqual(["gone-old", "gone-recent"]); // ties keep the row's stable fork order
    expect(s.more).toBe(0);
  });

  test("at most GLYPH_CAP glyphs by default; the rest overflow", () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`w${String(i).padStart(2, "0")}`, "open"));
    const r = buildFleet(input({ worktrees: many })).rows[0]!;
    expect(GLYPH_CAP).toBe(12);
    const s = stripOf(r.forks, false);
    expect(s.shown).toHaveLength(12);
    expect(s.more).toBe(18);
    expect(stripOf(r.forks, true).shown).toHaveLength(30);
  });

  test("short is the last path segment of the label", () => {
    const f = buildFleet(input({ worktrees: wts })).rows[0]!.forks.find((x) => x.id === "open")!;
    expect(f.short).toBe("open");
    expect(f.label).toBe("/Users/x/proj/.claude/worktrees/open");
  });
});

describe("repo labels (item 5)", () => {
  test("a trailing /.git or bare .git segment is stripped for display only", () => {
    expect(displayRepoLabel("browser-life/.git")).toBe("browser-life");
    expect(displayRepoLabel("/Users/n/browser-life/.git")).toBe("/Users/n/browser-life");
    expect(displayRepoLabel(".git")).toBe(".git");
    expect(displayRepoLabel("alpha.git")).toBe("alpha.git");
  });

  test("the row keeps the raw id and shows the stripped label", () => {
    const id = "/Users/n/develop/browser-life/.git";
    const r = buildFleet(input({ worktrees: [row({ repo_id: id, worktree_id: "w" })] })).rows[0]!;
    expect(r.id).toBe(id);
    expect(r.label).toBe("browser-life");
    expect(r.digest).toBe(false);
  });

  test("a digest-only repo id is labelled with its prefix and flagged unregistered", () => {
    const id = "3f9a1c0de5b7a2446f1d8e9c0b7a6d5e4c3b2a190f8e7d6c5b4a39281706f5e4";
    const r = buildFleet(input({ worktrees: [row({ repo_id: id, worktree_id: "w" })] })).rows[0]!;
    expect(r.label).toBe("3f9a1c0d");
    expect(r.digest).toBe(true);
    // A resolved or attention-named repo is not unregistered.
    expect(buildFleet(input({ worktrees: [row({ repo_id: id, worktree_id: "w" })], resolveLabel: () => "Real" })).rows[0]!.digest).toBe(false);
    expect(buildFleet(input({ worktrees: [], sessions: [att({ id: "s", repo_id: id, repo: "named" })] })).rows[0]!.digest).toBe(false);
  });
});

describe("needs-you never silently dropped (item 6)", () => {
  test("a pending session whose repo_id matches no /worktrees row still shows as a unit, on its own fog row", () => {
    const s = att({ id: "orphan", repo_id: "deadbeefcafe0123", waitMs: 40 * 60 * MIN, lastAgoMs: 40 * 60 * MIN });
    const r = buildFleet(input({ sessions: [s] }));
    const row = r.rows.find((x) => x.id === "deadbeefcafe0123")!;
    expect(row.known).toBe(false);
    expect(row.needsCount).toBe(1);
    expect(row.needs[0]!.stale).toBe(true);
    expect(r.needs.map((n) => n.id)).toEqual(["orphan"]);
  });

  test("a pending session with an empty repo_id lands on the No project row even when stale", () => {
    const r = buildFleet(input({ sessions: [att({ id: "e", waitMs: 5 * 24 * 60 * MIN, lastAgoMs: 5 * 24 * 60 * MIN })] }));
    const last = r.rows[r.rows.length - 1]!;
    expect(last.noRepo).toBe(true);
    expect(last.needsCount).toBe(1);
  });

  test("the unit count equals the attention strip's count of pending sessions", () => {
    const sessions = [
      att({ id: "a", repo_id: "repoA", waitMs: 2 * MIN }),
      att({ id: "b", repo_id: "ffffffff00", waitMs: 90 * 60 * MIN, lastAgoMs: 90 * 60 * MIN }),
      att({ id: "c", waitMs: 3 * 24 * 60 * MIN, lastAgoMs: 3 * 24 * 60 * MIN }),
    ];
    const r = buildFleet(input({ sessions }));
    expect(r.rows.reduce((n, x) => n + x.needsCount, 0)).toBe(sessions.filter((s) => s.pending).length);
  });
});

describe("gone age basis (review round 2)", () => {
  const D = 24 * 60 * MIN;
  const g = (id: string, extra: Partial<WorktreeLifetimeView>) => row({ repo_id: "g", worktree_id: id, state: "gone", ...extra });

  test("a worktree quiet for ten days but removed yesterday is recent: last_observed is the basis", () => {
    const r = buildFleet(input({ worktrees: [g("a", { last_time: iso(NOW - 10 * D), last_observed: iso(NOW - D) })] })).rows[0]!;
    expect(r.forks[0]!.old).toBe(false);
    expect(r.goneRecent).toBe(1);
    expect(stripOf(r.forks, false).hidden).toHaveLength(0);
  });

  test("a worktree removed nine days ago is old even if it was active a day before", () => {
    const r = buildFleet(input({ worktrees: [g("a", { last_time: iso(NOW - 9 * D - 1000), last_observed: iso(NOW - 9 * D) })] })).rows[0]!;
    expect(r.forks[0]!.old).toBe(true);
    expect(r.goneRecent).toBe(0);
  });

  test("without last_observed the age is unknown: not hidden by age, not in gone (7d), tallied apart", () => {
    const r = buildFleet(input({ worktrees: [g("a", { last_time: iso(NOW - 30 * D) }), g("b", { last_observed: iso(NOW - D) })] })).rows[0]!;
    const a = r.forks.find((f) => f.id === "a")!;
    expect(a.old).toBe(false);
    expect(a.ageUnknown).toBe(true);
    expect(r.goneRecent).toBe(1);
    expect(r.goneUnknown).toBe(1);
    expect(stripOf(r.forks, false).hidden).toHaveLength(0);
  });
});

describe("fork aria labels carry idle and needs", () => {
  const open = FIXTURE_ROWS.find((w) => w.worktree_id === "wt-open")!;
  const idle = FIXTURE_ROWS.find((w) => w.worktree_id === "wt-idle")!;
  test("forkOf: non-idle unchanged, idle appends ', idle'", () => {
    expect(forkOf(open, NOW).ariaLabel).toBe("/w/alpha-open, open");
    expect(forkOf(idle, NOW).ariaLabel).toBe("/w/alpha-idle, open, idle");
  });
  test("forkAriaLabel appends the need count in words", () => {
    const f = forkOf(open, NOW);
    expect(forkAriaLabel({ ...f, needs: 2 })).toBe(`${f.ariaLabel}, 2 need you`);
    expect(forkAriaLabel({ ...f, needs: 1 })).toBe(`${f.ariaLabel}, 1 needs you`);
    expect(forkAriaLabel({ ...f, needs: 0 })).toBe(f.ariaLabel);
    expect(forkAriaLabel({ ...f, needs: 2 })).not.toMatch(/cost|12/);
  });
});
