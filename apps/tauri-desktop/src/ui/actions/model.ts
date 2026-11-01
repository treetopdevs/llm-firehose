// Pure, DOM-free description of which user actions a unit offers. Actions are
// data only; nothing executes here. Rust (actions.rs) re-validates every path.
import type { WorktreeLifetimeView } from "../../api";

export type OpenKind = "terminal" | "editor" | "reveal";

export type ActionRequest =
  | { type: "open"; kind: OpenKind; path: string }
  | { type: "copy"; text: string }
  | { type: "register"; path: string }
  | { type: "prune"; root: string };

export interface UnitAction {
  id: string;
  label: string;
  request: ActionRequest;
}

// C0, DEL, C1, bidi embeddings/overrides (U+202A-202E) and isolates (U+2066-2069).
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export function isAbsPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 1 && p.startsWith("/") && !CONTROL.test(p);
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function isSafeRef(r: unknown): r is string {
  return typeof r === "string" && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(r) && !r.includes("..") && !r.includes("//") && !r.endsWith("/");
}

export function diffCommand(path: unknown, ref: unknown): string | undefined {
  if (!isAbsPath(path) || !isSafeRef(ref)) return undefined;
  return `git --no-pager -c core.fsmonitor=false -c diff.external= -C ${shellQuote(path)} diff --no-ext-diff --no-textconv --submodule=short ${ref}...HEAD`;
}

export function resumeCommand(agent: string | undefined, id: string | undefined): string | undefined {
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) return undefined;
  if (agent === "claude-code") return `claude --resume ${id}`;
  if (agent === "codex") return `codex resume ${id}`;
  return undefined;
}

export function worktreePath(w: Pick<WorktreeLifetimeView, "label" | "worktree_id">): string | undefined {
  if (isAbsPath(w.label)) return w.label;
  if (isAbsPath(w.worktree_id)) return w.worktree_id;
  return undefined;
}

const OPEN_LABELS: Array<[OpenKind, string, string]> = [
  ["terminal", "open-terminal", "Open in terminal"],
  ["editor", "open-editor", "Open in editor (VS Code)"],
  ["reveal", "reveal", "Reveal in Finder"],
];

export function actionsForWorktree(w: WorktreeLifetimeView): UnitAction[] {
  if (w.state === "gone") return [];
  const path = worktreePath(w);
  if (!path) return [];
  const out: UnitAction[] = OPEN_LABELS.map(([kind, id, label]) => ({ id, label, request: { type: "open", kind, path } }));
  const cmd = diffCommand(path, w.default_target_ref);
  if (cmd) out.push({ id: "copy-diff", label: "Copy diff command", request: { type: "copy", text: cmd } });
  return out;
}

export function actionsForSession(s: { source?: string; agent?: string; id?: string }): UnitAction[] {
  const cmd = resumeCommand(s.source ?? s.agent, s.id) ?? resumeCommand(s.agent, s.id);
  return cmd ? [{ id: "copy-resume", label: "Copy resume command", request: { type: "copy", text: cmd } }] : [];
}

function stripGit(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.endsWith("/.git") ? t.slice(0, -5) || "/" : t;
}

/** Absolute main-root path for a repo, or undefined (e.g. balanced-mode digest ids). */
export function repoRootOf(repoId: string | undefined, rawResolverLabel?: string): string | undefined {
  if (isAbsPath(repoId)) return stripGit(repoId);
  if (isAbsPath(rawResolverLabel)) return stripGit(rawResolverLabel);
  return undefined;
}

export interface RepoActionsInput {
  repoId: string;
  rawLabel?: string;
  registered: boolean;
  forks: WorktreeLifetimeView[];
}

export function actionsForRepo(r: RepoActionsInput): UnitAction[] {
  const out: UnitAction[] = [];
  if (!r.registered) {
    for (const f of r.forks) {
      if (f.state === "gone") continue;
      const path = worktreePath(f);
      if (path) {
        out.push({ id: "register-root", label: `Register root: ${path}`, request: { type: "register", path } });
        break;
      }
    }
  }
  const root = repoRootOf(r.repoId, r.rawLabel);
  if (root) out.push({ id: "prune-stale", label: "Prune stale worktrees", request: { type: "prune", root } });
  return out;
}
