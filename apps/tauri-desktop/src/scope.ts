// Shared desktop scope: one { project?, worktree?, session?, window } every
// panel reads. Altitude navigation: descending narrows, ascend() widens.
//
// Notes:
// - project/worktree are GRAPH-space ids (workspace-graph repository and
//   workspace ids), not event-space ids.
// - Notifications deliver the committed (next, prev) pair. get() may already be
//   ahead of the pair being delivered when a subscriber re-entrantly narrows;
//   those changes are queued and delivered in order.
// - `cell` is a deliberate escape hatch: SessionSummary carries no
//   repo_id/worktree_id, so the sessions matrix selects by CellScope instead.
import type { CellScope } from './ui/workspace/model';

export type ScopeWindow = { from: number; to: number } | 'live';
export type Altitude = 'fleet' | 'project' | 'worktree' | 'session';

export interface SessionRef {
  readonly id: string;
  readonly source?: string;
}

export interface Scope {
  readonly project?: string;
  readonly worktree?: string;
  readonly session?: SessionRef;
  readonly cell?: CellScope;
  readonly window: ScopeWindow;
}

export type ScopePatch = {
  project?: string | undefined;
  worktree?: string | undefined;
  session?: SessionRef | undefined;
  cell?: CellScope | undefined;
  window?: 'live' | { from?: number; to?: number };
};

export interface ScopeResolver {
  sessions(scope: Scope): ReadonlySet<string> | undefined;
  /** Source-qualified membership; preferred over sessions() when present. undefined = unrestricted. */
  matcher?(scope: Scope): ((ref: SessionRef) => boolean) | undefined;
  /** Re-reads membership data independently of whether the owning panel is visible. */
  refresh?(): Promise<void>;
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
  sameWindow(a.window, b.window);

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
  out.window = w && w !== 'live' && validWindow(w) ? Object.freeze({ from: w.from, to: w.to }) : 'live';
  return Object.freeze(out) as Scope;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function createScope(initial?: Partial<Scope>): ScopeStore {
  let current = freezeScope(initial ?? {});
  const subs = new Set<(next: Scope, prev: Scope) => void>();
  const resolverSubs = new Set<() => void>();
  let resolverRef: ScopeResolver | null = null;
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
      commit(compute({ window: current.window }, patch));
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
    resolver: () => resolverRef,
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
