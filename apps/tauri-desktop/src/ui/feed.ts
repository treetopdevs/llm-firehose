import type { FirehoseEvent } from "../api";
import { clear, el } from "../dom";
import { formatClock, severityClass, summaryLine, workspaceLabel } from "../format";
import type { FeedState, Row } from "../state";
import { coalesce } from "../state";

const CATEGORIES = [
  "", "session", "prompt", "message", "tool", "file", "permission", "shell", "error", "meta",
];

export interface FeedPanel {
  root: HTMLElement;
  refresh(): void;
}

// The live feed: filter bar + event rows, newest at the bottom, auto-scroll
// unless paused. Row click opens the detail pane.
export function createFeed(feed: FeedState, onSelect: (ev: FirehoseEvent) => void): FeedPanel {
  const rowsBox = el("div", { class: "feed-rows", role: "list" });

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
  const root = el("section", { class: "feed" }, bar, rowsBox);

  function renderRow(row: Row): HTMLElement {
    const ev = row.event;
    const line = el(
      "div",
      { class: `feed-row ${severityClass(ev.severity)}`, role: "listitem", tabindex: "0" },
      el("span", { class: "cell time" }, formatClock(ev.time)),
      el("span", { class: `cell source src-${ev.source}` }, `[${ev.source}]`),
      el("span", { class: "cell category" }, `[${ev.category}]`),
      el("span", { class: "cell summary" }, summaryLine(ev) + (row.count > 1 ? ` ×${row.count}` : "")),
      el("span", { class: "cell cwd", title: ev.cwd ?? "" }, workspaceLabel(ev.repo, ev.cwd)),
    );
    line.addEventListener("click", () => onSelect(ev));
    return line;
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

    const atBottom =
      rowsBox.scrollTop + rowsBox.clientHeight >= rowsBox.scrollHeight - 8;
    clear(rowsBox);
    for (const row of feed.rows().slice(-1000)) {
      rowsBox.append(renderRow(row));
    }
    if (!feed.paused && atBottom) {
      rowsBox.scrollTop = rowsBox.scrollHeight;
    }
  }

  // space pauses/resumes when not typing in a field
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !root.isConnected) return;
    const active = document.activeElement?.tagName;
    if (active === "INPUT" || active === "SELECT" || active === "TEXTAREA") return;
    e.preventDefault();
    if (feed.paused) {
      feed.resume();
    } else {
      feed.pause();
    }
    refresh();
  });

  return { root, refresh };
}

// Read-only event list used by the session explorer.
export function renderEventList(container: HTMLElement, evs: FirehoseEvent[], onSelect: (ev: FirehoseEvent) => void): void {
  clear(container);
  for (const row of coalesce(evs)) {
    const ev = row.event;
    const line = el(
      "div",
      { class: `feed-row ${severityClass(ev.severity)}`, role: "listitem", tabindex: "0" },
      el("span", { class: "cell time" }, formatClock(ev.time)),
      el("span", { class: "cell category" }, `[${ev.category}]`),
      el("span", { class: "cell summary" }, summaryLine(ev) + (row.count > 1 ? ` ×${row.count}` : "")),
    );
    line.addEventListener("click", () => onSelect(ev));
    container.append(line);
  }
}
