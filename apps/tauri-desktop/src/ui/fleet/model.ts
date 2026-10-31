// Pure derivation for the Fleet altitude: one row per repository, forks as
// branches off the row, needs-you and dwell from the same /attention snapshot
// every other view reads. DOM-free. Rows are the union of /worktrees and what
// attention observes, so a repo seen only by attention is drawn as fog (known:
// false), never dropped and never invented a fork.
import type { AttentionSession, WorktreeLifetimeView, WorktreeState } from "../../api";
import { idLabel, sessionName } from "../../format";
import { isFailure } from "../../needs";
import { liveSessions, sessionKey } from "../dwell/model";
import { IDLE_AFTER_MS, isIdleWorker, orderLanes } from "../project/model";

export type Encoding = "map" | "dwell" | "matrix" | "lanes" | "airspace";
export const ENCODINGS: readonly Encoding[] = ["map", "dwell", "matrix", "lanes", "airspace"];

/** One glyph per worktree state; Project and Fleet share the vocabulary. */
export const FORK_GLYPH: Record<WorktreeState, string> = { open: "●", landed: "✓", gone: "×", never_diverged: "·", unknown: "?" };
/** Appended to an open fork that is ahead of main with nothing recent. */
export const IDLE_MARK = "…";
/** Row id for sessions waiting on you that carry no repo_id. */
export const NOREPO_KEY = "__no_repo__";

const SPARK_BUCKETS = 14;
const SPARK_BUCKET_MS = IDLE_AFTER_MS * 3; // 12h: fourteen buckets cover the seven-day live window

export interface FleetFork {
  id: string;
  label: string;
  state: WorktreeState;
  glyph: string;
  idle: boolean;
  ariaLabel: string;
  tooltip: string;
  /** Needs-you sessions attributed to this fork by worktree_id. */
  needs: number;
  lastMs: number;
  spans: Array<{ first: number; last: number }>;
}

export interface FleetNeed {
  /** JSON.stringify([source, id]), as /attention scopes sessions. */
  key: string;
  id: string;
  source: string;
  /** The row this need belongs to (a repo id or NOREPO_KEY). */
  repoId: string;
  worktreeId?: string;
  label: string;
  dwellMs: number;
  failed: boolean;
  summary: string;
}

export interface FleetRow {
  id: string;
  label: string;
  /** True only when /worktrees lists this repo. */
  known: boolean;
  noRepo?: boolean;
  forks: FleetFork[];
  needs: FleetNeed[];
  needsCount: number;
  longestDwellMs: number;
  failed: boolean;
  working: number;
  idle: number;
  lastMs: number;
}

export interface FleetOrder { rows: string[]; forks: Record<string, string[]> }

export interface FleetInput {
  /** undefined when /worktrees is unavailable. */
  worktrees: readonly WorktreeLifetimeView[] | undefined;
  sessions: readonly AttentionSession[];
  now: number;
  order?: FleetOrder;
  resolveLabel?: (repoId: string) => string | undefined;
}

export interface FleetResult {
  rows: FleetRow[];
  order: FleetOrder;
  needs: FleetNeed[];
  /** Live, non-pending sessions with no repo_id. */
  unattributed: AttentionSession[];
}

const time = (s: string | undefined): number => (s === undefined ? NaN : Date.parse(s));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const finiteOr = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

function tooltipOf(r: WorktreeLifetimeView, label: string): string {
  const lines = [label, `state: ${r.state}`];
  if (r.outcome) lines.push(`outcome: ${r.outcome}`);
  if (r.state_reason) lines.push(`reason: ${r.state_reason}`);
  if (r.ahead !== undefined) lines.push(`ahead ${r.ahead}`);
  if (r.behind !== undefined) lines.push(`behind ${r.behind}`);
  if (r.dirty) lines.push("dirty: uncommitted changes");
  lines.push(`sessions ${r.sessions_total}`, `signal events ${r.signal_events}`, `cost (meta events): ${r.meta_events}`);
  if (!r.marks_available) lines.push("exact lifecycle marks unavailable in this privacy mode");
  return lines.join("\n");
}

export function forkOf(r: WorktreeLifetimeView, now: number): FleetFork {
  const label = r.label ?? idLabel(r.worktree_id);
  const spans = r.sessions
    .map((s) => ({ first: time(s.first_time), last: time(s.last_time) }))
    .filter((s) => Number.isFinite(s.first) && Number.isFinite(s.last))
    .map((s) => ({ first: Math.min(s.first, s.last), last: Math.max(s.first, s.last) }));
  return {
    id: r.worktree_id,
    label,
    state: r.state,
    glyph: FORK_GLYPH[r.state] ?? FORK_GLYPH.unknown,
    idle: isIdleWorker(r, now),
    ariaLabel: `${label}, ${r.state}`,
    tooltip: tooltipOf(r, label),
    needs: 0,
    lastMs: finiteOr(time(r.last_time), 0),
    spans,
  };
}

type Orderable = Pick<FleetRow, "id" | "known" | "lastMs"> & { noRepo?: boolean };

/**
 * Stable row order: ids already placed keep their slot, new ids append (known
 * by newest activity, then fog, then id); the no-repo row is always last.
 */
export function orderIds(prev: readonly string[] | undefined, rows: readonly Orderable[]): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kept = (prev ?? []).filter((id, i, a) => byId.has(id) && a.indexOf(id) === i && !byId.get(id)!.noRepo);
  const keptSet = new Set(kept);
  const fresh = rows.filter((r) => !keptSet.has(r.id) && !r.noRepo);
  fresh.sort((a, b) => (Number(!a.known) - Number(!b.known)) || (b.lastMs - a.lastMs) || cmp(a.id, b.id));
  const tail = rows.filter((r) => r.noRepo).map((r) => r.id);
  return [...kept, ...fresh.map((r) => r.id), ...tail];
}

