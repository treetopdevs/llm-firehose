import type { WorktreeLifetimeView } from "../../api";

/** Complete WorktreeLifetimeView with sane defaults; override via partial. */
export function wt(p: Partial<WorktreeLifetimeView> = {}): WorktreeLifetimeView {
  return {
    repo_id: "repo-1",
    worktree_id: "/w/a",
    first_time: "2026-11-01T10:00:00Z",
    last_time: "2026-11-01T11:00:00Z",
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
    default_target_ref: "main",
    ...p,
  };
}

/** The genuine API shape for a worktree whose repo the graph resolver does not know. */
export function wtUnregistered(p: Partial<WorktreeLifetimeView> = {}): WorktreeLifetimeView {
  return wt({ state: "unknown", state_reason: "repo_unregistered", default_target_ref: undefined, ...p });
}
