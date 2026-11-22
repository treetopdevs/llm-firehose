// Select, then open (MS-8). One click or an arrow key selects a row, and only the inspector
// follows; Enter, Space or a double click opens it, which is the only thing that navigates.
// The row never moves while it is selected, so a double click lands on the same node twice.
import { LOCAL } from "./keys";

export interface SelectOpen {
  /** Fills the inspector. Never navigates and never writes the scope. */
  select(): void;
  /** Drills in, and so pushes a history entry. */
  open(): void;
}

export interface SelectOpenOptions {
  /** Ignore events that start in a control inside the row (a nested button or focusable). */
  self?: boolean;
  /** The rows in list order, for the arrow keys. Without it the arrows do nothing. */
  siblings?: () => readonly Element[];
}

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [tabindex], [role="button"], [contenteditable=""], [contenteditable="true"]';

/** The event name a row listens to for "select yourself" (an arrow key on a neighbour sends it). */
export const ROW_SELECT_EVENT = "rowselect";

export function onSelectOpen(node: Element, h: SelectOpen, opts: SelectOpenOptions = {}): void {
  const fromControl = (e: Event): boolean => {
    if (!opts.self) return false;
    const hit = (e.target as Element | null)?.closest?.(INTERACTIVE) ?? null;
    return hit !== null && hit !== node && node.contains(hit);
  };
  node.addEventListener("click", (e) => {
    if (!fromControl(e)) h.select();
  });
  node.addEventListener("dblclick", (e) => {
    if (!fromControl(e)) h.open();
  });
  node.addEventListener(ROW_SELECT_EVENT, () => h.select());
  node.addEventListener("keydown", (e) => {
    if (fromControl(e)) return;
    if (LOCAL.activate.matches(e)) {
      e.preventDefault();
      h.open();
      return;
    }
    if (!LOCAL.rowSelect.matches(e) || !opts.siblings) return;
    const rows = opts.siblings();
    const to = rows[rows.indexOf(node) + (e.key === "ArrowDown" ? 1 : -1)];
    if (!to) return;
    e.preventDefault();
    (to as HTMLElement).focus?.();
    to.dispatchEvent(new Event(ROW_SELECT_EVENT));
  });
}
