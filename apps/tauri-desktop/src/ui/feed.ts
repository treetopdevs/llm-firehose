import type { FirehoseEvent } from "../api";
import { clear, el, onActivate } from "../dom";
import { LOCAL, QUEUE_KEYS, registerKeys } from "../keys";
import { formatClock, severityClass, summaryLine, workspaceLabel } from "../format";
import type { FeedState, Row } from "../state";
import { coalesce } from "../state";

const CATEGORIES = [
  "", "session", "prompt", "message", "tool", "file", "permission", "shell", "error", "meta",
];

const NO_SPACE_TARGETS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);

function rowLabel(ev: FirehoseEvent, count: number): string {
  const when = formatClock(ev.time);
  const what = summaryLine(ev) + (count > 1 ? `, ${count} times` : "");
  return `${when} ${ev.source} ${ev.category}: ${what}. Open details`;
}

/** Marks exactly one row as the tab stop; everything else is reachable by arrow keys. */
function setStop(box: HTMLElement, stop: Element | null): void {
  const rows = [...box.querySelectorAll<HTMLElement>(".feed-row")];
  const chosen = stop && rows.includes(stop as HTMLElement) ? stop : rows[rows.length - 1];
  for (const r of rows) r.setAttribute("tabindex", r === chosen ? "0" : "-1");
}

