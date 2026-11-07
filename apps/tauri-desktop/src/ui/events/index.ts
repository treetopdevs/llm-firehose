// One event list for Fleet Events, Project Events and the Worktree rung. It renders
// EventRows from any EventSource; the owner of the source keeps its network and state.

import type { FirehoseEvent } from "../../api";
import { clear, el } from "../../dom";
import { QUEUE_KEYS, registerKeys } from "../../keys";
import { coalesce } from "../../state";
import type { EventQuery, EventRow, EventSource, EventWindow } from "./model";
import { actionKey, captureRowFocus, eventRow, rove, setStop } from "./view";

export type { EventQuery, EventRow, EventSource, EventWindow } from "./model";

const CATEGORIES = [
  "", "session", "prompt", "message", "tool", "file", "permission", "shell", "error", "meta",
];

const NO_SPACE_TARGETS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);

export interface RowAction {
  label: string;
  run(row: EventRow): void;
}

export interface EventListOptions {
  heading?: string | false;
  onSelect: (ev: FirehoseEvent) => void;
  /** The retained scope.window as a time range, or undefined while following live. */
  window?: () => EventWindow | undefined;
  /** Returns to the live window; offered while a range is applied. */
  resetWindow?: () => void;
  /** Labels a session reference in the optional session filter. */
  sessionLabel?: (ref: string) => string;
  /** A control rendered as a sibling of the row (never inside it), so its keys do not select the row. */
  rowAction?: (row: EventRow) => RowAction | undefined;
  /** The logical row key to highlight; survives coalesce replacement. */
  selectedKey?: () => string | undefined;
}

export interface EventList {
  root: HTMLElement;
  /** Takes ownership of the events key scope and redraws. */
  activate(): void;
  /** Gives the key scope up (only if this list still owns it). */
  deactivate(): void;
  /** Called by the single onEvent fan-out; redraws while mounted. */
  onEvent(ev?: FirehoseEvent): void;
  setFilter(q: EventQuery): void;
  /** The typed query the owner has not been told about yet (inside the search debounce). */
  pending(): EventQuery | undefined;
  refresh(): void;
}

// One list owns the "events" scope at a time; a stale instance is displaced, and
// only the owner may release it.
let owner: object | null = null;
let releaseKeys: (() => void) | undefined;

