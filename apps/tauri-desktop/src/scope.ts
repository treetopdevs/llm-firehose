// Shared desktop scope: one { project?, worktree?, session?, window } every
// panel reads. Altitude navigation: descending narrows, ascend() widens.
//
// Notes:
// - project/worktree are GRAPH-space ids (workspace-graph repository and
//   workspace ids), not event-space ids.
// - Notifications deliver the committed (next, prev) pair. get() may already be
//   ahead of the pair being delivered when a subscriber re-entrantly narrows;
//   those changes are queued and delivered in order.
// - liveSpanMs is a user PREFERENCE for how far 'live' looks back at Project and
//   (when set) Fleet Lanes. Direct session selection resets window to live but keeps
//   the preference; navigations that pass an explicit window (Fleet) carry it. The
//   Session altitude treats live as the whole session and ignores the span.
// - `cell` is a deliberate escape hatch: SessionSummary carries no
//   repo_id/worktree_id, so the sessions matrix selects by CellScope instead.
import type { CellScope } from './ui/workspace/model';

export type ScopeWindow = { from: number; to: number } | 'live';
export type Altitude = 'fleet' | 'project' | 'worktree' | 'session';

export interface SessionRef {
  readonly id: string;
  readonly source?: string;
}

export const DEFAULT_LIVE_SPAN_MS = 7 * 86_400_000;
export type PresetId = '2h' | '8h' | '24h' | '7d';
export const PRESETS: readonly { id: PresetId; label: string; ms: number }[] = [
  { id: '2h', label: '2h', ms: 2 * 3_600_000 },
  { id: '8h', label: '8h', ms: 8 * 3_600_000 },
  { id: '24h', label: '24h', ms: 24 * 3_600_000 },
  { id: '7d', label: '7d', ms: 7 * 86_400_000 },
];

export interface Scope {
  readonly project?: string;
  readonly worktree?: string;
  readonly session?: SessionRef;
  readonly cell?: CellScope;
  readonly window: ScopeWindow;
  readonly liveSpanMs?: number;
}

export type ScopePatch = {
  project?: string | undefined;
  worktree?: string | undefined;
  session?: SessionRef | undefined;
  cell?: CellScope | undefined;
  window?: 'live' | { from?: number; to?: number };
  liveSpanMs?: number | undefined;
};

export interface ScopeResolver {
  sessions(scope: Scope): ReadonlySet<string> | undefined;
  /** Source-qualified membership; preferred over sessions() when present. undefined = unrestricted. */
  matcher?(scope: Scope): ((ref: SessionRef) => boolean) | undefined;
  /** Re-reads membership data independently of whether the owning panel is visible. */
  refresh?(): Promise<void>;
  /**
   * Whether this resolver can authoritatively answer for the scope's project/worktree.
   * Absent means it can. A composed primary that does not know a worktree defers to a
   * fallback that does, so one source's snapshot never erases another's history.
   */
  knows?(scope: Scope): boolean;
  /** Set when membership is a capped sample: `known` of `total` sessions are listed. */
  partial?(scope: Scope): { known: number; total: number } | undefined;
  labels(scope: Scope): { project?: string; worktree?: string };
}

export interface ScopeStore {
  get(): Scope;
  altitude(): Altitude;
  set(next: Scope): void;
  narrow(patch: ScopePatch): void;
  /** Clears project, worktree, session and cell, then applies patch. */
  replaceContext(patch: ScopePatch): void;
  ascend(): Altitude | null;
  subscribe(fn: (next: Scope, prev: Scope) => void): () => void;
  reset(): void;
  setResolver(r: ScopeResolver | null): void;
  /** Lower-priority resolver consulted where the primary answers undefined. setResolver(null) leaves it in place. */
  setFallbackResolver(r: ScopeResolver | null): void;
  resolver(): ScopeResolver | null;
  touchResolver(): void;
  onResolver(fn: () => void): () => void;
}

/** Identity is (id, source); an absent source is distinct from an explicit one. */
export function sameSession(a?: SessionRef, b?: SessionRef): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.source === b.source;
}

