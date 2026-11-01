// Executes UnitAction requests. Only called from user clicks or key handlers.
// Every branch reports through onStatus; nothing here throws to the caller.
import type { ActionRequest, OpenKind } from "./model";

export interface ActionStatus {
  kind: "ok" | "info" | "warn" | "error";
  message: string;
}

export interface PrunePreviewEntry {
  id: string;
  line: string;
  gitdir_path?: string | null;
}
export interface PrunePreview {
  token: string;
  root: string;
  common_dir: string;
  entries: PrunePreviewEntry[];
  skipped: Array<{ id: string; reason: string }>;
}
export interface PruneApplyResult {
  removed: string[];
  remaining: string[];
  skipped: string[];
}
export interface PruneConfirmInfo {
  root: string;
  commonDir: string;
  entries: PrunePreviewEntry[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface RunnerDeps {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** null forces "no clipboard"; undefined uses navigator.clipboard. */
  clipboard?: { writeText(text: string): Promise<void> } | null;
  registerRoot: (path: string) => Promise<void>;
  confirm: (info: PruneConfirmInfo) => Promise<boolean>;
  onStatus: (s: ActionStatus) => void;
  onChanged: () => void;
}

export interface Runner {
  run(req: ActionRequest, label?: string): Promise<void>;
  cancelAll(): void;
}

const NEEDS_DESKTOP = "Actions need the desktop app.";

// Lazy import so modules that never run an action do not load the Tauri core.
async function defaultInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const core = await import("@tauri-apps/api/core");
  if (!core.isTauri()) throw new Error(NEEDS_DESKTOP);
  return core.invoke(cmd, args);
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

const OPENED: Record<OpenKind, string> = {
  terminal: "Opened in terminal",
  editor: "Opened in editor",
  reveal: "Revealed in Finder",
};

export function createRunner(deps: RunnerDeps): Runner {
  const invoke = deps.invoke ?? defaultInvoke;
  let busy = false;
  let gen = 0;
  let cancelPending: (() => void) | undefined;

  const clipboard = () => (deps.clipboard === undefined ? (typeof navigator !== "undefined" ? navigator.clipboard : undefined) : deps.clipboard);

  async function prune(root: string, live: () => boolean, say: (s: ActionStatus) => void) {
    const prev = (await invoke("prune_preview", { root })) as PrunePreview;
    if (!live()) return;
    const entries = prev.entries ?? [];
    const skipped = prev.skipped ?? [];
    if (entries.length === 0) {
      say(skipped.length > 0
        ? { kind: "info", message: `Nothing to prune: ${skipped.length} stale ${skipped.length === 1 ? "entry was" : "entries were"} skipped as not plain admin directories` }
        : { kind: "info", message: "Nothing to prune" });
      return;
    }
    const cancelled = new Promise<boolean>((r) => (cancelPending = () => r(false)));
    const ok = await Promise.race([deps.confirm({ root: prev.root, commonDir: prev.common_dir, entries, skipped }), cancelled]);
    cancelPending = undefined;
    if (!live()) return;
    if (!ok) {
      say({ kind: "info", message: "Prune cancelled" });
      return;
    }
    const res = (await invoke("prune_apply", { root, token: prev.token })) as PruneApplyResult;
    const removed = res.removed ?? [];
    const remaining = res.remaining ?? [];
    // The prune already happened on disk; refresh data even if the user navigated away.
    if (removed.length > 0) deps.onChanged();
    if (!live()) return;
    if (remaining.length > 0) {
      say({ kind: "warn", message: `Pruned ${removed.length}, but ${remaining.length} stale ${remaining.length === 1 ? "entry" : "entries"} remain: ${remaining.join(", ")}` });
    } else {
      say({ kind: "ok", message: `Pruned ${removed.length} stale worktree entries` });
    }
  }

  return {
    async run(req, label) {
      if (busy) {
        deps.onStatus({ kind: "info", message: "Another action is in progress" });
        return;
      }
      busy = true;
      const my = ++gen;
      const live = () => gen === my;
      const say = (s: ActionStatus) => {
        if (live()) deps.onStatus(s);
      };
      try {
        switch (req.type) {
          case "open":
            await invoke("open_path", { kind: req.kind, path: req.path });
            say({ kind: "ok", message: OPENED[req.kind] ?? "Opened" });
            break;
          case "copy": {
            try {
              const cb = clipboard();
              if (!cb) throw new Error("no clipboard");
              await cb.writeText(req.text);
              say({ kind: "ok", message: `Copied ${label ?? "to clipboard"}` });
            } catch {
              say({ kind: "error", message: `Could not copy: ${req.text}` });
            }
            break;
          }
          case "register":
            await deps.registerRoot(req.path);
            deps.onChanged();
            say({ kind: "ok", message: "Registered repository root" });
            break;
          case "prune":
            await prune(req.root, live, say);
            break;
        }
      } catch (e) {
        say({ kind: "error", message: errText(e) });
      } finally {
        if (live()) {
          busy = false;
          cancelPending = undefined;
        }
      }
    },
    cancelAll() {
      gen++;
      busy = false;
      const c = cancelPending;
      cancelPending = undefined;
      c?.();
    },
  };
}
