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
