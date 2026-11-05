import { attention, sessionEvents, sessions } from "../api";
import type { AttentionSession, FirehoseEvent, SessionSummary, WorktreeLifetimeView, WorktreeSessionRef } from "../api";
import { clear, el, onActivate } from "../dom";
import { formatClock, projectName, sessionName, sessionRefLabel, sessionWhere, shortId, workspaceKey, worktreeName } from "../format";
import type { SessionLike } from "../format";
import type { SessionDirectory } from "../session-directory";
import { ERROR_MARK } from "../glyphs";
import { idChip } from "./session-id";
import { evidenceTime, needsLabel, pendingNow, stateWord } from "../needs";
import { bucketCountsBySession, formatAge, sessionHue, sparkline } from "../spark";
import { renderEventRows } from "./events";
import { scopeEvents } from "./events/model";
import type { CellScope } from "./workspace/model";
import { createScope, membership, sameSession } from "../scope";
import type { Scope, ScopeStore, SessionRef } from "../scope";
import { describeWorktree, orderWorktrees } from "./worktree-list";
import type { WorktreeRow } from "./worktree-list";

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
  /** Whether the current scope draws the worktree list; the one predicate Escape and the draw share. */
  hasWorktreeList(): boolean;
};

/** Rows drawn per page; the rest wait behind a "Show N more" button. */
export const SESSION_PAGE = 200;

export interface WorktreeOptions {
  /** The Needs you inbox (the strip's source), shown in place of the list while the toggle is on. */
  inbox?: { root: HTMLElement; refresh(): unknown; count?(): number; onCount?(fn: () => void): void };
}

const REFRESH_MS = 5000;
/** A refresh request that has not settled by now is abandoned, so the periodic poll is never starved by a hung one. */
const REQUEST_DEADLINE_MS = 15_000;

