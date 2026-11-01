// App-owned actions controller: one instance per app shell. Renders the action
// menu, the honest prune confirmation dialog and the status toast, and wires the
// runner. All text goes through el()/textContent; nothing here uses innerHTML.
import { el } from "../../dom";
import { claimEscape } from "../../escape";
import type { ActionRequest, UnitAction } from "./model";
import { createRunner, type ActionStatus, type PruneConfirmInfo, type RunnerDeps } from "./runner";

export type ActionsDeps = Omit<RunnerDeps, "confirm" | "onStatus">;

export interface MenuOpts {
  returnFocus?: HTMLElement | null;
}

export interface ActionsUi {
  root: HTMLElement;
  openMenu(actions: readonly UnitAction[], anchor: HTMLElement | { x: number; y: number }, opts?: MenuOpts): void;
  close(): void;
  run(req: ActionRequest, label?: string): Promise<void>;
  cancelAll(): void;
}

const TOAST_MS = 4000;
const TOAST_ERROR_MS = 8000;
const MARGIN = 8;

function freeze(a: UnitAction): UnitAction {
  return Object.freeze({ id: a.id, label: a.label, request: Object.freeze({ ...a.request }) as ActionRequest });
}

export function createActions(deps: ActionsDeps): ActionsUi {
  const root = el("div", { class: "actions-host" });
  const toast = el("div", { class: "action-toast", role: "status", "aria-live": "polite" });
  root.append(toast);

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let menu: HTMLElement | null = null;
  let menuFocus: HTMLElement | null = null;
  let dialog: { node: HTMLElement; resolve: (ok: boolean) => void; returnFocus: Element | null } | null = null;

  function say(s: ActionStatus): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toast.className = `action-toast ${s.kind}`;
    toast.textContent = s.message;
    toastTimer = setTimeout(() => {
      toastTimer = undefined;
      toast.className = "action-toast";
      toast.textContent = "";
    }, s.kind === "error" ? TOAST_ERROR_MS : TOAST_MS);
  }

  function onOutside(e: Event): void {
    if (menu && !menu.contains(e.target as Node)) closeMenu(false);
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!menu) return;
    document.removeEventListener("pointerdown", onOutside, true);
    menu.remove();
    menu = null;
    const f = menuFocus;
    menuFocus = null;
    if (restoreFocus && f && f.isConnected) f.focus();
  }

  function closeDialog(ok: boolean): void {
    if (!dialog) return;
    const d = dialog;
    dialog = null;
    d.node.remove();
    d.resolve(ok);
    if (d.returnFocus instanceof HTMLElement && d.returnFocus.isConnected) d.returnFocus.focus();
  }

  function confirm(info: PruneConfirmInfo): Promise<boolean> {
    closeMenu(false);
    closeDialog(false);
    return new Promise<boolean>((resolve) => {
      const n = info.entries.length;
      const lines = info.entries.map((e) => (e.gitdir_path ? `${e.id}  ${e.gitdir_path}` : e.id)).join("\n");
      const cancel = el("button", { type: "button", class: "action-dialog-cancel" }, "Cancel");
      const ok = el("button", { type: "button", class: "action-dialog-ok" }, `Prune ${n} stale ${n === 1 ? "entry" : "entries"}`);
      const skipped = info.skipped.length
        ? el("div", { class: "action-dialog-skipped" }, el("div", { class: "dim" }, "Skipped (not touched):"),
            el("ul", {}, ...info.skipped.map((s) => el("li", {}, `${s.id}: ${s.reason}`))))
        : null;
      const node = el("div", { class: "action-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Prune stale worktrees" },
        el("div", { class: "action-dialog-card" },
          el("h2", {}, "Prune stale worktrees"),
          el("p", {}, "Main worktree: ", el("span", { class: "mono" }, info.root)),
          el("p", {}, "Git directory: ", el("span", { class: "mono" }, info.commonDir)),
          el("pre", { class: "action-dialog-entries" }, lines),
          skipped,
          el("p", { class: "dim" }, "This removes only git's administrative records under .git/worktrees. It never deletes branches or working directories."),
          el("p", { class: "dim" }, "Worktrees on unmounted or removable volumes look stale; mark them with `git worktree lock` to keep them."),
          el("div", { class: "action-dialog-buttons" }, cancel, ok)));
      node.addEventListener("click", (e) => {
        if (e.target === node) closeDialog(false);
      });
      node.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          claimEscape(e);
          e.preventDefault();
          e.stopPropagation();
          closeDialog(false);
        } else if (e.key === "Tab") {
          e.preventDefault();
          (document.activeElement === cancel ? ok : cancel).focus();
        }
      });
      cancel.addEventListener("click", () => closeDialog(false));
      ok.addEventListener("click", () => closeDialog(true));
      dialog = { node, resolve, returnFocus: document.activeElement };
      root.append(node);
      cancel.focus();
    });
  }

  const runner = createRunner({ ...deps, confirm, onStatus: say });

  function run(req: ActionRequest, label?: string): Promise<void> {
    return runner.run(req, label);
  }

  function openMenu(actions: readonly UnitAction[], anchor: HTMLElement | { x: number; y: number }, opts: MenuOpts = {}): void {
    if (dialog) return;
    closeMenu(false);
    if (actions.length === 0) {
      say({ kind: "info", message: "No actions for this item" });
      return;
    }
    const items = actions.map(freeze);
    const buttons = items.map((a) =>
      el("button", { type: "button", role: "menuitem", tabindex: "-1" }, a.label));
    const m = el("div", { class: "action-menu", role: "menu" }, ...buttons);
    const focusAt = (i: number) => buttons[(i + buttons.length) % buttons.length].focus();
    buttons.forEach((b, i) => {
      b.addEventListener("click", () => {
        const a = items[i];
        closeMenu(true);
        void run(a.request, a.request.type === "copy" ? a.label.replace(/^Copy\s+/i, "") : undefined);
      });
    });
    m.addEventListener("keydown", (e) => {
      const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusAt(cur + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusAt(cur < 0 ? -1 : cur - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (cur >= 0) buttons[cur].click();
      } else if (e.key === "Escape") {
        claimEscape(e);
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      } else if (e.key === "Tab") {
        closeMenu(false);
      }
    });
    let x: number;
    let y: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = r.left;
      y = r.bottom;
    } else {
      ({ x, y } = anchor);
    }
    menu = m;
    menuFocus = opts.returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    root.append(m);
    const w = m.offsetWidth || 0;
    const h = m.offsetHeight || 0;
    const left = Math.max(0, Math.min(x, window.innerWidth - w - MARGIN));
    const top = Math.max(0, Math.min(y, window.innerHeight - h - MARGIN));
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
    document.addEventListener("pointerdown", onOutside, true);
    buttons[0].focus();
  }

  return {
    root,
    openMenu,
    close: () => closeMenu(true),
    run,
    cancelAll() {
      closeMenu(false);
      runner.cancelAll();
      closeDialog(false);
    },
  };
}
