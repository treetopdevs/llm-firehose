// One shared answer to "what is this session called?". Sessions arrive from
// /sessions and /attention at different times; the directory remembers them by
// source and id so a bare ref (scope crumb, lens head) can be named without a
// fetch of its own. A load never overwrites what was remembered after it began.
import type { SessionLike } from "./format";

export type SessionRefLike = { id: string; source?: string };

export interface SessionDirectory {
  remember(list: readonly SessionLike[]): void;
  /** A ref with a source is exact; an id alone resolves only when one source holds it. */
  lookup(ref: SessionRefLike): SessionLike | undefined;
  subscribe(fn: () => void): () => void;
  /** Asks the loader (at most once per 10 s) for a ref nothing has named yet. */
  ensure(ref: SessionRefLike): void;
}

const COOLDOWN_MS = 10_000;
const keyOf = (source: string, id: string) => `${source}\0${id}`;
const same = (a: SessionLike, b: SessionLike) =>
  a.title === b.title && a.agent === b.agent && a.repo === b.repo && a.cwd === b.cwd;

export function createSessionDirectory(
  loader?: () => Promise<readonly SessionLike[]>,
  now: () => number = Date.now,
): SessionDirectory {
  const entries = new Map<string, { s: SessionLike; gen: number }>();
  const byId = new Map<string, Set<string>>();
  const subs = new Set<() => void>();
  let counter = 0;
  let loading = false;
  let lastStart = -Infinity;

  /** Stores one entry; true when the visible data changed. */
  function put(s: SessionLike, gen: number): boolean {
    const k = keyOf(s.source, s.id);
    const prev = entries.get(k);
    // An entry without first_time (an /attention row) never erases one a /sessions row supplied.
    const merged = { ...s };
    if (merged.first_time === undefined && prev?.s.first_time !== undefined) merged.first_time = prev.s.first_time;
    entries.set(k, { s: merged, gen });
    let set = byId.get(s.id);
    if (!set) byId.set(s.id, (set = new Set()));
    set.add(s.source);
    return !prev || !same(prev.s, s);
  }

  function lookup(ref: SessionRefLike): SessionLike | undefined {
    if (ref.source !== undefined) return entries.get(keyOf(ref.source, ref.id))?.s;
    const sources = byId.get(ref.id);
    if (!sources || sources.size !== 1) return undefined;
    return entries.get(keyOf([...sources][0]!, ref.id))?.s;
  }

  function notify() {
    for (const fn of [...subs]) fn();
  }

  return {
    remember(list) {
      let changed = false;
      for (const s of list) if (put(s, ++counter)) changed = true;
      if (changed) notify();
    },
    lookup,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    ensure(ref) {
      if (!loader || loading || lookup(ref)) return;
      const t = now();
      if (t - lastStart < COOLDOWN_MS) return;
      lastStart = t;
      loading = true;
      const startGen = counter;
      let pending: Promise<readonly SessionLike[]>;
      try {
        pending = loader();
      } catch {
        loading = false;
        return;
      }
      pending.then(
        (list) => {
          loading = false;
          let changed = false;
          for (const s of list) {
            const prev = entries.get(keyOf(s.source, s.id));
            if (prev && prev.gen > startGen) continue;
            if (put(s, ++counter)) changed = true;
          }
          if (changed) notify();
        },
        () => {
          loading = false;
        },
      );
    },
  };
}