/** Settles with p, or with undefined once the deadline signal aborts (or the same deadline elapses on the clock): a consumer must not outlive its deadline on a collaborator that ignores the signal. */
function bounded<T>(p: Promise<T> | undefined, signal: AbortSignal): Promise<T | undefined> | undefined {
  if (!p) return p;
  return new Promise<T | undefined>((resolve, reject) => {
    if (signal.aborted) return resolve(undefined);
    const timer = setTimeout(() => resolve(undefined), REQUEST_DEADLINE_MS);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

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

const sessionKey = (source: string, id: string): string => `${source}\0${id}`;

/**
 * A row joins only its own source's /attention entry. /sessions keys rows by native id
 * alone with the first event's source (projection ix.sessions), while /attention keys by
 * (source, id): another agent sharing the id has no row of its own and shows in the Needs
 * you inbox only, never on this row. An entry /attention does not know (legacy history,
 * or /attention down) is "unknown", never "needs you".
 */
function statusOf(entry: AttentionSession | undefined, nowMs: number): Status {
  if (!entry) return { label: "unknown", needs: false, since: NaN };
  if (pendingNow(entry, nowMs)) return { label: needsLabel(entry, nowMs), needs: true, since: evidenceTime(entry.pending), text: entry.pending?.summary };
  return { label: stateWord(entry.state), needs: false, since: NaN };
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
  // A toggle over the inbox, not a filter on these rows, because the rows cannot reproduce the
  // strip's count: it counts every pending episode per (source, id) minus snoozed, across all
  // projects; a row is one per native id, lit only while its episode is fresh, inside this scope.
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
  /** The worktree last widened from: marked in the list until the project changes. */
  let selectedWt: string | undefined;
  /** Set when a widening on screen should hand focus to that worktree's row; consumed by the next list draw. */
  let returnFocusWt: string | undefined;
  /** What held focus when that widening began: focus elsewhere in the panel by draw time was the user's move, and stays. */
  let focusAtWiden: Element | null = null;

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
  /** The fetched history of the open session; re-scoped (not refetched) when the shared window moves. */
  let loaded: { id: string; source?: string; summary: SessionSummary | undefined; events: FirehoseEvent[] } | null = null;

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
    loaded = null;
    clear(eventsBox);
  }

  // Never narrows the store, only reconciles the history with it.
  store.subscribe((next, prev) => {
    drawScopeLine();
    if (next.project !== prev.project) selectedWt = undefined;
    returnFocusWt = undefined;
    if (prev.worktree !== undefined && next.worktree === undefined && next.project === prev.project) {
      selectedWt = prev.worktree;
      if (root.isConnected) {
        returnFocusWt = prev.worktree;
        focusAtWiden = document.activeElement;
      }
    }
    if (next.project !== prev.project || next.worktree !== prev.worktree || next.cell?.where !== prev.cell?.where || next.cell?.agent !== prev.cell?.agent) cap = SESSION_PAGE;
    if (!historyRef) return;
    const cellOpened = next.cell !== undefined && (next.cell.where !== prev.cell?.where || next.cell.agent !== prev.cell?.agent);
    const contextMoved = next.project !== prev.project || next.worktree !== prev.worktree || !sameSession(next.session, prev.session);
    const departed = contextMoved && (!next.session || !sameSession(next.session, historyRef));
    if (cellOpened || departed) dropHistory();
    else if (loaded && !sameWindow(next.window, prev.window)) drawHistory();
  });

  function sameWindow(a: Scope["window"], b: Scope["window"]): boolean {
    if (a === "live" || b === "live") return a === b;
    return a.from === b.from && a.to === b.to;
  }

  /** The rows of the worktree list this scope draws, else undefined (then it is the session list). */
  function listRows(sc: Scope): readonly WorktreeLifetimeView[] | undefined {
    if (!sc.project || sc.worktree || sc.cell) return undefined;
    const rows = store.resolver()?.lifetimes?.(sc);
    return rows?.length ? rows : undefined;
  }

  function worktreeItem(w: WorktreeRow, selected: boolean): HTMLElement {
    const node = el(
      "div",
      {
        class: selected ? "worktree-item selected" : "worktree-item",
        tabindex: "0",
        role: "button",
        "aria-label": `open worktree ${w.name}, ${w.stateText}, ${w.sessionsText}, ${w.ageText === "no activity time" ? w.ageText : `last activity ${w.ageText}`}`,
        "data-wt": w.id,
        title: w.title,
        ...(selected ? { "aria-current": "true" } : {}),
      },
      el(
        "div",
        { class: "band-row", style: `--hue:${sessionHue(w.id)}` },
        el("span", { class: "cell name" }, w.name),
        el("span", { class: "cell age" }, w.ageText),
        el("span", { class: "cell state" }, w.stateText),
      ),
      el("div", { class: "session-sub" }, el("span", { class: "session-facts" }, [w.sessionsText, w.badge].filter(Boolean).join(" · "))),
    );
    onActivate(node, () => {
      store.narrow({ project: store.get().project, worktree: w.id, cell: undefined });
      void refresh();
    });
    return node;
  }

  /** Draws the list; hands focus to the row just widened from, unless focus left the panel or the user moved it. */
  function drawWorktreeList(rows: readonly WorktreeLifetimeView[], now: number, willClear: (restore: () => void) => void) {
    willClear(captureFocus());
    clear(listBox);
    listBox.append(el("p", { class: "dim sessions-count" }, `${rows.length} worktree${rows.length === 1 ? "" : "s"}`));
    for (const r of orderWorktrees(rows)) listBox.append(worktreeItem(describeWorktree(r, now), r.worktree_id === selectedWt));
    const back = returnFocusWt;
    returnFocusWt = undefined;
    const a = document.activeElement;
    if (back === undefined || (a && a !== document.body && !(a === focusAtWiden && root.contains(a)))) return;
    const target = [...listBox.querySelectorAll<HTMLElement>(".worktree-item")].find((n) => n.getAttribute("data-wt") === back);
    if (target) willClear(() => target.focus());
  }

  /**
   * The rows of a selected worktree. /sessions holds one row per native id, aggregated over every
   * source, so where another source is known for that id the row's counts, times and last summary
   * may be that source's: it is rebuilt from this member's lifetime reference, and a member with no
   * row at all gets one the same way. Only the title is bound to the row's source in the projection,
   * so agent, repo and cwd come from the member's attention entry. Elsewhere rows stay as /sessions has them.
   */
  function rowsInScope(sc: Scope, listed: readonly SessionSummary[], attended: ReadonlyMap<string, AttentionSession>): readonly SessionSummary[] {
    if (!sc.worktree) return listed;
    const rows = store.resolver()?.lifetimes?.(sc);
    const refs = rows?.find((r) => r.worktree_id === sc.worktree)?.sessions;
    if (!rows || !refs) return listed;
    const sharedWithAnother = (id: string, source: string): boolean =>
      [...attended.values()].some((a) => a.id === id && a.source !== source) || rows.some((r) => r.sessions.some((m) => m.session_id === id && m.source !== source));
    const fromRef = (r: WorktreeSessionRef, s: SessionSummary | undefined): SessionSummary => {
      const own = attended.get(sessionKey(r.source, r.session_id));
      const title = s?.title ?? own?.title;
      return {
        id: r.session_id,
        source: r.source,
        first_time: r.first_time,
        last_time: r.last_time,
        events: r.events,
        ...(own?.agent ? { agent: own.agent } : {}),
        ...(own?.repo ? { repo: own.repo } : {}),
        ...(own?.cwd ? { cwd: own.cwd } : {}),
        ...(title ? { title } : {}),
      };
    };
    const member = new Map(refs.map((r) => [sessionKey(r.source, r.session_id), r]));
    const have = new Set<string>();
    const kept = listed.map((s) => {
      const key = sessionKey(s.source, s.id);
      have.add(key);
      const r = member.get(key);
      return r && sharedWithAnother(s.id, s.source) ? fromRef(r, s) : s;
    });
    return [...kept, ...refs.filter((r) => !have.has(sessionKey(r.source, r.session_id))).map((r) => fromRef(r, undefined))];
  }

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
      if (version !== historyVersion) return;
      loaded = { id, source, summary: s, events: evsAll.filter(ev => !source || ev.source === source) };
      drawHistory();
    } catch (err) {
      if (version !== historyVersion) return;
      historyRef = null;
      clear(eventsBox);
      eventsBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  /**
   * The one event-list policy over the fetched history: retained range, meta hidden by default.
   * No worktree filter: the session list is already scoped by the resolver, and a graph worktree id is
   * not an event id, so comparing it with raw event fields would hide a session's own rows.
   */
  function drawHistory() {
    if (!loaded) return;
    const { id, source, summary, events } = loaded;
    const sc = store.get();
    const evs = scopeEvents(events, { window: sc.window === "live" ? undefined : { from: sc.window.from, to: sc.window.to } });
    clear(eventsBox);
    shown = { id, source, count: evs.length };
    // renderEventRows owns (and clears) its container, so the heading gets its own.
    // The list may have refreshed while the history loaded: prefer its summary.
    const list = el("div", { class: "session-events-list" });
    eventsBox.append(sessionHeading(id, known.get(id) ?? summary, source, evs.length), list);
    if (evs.length < events.length || evs.length === 0) {
      const hidden = events.length - evs.length;
      eventsBox.append(
        el(
          "p",
          { class: "dim session-events-note", role: "status" },
          evs.length === 0 && hidden === 0
            ? "No captured events for this session."
            : `${hidden} event${hidden === 1 ? "" : "s"} hidden by the time window or the meta filter.`,
        ),
      );
    }
    renderEventRows(list, evs, onSelect);
  }

  /** What names the history on screen: the matching source's attention entry when the open is source-qualified. */
  function headingSubject(id: string, s: SessionSummary | undefined, source: string | undefined): SessionLike | undefined {
    if (source && s && s.source !== source) return knownBySource.get(sessionKey(source, id)) ?? { id, source };
    if (source && !s) return knownBySource.get(sessionKey(source, id));
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
        // Inside a worktree each member has its own row, so a row opens only its source's events (no source
        // cannot qualify). Elsewhere a row aggregates the native id: another agent sharing it has no row, so
        // this is the only way to its history.
        void openSession(s.id, store.get().worktree ? s.source || undefined : undefined);
      },
      { self: true },
    );
    return item;
  }

  const ITEMS = ".session-item, .worktree-item";
  const itemKey = (n: Element): string => {
    const wt = n.getAttribute("data-wt");
    return wt !== null ? `wt\0${wt}` : `${n.getAttribute("data-source") ?? ""}\0${n.getAttribute("data-id") ?? ""}`;
  };
  const CONTROLS = ["score-open", "loops-open", "session-id"];

  /**
   * Remembers what has focus in the list so a rebuild can give it back: the same
   * item or nested control, else the nearest surviving item, else the list itself.
   */
  function captureFocus(): () => void {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !listBox.contains(a)) return () => {};
    const order = [...listBox.querySelectorAll(ITEMS)].map(itemKey);
    const item = a.closest(ITEMS);
    const key = item ? itemKey(item) : undefined;
    const control = item && a !== item ? CONTROLS.find((c) => a.classList.contains(c)) : undefined;
    const onChip = !item && !!a.closest(".sessions-cell");
    const onBack = !item && !!a.closest(".sessions-back");
    return () => {
      const fresh = [...listBox.querySelectorAll<HTMLElement>(ITEMS)];
      const btn = onChip ? listBox.querySelector<HTMLElement>(".sessions-cell button") : onBack ? listBox.querySelector<HTMLElement>(".sessions-back") : null;
      if (btn) { btn.focus(); return; }
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
        // Narrowed from a worktree row: its sessions are next, and the list container would ring the whole panel.
        if (key.startsWith("wt\0")) {
          const next = fresh[0] ?? listBox.querySelector<HTMLElement>(".sessions-back");
          if (next) { next.focus(); return; }
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
      const signal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
      const [list, inbox] = await Promise.allSettled([sessions(signal), attention(signal), scoped ? bounded(store.resolver()?.refresh?.(signal), signal) : undefined]);
      // A newer refresh started while these requests were in flight: it owns the DOM and the maps.
      if (gen !== refreshGen) return;
      const attended = new Map<string, AttentionSession>();
      if (inbox.status === "fulfilled") {
        for (const a of inbox.value.sessions) attended.set(sessionKey(a.source, a.id), a);
        knownBySource = attended;
      }
      if (list.status === "fulfilled") {
        known = new Map(list.value.map((s) => [s.id, s]));
        directory?.remember([...list.value, ...(inbox.status === "fulfilled" ? inbox.value.sessions : [])]);
        // A title that arrived since the history was opened moves into its heading.
        const heading = eventsBox.querySelector(".session-heading");
        if (shown && heading) heading.replaceWith(sessionHeading(shown.id, known.get(shown.id), shown.source, shown.count));
      }
      // The scope may have moved while the requests were in flight: read it now.
      const sc = store.get();
      // The list needs only the resolver's rows, so it stands when /sessions is down.
      const worktrees = listRows(sc);
      if (worktrees) {
        drawWorktreeList(worktrees, now, willClear);
        return;
      }
      if (list.status === "rejected") throw list.reason;
      const scope = sc.cell ?? null;
      const members = sc.worktree || sc.project ? membership(store, sc) : undefined;
      const all = rowsInScope(sc, list.value, attended)
        .filter((s) => inCell(s, sc.cell) && (!members || members({ id: s.id, source: s.source })))
        .map((s) => ({ s, status: statusOf(attended.get(sessionKey(s.source, s.id)), now) }))
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
      if (sc.worktree && listRows({ ...sc, worktree: undefined })) {
        const back = el("button", { type: "button", class: "sessions-back" }, "All worktrees");
        back.addEventListener("click", () => {
          store.narrow({ worktree: undefined });
          void refresh();
        });
        listBox.append(back);
      }
      if (all.length === 0) {
        listBox.append(el("p", { class: "dim" }, scope ? "no sessions in this worktree" : members ? "no sessions in this scope" : "no sessions captured yet"));
        return;
      }
      if (members) {
        const part = store.resolver()?.partial?.(sc);
        const note = part ? `active sessions in this scope (partial: ${part.known} of ${part.total} sessions known)` : "active sessions in this scope";
        listBox.append(el("p", { class: "dim sessions-scope-note" }, note));
      } else if (sc.worktree || sc.project) {
        // Nothing to filter by: the scope line names the scope, so say these rows are not limited to it.
        listBox.append(el("p", { class: "dim sessions-scope-note" }, sc.worktree ? "This worktree's membership is unknown: showing sessions from all projects." : "No worktree rows for this project, so its membership is unknown: showing sessions from all projects."));
      }
      listBox.append(el("p", { class: "dim sessions-count" }, all.length > cap ? `Showing ${cap} of ${all.length} sessions` : `${all.length} session${all.length === 1 ? "" : "s"}`));
      const counts = bucketCountsBySession(recentEvents(), now);
      let scale = 0;
      for (const c of counts.values()) {
        for (const n of c) scale = Math.max(scale, n);
      }
      for (const { s, status } of all.slice(0, cap)) {
        listBox.append(sessionItem(s, status, counts.get(s.id) ?? [], scale, now));
      }
      if (all.length > cap) {
        const more = el("button", { type: "button", class: "sessions-more" }, `Show ${Math.min(all.length - cap, SESSION_PAGE)} more`);
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

  return { root, refresh, openSession, setScope, setNeedsOnly, needsOnly: () => needs, activate, hasWorktreeList: () => listRows(store.get()) !== undefined };
}
