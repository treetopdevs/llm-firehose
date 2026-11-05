// The Worktree rung's list: GET /worktrees rows as the panel draws them. DOM-free.
// States are only what the API classified; it holds no landing time, so none is drawn.
import type { WorktreeLifetimeView } from "../api";
import { worktreeName } from "../format";
import { formatAge } from "../spark";
import { badgeOf, worktreeStateText } from "./project/model";

export interface WorktreeRow {
  id: string;
  name: string;
  /** The worktree's path where the label is one, else its id; only the folder name is drawn. */
  title: string;
  stateText: string;
  badge: string;
  ageText: string;
  sessionsText: string;
}

const lastOf = (r: WorktreeLifetimeView): number => {
  const t = Date.parse(r.last_time);
  return Number.isFinite(t) ? t : -Infinity;
};

/** Newest activity first, ties by id, an unreadable time last. */
export function orderWorktrees(rows: readonly WorktreeLifetimeView[]): WorktreeLifetimeView[] {
  return [...rows].sort((a, b) => {
    const [x, y] = [lastOf(a), lastOf(b)];
    if (x !== y) return y > x ? 1 : -1;
    return a.worktree_id < b.worktree_id ? -1 : a.worktree_id > b.worktree_id ? 1 : 0;
  });
}

export function describeWorktree(r: WorktreeLifetimeView, now: number): WorktreeRow {
  const last = Date.parse(r.last_time);
  return {
    id: r.worktree_id,
    name: worktreeName(r.worktree_id, r.label).label,
    title: (r.label || r.worktree_id).replace(/\/\.git\/?$/, ""),
    stateText: worktreeStateText(r),
    badge: badgeOf(r),
    ageText: Number.isNaN(last) ? "no activity time" : formatAge(now - last),
    sessionsText: `${r.sessions_total} session${r.sessions_total === 1 ? "" : "s"} captured`,
  };
}
