// Repo-roots store owned by main.ts, independent of the Graph panel. Holds the
// graph resolver's raw (unredacted) repo labels so actions can offer
// Register/Prune before the Graph panel is ever opened.
import type { Repository } from "../graph/api";

export interface RootsDeps {
  repos: () => Promise<Repository[]>;
}

export interface RootRepo {
  id: string;
  label: string;
  vcs?: string;
}

export interface RefreshResult {
  /** True only when THIS call's response was applied (not failed, not superseded). */
  ok: boolean;
  revision: number;
  repos: RootRepo[];
}

export interface Roots {
  refresh(): Promise<RefreshResult>;
  /** False until the first successful fetch: unknown must not read as "not registered". */
  loaded(): boolean;
  resolved(repoId: string | undefined): boolean;
  rawLabel(repoId: string | undefined): string | undefined;
  /** The last applied snapshot. */
  list(): RootRepo[];
  /** Fired after every applied refresh. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}

export function createRoots(deps: RootsDeps): Roots {
  let items: RootRepo[] = [];
  let byId = new Map<string, string>();
  let loaded = false;
  let issued = 0;
  let revision = 0;
  const subs = new Set<() => void>();
  const copy = (): RootRepo[] => items.map((r) => ({ ...r }));
  return {
    async refresh() {
      const mine = ++issued;
      try {
        const list = await deps.repos();
        // A newer refresh started after this one: its response (or failure)
        // decides; an older response must never overwrite newer state.
        if (mine !== issued) return { ok: false, revision, repos: copy() };
        items = list.map((r) => (r.vcs === undefined ? { id: r.id, label: r.label } : { id: r.id, label: r.label, vcs: r.vcs }));
        byId = new Map(list.map((r) => [r.id, r.label]));
        loaded = true;
        revision++;
        for (const fn of [...subs]) fn();
        return { ok: true, revision, repos: copy() };
      } catch {
        // keep the last good data
        return { ok: false, revision, repos: copy() };
      }
    },
    loaded: () => loaded,
    resolved: (id) => id !== undefined && byId.has(id),
    rawLabel: (id) => (id === undefined ? undefined : byId.get(id)),
    list: copy,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
