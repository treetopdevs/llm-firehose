// Pure geometry for the Project altitude: one repository, worktree lanes that
// leave and rejoin main through a time window. DOM-free. It never infers
// causality or handoffs; commit-to-session attribution is a labelled time join.
import type { WorktreeCommit, WorktreeLifetimeView, WorktreeMark, WorktreeOutcome, WorktreeState } from "../../api";
import { DEFAULT_LIVE_SPAN_MS, resolveRange } from "../../scope";
import type { ScopeWindow } from "../../scope";
import { idLabel } from "../../format";

export const LIVE_SPAN_MS = DEFAULT_LIVE_SPAN_MS;
export const IDLE_AFTER_MS = 4 * 3_600_000;
export const MIN_BEAD_PX = 6;
export const MIN_BRUSH_PX = 4;
export const LABEL_X = 8;
/** Clear space between the label column and the chart origin. */
export const LABEL_PAD = 8;
const LABEL_CHAR_PX = 6.5;
/** Widest a lane label may render: from LABEL_X up to LABEL_PAD short of x0. */
export const labelMaxWidth = (x0: number): number => Math.max(0, x0 - LABEL_X - LABEL_PAD);
/** Longest lane label, in characters, that fits labelMaxWidth. */
export const labelMaxChars = (x0: number): number => Math.max(2, Math.floor(labelMaxWidth(x0) / LABEL_CHAR_PX));

export interface TimeRange { from: number; to: number }
export type LaneEnd = "rejoin" | "open" | "gone" | "flat" | "hatched";

export interface LaneBead { session: string; source: string; x: number; w: number; t0: number; t1: number; events: number }
export interface LaneTick { kind: "commit_mark" | "commit"; x: number; t: number; id: string; session?: string }
export interface LaneGlyph { kind: "push" | "pr_create" | "pr_merge"; x: number; t: number; id: string }

export interface LaneGeom {
  id: string;
  repoId: string;
  label: string;
  ariaLabel: string;
  state: WorktreeState;
  end: LaneEnd;
  forkX: number;
  /** Where captured activity ends (last_time). Never a landing time. */
  endX: number;
  /** Rejoin position for a landed lane: the pr_merge mark's time when one exists, else the lane end. */
  rejoinX: number;
  /** True only when rejoinX comes from a pr_merge mark; otherwise the landing time is unknown. */
  rejoinKnown: boolean;
  outcome?: WorktreeOutcome;
  tailX?: number;
  clippedLeft: boolean;
  clippedRight: boolean;
  beads: LaneBead[];
  ticks: LaneTick[];
  glyphs: LaneGlyph[];
  badge: string;
  idle: boolean;
  tooltip: string;
}

const time = (s: string | undefined): number => (s === undefined ? NaN : Date.parse(s));
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function resolveWindow(w: ScopeWindow, now: number, liveSpanMs: number = DEFAULT_LIVE_SPAN_MS): TimeRange {
  return resolveRange(w, now, liveSpanMs);
}

export function timeToX(t: number, range: TimeRange, x0: number, x1: number): number {
  const span = range.to - range.from;
  if (!(span > 0)) return x0;
  return x0 + ((t - range.from) / span) * (x1 - x0);
}

export function xToTime(x: number, range: TimeRange, x0: number, x1: number): number {
  const span = x1 - x0;
  if (!(span > 0)) return range.from;
  return range.from + ((clamp(x, x0, x1) - x0) / span) * (range.to - range.from);
}

/** Client pixel to viewBox unit; a zero-width rect falls back to the raw offset. */
export function viewX(clientX: number, rect: { left: number; width: number }, viewW: number): number {
  if (!(rect.width > 0)) return clientX - rect.left;
  return ((clientX - rect.left) / rect.width) * viewW;
}

export function brushWindow(a: number, b: number, range: TimeRange, x0: number, x1: number): { from: number; to: number } | null {
  const lo = clamp(Math.min(a, b), x0, x1);
  const hi = clamp(Math.max(a, b), x0, x1);
  if (hi - lo < MIN_BRUSH_PX) return null;
  return { from: xToTime(lo, range, x0, x1), to: xToTime(hi, range, x0, x1) };
}

function repoLast(rows: readonly WorktreeLifetimeView[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const t = time(r.last_time);
    const cur = m.get(r.repo_id);
    const v = Number.isFinite(t) ? t : -Infinity;
    if (cur === undefined || v > cur) m.set(r.repo_id, v);
  }
  return m;
}

