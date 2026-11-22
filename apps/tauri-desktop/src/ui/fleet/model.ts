// Pure derivation for the Fleet altitude: one row per repository, forks as
// branches off the row, needs-you and dwell from the same /attention snapshot
// every other view reads. DOM-free. Rows are the union of /worktrees and what
// attention observes, so a repo seen only by attention is drawn as fog (known:
// false), never dropped and never invented a fork.
import type { AttentionSession, WorktreeLifetimeView, WorktreeState } from "../../api";
import { displayRepoLabel, idLabel, projectName, sessionName } from "../../format";
import { FORK_GLYPH, IDLE_MARK } from "../../glyphs";
import { isFailure, needYouCount } from "../../needs";
import { liveSessions, sessionKey } from "../dwell/model";
import { IDLE_AFTER_MS, isIdleWorker, orderLanes } from "../project/model";

export type Encoding = "map" | "dwell" | "matrix" | "lanes" | "airspace" | "strata" | "ecosystem" | "events";
export const ENCODINGS: readonly Encoding[] = ["map", "dwell", "matrix", "lanes", "airspace", "strata", "ecosystem", "events"];
/** Encodings whose body is a hosted lens panel rather than a Fleet drawing. */
export type HostEncoding = "strata" | "ecosystem" | "events";
export const isHostEncoding = (e: Encoding): e is HostEncoding => e === "strata" || e === "ecosystem" || e === "events";

/** One glyph per worktree state; Project and Fleet share the vocabulary. */
export { FORK_GLYPH, IDLE_MARK };
/** Appended to an open fork that is ahead of main with nothing recent. */
/** Row id for sessions waiting on you that carry no repo_id. */
export const NOREPO_KEY = "__no_repo__";

/** Glyphs a row draws before the "+N" overflow chip. */
export const GLYPH_CAP = 12;
/** A gone fork older than this stays behind the overflow. */
export const GONE_RECENT_MS = 7 * 24 * 3_600_000;
const SPARK_BUCKETS = 14;
const SPARK_BUCKET_MS = IDLE_AFTER_MS * 3; // 12h: fourteen buckets cover the seven-day live window

/** What a worktree is doing, as far as captured evidence says (MS-10). Unknown is its own answer, never idle. */
export type ForkKind = "needs" | "working" | "idle" | "unknown" | "landed" | "never_diverged" | "gone";
/** How recent a worktree's own last activity must be to count as evidence that it is merely idle. */
export const RECENT_EVIDENCE_MS = 7 * 24 * 3_600_000;
/** The words a summary uses for each kind, in the order it lists them. */
export const KIND_ORDER: readonly ForkKind[] = ["needs", "working", "idle", "unknown", "landed", "never_diverged", "gone"];
export const KIND_WORD: Record<ForkKind, string> = { needs: "needs you", working: "working", idle: "idle", unknown: "unknown", landed: "landed", never_diverged: "never diverged", gone: "gone" };

export interface FleetFork {
  id: string;
  label: string;
  /** Last path segment of the label; drawn beside the glyph only for open forks. */
  short: string;
  state: WorktreeState;
  glyph: string;
  idle: boolean;
  /** Known to have gone more than seven days ago (by last_observed): hidden behind the overflow by default. */
  old: boolean;
  /** Gone, but the daemon gave no last_observed: the removal age is unknown, so it is never hidden by age. */
  ageUnknown: boolean;
  ariaLabel: string;
  tooltip: string;
  /** Needs-you sessions attributed to this fork by worktree_id. */
  needs: number;
  /** Live sessions working in this fork, by worktree_id. */
  working: number;
  /** The one status the row summary counts this worktree under. */
  kind: ForkKind;
  /** Its own last activity is within RECENT_EVIDENCE_MS of now. */
  recent: boolean;
  /** Why the status is unknown; set only for an unknown. */
  reason?: string;
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
  /** The request is old enough that the engine's freshness rule no longer calls the session live; still counted, as the attention strip counts it. */
  stale: boolean;
}

