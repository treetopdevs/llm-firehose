// Repo-roots store owned by main.ts, independent of the Graph panel. Holds the
// graph resolver's raw (unredacted) repo labels so actions can offer
// Register/Prune before the Graph panel is ever opened.
import type { Repository } from "../graph/api";

export interface RootsDeps {
  repos: () => Promise<Repository[]>;
}

export interface Roots {
  refresh(): Promise<void>;
  /** False until the first successful fetch: unknown must not read as "not registered". */
  loaded(): boolean;
  resolved(repoId: string | undefined): boolean;
  rawLabel(repoId: string | undefined): string | undefined;
}

export function createRoots(deps: RootsDeps): Roots {
  let byId = new Map<string, string>();
  let loaded = false;
  let issued = 0;
  return {
    async refresh() {
      const mine = ++issued;
      try {
        const list = await deps.repos();
        // A newer refresh started after this one: its response (or failure)
        // decides; an older response must never overwrite newer state.
        if (mine !== issued) return;
        byId = new Map(list.map((r) => [r.id, r.label]));
        loaded = true;
      } catch {
        // keep the last good data
      }
    },
    loaded: () => loaded,
    resolved: (id) => id !== undefined && byId.has(id),
    rawLabel: (id) => (id === undefined ? undefined : byId.get(id)),
  };
}