const validWindow = (w: { from: number; to: number }): boolean =>
  Number.isFinite(w.from) && Number.isFinite(w.to) && w.from <= w.to;

const sameCell = (a?: CellScope, b?: CellScope): boolean =>
  !a || !b ? !a && !b : a.where === b.where && a.agent === b.agent && a.label === b.label;

const sameWindow = (a: ScopeWindow, b: ScopeWindow): boolean =>
  a === 'live' || b === 'live' ? a === b : a.from === b.from && a.to === b.to;

const sameScope = (a: Scope, b: Scope): boolean =>
  a.project === b.project &&
  a.worktree === b.worktree &&
  sameSession(a.session, b.session) &&
  sameCell(a.cell, b.cell) &&
  sameWindow(a.window, b.window) &&
  a.liveSpanMs === b.liveSpanMs;

const validSpan = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

function freezeScope(s: Partial<Scope>): Scope {
  const out: { -readonly [K in keyof Scope]?: Scope[K] } = {};
  if (s.project !== undefined) out.project = s.project;
  if (s.worktree !== undefined) out.worktree = s.worktree;
  if (s.session !== undefined) {
    const ref: { id: string; source?: string } = { id: s.session.id };
    if (s.session.source !== undefined) ref.source = s.session.source;
    out.session = Object.freeze(ref);
  }
  if (s.cell !== undefined) out.cell = Object.freeze({ ...s.cell });
  const w = s.window;
  if (validSpan(s.liveSpanMs)) out.liveSpanMs = s.liveSpanMs;
  out.window = w && w !== 'live' && validWindow(w) ? Object.freeze({ from: w.from, to: w.to }) : 'live';
  return Object.freeze(out) as Scope;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function createScope(initial?: Partial<Scope>): ScopeStore {
  let current = freezeScope(initial ?? {});
  const subs = new Set<(next: Scope, prev: Scope) => void>();
  const resolverSubs = new Set<() => void>();
  let resolverRef: ScopeResolver | null = null;
  let fallbackRef: ScopeResolver | null = null;
  let composed: { p: ScopeResolver; f: ScopeResolver; r: ScopeResolver } | null = null;
  const queue: Array<[Scope, Scope]> = [];
  let delivering = false;

  const deliver = () => {
    if (delivering) return;
    delivering = true;
    try {
      while (queue.length) {
        const [next, prev] = queue.shift()!;
        for (const fn of [...subs]) fn(next, prev);
      }
    } finally {
      delivering = false;
    }
  };

  const commit = (next: Scope) => {
    if (sameScope(current, next)) return;
    const prev = current;
    current = next;
    queue.push([next, prev]);
    deliver();
  };

  const compute = (base: Partial<Scope>, patch: ScopePatch): Scope => {
    const prev = current;
    const next: { -readonly [K in keyof Scope]?: Scope[K] } = { ...base };
    if (has(patch, 'project')) {
      next.project = patch.project;
      if (patch.project !== prev.project) {
        if (!has(patch, 'worktree')) next.worktree = undefined;
        if (!has(patch, 'session')) next.session = undefined;
      }
    }
    if (has(patch, 'worktree')) {
      next.worktree = patch.worktree;
      if (patch.worktree !== prev.worktree && !has(patch, 'session')) next.session = undefined;
    }
    if (has(patch, 'session')) next.session = patch.session;
    if (has(patch, 'cell')) next.cell = patch.cell;

    let win: ScopeWindow = base.window ?? 'live';
    if (!sameSession(next.session, prev.session)) win = 'live';
    if (has(patch, 'window') && patch.window !== undefined) {
      const pw = patch.window;
      if (pw === 'live') win = 'live';
      else if (win === 'live') {
        if (pw.from !== undefined && pw.to !== undefined && validWindow({ from: pw.from, to: pw.to }))
          win = { from: pw.from, to: pw.to };
      } else {
        const cand = { from: pw.from ?? win.from, to: pw.to ?? win.to };
        if (validWindow(cand)) win = cand;
      }
    }
    next.window = win;
    if (has(patch, 'liveSpanMs') && validSpan(patch.liveSpanMs)) next.liveSpanMs = patch.liveSpanMs;
    return freezeScope(next);
  };

  const store: ScopeStore = {
    get: () => current,
    altitude() {
      if (current.session) return 'session';
      if (current.worktree) return 'worktree';
      if (current.project) return 'project';
      return 'fleet';
    },
    set: (next) => commit(freezeScope(next)),
    narrow: (patch) => commit(compute(current, patch)),
    replaceContext(patch) {
      const base: Partial<Scope> = { window: current.window };
      if (current.liveSpanMs !== undefined) (base as { liveSpanMs?: number }).liveSpanMs = current.liveSpanMs;
      commit(compute(base, patch));
    },
    ascend() {
      let next: Scope;
      if (current.session) next = freezeScope({ ...current, session: undefined, window: 'live' });
      else if (current.worktree) next = freezeScope({ ...current, worktree: undefined });
      else if (current.project) next = freezeScope({ ...current, project: undefined, cell: undefined });
      else if (current.cell) next = freezeScope({ ...current, cell: undefined });
      else return null;
      commit(next);
      return store.altitude();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    reset: () => commit(freezeScope({})),
    setResolver(r) {
      resolverRef = r;
      for (const fn of [...resolverSubs]) fn();
    },
    setFallbackResolver(r) {
      fallbackRef = r;
      for (const fn of [...resolverSubs]) fn();
    },
    resolver() {
      if (!fallbackRef) return resolverRef;
      if (!resolverRef) return fallbackRef;
      const p = resolverRef;
      const f = fallbackRef;
      if (composed && composed.p === p && composed.f === f) return composed.r;
      const r = composeResolvers(p, f);
      composed = { p, f, r };
      return r;
    },
    touchResolver() {
      for (const fn of [...resolverSubs]) fn();
    },
    onResolver(fn) {
      resolverSubs.add(fn);
      return () => void resolverSubs.delete(fn);
    },
  };
  return store;
}

const matcherOf = (r: ScopeResolver, sc: Scope): ((ref: SessionRef) => boolean) | undefined => {
  if (r.matcher) return r.matcher(sc);
  const ids = r.sessions(sc);
  return ids ? (ref) => ids.has(ref.id) : undefined;
};

/** Primary answers win when defined and it knows the scope; otherwise a fallback that knows goes first. */
function composeResolvers(p: ScopeResolver, f: ScopeResolver): ScopeResolver {
  const order = (sc: Scope): [ScopeResolver, ScopeResolver] =>
    p.knows && !p.knows(sc) && f.knows?.(sc) ? [f, p] : [p, f];
  return {
    sessions(sc) {
      const [a, b] = order(sc);
      return a.sessions(sc) ?? b.sessions(sc);
    },
    matcher(sc) {
      const [a, b] = order(sc);
      return matcherOf(a, sc) ?? matcherOf(b, sc);
    },
    partial(sc) {
      const [a, b] = order(sc);
      if (matcherOf(a, sc)) return a.partial?.(sc);
      return matcherOf(b, sc) ? b.partial?.(sc) : undefined;
    },
    knows: (sc) => (p.knows?.(sc) ?? true) || (f.knows?.(sc) ?? false),
    refresh: () => Promise.all([p.refresh?.(), f.refresh?.()]).then(() => undefined),
    labels(sc) {
      const out: { project?: string; worktree?: string } = { ...f.labels(sc) };
      for (const [k, v] of Object.entries(p.labels(sc)) as Array<['project' | 'worktree', string | undefined]>) {
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
  };
}

export const scope: ScopeStore = createScope();

/**
 * Records a user-chosen session in scope. project/worktree parents are kept
 * only when the same session is already scoped or the graph resolver confirms
 * membership; otherwise they are cleared so the breadcrumb never asserts a
 * containment the user did not choose.
 */
/** Membership test for a scope, source-aware when the resolver supports it. undefined = unrestricted. */
export function membership(store: ScopeStore, sc: Scope): ((ref: SessionRef) => boolean) | undefined {
  const r = store.resolver();
  if (!r) return undefined;
  if (r.matcher) return r.matcher(sc);
  const ids = r.sessions(sc);
  return ids ? (ref) => ids.has(ref.id) : undefined;
}

export function selectSession(store: ScopeStore, ref: SessionRef): void {
  const cur = store.get();
  if (!cur.project && !cur.worktree) return store.narrow({ session: ref });
  // Same (id, source) identity only; a shared native id under another source proves nothing.
  if (cur.session && cur.session.id === ref.id && cur.session.source === ref.source) return store.narrow({ session: ref });
  if (membership(store, cur)?.(ref)) store.narrow({ session: ref });
  else store.replaceContext({ session: ref });
}

// ---- pure window helpers (the shell transport reads/writes through these) ----

export const liveSpanOf = (s: Pick<Scope, 'liveSpanMs'>): number =>
  validSpan(s.liveSpanMs) ? s.liveSpanMs : DEFAULT_LIVE_SPAN_MS;

export const isLive = (w: ScopeWindow): w is 'live' => w === 'live';

export function presetWindow(id: PresetId, now: number): { from: number; to: number } {
  const p = PRESETS.find((x) => x.id === id)!;
  return { from: now - p.ms, to: now };
}

export function spanOf(w: ScopeWindow, _now: number, liveSpanMs: number = DEFAULT_LIVE_SPAN_MS): number {
  return w === 'live' ? liveSpanMs : w.to - w.from;
}

export function resolveRange(
  w: ScopeWindow,
  now: number,
  liveSpanMs: number = DEFAULT_LIVE_SPAN_MS,
): { from: number; to: number } {
  return w === 'live' ? { from: now - liveSpanMs, to: now } : { from: w.from, to: w.to };
}

/** Moves the window by deltaMs, clamped so it never ends after now. Returns 'live' when it is the live span ending now. */
export function shiftWindow(
  w: ScopeWindow,
  deltaMs: number,
  now: number,
  liveSpanMs: number = DEFAULT_LIVE_SPAN_MS,
): ScopeWindow {
  if (!Number.isFinite(deltaMs)) return w;
  const r = resolveRange(w, now, liveSpanMs);
  const span = r.to - r.from;
  const to = Math.min(r.to + deltaMs, now);
  if (to >= now && Math.abs(span - liveSpanMs) <= 1) return 'live';
  return { from: to - span, to };
}

export function formatSpan(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d} d ${hr} h` : `${d} d`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number): string => String(n).padStart(2, '0');

function stamp(
  d: Date,
  utc: boolean,
  year: boolean,
  secs: boolean,
): string {
  const mo = utc ? d.getUTCMonth() : d.getMonth();
  const day = utc ? d.getUTCDate() : d.getDate();
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const h = utc ? d.getUTCHours() : d.getHours();
  const mi = utc ? d.getUTCMinutes() : d.getMinutes();
  const se = utc ? d.getUTCSeconds() : d.getSeconds();
  return `${MONTHS[mo]} ${day},${year ? ` ${y},` : ''} ${p2(h)}:${p2(mi)}${secs ? `:${p2(se)}` : ''}`;
}

export function formatRange(
  w: ScopeWindow,
  now: number,
  liveSpanMs?: number,
  opts?: { wholeSession?: boolean },
): { text: string; title: string } {
  if (w === 'live' && opts?.wholeSession) {
    const t = 'Live · whole session';
    return { text: t, title: t };
  }
  const span = w === 'live' ? (validSpan(liveSpanMs) ? liveSpanMs : DEFAULT_LIVE_SPAN_MS) : w.to - w.from;
  const r = resolveRange(w, now, span);
  const a = new Date(r.from);
  const b = new Date(r.to);
  const year = a.getFullYear() !== b.getFullYear();
  const secs = span < 15 * 60_000;
  const local = `${stamp(a, false, year, secs)} › ${stamp(b, false, year, secs)} · ${formatSpan(span)}`;
  const utc = `UTC ${stamp(a, true, year, secs)} › ${stamp(b, true, year, secs)}`;
  if (w === 'live') {
    const text = validSpan(liveSpanMs) ? `Live · last ${formatSpan(liveSpanMs)}` : 'Live';
    return { text, title: `${text} · ${local} · ${utc}` };
  }
  return { text: local, title: `${local} · ${utc}` };
}
