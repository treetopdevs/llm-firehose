import { sessionEvents, sessions } from "../api";
import type { FirehoseEvent, SessionSummary } from "../api";
import { clear, el } from "../dom";
import { shortPath } from "../format";
import { bucketCountsBySession, formatAge, sessionHue, sparkline } from "../spark";
import { renderEventList } from "./feed";

export type SessionsPanel = {
  root: HTMLElement;
  refresh(): Promise<void>;
  openSession(id: string): Promise<void>;
};

const REFRESH_MS = 5000;

// Needs-you first (longest wait first), then most recent activity.
function bySupervision(a: SessionSummary, b: SessionSummary): number {
  const an = a.state === "needs_input";
  const bn = b.state === "needs_input";
  if (an !== bn) return an ? -1 : 1;
  if (an) {
    const d = Date.parse(a.state_since ?? "") - Date.parse(b.state_since ?? "");
    if (Number.isFinite(d) && d !== 0) return d;
  }
  const d = Date.parse(b.last_time) - Date.parse(a.last_time);
  if (Number.isFinite(d) && d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Session explorer: a small-multiples band from /sessions (one row per
// session, same encoding every row), drill-down via /sessions/{id}.
export function createSessions(
  onSelect: (ev: FirehoseEvent) => void,
  recentEvents: () => readonly FirehoseEvent[],
): SessionsPanel {
  const listBox = el("div", { class: "sessions-list" });
  const eventsBox = el("div", { class: "sessions-events" });
  const root = el("section", { class: "sessions" }, listBox, eventsBox);

  async function openSession(id: string) {
    clear(eventsBox);
    eventsBox.append(el("p", { class: "dim" }, `loading ${id}…`));
    try {
      const evs = await sessionEvents(id);
      clear(eventsBox);
      eventsBox.append(el("h3", {}, `session ${id} — ${evs.length} events`));
      renderEventList(eventsBox, evs, onSelect);
    } catch (err) {
      clear(eventsBox);
      eventsBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  function sessionItem(s: SessionSummary, buckets: readonly number[], scale: number, now: number): HTMLElement {
    const needs = s.state === "needs_input";
    const last = Date.parse(s.last_time);
    const age = Number.isNaN(last) ? "" : formatAge(now - last);
    const summary = needs && s.state_reason ? s.state_reason : (s.last_summary ?? "");
    const row = el(
      "div",
      { class: "band-row", style: `--hue:${sessionHue(s.id)}` },
      el("span", { class: "cell agent" }, s.agent || s.source),
      el("span", { class: "cell spark", "aria-hidden": "true" }, sparkline(buckets, scale)),
      el("span", { class: "cell age" }, age),
      el("span", { class: `cell state${needs ? " needs" : ""}` }, needs ? "NEEDS YOU" : (s.state ?? "")),
      el("span", { class: "cell err", title: s.has_error ? "an error was captured in this session" : "" }, s.has_error ? "!" : ""),
      el("span", { class: "cell summary" }, summary),
    );
    const sub = [s.repo, s.cwd ? shortPath(s.cwd) : "", `${s.events} events`].filter(Boolean).join(" · ");
    const item = el(
      "div",
      { class: "session-item", tabindex: "0" },
      row,
      el("div", { class: "session-sub" }, sub),
      el("div", { class: "session-id dim" }, s.id),
    );
    item.addEventListener("click", () => openSession(s.id));
    return item;
  }

  async function refresh() {
    if (!listBox.firstChild) {
      listBox.append(el("p", { class: "dim" }, "loading sessions…"));
    }
    try {
      const all = [...(await sessions())].sort(bySupervision);
      clear(listBox);
      if (all.length === 0) {
        listBox.append(el("p", { class: "dim" }, "no sessions captured yet"));
        return;
      }
      const now = Date.now();
      const counts = bucketCountsBySession(recentEvents(), now);
      let scale = 0;
      for (const c of counts.values()) {
        for (const n of c) scale = Math.max(scale, n);
      }
      for (const s of all) {
        listBox.append(sessionItem(s, counts.get(s.id) ?? [], scale, now));
      }
    } catch (err) {
      clear(listBox);
      listBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  // Ages and sparklines move while the panel is on screen.
  setInterval(() => {
    if (root.isConnected) void refresh();
  }, REFRESH_MS);

  return { root, refresh, openSession };
}