const roved = new WeakSet<HTMLElement>();
/** Roving tabindex over `.feed-row` children: Up/Down/Home/End move the single tab stop. */
function rove(box: HTMLElement): void {
  if (roved.has(box)) return;
  roved.add(box);
  box.addEventListener("focusin", (e) => {
    const row = (e.target as Element | null)?.closest?.(".feed-row");
    if (row && box.contains(row) && (e.target as Element) === row) setStop(box, row);
  });
  box.addEventListener("keydown", (e) => {
    const t = e.target as Element | null;
    if (!t || !t.classList?.contains("feed-row") || !LOCAL.feedRows.matches(e)) return;
    const rows = [...box.querySelectorAll<HTMLElement>(".feed-row")];
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

/**
 * Remembers which row has focus (by its stable key) so a rebuild can give it back:
 * the same row, else the nearest surviving row, else the container. Never body.
 */
function captureRowFocus(box: HTMLElement): () => void {
  const a = document.activeElement as HTMLElement | null;
  if (!a || !box.contains(a) || !a.classList.contains("feed-row")) return () => {};
  const order = [...box.querySelectorAll(".feed-row")].map((r) => r.getAttribute("data-key"));
  const key = a.getAttribute("data-key");
  return () => {
    const rows = [...box.querySelectorAll<HTMLElement>(".feed-row")];
    const byKey = new Map(rows.map((r) => [r.getAttribute("data-key"), r]));
    const same = byKey.get(key);
    if (same) { setStop(box, same); same.focus({ preventScroll: true }); return; }
    const at = order.indexOf(key);
    for (const k of [...order.slice(at + 1), ...order.slice(0, at).reverse()]) {
      const n = byKey.get(k);
      if (n) { setStop(box, n); n.focus({ preventScroll: true }); return; }
    }
    box.focus({ preventScroll: true });
  };
}

function eventRow(row: Row, onSelect: (ev: FirehoseEvent) => void, cells: HTMLElement[]): HTMLElement {
  const ev = row.event;
  const line = el(
    "div",
    {
      class: `feed-row ${severityClass(ev.severity)}`,
      role: "button",
      tabindex: "-1",
      "data-key": row.key,
      "aria-label": rowLabel(ev, row.count),
    },
    ...cells,
  );
  onActivate(line, () => onSelect(ev), { self: true });
  return line;
}

export interface FeedPanel {
  root: HTMLElement;
  refresh(): void;
}

// The live feed: filter bar + event rows, newest at the bottom, auto-scroll
// unless paused. Row click opens the detail pane.
let activeFeedKeys: (() => void) | undefined;

export function createFeed(feed: FeedState, onSelect: (ev: FirehoseEvent) => void, opts?: {
  heading?: string | false;
  /** The retained scope.window as a time range, or undefined while following live. Rows outside it are hidden. */
  window?: () => { from?: number; to?: number } | undefined;
  /** Returns to the live window; offered while a range is applied. */
  resetWindow?: () => void;
}): FeedPanel {
  const rowsBox = el("div", { class: "feed-rows", role: "group", "aria-label": "Events", tabindex: "0" });
  rove(rowsBox);

  const pauseBtn = el("button", { class: "pause" }, "pause");
  pauseBtn.addEventListener("click", () => {
    if (feed.paused) {
      feed.resume();
    } else {
      feed.pause();
    }
    refresh();
  });

  const categorySel = el("select", { title: "category filter" });
  for (const c of CATEGORIES) {
    categorySel.append(el("option", { value: c }, c === "" ? "all categories" : c));
  }
  const sourceSel = el("select", { title: "source filter" });
  const search = el("input", { type: "search", placeholder: "search summaries…" });

  const applyFilter = () => {
    feed.setFilter({
      category: categorySel.value || undefined,
      source: sourceSel.value || undefined,
      text: search.value || undefined,
    });
    refresh();
  };
  categorySel.addEventListener("change", applyFilter);
  sourceSel.addEventListener("change", applyFilter);
  search.addEventListener("input", applyFilter);

  const bar = el("div", { class: "feed-bar" }, pauseBtn, categorySel, sourceSel, search);
  const windowNote = el("p", { class: "feed-window dim", role: "status" });
  windowNote.hidden = true;
  const root = el("section", { class: "feed" }, ...(opts?.heading === false ? [] : [el("h2", {}, opts?.heading ?? "Events")]), bar, windowNote, rowsBox);

  function renderRow(row: Row): HTMLElement {
    const ev = row.event;
    return eventRow(row, onSelect, [
      el("span", { class: "cell time" }, formatClock(ev.time)),
      el("span", { class: `cell source src-${ev.source}` }, `[${ev.source}]`),
      el("span", { class: "cell category" }, `[${ev.category}]`),
      el("span", { class: "cell summary" }, summaryLine(ev) + (row.count > 1 ? ` ×${row.count}` : "")),
      el("span", { class: "cell cwd", title: ev.cwd ?? "" }, workspaceLabel(ev.repo, ev.cwd)),
    ]);
  }

  function refreshSources() {
    const current = sourceSel.value;
    clear(sourceSel);
    sourceSel.append(el("option", { value: "" }, "all sources"));
    for (const s of feed.sources()) {
      sourceSel.append(el("option", { value: s }, s));
    }
    sourceSel.value = current;
  }

  function refresh() {
    pauseBtn.textContent = feed.paused
      ? `resume${feed.unread > 0 ? ` (${feed.unread} new)` : ""}`
      : "pause";
    pauseBtn.classList.toggle("paused", feed.paused);
    refreshSources();
    const range = opts?.window?.();
    clear(windowNote);
    windowNote.hidden = !range;
    if (range) {
      windowNote.append("Showing the retained time window, not the live tail. ");
      if (opts?.resetWindow) {
        const live = el("button", { type: "button", class: "feed-window-live" }, "Return to live");
        live.addEventListener("click", () => {
          opts.resetWindow!();
          refresh();
        });
        windowNote.append(live);
      }
    }

    const atBottom =
      rowsBox.scrollTop + rowsBox.clientHeight >= rowsBox.scrollHeight - 8;
    const restoreFocus = captureRowFocus(rowsBox);
    const prevStop = rowsBox.querySelector(".feed-row[tabindex='0']")?.getAttribute("data-key") ?? null;
    clear(rowsBox);
    const inRange = (row: Row): boolean => {
      if (!range) return true;
      const t = Date.parse(row.event.time);
      return !Number.isNaN(t) && (range.from === undefined || t >= range.from) && (range.to === undefined || t <= range.to);
    };
    for (const row of feed.rows().filter(inRange).slice(-1000)) {
      rowsBox.append(renderRow(row));
    }
    setStop(rowsBox, prevStop === null ? null : rowsBox.querySelector(`.feed-row[data-key="${CSS.escape(prevStop)}"]`));
    restoreFocus();
    if (!feed.paused && atBottom) {
      rowsBox.scrollTop = rowsBox.scrollHeight;
    }
  }

  // Space pauses/resumes when focus is on the page or inside the feed, but not on a
  // field, a button, or a row (where it selects).
  const pauseOnSpace = (e: KeyboardEvent): boolean => {
    const t = e.target as Element | null;
    const onPage = t === null || t === document.body || (t as unknown) === document || t === document.documentElement;
    if (!onPage && !(t instanceof Element && root.contains(t))) return false;
    if (t instanceof Element) {
      if (NO_SPACE_TARGETS.has(t.tagName) || t.closest(".feed-row") || (t as HTMLElement).isContentEditable) return false;
    }
    e.preventDefault();
    if (feed.paused) {
      feed.resume();
    } else {
      feed.pause();
    }
    refresh();
    return true;
  };
  // One feed owns the "events" scope at a time; a stale instance is displaced.
  activeFeedKeys?.();
  activeFeedKeys = registerKeys([
    { scope: "events", ...QUEUE_KEYS.jump, label: "pause or resume the feed", handler: pauseOnSpace, enabled: () => root.isConnected },
  ]);

  return { root, refresh };
}

// Read-only event list used by the session explorer.
export function renderEventList(container: HTMLElement, evs: FirehoseEvent[], onSelect: (ev: FirehoseEvent) => void): void {
  clear(container);
  rove(container);
  for (const row of coalesce(evs)) {
    const ev = row.event;
    container.append(
      eventRow(row, onSelect, [
        el("span", { class: "cell time" }, formatClock(ev.time)),
        el("span", { class: "cell category" }, `[${ev.category}]`),
        el("span", { class: "cell summary" }, summaryLine(ev) + (row.count > 1 ? ` ×${row.count}` : "")),
      ]),
    );
  }
  setStop(container, null);
}