function needOrder(a: FleetNeed, b: FleetNeed): number {
  return (b.dwellMs - a.dwellMs) || cmp(a.key, b.key);
}

export function buildFleet(input: FleetInput): FleetResult {
  const { worktrees, sessions, now } = input;
  const live = liveSessions(sessions, now);

  const byRepo = new Map<string, WorktreeLifetimeView[]>();
  for (const w of worktrees ?? []) {
    const list = byRepo.get(w.repo_id);
    if (list) list.push(w);
    else byRepo.set(w.repo_id, [w]);
  }

  type Acc = { needs: FleetNeed[]; working: number; idle: number; last: number; repoName?: string };
  const acc = new Map<string, Acc>();
  const accOf = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { needs: [], working: 0, idle: 0, last: 0 }));
    return a;
  };
  const unattributed: AttentionSession[] = [];
  for (const { s, since, last } of live) {
    const pending = !!s.pending;
    const rowId = s.repo_id || (pending ? NOREPO_KEY : undefined);
    if (rowId === undefined) { unattributed.push(s); continue; }
    const a = accOf(rowId);
    a.last = Math.max(a.last, last);
    if (s.repo && !a.repoName) a.repoName = s.repo;
    if (pending) {
      a.needs.push({
        key: sessionKey(s), id: s.id, source: s.source, repoId: rowId,
        ...(s.worktree_id ? { worktreeId: s.worktree_id } : {}),
        label: sessionName(s), dwellMs: Math.max(0, now - since), failed: isFailure(s), summary: s.pending?.summary ?? "",
      });
    } else if (s.state === "working") a.working++;
    else a.idle++;
  }
  unattributed.sort((a, b) => cmp(sessionKey(a), sessionKey(b)));

  const rowIds = new Set<string>([...byRepo.keys(), ...acc.keys()]);
  const order: FleetOrder = { rows: [], forks: {} };
  const rows = new Map<string, FleetRow>();
  for (const id of rowIds) {
    const wts = byRepo.get(id) ?? [];
    const a = acc.get(id) ?? { needs: [], working: 0, idle: 0, last: 0 };
    const forkOrder = orderLanes(input.order?.forks[id], wts);
    order.forks[id] = forkOrder;
    const byWt = new Map(wts.map((w) => [w.worktree_id, w]));
    const forks = forkOrder.map((fid) => forkOf(byWt.get(fid)!, now));
    const needs = [...a.needs].sort(needOrder);
    for (const n of needs) {
      const f = forks.find((x) => x.id === n.worktreeId);
      if (f) f.needs++;
    }
    const noRepo = id === NOREPO_KEY;
    let label: string;
    if (noRepo) label = "No repo id";
    else {
      let resolved: string | undefined;
      try { resolved = input.resolveLabel?.(id) || undefined; } catch { resolved = undefined; }
      label = resolved ?? (a.repoName || idLabel(id));
    }
    rows.set(id, {
      id, label, known: byRepo.has(id), ...(noRepo ? { noRepo: true } : {}), forks, needs,
      needsCount: needs.length,
      longestDwellMs: needs.reduce((m, n) => Math.max(m, n.dwellMs), 0),
      failed: needs.some((n) => n.failed),
      working: a.working, idle: a.idle,
      lastMs: Math.max(a.last, ...forks.map((f) => f.lastMs), 0),
    });
  }
  order.rows = orderIds(input.order?.rows, [...rows.values()]);
  const ordered = order.rows.map((id) => rows.get(id)!);
  const needs = ordered.flatMap((r) => r.needs).sort(needOrder);
  return { rows: ordered, order, needs, unattributed };
}

/**
 * Activity sparkline for a row: for each bucket, how many captured session
 * spans overlap it. Oldest first; the last bucket ends at nowMs.
 */
export function repoBuckets(row: FleetRow, nowMs: number, n = SPARK_BUCKETS, bucketMs = SPARK_BUCKET_MS): number[] {
  const out = new Array<number>(Math.max(0, n)).fill(0);
  const spans = row.forks.flatMap((f) => f.spans);
  for (let i = 0; i < out.length; i++) {
    const end = nowMs - (out.length - 1 - i) * bucketMs;
    const start = end - bucketMs;
    for (const s of spans) if (s.last >= start && s.first <= end) out[i]++;
  }
  return out;
}

/** The next need after `current` in list order, wrapping; an unknown or absent current starts at an end. */
export function nextNeed(needs: readonly FleetNeed[], current: string | undefined, dir: 1 | -1 = 1): FleetNeed | undefined {
  if (!needs.length) return undefined;
  const i = current === undefined ? -1 : needs.findIndex((n) => n.key === current);
  if (i < 0) return dir === 1 ? needs[0] : needs[needs.length - 1];
  return needs[(i + dir + needs.length) % needs.length];
}

/** The need that has waited longest; ties break by key. */
export function longestWaiting(needs: readonly FleetNeed[]): FleetNeed | undefined {
  let best: FleetNeed | undefined;
  for (const n of needs) if (!best || needOrder(n, best) < 0) best = n;
  return best;
}

/** A string equal for equal derived state: every rendered field except time-varying dwell and sparklines, which are refreshed in place. */
export function signature(r: FleetResult): string {
  return JSON.stringify([
    r.rows.map((x) => [x.id, x.label, x.known, !!x.noRepo, x.needs.map((n) => [n.key, n.failed, n.worktreeId ?? "", n.label, n.summary]), x.failed, x.working, x.idle,
      x.forks.map((f) => [f.id, f.label, f.state, f.idle, f.needs, f.glyph, f.ariaLabel, f.tooltip])]),
    r.unattributed.map(sessionKey),
  ]);
}