export interface FleetRow {
  id: string;
  label: string;
  /** True only when /worktrees lists this repo. */
  known: boolean;
  noRepo?: boolean;
  /** The label is only a digest prefix: recorded in balanced/minimal mode or an unregistered repository. */
  digest: boolean;
  forks: FleetFork[];
  /** Open forks (idle ones included), the idle subset, and forks gone in the last seven days. */
  openForks: number;
  idleForks: number;
  goneRecent: number;
  /** Gone forks whose removal age is unknown (no last_observed); counted apart from goneRecent. */
  goneUnknown: number;
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

export { displayRepoLabel };

const lastSegment = (s: string): string => idLabel(s).split("/").pop() || s;
const looksDigest = (id: string): boolean => !/[/\\]/.test(id) && /^[0-9a-f]{8,}$/i.test(id);

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

/** The fork's accessible name: its state and idleness, plus how many sessions wait on you. */
export function forkAriaLabel(f: Pick<FleetFork, "ariaLabel" | "needs">): string {
  return f.needs > 0 ? `${f.ariaLabel}, ${needYouCount(f.needs)}` : f.ariaLabel;
}

export function forkOf(r: WorktreeLifetimeView, now: number): FleetFork {
  const label = r.label ?? idLabel(r.worktree_id);
  // A gone worktree's age is when the daemon last saw it, not when it last produced a signal:
  // one quiet for ten days and removed today is recent. No observation time means unknown.
  const removedAt = r.state === "gone" ? time(r.last_observed) : NaN;
  const goneKnown = Number.isFinite(removedAt);
  const spans = r.sessions
    .map((s) => ({ first: time(s.first_time), last: time(s.last_time) }))
    .filter((s) => Number.isFinite(s.first) && Number.isFinite(s.last))
    .map((s) => ({ first: Math.min(s.first, s.last), last: Math.max(s.first, s.last) }));
  const lastMs = time(r.last_time);
  const evidence = Number.isFinite(lastMs) || spans.length > 0;
  // Idle needs evidence that it went quiet; with none, the worktree is unknown, not idle.
  const idle = evidence && isIdleWorker(r, now);
  const fork: FleetFork = {
    id: r.worktree_id,
    label,
    short: lastSegment(label),
    state: r.state,
    glyph: FORK_GLYPH[r.state] ?? FORK_GLYPH.unknown,
    idle,
    old: goneKnown && !(now - removedAt <= GONE_RECENT_MS),
    ageUnknown: r.state === "gone" && !goneKnown,
    ariaLabel: `${label}, ${r.state}${idle ? ", idle" : ""}`,
    tooltip: tooltipOf(r, label),
    needs: 0,
    working: 0,
    kind: "unknown",
    recent: Number.isFinite(lastMs) && now - lastMs <= RECENT_EVIDENCE_MS,
    lastMs: finiteOr(lastMs, 0),
    spans,
  };
  setKind(fork, r, 0);
  return fork;
}

/**
 * Re-derives kind and reason once needs and working are known. Idle needs positive evidence: the
 * worktree's own last activity is recent, or a live session in it says it is idle. An open worktree
 * with neither is unknown, never idle (MS-10).
 */
const UNKNOWN_LINE = "\nunknown: ";
function setKind(f: FleetFork, r: Pick<WorktreeLifetimeView, "state_reason">, idleSessions: number): void {
  delete f.reason;
  if (f.needs > 0) f.kind = "needs";
  else if (f.working > 0) f.kind = "working";
  else if (f.state === "open") {
    if (idleSessions > 0 || f.recent) f.kind = "idle";
    else {
      f.kind = "unknown";
      f.reason = f.lastMs > 0 ? "no activity captured in the last 7 days" : "no activity time captured";
    }
  } else if (f.state === "unknown") { f.kind = "unknown"; f.reason = r.state_reason || "state could not be determined"; }
  else f.kind = f.state;
  // The quiet-for-hours flag must not claim idleness the summary denies.
  if (f.kind === "unknown" && f.idle) f.idle = false;
  // The chip says what the summary says: an open worktree with no evidence draws the unknown mark and
  // announces why, rather than reading as open.
  const unknown = f.kind === "unknown";
  f.glyph = unknown ? FORK_GLYPH.unknown : FORK_GLYPH[f.state] ?? FORK_GLYPH.unknown;
  f.ariaLabel = unknown ? `${f.label}, unknown${f.reason ? `, ${f.reason}` : ""}` : `${f.label}, ${f.state}${f.idle ? ", idle" : ""}`;
  const base = f.tooltip.split(UNKNOWN_LINE)[0]!;
  f.tooltip = unknown && f.state === "open" && f.reason ? `${base}${UNKNOWN_LINE}${f.reason}` : base;
}

/** One status count of a row summary. */
export interface SummaryPart { kind: ForkKind; count: number; text: string }

const countText = (parts: readonly SummaryPart[]): string => parts.map((p) => p.text).join(" · ");

function partsOf(forks: readonly Pick<FleetFork, "kind">[]): SummaryPart[] {
  const n = new Map<ForkKind, number>();
  for (const f of forks) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
  return KIND_ORDER.filter((k) => n.has(k)).map((k) => ({ kind: k, count: n.get(k)!, text: `${n.get(k)} ${KIND_WORD[k]}` }));
}

/** "1 needs you · 3 working · 20 idle · 59 unknown": worktrees by status, zeros left out. */
export function summarize(row: Pick<FleetRow, "known" | "noRepo" | "forks">): { parts: SummaryPart[]; text: string } {
  if (row.noRepo) return { parts: [], text: "" };
  if (!row.known) return { parts: [], text: "no worktree data" };
  if (row.forks.length === 0) return { parts: [], text: "no worktrees" };
  const parts = partsOf(row.forks);
  return { parts, text: countText(parts) };
}

/** The count line for what a collapsed row leaves out. */
export function describeRest(forks: readonly Pick<FleetFork, "kind">[]): string {
  return countText(partsOf(forks));
}

const RANK = (f: FleetFork): number =>
  f.kind === "needs" ? -2 : f.kind === "working" ? -1 : f.state === "open" ? (f.idle ? 0 : 1) : f.state === "landed" ? 2 : f.state === "never_diverged" ? 3 : f.state === "unknown" ? 4 : 5;

/**
 * The glyphs a row draws: open+idle first, then open, landed, never_diverged,
 * unknown, gone; ties keep the row's stable fork order. Collapsed, old gone
 * forks and everything past GLYPH_CAP sit behind `more`.
 */
export function stripOf(forks: readonly FleetFork[], expanded: boolean, cap = GLYPH_CAP): { shown: FleetFork[]; hidden: FleetFork[]; more: number } {
  const ranked = forks.map((f, i) => ({ f, i })).sort((a, b) => RANK(a.f) - RANK(b.f) || a.i - b.i).map((x) => x.f);
  if (expanded) return { shown: ranked, hidden: [], more: 0 };
  const eligible = ranked.filter((f) => !f.old);
  const shown = eligible.slice(0, cap);
  const hidden = [...eligible.slice(cap), ...ranked.filter((f) => f.old)];
  return { shown, hidden, more: hidden.length };
}

/** What an expanded row shows first: the worktrees that need you or are working, needs first, each in the row's stable order (MS-10). */
export function childrenOf(forks: readonly FleetFork[]): FleetFork[] {
  const rank = (f: FleetFork): number => (f.kind === "needs" ? 0 : 1);
  return forks.map((f, i) => ({ f, i })).filter((x) => x.f.kind === "needs" || x.f.kind === "working").sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i).map((x) => x.f);
}

