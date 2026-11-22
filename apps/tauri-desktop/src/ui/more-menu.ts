// The More menu (MS-9): where a demoted view lives. One button opens a small menu of
// radio items; Escape closes it and gives focus back to the button; arrows, Home and End
// move; choosing an item closes it. The pop-up stays in the DOM (hidden) so a view that
// was reached by another route can be marked as the current one.
import { el } from "../dom";
import { claimEscape, yieldsToModal } from "../escape";
import { LOCAL } from "../keys";

export interface MoreItem {
  id: string;
  label: string;
}

export interface MoreMenuOptions {
  /** The closed button's text, and the menu's accessible name. */
  label: string;
  items: readonly MoreItem[];
  onPick(id: string): void;
  /** Extra attributes for one item, for an id other code already names. */
  itemAttrs?(id: string): Record<string, string>;
}

export interface MoreMenu {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  items: ReadonlyMap<string, HTMLButtonElement>;
  /** Marks the demoted view that is showing, if any; the button then names it. */
  setCurrent(id: string | undefined): void;
  open(): void;
  close(restoreFocus?: boolean): void;
  isOpen(): boolean;
}

let seq = 0;

export function createMoreMenu(opts: MoreMenuOptions): MoreMenu {
  const popId = `more-pop-${++seq}`;
  const caret = el("span", { class: "more-caret", "aria-hidden": "true" }, "▾");
  const name = el("span", { class: "more-name" }, opts.label);
  const trigger = el("button", { type: "button", class: "more-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": popId }, name, caret);
  const pop = el("div", { class: "more-pop", role: "menu", id: popId, "aria-label": opts.label });
  pop.hidden = true;
  const byId = new Map<string, HTMLButtonElement>();
  for (const it of opts.items) {
    const b = el("button", { type: "button", class: "more-item", role: "menuitemradio", "aria-checked": "false", "data-more": it.id, ...(opts.itemAttrs?.(it.id) ?? {}) }, it.label);
    b.addEventListener("click", () => {
      close(true);
      opts.onPick(it.id);
    });
    byId.set(it.id, b);
    pop.append(b);
  }
  const root = el("span", { class: "more" }, trigger, pop);
  const list = (): HTMLButtonElement[] => [...byId.values()];
  let current: string | undefined;

  const isOpen = (): boolean => !pop.hidden;
  function close(restoreFocus = false): void {
    if (!isOpen()) return;
    pop.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (restoreFocus) trigger.focus();
  }
  function open(at: "current" | "first" | "last" = "current"): void {
    if (isOpen()) return;
    pop.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    const items = list();
    const target = at === "last" ? items[items.length - 1] : at === "first" ? items[0] : ((current && byId.get(current)) || items[0]);
    target?.focus();
  }
  function onOutside(e: Event): void {
    if (!root.contains(e.target as Node)) close(false);
  }

  trigger.addEventListener("click", () => (isOpen() ? close(true) : open()));
  root.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (isOpen() && next && !root.contains(next)) close(false);
  });
  root.addEventListener("keydown", (e) => {
    if (!LOCAL.moreMenu.matches(e)) return;
    const t = e.target as Element;
    if (!isOpen()) {
      if (t === trigger && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        open(e.key === "ArrowDown" ? "first" : "last");
      }
      return;
    }
    if (e.key === "Escape") {
      if (e.defaultPrevented || yieldsToModal(e, trigger)) return;
      claimEscape(e);
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const items = list();
    const at = items.indexOf(t as HTMLButtonElement);
    const to =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at <= 0 ? items.length - 1 : at - 1) : -1;
    if (to < 0) return;
    e.preventDefault();
    items[to]?.focus();
  });

  return {
    root,
    trigger,
    items: byId,
    isOpen,
    open: () => open(),
    close: (restore = false) => close(restore),
    setCurrent(id) {
      current = id !== undefined && byId.has(id) ? id : undefined;
      for (const [k, b] of byId) b.setAttribute("aria-checked", String(k === current));
      const label = current !== undefined ? opts.items.find((i) => i.id === current)!.label : opts.label;
      name.textContent = label;
      trigger.classList.toggle("current", current !== undefined);
      trigger.setAttribute("aria-label", current !== undefined ? `${opts.label}, ${label} selected` : opts.label);
    },
  };
}
