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
  /** The raw label of a registered repository, or of the project a registration belongs to. */
  rawLabel(repoId: string | undefined): string | undefined;
  /**
   * The VCS of a registration that is a second view of a project identified by
   * another id (the JJ side of a colocated repository); undefined for the
   * project's own id and for unknown ids.
   */
  view?(repoId: string | undefined): string | undefined;
  /** The last applied snapshot. */
  list(): RootRepo[];
  /** Fired after every applied refresh. Returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}

export function createRoots(deps: RootsDeps): Roots {
  let items: RootRepo[] = [];
  let byId = new Map<string, string>();
  let labels = new Map<string, string>();
  let views = new Map<string, string>();
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
        // A project id names the same checkout as its registrations, so it resolves
        // to a label even when only another view of the project is registered.
        labels = new Map(byId);
        for (const r of list)
          if (r.project_id && !labels.has(r.project_id)) labels.set(r.project_id, r.project_label ?? r.label);
        views = new Map(
          list.filter((r) => r.project_id && r.project_id !== r.id && r.status !== "unavailable").map((r) => [r.id, r.vcs]),
        );
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
    rawLabel: (id) => (id === undefined ? undefined : labels.get(id)),
    view: (id) => (id === undefined ? undefined : views.get(id)),
    list: copy,
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
