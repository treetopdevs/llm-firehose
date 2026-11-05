// Navigation aliases: retired lens names that now land on an altitude and an
// encoding. Pure, so the shell, the tests and later slices share one table.
import type { Scope } from "./scope";

export type AliasName = "live" | "attention" | "strata" | "ecosystem" | "workspace";

const ALIASES: ReadonlySet<string> = new Set<AliasName>(["live", "attention", "strata", "ecosystem", "workspace"]);

export const isAlias = (n: string): n is AliasName => ALIASES.has(n);

export interface Landing {
  panel: "fleet" | "project" | "sessions";
  /** Project encoding chip. */
  encoding?: string;
  /** Fleet host encoding. */
  fleetEncoding?: "events" | "strata" | "ecosystem";
  needsOnly?: true;
}

/** Where an alias lands. Landings never clear scope; Needs you shows the inbox on the Worktree rung. */
export function resolveAlias(name: AliasName, sc: Scope, isRegistered?: (projectId: string) => boolean): Landing {
  switch (name) {
    case "strata": return { panel: "fleet", fleetEncoding: "strata" };
    case "ecosystem": return { panel: "fleet", fleetEncoding: "ecosystem" };
    case "workspace": return { panel: "project", encoding: "graph" };
    case "live":
      // A registered project lands on its Events chip (already narrowed by the scope); anything else on Fleet Events.
      if (sc.project !== undefined && isRegistered?.(sc.project)) return { panel: "project", encoding: "events" };
      return { panel: "fleet", fleetEncoding: "events" };
    case "attention": return { panel: "sessions", needsOnly: true };
  }
}
