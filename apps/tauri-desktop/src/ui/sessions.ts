import { attention, sessionEvents, sessions } from "../api";
import type { AttentionSession, FirehoseEvent, SessionSummary } from "../api";
import { clear, el, onActivate } from "../dom";
import { formatClock, projectName, sessionName, sessionRefLabel, sessionWhere, shortId, workspaceKey, worktreeName } from "../format";
import type { SessionLike } from "../format";
import type { SessionDirectory } from "../session-directory";
import { ERROR_MARK } from "../glyphs";
import { idChip } from "./session-id";
import { evidenceTime, needsLabel, pendingNow, stateWord } from "../needs";
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
  /** Needs you mode: the inbox replaces the list. Never touches scope. */
  setNeedsOnly(on: boolean): void;
  needsOnly(): boolean;
  /** Shows the panel: applies the optional Needs you state (absent keeps the last), then refreshes. */
  activate(opts?: { needsOnly?: boolean }): Promise<void>;
};

/** Rows drawn per page; the rest wait behind a "Show N more" button. */
export const SESSION_PAGE = 200;

export interface WorktreeOptions {
  /** The Needs you inbox (the strip's source), shown in place of the list while the toggle is on. */
  inbox?: { root: HTMLElement; refresh(): unknown; count?(): number; onCount?(fn: () => void): void };
}

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
 * "unknown", never "needs you".
 */
