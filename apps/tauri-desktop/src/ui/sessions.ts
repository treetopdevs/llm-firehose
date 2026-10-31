import { attention, sessionEvents, sessions } from "../api";
import type { AttentionSession, FirehoseEvent, SessionSummary } from "../api";
import { clear, el } from "../dom";
import { formatClock, sessionName, sessionWhere, shortId, workspaceKey } from "../format";
import type { SessionLike } from "../format";
import { evidenceTime, needsLabel, pendingNow } from "../needs";
import { bucketCountsBySession, formatAge, sessionHue, sparkline } from "../spark";
import { renderEventList } from "./feed";
import type { CellScope } from "./workspace/model";
import { createScope, membership, sameSession } from "../scope";
import type { ScopeStore, SessionRef } from "../scope";

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
  onOpenScore?: (id: string) => void,
  onOpenLoops?: (id: string) => void,
  store: ScopeStore = createScope(),
): SessionsPanel {
  const listBox = el("div", { class: "sessions-list" });
  const eventsBox = el("div", { class: "sessions-events" });
  const root = el("section", { class: "sessions" }, listBox, eventsBox);
  let historyVersion = 0;
  /** The last list drawn, so a session opened by id can be named. */
  let known = new Map<string, SessionSummary>();
  /** /attention entries by `source\0id`: a source-qualified open is named by its own source, not the aggregated row's. */
  let knownBySource = new Map<string, AttentionSession>();
  /** The session whose history is on screen, so a refreshed title updates its heading. */
  let shown: { id: string; source?: string; count: number } | null = null;

  /** The session whose history is on screen or loading; null when no history is open. */
  let historyRef: SessionRef | null = null;

  function setScope(next: CellScope | null) {
    store.narrow({ cell: next ?? undefined });
  }

  function inCell(s: SessionSummary, cell: CellScope | undefined): boolean {
    return !cell || (workspaceKey(s.repo, s.cwd) === cell.where && (s.agent || s.source) === cell.agent);
  }

  /** Invalidates any load in flight and empties the history area. */
  function dropHistory() {
    ++historyVersion;
    historyRef = null;
    shown = null;
    clear(eventsBox);
  }

  // Never narrows the store, only reconciles the history with it.
  store.subscribe((next, prev) => {
    if (!historyRef) return;
    const cellOpened = next.cell !== undefined && (next.cell.where !== prev.cell?.where || next.cell.agent !== prev.cell?.agent);
    const contextMoved = next.project !== prev.project || next.worktree !== prev.worktree || !sameSession(next.session, prev.session);
    const departed = contextMoved && (!next.session || !sameSession(next.session, historyRef));
    if (cellOpened || departed) dropHistory();
  });

  function scopeChip(active: CellScope): HTMLElement {
    const clearBtn = el("button", { title: "show every session" }, "×");
    clearBtn.addEventListener("click", () => {
      store.narrow({ cell: undefined });
      void refresh();
    });
    return el("div", { class: "sessions-scope" }, el("span", {}, active.label), clearBtn);
  }

  async function openSession(id: string, source?: string) {
    const version = ++historyVersion;
    historyRef = source === undefined ? { id } : { id, source };
    clear(eventsBox);
    eventsBox.append(el("p", { class: "dim" }, `loading ${known.has(id) ? sessionName(known.get(id)!) : `session ${shortId(id)}`}…`));
    try {
      // Arriving from the graph, dwell or lanes, the list may not have loaded yet:
      // fetch the summary alongside the history so the heading is the name, not the id.
      const [evsAll, s] = await Promise.all([
        sessionEvents(id),
        known.has(id)
          ? Promise.resolve(known.get(id))
          : Promise.resolve()
              .then(() => sessions())
              .then((list) => list?.find((x) => x.id === id))
              .catch(() => undefined),
      ]);
      const evs = evsAll.filter(ev => !source || ev.source === source);
      if (version !== historyVersion) return;
      clear(eventsBox);
      shown = { id, source, count: evs.length };
      // renderEventList owns (and clears) its container, so the heading gets its own.
      // The list may have refreshed while the history loaded: prefer its summary.
      const list = el("div", { class: "session-events-list" });
      eventsBox.append(sessionHeading(id, known.get(id) ?? s, source, evs.length), list);
      renderEventList(list, evs, onSelect);
    } catch (err) {
      if (version !== historyVersion) return;
      historyRef = null;
      clear(eventsBox);
      eventsBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  /** The full native id, demoted to a copyable detail. */
  function idChip(id: string): HTMLElement {
    const chip = el("button", { class: "session-id dim", title: `copy session id ${id}`, "aria-label": `copy session id ${id}` }, id);
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard?.writeText(id).then(
        () => chip.classList.add("copied"),
        () => {},
      );
    });
    return chip;
  }

  /** What names the history on screen: the matching source's attention entry when the open is source-qualified. */
  function headingSubject(id: string, s: SessionSummary | undefined, source: string | undefined): SessionLike | undefined {
    if (source && s && s.source !== source) return knownBySource.get(`${source}\0${id}`) ?? { id, source };
    if (source && !s) return knownBySource.get(`${source}\0${id}`);
    return s;
  }

  function sessionHeading(id: string, summary: SessionSummary | undefined, source: string | undefined, count: number): HTMLElement {
    const s = headingSubject(id, summary, source);
    const name = s ? sessionName(s) : `session ${shortId(id)}`;
    const where = s ? sessionWhere(s) : { label: "", full: undefined };
    const facts = [source || s?.source, where.label, s?.first_time ? `started ${formatClock(s.first_time)}` : "", `${count} events`].filter(Boolean);
    return el(
      "div",
      { class: "session-heading" },
      el("h3", {}, name),
      el("div", { class: "session-sub" }, el("span", { title: where.full ?? "" }, facts.join(" · ")), idChip(id)),
    );
  }

  function sessionItem(s: SessionSummary, status: Status, buckets: readonly number[], scale: number, now: number): HTMLElement {
    const needs = status.needs;
    const last = Date.parse(s.last_time);
    const age = Number.isNaN(last) ? "" : formatAge(now - last);
    const summary = (needs && status.text) || (s.last_summary ?? "");
    const where = sessionWhere(s);
    const row = el(
      "div",
      { class: "band-row", style: `--hue:${sessionHue(s.id)}` },
      el("span", { class: "cell name", title: s.title ? sessionName(s) : "" }, sessionName(s)),
      el("span", { class: "cell spark", "aria-hidden": "true" }, sparkline(buckets, scale)),
      el("span", { class: "cell age" }, age),
      el("span", { class: `cell state${needs ? " needs" : ""}` }, status.label),
      el("span", { class: "cell err", title: s.has_error ? "an error was captured in this session" : "" }, s.has_error ? "!" : ""),
    );
    const facts = [s.agent || s.source, where.label, s.first_time ? `started ${formatClock(s.first_time)}` : "", `${s.events} events`].filter(Boolean);
    const subRow = el("div", { class: "session-sub" }, el("span", { class: "session-facts", title: where.full ?? "" }, facts.join(" · ")));
    if (onOpenScore) {
      // The score replays this one session; the row itself still opens the list.
      const score = el("button", { class: "score-open", "aria-label": `open score for session ${s.id}`, title: "replay this session as a score" }, "score");
      score.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenScore(s.id);
      });
      subRow.append(score);
    }
    if (onOpenLoops) {
      const loops = el("button", { class: "loops-open", "aria-label": `open loops for session ${s.id}` }, "loops");
      loops.addEventListener("click", (e) => { e.stopPropagation(); onOpenLoops(s.id); });
      subRow.append(loops);
    }
    const item = el(
      "div",
      { class: "session-item", tabindex: "0", "data-id": s.id },
      row,
      el("div", { class: "session-last", title: summary }, summary),
      subRow,
      idChip(s.id),
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
      const scoped = !!(store.get().worktree || store.get().project);
      const [list, inbox] = await Promise.allSettled([sessions(), attention(), scoped ? store.resolver()?.refresh?.() : undefined]);
      if (list.status === "rejected") throw list.reason;
      const byId = new Map<string, AttentionSession[]>();
      if (inbox.status === "fulfilled") {
        knownBySource = new Map();
        for (const a of inbox.value.sessions) {
          byId.set(a.id, [...(byId.get(a.id) ?? []), a]);
          knownBySource.set(`${a.source}\0${a.id}`, a);
        }
      }
      // The scope may have moved while the requests were in flight: read it now.
      const sc = store.get();
      const scope = sc.cell ?? null;
      const members = sc.worktree || sc.project ? membership(store, sc) : undefined;
      known = new Map(list.value.map((s) => [s.id, s]));
      // A title that arrived since the history was opened moves into its heading.
      const heading = eventsBox.querySelector(".session-heading");
      if (shown && heading) heading.replaceWith(sessionHeading(shown.id, known.get(shown.id), shown.source, shown.count));
      const all = list.value
        .filter((s) => inCell(s, sc.cell) && (!members || members({ id: s.id, source: s.source })))
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
        listBox.append(el("p", { class: "dim" }, scope ? "no sessions in this cell" : members ? "no sessions in this scope" : "no sessions captured yet"));
        return;
      }
      if (members) listBox.append(el("p", { class: "dim sessions-scope-note" }, "active sessions in this scope"));
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