/**
 * The worktrees an expanded row leaves out, with the one line that counts them by status:
 * "79 more worktrees: 20 idle · 59 unknown (no recent evidence)". The parenthesis is only said when every
 * unknown one is unknown for lack of recent evidence; a state the daemon could not determine says just unknown.
 */
export function restOf(forks: readonly FleetFork[]): { forks: FleetFork[]; text: string } {
  const kids = new Set(childrenOf(forks));
  const rest = forks.filter((f) => !kids.has(f));
  if (rest.length === 0) return { forks: [], text: "" };
  const unknown = rest.filter((f) => f.kind === "unknown");
  const lacksEvidence = unknown.length > 0 && unknown.every((f) => f.state === "open");
  const parts = partsOf(rest).map((p) => (p.kind === "unknown" && lacksEvidence ? `${p.text} (no recent evidence)` : p.text));
  return { forks: rest, text: `${rest.length} more worktree${rest.length === 1 ? "" : "s"}: ${parts.join(" · ")}` };
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
  // A pending request is counted whether or not it is still fresh, as the attention
  // strip counts it: stale ones are flagged, never dropped. Other sessions need to be live.
  // Dwell admits the same set (buildDwell with includeStalePending).
  const seen = liveSessions(sessions, now, { includeStalePending: true });

  const byRepo = new Map<string, WorktreeLifetimeView[]>();
  for (const w of worktrees ?? []) {
    const list = byRepo.get(w.repo_id);
    if (list) list.push(w);
    else byRepo.set(w.repo_id, [w]);
  }

  type Acc = { failed: boolean; needs: FleetNeed[]; working: number; idle: number; last: number; repoName?: string; workingBy: Map<string, number>; idleBy: Map<string, number> };
  const acc = new Map<string, Acc>();
  const accOf = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { failed: false, needs: [], working: 0, idle: 0, last: 0, workingBy: new Map(), idleBy: new Map() }));
    return a;
  };
  const unattributed: AttentionSession[] = [];
  for (const { s, since, last, stale } of seen) {
    const pending = !!s.pending;
    const rowId = s.repo_id || (pending ? NOREPO_KEY : undefined);
    if (rowId === undefined) { unattributed.push(s); continue; }
    const a = accOf(rowId);
    a.failed ||= isFailure(s);
    a.last = Math.max(a.last, last);
    if (s.repo && !a.repoName) a.repoName = s.repo;
    if (pending) {
      a.needs.push({
        key: sessionKey(s), id: s.id, source: s.source, repoId: rowId,
        ...(s.worktree_id ? { worktreeId: s.worktree_id } : {}),
        label: sessionName(s), dwellMs: Math.max(0, now - since), failed: isFailure(s), summary: s.pending?.summary ?? "",
        stale: !!stale,
      });
    } else if (s.state === "working") {
      a.working++;
      if (s.worktree_id) a.workingBy.set(s.worktree_id, (a.workingBy.get(s.worktree_id) ?? 0) + 1);
    }
    else if (!isFailure(s)) {
      a.idle++;
      if (s.worktree_id && s.state === "idle") a.idleBy.set(s.worktree_id, (a.idleBy.get(s.worktree_id) ?? 0) + 1);
    }
  }
  unattributed.sort((a, b) => cmp(sessionKey(a), sessionKey(b)));

  const rowIds = new Set<string>([...byRepo.keys(), ...acc.keys()]);
  const order: FleetOrder = { rows: [], forks: {} };
  const rows = new Map<string, FleetRow>();
  for (const id of rowIds) {
    const wts = byRepo.get(id) ?? [];
    const a = acc.get(id) ?? { failed: false, needs: [], working: 0, idle: 0, last: 0, workingBy: new Map<string, number>(), idleBy: new Map<string, number>() };
    const forkOrder = orderLanes(input.order?.forks[id], wts);
    order.forks[id] = forkOrder;
    const byWt = new Map(wts.map((w) => [w.worktree_id, w]));
    const forks = forkOrder.map((fid) => forkOf(byWt.get(fid)!, now));
    const needs = [...a.needs].sort(needOrder);
    for (const n of needs) {
      const f = forks.find((x) => x.id === n.worktreeId);
      if (f) f.needs++;
    }
    for (const f of forks) {
      f.working = a.workingBy.get(f.id) ?? 0;
      setKind(f, byWt.get(f.id)!, a.idleBy.get(f.id) ?? 0);
    }
    const noRepo = id === NOREPO_KEY;
    let label: string;
    let digest = false;
    if (noRepo) label = "No project";
    else {
      let resolved: string | undefined;
      try { resolved = input.resolveLabel?.(id) || undefined; } catch { resolved = undefined; }
      const named = resolved ?? (a.repoName || undefined);
      digest = named === undefined && looksDigest(id);
      label = projectName(id, named).label;
    }
    rows.set(id, {
      id, label, known: byRepo.has(id), ...(noRepo ? { noRepo: true } : {}), digest, forks, needs,
      openForks: forks.filter((f) => f.state === "open").length,
      idleForks: forks.filter((f) => f.idle).length,
      goneRecent: forks.filter((f) => f.state === "gone" && !f.old && !f.ageUnknown).length,
      goneUnknown: forks.filter((f) => f.ageUnknown).length,
      needsCount: needs.length,
      longestDwellMs: needs.reduce((m, n) => Math.max(m, n.dwellMs), 0),
      failed: a.failed,
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
    r.rows.map((x) => [x.id, x.label, x.known, !!x.noRepo, x.digest, x.openForks, x.idleForks, x.goneRecent, x.goneUnknown, x.needs.map((n) => [n.key, n.failed, n.stale, n.worktreeId ?? "", n.label, n.summary]), x.failed, x.working, x.idle,
      x.forks.map((f) => [f.id, f.label, f.state, f.idle, f.old, f.ageUnknown, f.needs, f.working, f.kind, f.glyph, f.ariaLabel, f.tooltip])]),
    r.unattributed.map(sessionKey),
  ]);
}