function statusOf(entries: readonly AttentionSession[], nowMs: number): Status {
  const pending = entries.filter((a) => pendingNow(a, nowMs)).sort((a, b) => evidenceTime(a.pending) - evidenceTime(b.pending));
  if (pending.length > 0) {
    const first = pending[0];
    return { label: needsLabel(first, nowMs), needs: true, since: evidenceTime(first.pending), text: first.pending?.summary };
  }
  if (entries.length === 0) return { label: "unknown", needs: false, since: NaN };
  const latest = entries.reduce((a, b) => (evidenceTime(b.last) > evidenceTime(a.last) ? b : a));
  return { label: stateWord(latest.state), needs: false, since: NaN };
}
export function createSessions(
  onSelect: (ev: FirehoseEvent) => void,
  recentEvents: () => readonly FirehoseEvent[],
  onOpenScore?: (id: string, source?: string) => void,
  onOpenLoops?: (id: string, source?: string) => void,
  store: ScopeStore = createScope(),
  directory?: SessionDirectory,
  /** Records the activated session in scope; called before its history opens. */
  onSelectSession: (ref: SessionRef) => void = () => {},
  opts: WorktreeOptions = {},
): SessionsPanel {
  const listBox = el("div", { class: "sessions-list", tabindex: "-1", "aria-label": "Sessions" });
  const eventsBox = el("div", { class: "sessions-events" });
  const scopeLine = el("p", { class: "sessions-scope" });
  const needsCount = el("span", { class: "sessions-needs-count" });
  const needsBtn = el("button", { type: "button", class: "sessions-needs", "aria-pressed": "false" }, "Needs you", needsCount);
  const inboxBox = el("div", { class: "sessions-inbox" });
  inboxBox.hidden = true;
  if (opts.inbox) inboxBox.append(el("p", { class: "dim sessions-inbox-caption" }, "Needs you, across all projects"), opts.inbox.root);
  const head = el("div", { class: "sessions-head" }, scopeLine, needsBtn);
  const body = el("div", { class: "sessions-body" }, inboxBox, listBox, eventsBox);
  const root = el("section", { class: "sessions" }, el("h2", {}, "Worktree"), head, body);
  let needs = false;
  let refreshGen = 0;
  /** Requests in flight; the periodic poll skips while one is pending so a slow response is never starved. */
  let pendingRequests = 0;
  let cap = SESSION_PAGE;

  function drawScopeLine() {
    const sc = store.get();
    const lab = store.resolver()?.labels(sc) ?? {};
    if (sc.worktree) {
      const n = worktreeName(sc.worktree, lab.worktree);
      scopeLine.textContent = n.label;
      scopeLine.title = n.full;
    } else if (sc.project) {
      const n = projectName(sc.project, lab.project);
      scopeLine.textContent = n.label;
      scopeLine.title = n.full;
    } else {
      scopeLine.textContent = "Sessions in all worktrees";
      scopeLine.removeAttribute("title");
    }
  }
  function drawNeedsCount() {
    const n = opts.inbox?.count?.();
    needsCount.textContent = n === undefined ? "" : ` (${n})`;
  }
  function applyNeeds(on: boolean) {
    needs = on;
    needsBtn.setAttribute("aria-pressed", String(on));
    inboxBox.hidden = !on;
    listBox.hidden = on;
    drawNeedsCount();
  }
  async function refreshInbox() {
    try {
      await opts.inbox?.refresh();
    } catch { /* the inbox reports its own failures */ }
    drawNeedsCount();
  }
  function setNeedsOnly(on: boolean) {
    const changed = on !== needs;
    applyNeeds(on);
    if (changed && on) void refreshInbox();
  }
  needsBtn.addEventListener("click", () => setNeedsOnly(!needs));
  opts.inbox?.onCount?.(drawNeedsCount);
  drawScopeLine();
  store.onResolver(drawScopeLine);
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
    drawScopeLine();
    if (next.project !== prev.project || next.worktree !== prev.worktree || next.cell?.where !== prev.cell?.where || next.cell?.agent !== prev.cell?.agent) cap = SESSION_PAGE;
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
    return el("div", { class: "sessions-cell" }, el("span", {}, active.label), clearBtn);
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

  /** What names the history on screen: the matching source's attention entry when the open is source-qualified. */
  function headingSubject(id: string, s: SessionSummary | undefined, source: string | undefined): SessionLike | undefined {
    if (source && s && s.source !== source) return knownBySource.get(`${source}\0${id}`) ?? { id, source };
    if (source && !s) return knownBySource.get(`${source}\0${id}`);
    return s;
  }

  function sessionHeading(id: string, summary: SessionSummary | undefined, source: string | undefined, count: number): HTMLElement {
    const s = headingSubject(id, summary, source) ?? directory?.lookup({ id, source });
    const ref = sessionRefLabel({ id, source }, s);
    const where = s ? sessionWhere(s) : { label: "", full: undefined };
    const facts = [source || s?.source, where.label, s?.first_time ? `started ${formatClock(s.first_time)}` : "", `${count} events`].filter(Boolean);
    return el(
      "div",
      { class: "session-heading" },
      el("h3", { class: ref.resolved ? "" : "unresolved" }, ref.label),
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
      el(
        "span",
        s.has_error
          ? { class: "cell err", role: "img", "aria-label": "error captured", title: "an error was captured in this session" }
          : { class: "cell err", title: "" },
        s.has_error ? ERROR_MARK : "",
      ),
    );
    const facts = [s.agent || s.source, where.label, s.first_time ? `started ${formatClock(s.first_time)}` : "", `${s.events} events`].filter(Boolean);
    const subRow = el("div", { class: "session-sub" }, el("span", { class: "session-facts", title: where.full ?? "" }, facts.join(" · ")));
    if (onOpenScore) {
      // The score replays this one session; the row itself still opens the list.
      const score = el("button", { class: "score-open", "aria-label": `open score for ${sessionName(s)}`, title: "replay this session as a score" }, "score");
      score.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenScore(s.id, s.source);
      });
      subRow.append(score);
    }
    if (onOpenLoops) {
      const loops = el("button", { class: "loops-open", "aria-label": `open loops for ${sessionName(s)}` }, "loops");
      loops.addEventListener("click", (e) => { e.stopPropagation(); onOpenLoops(s.id, s.source); });
      subRow.append(loops);
    }
    const item = el(
      "div",
      {
        class: "session-item",
        tabindex: "0",
        // A group, not a button: it holds the Score, Loops and id controls, and a button's children are presentational.
        role: "group",
        "aria-label": `open ${sessionName(s)}, ${status.label}`,
        "data-id": s.id,
        ...(s.source ? { "data-source": s.source } : {}),
      },
      row,
      el("div", { class: "session-last", title: summary }, summary),
      subRow,
      idChip(s.id),
    );
    // Choosing a row narrows the scope first, then opens its history. Its own
    // controls (score, loops, id chip) are not the row.
    onActivate(
      item,
      () => {
        onSelectSession(s.source ? { id: s.id, source: s.source } : { id: s.id });
        void openSession(s.id);
      },
      { self: true },
    );
    return item;
  }

  const itemKey = (n: Element): string => `${n.getAttribute("data-source") ?? ""}\0${n.getAttribute("data-id") ?? ""}`;
  const CONTROLS = ["score-open", "loops-open", "session-id"];

  /**
   * Remembers what has focus in the list so a rebuild can give it back: the same
   * item or nested control, else the nearest surviving item, else the list itself.
   */
  function captureFocus(): () => void {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !listBox.contains(a)) return () => {};
    const order = [...listBox.querySelectorAll(".session-item")].map(itemKey);
    const item = a.closest(".session-item");
    const key = item ? itemKey(item) : undefined;
    const control = item && a !== item ? CONTROLS.find((c) => a.classList.contains(c)) : undefined;
    const onChip = !item && !!a.closest(".sessions-cell");
    return () => {
      const fresh = [...listBox.querySelectorAll<HTMLElement>(".session-item")];
      if (onChip) {
        const btn = listBox.querySelector<HTMLElement>(".sessions-cell button");
        if (btn) { btn.focus(); return; }
      }
      if (key !== undefined) {
        const same = fresh.find((n) => itemKey(n) === key);
        if (same) {
          (control ? same.querySelector<HTMLElement>(`.${control}`) ?? same : same).focus();
          return;
        }
        const at = order.indexOf(key);
        const alive = new Map(fresh.map((n) => [itemKey(n), n]));
        for (const k of [...order.slice(at + 1), ...order.slice(0, at).reverse()]) {
          const n = alive.get(k);
          if (n) { n.focus(); return; }
        }
      }
      listBox.focus();
    };
  }

  async function refresh() {
    let restoreFocus: (() => void) | undefined;
    try {
      await rebuild((fn) => { restoreFocus = fn; });
    } finally {
      restoreFocus?.();
    }
  }

  async function rebuild(willClear: (restore: () => void) => void) {
    const gen = ++refreshGen;
    pendingRequests++;
    try {
      await rebuildBody(gen, willClear);
    } finally {
      pendingRequests--;
    }
  }

  async function rebuildBody(gen: number, willClear: (restore: () => void) => void) {
    drawNeedsCount();
    if (!listBox.firstChild) {
      listBox.append(el("p", { class: "dim" }, "loading sessions…"));
    }
    try {
      const now = Date.now();
      const scoped = !!(store.get().worktree || store.get().project);
      const [list, inbox] = await Promise.allSettled([sessions(), attention(), scoped ? store.resolver()?.refresh?.() : undefined]);
      // A newer refresh started while these requests were in flight: it owns the DOM and the maps.
      if (gen !== refreshGen) return;
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
      directory?.remember([...list.value, ...(inbox.status === "fulfilled" ? inbox.value.sessions : [])]);
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
      willClear(captureFocus());
      clear(listBox);
      if (scope) {
        listBox.append(scopeChip(scope));
      }
      if (all.length === 0) {
        listBox.append(el("p", { class: "dim" }, scope ? "no sessions in this worktree" : members ? "no sessions in this scope" : "no sessions captured yet"));
        return;
      }
      if (members) {
        const part = store.resolver()?.partial?.(sc);
        const note = part ? `active sessions in this scope (partial: ${part.known} of ${part.total} sessions known)` : "active sessions in this scope";
        listBox.append(el("p", { class: "dim sessions-scope-note" }, note));
      }
      const counts = bucketCountsBySession(recentEvents(), now);
      let scale = 0;
      for (const c of counts.values()) {
        for (const n of c) scale = Math.max(scale, n);
      }
      for (const { s, status } of all.slice(0, cap)) {
        listBox.append(sessionItem(s, status, counts.get(s.id) ?? [], scale, now));
      }
      if (all.length > cap) {
        const more = el("button", { type: "button", class: "sessions-more" }, `Show ${all.length - cap} more`);
        more.addEventListener("click", () => {
          cap += SESSION_PAGE;
          void refresh();
        });
        listBox.append(more);
      }
    } catch (err) {
      if (gen !== refreshGen) return;
      willClear(captureFocus());
      clear(listBox);
      listBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  // Ages and sparklines move while the panel is on screen.
  setInterval(() => {
    if (root.isConnected && pendingRequests === 0) void refresh();
  }, REFRESH_MS);

  async function activate(o?: { needsOnly?: boolean }) {
    if (o?.needsOnly !== undefined) applyNeeds(o.needsOnly);
    drawScopeLine();
    await Promise.all([refresh(), needs ? refreshInbox() : undefined]);
  }

  return { root, refresh, openSession, setScope, setNeedsOnly, needsOnly: () => needs, activate };
}
