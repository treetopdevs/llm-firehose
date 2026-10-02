import { attention, sessionEvents, sessions } from "../api";
import type { AttentionSession, FirehoseEvent, SessionSummary } from "../api";
import { clear, el } from "../dom";
import { workspaceKey, workspaceLabel } from "../format";
import { evidenceTime, needsLabel, pendingNow } from "../needs";
import { bucketCountsBySession, formatAge, sessionHue, sparkline } from "../spark";
import { renderEventList } from "./feed";
import type { CellScope } from "./workspace/model";

export type SessionsPanel = {
  root: HTMLElement;
  refresh(): Promise<void>;
  openSession(id: string, source?: string): Promise<void>;
  /** Narrows the list to one workspace × agent cell; null shows every session. */
  setScope(scope: CellScope | null): void;
};

const REFRESH_MS = 5000;

// Session explorer: a small-multiples band from /sessions (one row per
// session, same encoding every row), drill-down via /sessions/{id}. Who needs
// you comes from /attention, so this list agrees with the strip and dwell.

type Status = {
  label: string;
  needs: boolean;
  /** When the oldest live pending episode was captured. */
  since: number;
  text?: string;
};

/**
 * /sessions aggregates every source under one native id, so a row needs you
 * when any /attention entry with that id holds a live pending episode. A
 * session /attention does not know (legacy history, or /attention down) is
 * "unknown", never NEEDS YOU.
 */
function statusOf(entries: readonly AttentionSession[], nowMs: number): Status {
  const pending = entries.filter((a) => pendingNow(a, nowMs)).sort((a, b) => evidenceTime(a.pending) - evidenceTime(b.pending));
  if (pending.length > 0) {
    const first = pending[0];
    return { label: needsLabel(first, nowMs), needs: true, since: evidenceTime(first.pending), text: first.pending?.summary };
  }
  if (entries.length === 0) return { label: "unknown", needs: false, since: NaN };
  const latest = entries.reduce((a, b) => (evidenceTime(b.last) > evidenceTime(a.last) ? b : a));
  return { label: latest.state, needs: false, since: NaN };
}
export function createSessions(
  onSelect: (ev: FirehoseEvent) => void,
  recentEvents: () => readonly FirehoseEvent[],
): SessionsPanel {
  const listBox = el("div", { class: "sessions-list" });
  const eventsBox = el("div", { class: "sessions-events" });
  const root = el("section", { class: "sessions" }, listBox, eventsBox);
  let scope: CellScope | null = null;
  let historyVersion = 0;

  function setScope(next: CellScope | null) {
    scope = next;
  }

  function inScope(s: SessionSummary): boolean {
    return !scope || (workspaceKey(s.repo, s.cwd) === scope.where && (s.agent || s.source) === scope.agent);
  }

  function scopeChip(active: CellScope): HTMLElement {
    const clearBtn = el("button", { title: "show every session" }, "×");
    clearBtn.addEventListener("click", () => {
      scope = null;
      void refresh();
    });
    return el("div", { class: "sessions-scope" }, el("span", {}, active.label), clearBtn);
  }

  async function openSession(id: string, source?: string) {
    const version = ++historyVersion;
    clear(eventsBox);
    eventsBox.append(el("p", { class: "dim" }, `loading ${id}…`));
    try {
      const evs = (await sessionEvents(id)).filter(ev => !source || ev.source === source);
      if (version !== historyVersion) return;
      clear(eventsBox);
      eventsBox.append(el("h3", {}, `session ${id} — ${evs.length} events`));
      renderEventList(eventsBox, evs, onSelect);
    } catch (err) {
      if (version !== historyVersion) return;
      clear(eventsBox);
      eventsBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  function sessionItem(s: SessionSummary, status: Status, buckets: readonly number[], scale: number, now: number): HTMLElement {
    const needs = status.needs;
    const last = Date.parse(s.last_time);
    const age = Number.isNaN(last) ? "" : formatAge(now - last);
    const summary = (needs && status.text) || (s.last_summary ?? "");
    const row = el(
      "div",
      { class: "band-row", style: `--hue:${sessionHue(s.id)}` },
      el("span", { class: "cell agent" }, s.agent || s.source),
      el("span", { class: "cell spark", "aria-hidden": "true" }, sparkline(buckets, scale)),
      el("span", { class: "cell age" }, age),
      el("span", { class: `cell state${needs ? " needs" : ""}` }, status.label),
      el("span", { class: "cell err", title: s.has_error ? "an error was captured in this session" : "" }, s.has_error ? "!" : ""),
      el("span", { class: "cell summary" }, summary),
    );
    const sub = [workspaceLabel(s.repo, s.cwd), `${s.events} events`].filter(Boolean).join(" · ");
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
      const now = Date.now();
      const [list, inbox] = await Promise.allSettled([sessions(), attention()]);
      if (list.status === "rejected") throw list.reason;
      const byId = new Map<string, AttentionSession[]>();
      if (inbox.status === "fulfilled") {
        for (const a of inbox.value.sessions) {
          byId.set(a.id, [...(byId.get(a.id) ?? []), a]);
        }
      }
      const all = list.value
        .filter(inScope)
        .map((s) => ({ s, status: statusOf(byId.get(s.id) ?? [], now) }))
        .sort((a, b) => {
          if (a.status.needs !== b.status.needs) return a.status.needs ? -1 : 1;
          // Longest wait first, then most recent activity, then id.
          const d = a.status.needs ? a.status.since - b.status.since : Date.parse(b.s.last_time) - Date.parse(a.s.last_time);
          if (Number.isFinite(d) && d !== 0) return d;
          return a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0;
        });
      clear(listBox);
      if (scope) {
        listBox.append(scopeChip(scope));
      }
      if (all.length === 0) {
        listBox.append(el("p", { class: "dim" }, scope ? "no sessions in this cell" : "no sessions captured yet"));
        return;
      }
      const counts = bucketCountsBySession(recentEvents(), now);
      let scale = 0;
      for (const c of counts.values()) {
        for (const n of c) scale = Math.max(scale, n);
      }
      for (const { s, status } of all) {
        listBox.append(sessionItem(s, status, counts.get(s.id) ?? [], scale, now));
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

  return { root, refresh, openSession, setScope };
}
