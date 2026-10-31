// Shared fixtures for the Project altitude tests. Row shapes mirror
// WorktreeLifetimeView (docs/contracts.md "GET /worktrees (additive)").
import type { WorktreeLifetimeView, WorktreeMark, WorktreeSessionRef } from "../../api";

export const NOW = Date.parse("2026-10-31T12:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

export const iso = (ms: number): string => new Date(ms).toISOString();

export function row(over: Partial<WorktreeLifetimeView> = {}): WorktreeLifetimeView {
  return {
    repo_id: "repoA",
    worktree_id: "wt-x",
    first_time: iso(NOW - D),
    last_time: iso(NOW),
    sessions: [],
    sessions_total: 0,
    paths: [],
    paths_total: 0,
    signal_events: 0,
    meta_events: 0,
    marks: [],
    marks_total: 0,
    marks_available: true,
    state: "open",
    ...over,
  };
}

const ref = (source: string, id: string, first: number, last: number, events: number): WorktreeSessionRef => ({
  source, session_id: id, first_time: iso(first), last_time: iso(last), events,
});
const mark = (kind: WorktreeMark["kind"], t: number, id: string): WorktreeMark => ({
  kind, time: iso(t), event_id: id,
});

const landedMarks = [
  mark("worktree_add", NOW - 5 * D - H, "m-add"),
  mark("commit", NOW - 4.5 * D, "m-commit"),
  mark("push", NOW - 3.5 * D, "m-push"),
  mark("pr_create", NOW - 3.2 * D, "m-pr"),
  mark("pr_merge", NOW - 3 * D, "m-merge"),
];

export const FIXTURE_ROWS: WorktreeLifetimeView[] = [
  row({
    worktree_id: "wt-landed", label: "/w/alpha-landed", state: "landed", outcome: "landed",
    first_time: iso(NOW - 5 * D), last_time: iso(NOW - 3 * D), behind: 2, ahead: 0,
    sessions: [ref("codex", "s-l1", NOW - 5 * D, NOW - 4 * D, 40), ref("claude-code", "s-l2", NOW - 4 * D, NOW - 3 * D, 10)],
    sessions_total: 2, signal_events: 50, marks: landedMarks, marks_total: landedMarks.length,
  }),
  row({
    worktree_id: "wt-open", label: "/w/alpha-open", state: "open",
    first_time: iso(NOW - 2 * D), last_time: iso(NOW - 30 * MIN), ahead: 3, behind: 1, dirty: true,
    sessions: [ref("codex", "s-o1", NOW - 2 * D, NOW - 30 * MIN, 50)],
    sessions_total: 2, signal_events: 50, meta_events: 12,
  }),
  row({
    worktree_id: "wt-idle", label: "/w/alpha-idle", state: "open",
    first_time: iso(NOW - 6 * D), last_time: iso(NOW - D), ahead: 2,
    sessions: [ref("claude-code", "s-i1", NOW - 6 * D, NOW - D, 20)], sessions_total: 1, signal_events: 20,
  }),
  row({
    worktree_id: "wt-gone", label: "/w/alpha-gone", state: "gone", outcome: "abandoned",
    first_time: iso(NOW - 4 * D), last_time: iso(NOW - 2 * D),
  }),
  row({
    worktree_id: "wt-never", label: "/w/alpha-never", state: "never_diverged", outcome: "never_diverged", ahead: 0,
    first_time: iso(NOW - D), last_time: iso(NOW - 20 * H),
  }),
  row({
    worktree_id: "wt-unk", state: "unknown", state_reason: "repository not registered",
    first_time: iso(NOW - 2 * D), last_time: iso(NOW - D),
  }),
  row({
    repo_id: "repoB", worktree_id: "wt-b1", label: "/w/beta-1", state: "open", ahead: 1,
    first_time: iso(NOW - D), last_time: iso(NOW - 10 * MIN),
    sessions: [ref("codex", "s-b1", NOW - D, NOW - 10 * MIN, 5)], sessions_total: 1,
  }),
];

export const ROW_ORDER_A = ["wt-idle", "wt-landed", "wt-gone", "wt-open", "wt-unk", "wt-never"];
