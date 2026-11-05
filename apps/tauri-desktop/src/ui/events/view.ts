// Row building and focus mechanics shared by every event list: one tab stop with
// roving arrows, focus that survives a rebuild, and the row element itself.

import { el, onActivate } from "../../dom";
import { LOCAL } from "../../keys";
import { formatClock, severityClass, summaryLine, workspaceLabel } from "../../format";
import type { FirehoseEvent } from "../../api";

export interface ViewRow {
  key: string;
  event: FirehoseEvent;
  count: number;
}

export type StopDefault = "first" | "last";

const ROW = ".feed-row";

export function rowLabel(ev: FirehoseEvent, count: number): string {
  const when = formatClock(ev.time);
  const what = summaryLine(ev) + (count > 1 ? `, ${count} times` : "");
  return `${when} ${ev.source} ${ev.category}: ${what}. Open details`;
}

const stopDefaults = new WeakMap<HTMLElement, StopDefault>();

/** Marks exactly one row as the tab stop; everything else is reachable by arrow keys. */
export function setStop(box: HTMLElement, stop: Element | null): void {
  const rows = [...box.querySelectorAll<HTMLElement>(ROW)];
  const fallback = stopDefaults.get(box) === "first" ? rows[0] : rows[rows.length - 1];
  const chosen = stop && rows.includes(stop as HTMLElement) ? stop : fallback;
  for (const r of rows) r.setAttribute("tabindex", r === chosen ? "0" : "-1");
}

const roved = new WeakSet<HTMLElement>();
/** Roving tabindex over `.feed-row` descendants: Up/Down/Home/End move the single tab stop. */
export function rove(box: HTMLElement, stop: StopDefault = "last"): void {
  stopDefaults.set(box, stop);
  if (roved.has(box)) return;
  roved.add(box);
  box.addEventListener("focusin", (e) => {
    const row = (e.target as Element | null)?.closest?.(ROW);
    if (row && box.contains(row) && (e.target as Element) === row) setStop(box, row);
  });
  box.addEventListener("keydown", (e) => {
    const t = e.target as Element | null;
    if (!t || !t.classList?.contains("feed-row") || !LOCAL.feedRows.matches(e)) return;
    const rows = [...box.querySelectorAll<HTMLElement>(ROW)];
    const at = rows.indexOf(t as HTMLElement);
    let to = -1;
    if (e.key === "ArrowDown") to = Math.min(rows.length - 1, at + 1);
    else if (e.key === "ArrowUp") to = Math.max(0, at - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = rows.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setStop(box, rows[to]);
    rows[to].focus();
  });
}

const ACTION_SEP = "\0action";

/**
 * Remembers which row (or row action) has focus by its stable key so a rebuild can give it back:
 * the same element, else the same row, else the nearest surviving row, else the container. Never body.
 */
export function captureRowFocus(box: HTMLElement): () => void {
  const a = document.activeElement as HTMLElement | null;
  if (!a || !box.contains(a) || !a.hasAttribute("data-key")) return () => {};
  const order = [...box.querySelectorAll(ROW)].map((r) => r.getAttribute("data-key"));
  const exact = a.getAttribute("data-key");
  const key = a.classList.contains("feed-row") ? exact : (exact ?? "").split(ACTION_SEP)[0];
  return () => {
    const all = [...box.querySelectorAll<HTMLElement>("[data-key]")];
    const rows = all.filter((n) => n.classList.contains("feed-row"));
    const byKey = new Map(rows.map((r) => [r.getAttribute("data-key"), r]));
    const sameEl = all.find((n) => n.getAttribute("data-key") === exact);
    const same = sameEl ?? byKey.get(key);
    if (same) {
      if (same.classList.contains("feed-row")) setStop(box, same);
      same.focus({ preventScroll: true });
      return;
    }
    const at = order.indexOf(key);
    for (const k of [...order.slice(at + 1), ...order.slice(0, at).reverse()]) {
      const n = byKey.get(k);
      if (n) { setStop(box, n); n.focus({ preventScroll: true }); return; }
    }
    box.focus({ preventScroll: true });
  };
}

export function actionKey(rowKey: string): string {
  return rowKey + ACTION_SEP;
}

export interface RowOptions {
  /** Compact rows (time, category, summary) for read-only lists; full rows add source and workspace. */
  compact?: boolean;
  selected?: boolean;
}

export function eventRow(row: ViewRow, onSelect: (ev: FirehoseEvent) => void, o: RowOptions = {}): HTMLElement {
  const ev = row.event;
  const summary = summaryLine(ev) + (row.count > 1 ? ` ×${row.count}` : "");
  const cells = o.compact
    ? [
        el("span", { class: "cell time" }, formatClock(ev.time)),
        el("span", { class: "cell category" }, `[${ev.category}]`),
        el("span", { class: "cell summary" }, summary),
      ]
    : [
        el("span", { class: "cell time" }, formatClock(ev.time)),
        el("span", { class: `cell source src-${ev.source}` }, `[${ev.source}]`),
        el("span", { class: "cell category" }, `[${ev.category}]`),
        el("span", { class: "cell summary" }, summary),
        el("span", { class: "cell cwd", title: ev.cwd ?? "" }, workspaceLabel(ev.repo, ev.cwd)),
      ];
  const line = el(
    "div",
    {
      class: `feed-row ${severityClass(ev.severity)}${o.selected ? " selected" : ""}`,
      role: "button",
      tabindex: "-1",
      "data-key": row.key,
      "aria-label": rowLabel(ev, row.count),
      ...(o.selected ? { "aria-current": "true" } : {}),
    },
    ...cells,
  );
  onActivate(line, () => onSelect(ev), { self: true });
  return line;
}
