// Pure scope remap for a privacy-mode change. main.ts is the ONLY scope writer
// on such a change; panels (graph reconcileScope included) must not rewrite
// scope.project/worktree for it.
//
// What is and is not knowable (internal/daemon service.go identity()):
//  - Repository LABELS are raw in every privacy mode; repository IDS are not
//    (a path id in full mode becomes a digest in minimal/balanced). So a project
//    can be re-found across modes by its raw label plus vcs, and only when that
//    pair is unique on both sides of a verified snapshot.
//  - Worktree ids are NOT remappable: the API exposes no alias list.
//  - Session membership under the new ids is unverified.
// Hence: project-only remap, worktree and session always cleared, window kept.
import { projectName } from "./format";
import type { Scope, ScopePatch } from "./scope";

export interface IdentitySet {
  repos: { id: string; label: string; vcs: string }[];
}

export type RemapResult =
  | { kind: "unchanged" }
  | { kind: "remapped"; patch: ScopePatch; note: string }
  | { kind: "cleared"; note: string };

const PREFIX = "Privacy mode changed";

export function remapScope(sc: Scope, before: IdentitySet, after: IdentitySet): RemapResult {
  const hasInner = sc.worktree !== undefined || sc.session !== undefined;
  if (sc.project === undefined) {
    if (!hasInner) return { kind: "unchanged" };
    return { kind: "cleared", note: `${PREFIX}: the worktree and session selection could not be carried over and was cleared.` };
  }
  // The same id still names a repository: nothing about the project changed.
  if (after.repos.some((r) => r.id === sc.project)) return { kind: "unchanged" };

  const old = before.repos.find((r) => r.id === sc.project);
  const key = (r: { label: string; vcs: string }) => `${r.vcs}\u0000${r.label}`;
  if (!old) return { kind: "cleared", note: `${PREFIX}: the project could not be matched, so the view returned to Fleet.` };
  const k = key(old);
  const matchesBefore = before.repos.filter((r) => key(r) === k);
  const matchesAfter = after.repos.filter((r) => key(r) === k);
  if (matchesBefore.length !== 1 || matchesAfter.length !== 1) {
    return { kind: "cleared", note: `${PREFIX}: the project name is not unique, so the view returned to Fleet.` };
  }
  const next = matchesAfter[0]!;
  const w = sc.window;
  const window = w === "live" ? "live" : { from: w.from, to: w.to };
  const inner = hasInner ? " Worktree and session were cleared." : "";
  return {
    kind: "remapped",
    patch: { project: next.id, worktree: undefined, session: undefined, window },
    note: `${PREFIX}: project kept as ${projectName(old.id, old.label).label}.${inner}`,
  };
}

/**
 * Old repository id -> current id, extended across one verified mode change. Captured sessions keep the id they were
 * captured under, so this is what lets them reach their project. Uses remapScope's rule: label plus vcs, unique on
 * both sides. Held for the running app only: it links a path to its digest, so it is not written to disk.
 */
export function mergeRepoAliases(prev: ReadonlyMap<string, string>, before: IdentitySet, after: IdentitySet): Map<string, string> {
  const key = (r: { label: string; vcs: string }) => `${r.vcs}\u0000${r.label}`;
  const unique = (s: IdentitySet) => {
    const seen = new Map<string, string | null>();
    for (const r of s.repos) seen.set(key(r), seen.has(key(r)) ? null : r.id);
    return seen;
  };
  const was = unique(before);
  const now = unique(after);
  const step = new Map<string, string>();
  for (const [k, id] of was) {
    const next = now.get(k);
    if (id && next && next !== id) step.set(id, next);
  }
  const out = new Map<string, string>();
  for (const [from, to] of prev) {
    const next = step.get(to) ?? to;
    if (next !== from) out.set(from, next);
  }
  for (const [from, to] of step) if (!out.has(from) && !prev.has(from)) out.set(from, to);
  return out;
}

/**
 * A history place after a privacy change, the way remapScope treats the scope: a project that still exists is
 * kept, one that can be matched takes its new id (worktree and session are not remappable and are dropped), and
 * anything else, or identities that could not be verified (`after` undefined), loses its identity.
 */
type Identity = { project?: string; worktree?: string; session?: { id: string; source?: string } };
/** The place with its three identity fields typed as optional, whatever the caller's type promised. */
export type Remapped<P extends Identity> = Omit<P, keyof Identity> & Identity;

export function remapPlace<P extends Identity>(place: P, before: IdentitySet, after: IdentitySet | undefined): Remapped<P> {
  const has = place.project !== undefined || place.worktree !== undefined || place.session !== undefined;
  if (!has) return place as Remapped<P>;
  // A Session place without a session is an empty Score: it lands on what is left of its scope instead.
  const landed = <T extends Identity & { panel?: string; view?: string }>(p: T): T => {
    if (p.panel !== "session") return p;
    const { view: _view, ...rest } = p;
    return { ...rest, panel: p.project !== undefined ? "project" : "fleet" } as T;
  };
  const cleared = landed({ ...place, project: undefined, worktree: undefined, session: undefined });
  if (!after) return cleared;
  const sc: Scope = { window: "live", ...(place.project !== undefined ? { project: place.project } : {}), ...(place.worktree !== undefined ? { worktree: place.worktree } : {}), ...(place.session !== undefined ? { session: place.session } : {}) };
  const r = remapScope(sc, before, after);
  if (r.kind === "unchanged") return place as Remapped<P>;
  if (r.kind === "cleared") return cleared;
  return landed({ ...place, project: r.patch.project, worktree: undefined, session: undefined });
}