export function createEventList(source: EventSource, opts: EventListOptions): EventList {
  const me = {};
  const rowsBox = el("div", { class: "feed-rows", role: "group", "aria-label": "Events", tabindex: "0" });
  rove(rowsBox, source.order === "newest-first" ? "first" : "last");

  let query: EventQuery = {};

  const pauseBtn = el("button", { class: "pause" }, "pause");
  pauseBtn.addEventListener("click", () => {
    togglePause();
  });

  // data-key lets keepFocus give the control back when a host rebuilds around the list.
  const categorySel = el("select", { title: "category filter", "data-key": "events-category" });
  for (const c of CATEGORIES) categorySel.append(el("option", { value: c }, c === "" ? "all categories" : c));
  const sourceSel = el("select", { title: "source filter", "data-key": "events-source" });
  const sessionSel = opts.sessionLabel ? el("select", { title: "session filter", "data-key": "events-session" }) : null;
  const search = el("input", { type: "search", placeholder: "search summaries…", "data-key": "events-search" });

  // Typing redraws locally at once, but the owner's refetch waits for a pause, so a host that
  // rebuilds around the list on every page does not take focus away mid-word.
  const SEARCH_DEBOUNCE_MS = 250;
  let pendingQuery: ReturnType<typeof setTimeout> | undefined;
  const flushQuery = () => {
    if (pendingQuery === undefined) return;
    clearTimeout(pendingQuery);
    pendingQuery = undefined;
    source.setQuery(query);
  };
  const readQuery = (): EventQuery => ({
    category: categorySel.value || undefined,
    source: sourceSel.value || undefined,
    session: sessionSel?.value || undefined,
    text: search.value || undefined,
  });
  const applyFilter = () => {
    flushQuery();
    query = readQuery();
    source.setQuery(query);
    refresh();
  };
  categorySel.addEventListener("change", applyFilter);
  sourceSel.addEventListener("change", applyFilter);
  sessionSel?.addEventListener("change", applyFilter);
  search.addEventListener("input", () => {
    query = readQuery();
    if (pendingQuery !== undefined) clearTimeout(pendingQuery);
    pendingQuery = setTimeout(() => {
      pendingQuery = undefined;
      source.setQuery(query);
    }, SEARCH_DEBOUNCE_MS);
    refresh();
  });

  const bar = el("div", { class: "feed-bar" });
  if (source.pausable) bar.append(pauseBtn);
  bar.append(categorySel, sourceSel);
  if (sessionSel) bar.append(sessionSel);
  bar.append(search);

  const notice = el("p", { class: "dim", role: "status" });
  notice.hidden = true;
  const windowNote = el("p", { class: "feed-window dim", role: "status" });
  windowNote.hidden = true;
  const more = el("div", { class: "feed-more" });
  more.hidden = true;
  const root = el(
    "section",
    { class: "feed", "data-component": "event-list" },
    ...(opts.heading === false ? [] : [el("h2", {}, opts.heading ?? "Events")]),
    bar,
    notice,
    windowNote,
    rowsBox,
    more,
  );

  // The query is authoritative: options are built first (including the requested value, even
  // before the source lists it) and only then is the selection restored from it.
  function fillSelect(sel: HTMLSelectElement, all: string, values: string[], current: string | undefined, label: (v: string) => string = (v) => v): void {
    clear(sel);
    sel.append(el("option", { value: "" }, all));
    const shown = current && !values.includes(current) ? [...values, current] : values;
    for (const v of shown) sel.append(el("option", { value: v }, label(v)));
    sel.value = current ?? "";
  }

  function togglePause(): void {
    if (source.paused) source.resume();
    else source.pause();
    refresh();
  }

  let loading = false;

  function refresh(): void {
    const range = opts.window?.();
    if (source.pausable) {
      const unread = source.unread(query, range);
      pauseBtn.textContent = source.paused ? `resume${unread > 0 ? ` (${unread} new)` : ""}` : "pause";
      pauseBtn.classList.toggle("paused", source.paused);
    }
    fillSelect(sourceSel, "all sources", source.sources(), query.source);
    if (sessionSel) fillSelect(sessionSel, "all sessions", source.sessions(), query.session, opts.sessionLabel);

    const note = source.notice();
    notice.textContent = note;
    notice.hidden = note === "";

    clear(windowNote);
    windowNote.hidden = !range;
    if (range) {
      windowNote.append("Showing the retained time window, not the live tail. ");
      if (opts.resetWindow) {
        const live = el("button", { type: "button", class: "feed-window-live" }, "Return to live");
        live.addEventListener("click", () => {
          opts.resetWindow!();
          refresh();
        });
        windowNote.append(live);
      }
    }

    const oldestFirst = source.order === "oldest-first";
    const atBottom = rowsBox.scrollTop + rowsBox.clientHeight >= rowsBox.scrollHeight - 8;
    const prevTop = rowsBox.scrollTop;
    const restoreFocus = captureRowFocus(rowsBox);
    const prevStop = rowsBox.querySelector(".feed-row[tabindex='0']")?.getAttribute("data-key") ?? null;
    clear(rowsBox);
    const selected = opts.selectedKey?.();
    for (const row of source.rows(query, range)) {
      const line = eventRow(row, opts.onSelect, { selected: selected !== undefined && selected === row.key });
      const action = opts.rowAction?.(row);
      if (!action) {
        rowsBox.append(line);
        continue;
      }
      const btn = el("button", { type: "button", class: "feed-row-action", "data-key": actionKey(row.key) }, action.label);
      btn.addEventListener("click", () => action.run(row));
      rowsBox.append(el("div", { class: "feed-item" }, line, btn));
    }
    setStop(rowsBox, prevStop === null ? null : rowsBox.querySelector(`.feed-row[data-key="${CSS.escape(prevStop)}"]`));
    restoreFocus();
    if (oldestFirst) {
      if (!source.paused && atBottom) rowsBox.scrollTop = rowsBox.scrollHeight;
    } else {
      rowsBox.scrollTop = prevTop;
    }

    clear(more);
    more.hidden = !(source.hasOlder && source.loadOlder);
    if (!more.hidden) {
      const older = el("button", { type: "button", class: "feed-older" }, "Load older events");
      older.disabled = loading;
      older.addEventListener("click", () => {
        if (loading) return;
        loading = true;
        older.disabled = true;
        void Promise.resolve(source.loadOlder!()).finally(() => {
          loading = false;
          refresh();
        });
      });
      more.append(older);
    }
  }

  // Space pauses/resumes when focus is on the page or inside the list, but not on a
  // field, a button, or a row (where it selects). Lists that cannot pause never claim it.
  const pauseOnSpace = (e: KeyboardEvent): boolean => {
    if (!source.pausable) return false;
    const t = e.target as Element | null;
    const onPage = t === null || t === document.body || (t as unknown) === document || t === document.documentElement;
    if (!onPage && !(t instanceof Element && root.contains(t))) return false;
    if (t instanceof Element) {
      if (NO_SPACE_TARGETS.has(t.tagName) || t.closest(".feed-row") || (t as HTMLElement).isContentEditable) return false;
    }
    e.preventDefault();
    togglePause();
    return true;
  };

  function claim(): void {
    if (!source.pausable || owner === me) return;
    releaseKeys?.();
    owner = me;
    releaseKeys = registerKeys([
      { scope: "events", ...QUEUE_KEYS.jump, label: "pause or resume the feed", handler: pauseOnSpace, enabled: () => root.isConnected },
    ]);
  }
  function release(): void {
    if (owner !== me) return;
    releaseKeys?.();
    releaseKeys = undefined;
    owner = null;
  }
  claim();

  return {
    root,
    activate() {
      claim();
      refresh();
    },
    deactivate: release,
    onEvent() {
      if (root.isConnected) refresh();
    },
    setFilter(q) {
      if (pendingQuery !== undefined) {
        clearTimeout(pendingQuery);
        pendingQuery = undefined;
      }
      query = { ...q };
      categorySel.value = q.category ?? "";
      sourceSel.value = q.source ?? "";
      if (sessionSel) sessionSel.value = q.session ?? "";
      search.value = q.text ?? "";
      source.setQuery(query);
      refresh();
    },
    pending: () => (pendingQuery === undefined ? undefined : { ...query }),
    refresh,
  };
}

/** Read-only coalesced list (time, category, summary) into a container the caller owns. */
export function renderEventRows(container: HTMLElement, events: FirehoseEvent[], onSelect: (ev: FirehoseEvent) => void): void {
  clear(container);
  rove(container);
  for (const row of coalesce(events)) container.append(eventRow(row, onSelect, { compact: true }));
  setStop(container, null);
}