/** Distinct repo ids, newest last_time first, ties by repo_id ascending. */
export function repoIds(rows: readonly WorktreeLifetimeView[]): string[] {
  const m = repoLast(rows);
  return [...m.keys()].sort((a, b) => (m.get(b)! - m.get(a)!) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The scoped project when it is a known repo, else the newest repo. */
export function pickRepo(rows: readonly WorktreeLifetimeView[], projectId?: string): string | undefined {
  const ids = repoIds(rows);
  if (projectId !== undefined && ids.includes(projectId)) return projectId;
  return ids[0];
}

/** Stable lane order: existing ids keep their slot, new ids append by first_time then id. */
export function orderLanes(prev: readonly string[] | undefined, rows: readonly WorktreeLifetimeView[]): string[] {
  const present = new Map(rows.map((r) => [r.worktree_id, r]));
  const kept = (prev ?? []).filter((id, i, a) => present.has(id) && a.indexOf(id) === i);
  const keptSet = new Set(kept);
  const fresh = [...present.values()].filter((r) => !keptSet.has(r.worktree_id));
  const ft = (r: WorktreeLifetimeView) => { const t = time(r.first_time); return Number.isFinite(t) ? t : Infinity; };
  fresh.sort((a, b) => {
    const d = ft(a) - ft(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return a.worktree_id < b.worktree_id ? -1 : a.worktree_id > b.worktree_id ? 1 : 0;
  });
  return [...kept, ...fresh.map((r) => r.worktree_id)];
}

/** Open, ahead of main, nothing recent: the "forgot about it" signal. */
export function isIdleWorker(row: WorktreeLifetimeView, now: number): boolean {
  if (row.state !== "open" || !(row.ahead !== undefined && row.ahead > 0)) return false;
  const cutoff = now - IDLE_AFTER_MS;
  if (row.sessions.some((s) => time(s.last_time) >= cutoff)) return false;
  return !(time(row.last_time) >= cutoff);
}

export function axisTicks(range: TimeRange, x0: number, x1: number, n = 6): Array<{ x: number; t: number; label: string }> {
  const count = Math.max(2, Math.floor(n));
  const span = range.to - range.from;
  const short = span <= 2 * 24 * 3_600_000;
  return Array.from({ length: count }, (_, i) => {
    const f = i / (count - 1);
    const t = range.from + f * span;
    const iso = new Date(t).toISOString();
    const label = Number.isFinite(t) ? (short ? iso.slice(11, 16) : iso.slice(5, 10)) : "?";
    return { x: x0 + f * (x1 - x0), t, label };
  });
}

const END: Record<WorktreeState, LaneEnd> = { landed: "rejoin", open: "open", gone: "gone", never_diverged: "flat", unknown: "hatched" };

function badgeOf(r: WorktreeLifetimeView): string {
  if (r.state !== "open") return r.dirty ? "±" : "";
  const parts: string[] = [];
  if ((r.ahead ?? 0) > 0) parts.push(`↑${r.ahead}`);
  if ((r.behind ?? 0) > 0) parts.push(`↓${r.behind}`);
  if (r.dirty) parts.push("±");
  return parts.join(" ");
}

function tooltipOf(r: WorktreeLifetimeView, label: string, extra: string[]): string {
  const lines = [label, `state: ${r.state}`];
  if (r.outcome) lines.push(`outcome: ${r.outcome}`);
  if (r.state_reason) lines.push(`reason: ${r.state_reason}`);
  if (r.ahead !== undefined) lines.push(`ahead ${r.ahead}`);
  if (r.behind !== undefined) lines.push(`behind ${r.behind}`);
  if (r.dirty) lines.push("dirty: uncommitted changes");
  lines.push(`sessions ${r.sessions_total}`, `signal events ${r.signal_events}`, `cost (meta events): ${r.meta_events}`);
  if (!r.marks_available) lines.push("exact lifecycle marks unavailable in this privacy mode");
  return [...lines, ...extra].join("\n");
}

export function layoutLanes(
  rows: readonly WorktreeLifetimeView[],
  order: readonly string[],
  range: TimeRange,
  x0: number,
  x1: number,
  now: number,
  commits?: Readonly<Record<string, readonly WorktreeCommit[]>>,
): LaneGeom[] {
  const byId = new Map(rows.map((r) => [r.worktree_id, r]));
  const X = (t: number) => clamp(timeToX(t, range, x0, x1), x0, x1);
  const inRange = (t: number) => Number.isFinite(t) && t >= range.from && t <= range.to;
  const out: LaneGeom[] = [];
  for (const id of order) {
    const r = byId.get(id);
    if (!r) continue;
    const first = time(r.first_time);
    const addMarks = r.marks.filter((m): m is WorktreeMark => m.kind === "worktree_add").map((m) => time(m.time)).filter(Number.isFinite);
    const forkT = Math.min(...[first, ...addMarks].filter(Number.isFinite));
    if (!Number.isFinite(forkT)) continue;
    const lastRaw = time(r.last_time);
    const lastT = Number.isFinite(lastRaw) ? Math.max(forkT, lastRaw) : forkT;
    const end = END[r.state] ?? "hatched";
    const open = end === "open";
    // Landing evidence is only a pr_merge mark's own time; last_time is activity, not a landing.
    const mergeTimes = end === "rejoin" ? r.marks.filter((m) => m.kind === "pr_merge").map((m) => time(m.time)).filter(Number.isFinite) : [];
    const mergeT = mergeTimes.length ? Math.max(...mergeTimes) : undefined;
    const extentT = mergeT === undefined ? lastT : Math.max(lastT, mergeT);
    if (forkT > range.to) continue;
    if (!open && extentT < range.from) continue;
    const label = r.label ?? idLabel(r.worktree_id);
    const beads: LaneBead[] = [];
    for (const s of r.sessions) {
      const t0 = time(s.first_time);
      const t1 = time(s.last_time);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const hi = Math.max(t0, t1);
      if (hi < range.from || t0 > range.to) continue;
      const bx = X(t0);
      const w = Math.max(MIN_BEAD_PX, X(hi) - bx);
      beads.push({ session: s.session_id, source: s.source, x: bx, w, t0, t1: hi, events: s.events });
    }
    const ticks: LaneTick[] = [];
    const glyphs: LaneGlyph[] = [];
    for (const m of r.marks) {
      const t = time(m.time);
      if (!inRange(t)) continue;
      if (m.kind === "commit") ticks.push({ kind: "commit_mark", x: timeToX(t, range, x0, x1), t, id: m.event_id, ...(m.session_id ? { session: m.session_id } : {}) });
      else if (m.kind === "push" || m.kind === "pr_create" || m.kind === "pr_merge") glyphs.push({ kind: m.kind, x: timeToX(t, range, x0, x1), t, id: m.event_id });
    }
    glyphs.sort((a, b) => a.t - b.t);
    const extra: string[] = [];
    const cs = commits?.[id];
    if (cs) {
      let untimed = 0;
      for (const c of cs) {
        const t = time(c.time);
        if (!Number.isFinite(t)) { untimed++; continue; }
        if (!inRange(t)) continue;
        ticks.push({ kind: "commit", x: timeToX(t, range, x0, x1), t, id: c.commit_id, ...(c.session_id ? { session: c.session_id } : {}) });
      }
      extra.push("commits attributed to sessions by time join");
      if (untimed > 0) extra.push(`${untimed} commit${untimed === 1 ? "" : "s"} without time`);
    }
    ticks.sort((a, b) => a.t - b.t);
    if (end === "rejoin") {
      extra.unshift(mergeT === undefined ? "landed (time unknown)" : `landed at ${new Date(mergeT).toISOString()} (pr_merge mark time)`);
      extra.push(`activity ended ${r.last_time}`);
    }
    const lane: LaneGeom = {
      id,
      repoId: r.repo_id,
      label,
      ariaLabel: `${label}, ${r.state}`,
      state: r.state,
      end,
      forkX: X(forkT),
      endX: X(lastT),
      rejoinX: X(mergeT ?? lastT),
      rejoinKnown: mergeT !== undefined,
      ...(r.outcome ? { outcome: r.outcome } : {}),
      clippedLeft: forkT < range.from,
      clippedRight: open ? now > range.to : extentT > range.to,
      beads,
      ticks,
      glyphs,
      badge: badgeOf(r),
      idle: isIdleWorker(r, now),
      tooltip: tooltipOf(r, label, extra),
    };
    if (open) lane.tailX = x1;
    out.push(lane);
  }
  return out;
}
