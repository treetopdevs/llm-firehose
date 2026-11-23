import { READ_DEADLINE_MS } from "../../deadlines";
// Fleet altitude: one row per repository, forks as branches off the row, the
// needs-you queue as units you click. The old fleet panels (dwell, matrix,
// lanes, airspace) are encodings of this one view. Reads scope for highlight
// and window; navigates only through deps.go, always with every scope key explicit.
import { ApiError, attention as fetchAttention, sessions as fetchSessions, worktrees as fetchWorktrees } from "../../api";
import type { AttentionSession, AttentionSnapshot, FirehoseEvent, SessionSummary, WorktreeLifetimeView } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { onSelectOpen } from "../../select-open";
import { createMoreMenu } from "../more-menu";
import type { Inspected } from "../inspector";
import { claimEscape, isEscapeEligible } from "../../escape";
import { LOCAL, QUEUE_KEYS, registerKeys } from "../../keys";
import type { KeyBinding } from "../../keys";
import { DEFAULT_LIVE_SPAN_MS, isLive } from "../../scope";
import type { Scope, ScopePatch, ScopeStore } from "../../scope";
import type { CellScope } from "../workspace/model";
import type { ActionsUi } from "../actions";
import { actionsForRepo, actionsForSession, actionsForWorktree } from "../actions/model";
import type { UnitAction } from "../actions/model";
import type { Roots } from "../actions/roots";
import { formatAge } from "../../spark";
import { deriveAirspace } from "../airspace/model";
import { buildDwell, sessionKey } from "../dwell/model";
import type { DwellRow } from "../dwell/model";
import { LANE_WINDOWS_MS, SEP, buildLanes, decodeLaneId } from "../lanes/model";
import type { SessionDirectory } from "../../session-directory";
import { needYouCount } from "../../needs";
import { airspaceBands, lanesStrip, qualifyLaneInput } from "./encodings";
import { FORK_GLYPH, IDLE_MARK, NEEDS_MARK, NO_DATA_MARK, NO_PROJECT_MARK } from "../../glyphs";
import { ENCODINGS, KIND_WORD, NOREPO_KEY, isHostEncoding, buildFleet, childrenOf, forkAriaLabel, longestWaiting, nextNeed, repoBuckets, restOf, signature, stripOf, summarize } from "./model";
import type { Encoding, FleetFork, HostEncoding, FleetNeed, FleetOrder, FleetResult, FleetRow } from "./model";

export type { Encoding, HostEncoding } from "./model";

/** A lens panel Fleet mounts as an encoding body; Fleet owns its activate/deactivate lifetime. */
export interface FleetHost {
  root: HTMLElement;
  activate?(): unknown;
  deactivate(): unknown;
}

export interface FleetApi {
  worktrees(signal?: AbortSignal): Promise<WorktreeLifetimeView[]>;
  attention(signal?: AbortSignal): Promise<AttentionSnapshot>;
  sessions(signal?: AbortSignal): Promise<SessionSummary[]>;
}

export interface FleetDeps {
  store: ScopeStore;
  go(name: "project" | "sessions" | "score" | "live", patch?: ScopePatch): void;
  /** The live event buffer; lanes are drawn from it. */
  events: () => readonly FirehoseEvent[];
  /** Names lane sessions the summaries do not cover; optional, so lanes fall back to agent names. */
  directory?: SessionDirectory;
  api?: FleetApi;
  now?: () => number;
  refreshMs?: number;
  /** A load that has not settled by then is aborted and its slot released. */
  loadTimeoutMs?: number;
  /** Repo id to display label, whenever the set changes. */
  onLabels?: (labels: Record<string, string>) => void;
  /** The encoding changed, so effectiveLiveSpan may have too. */
  onEncoding?: () => void;
  /** Lens panels mounted as the Strata and Patches encodings. */
  hosts?: Partial<Record<HostEncoding, FleetHost>>;
  /** The app-owned actions controller; without it the view offers no actions. */
  actions?: ActionsUi;
  /** The app-owned repo-roots store (graph resolver raw labels). */
  roots?: Roots;
  /** A selection fills the inspector (null clears it). Selecting never navigates. */
  inspect?: (s: Inspected | null) => void;
}

export interface FleetPanel {
  root: HTMLElement;
  refresh(): Promise<void>;
  activate(): Promise<void>;
  deactivate(): void;
  setConnected(connected: boolean): void;
  onEvent(ev: FirehoseEvent): void;
  encoding: Encoding;
  /** The trailing span the live view draws now: the user-set span for Lanes, else the default. */
  effectiveLiveSpan(): number;
  /** Drops the selection (and the inspector it filled). */
  clearSelection(): void;
  /** The key of the selected row, need or worktree, for the history entry. */
  selectedKey(): string | undefined;
  /** Selects by key once the rows are drawn; a key that is gone falls to the nearest surviving row. */
  selectKey(key: string | undefined): void;
  /** The keys a selection can take, in drawn order (the shell restores by key, else by place in this list). */
  selectableKeys(): string[];
  /** The keys of the rows that are drawn now (a collapsed project hides its worktrees), in drawn order; a selection falls back by place in this list. */
  visibleKeys(): string[];
  /** Puts keyboard focus on the row a selection key names, when it is drawn. */
  focusKey(key: string): void;
  /** The stable fork order for a repository (Project seeds its lanes from it); undefined before the first load or for an unknown repo. */
  forkOrder(repo: string): readonly string[] | undefined;
}

const CHANGE_MS = 1600;
/** A pointer press holds the drawn rows still this long, so the second click of a double click lands on what the first did. */
const HOLD_MS = 600;
const EVENT_REFRESH_MS = 1000;
const LANES_REDRAW_MS = 250;
const AIRSPACE_WINDOW_MS = 15 * 60_000;
const BLOCKS = "▁▂▃▄▅▆▇█";
/** Visible labels. The retired encodings (dwell, matrix, airspace) have none: the List carries what they showed (MS-9). */
const ENCODING_LABEL: Partial<Record<Encoding, string>> = { map: "List", lanes: "Lanes", strata: "Strata", ecosystem: "Patches", events: "Events" };
/** The tabs of the switcher, and the views that sit behind More (MS-9). The rest stay reachable by name, not by tab. */
const TAB_ENCODINGS: readonly Encoding[] = ["map", "lanes", "events"];
const MORE_ENCODINGS: readonly Encoding[] = ["strata", "ecosystem"];
const FALLBACK_W = 800;
const TOAST_MS = 2500;
const NO_NEEDS = "no sessions need you";
/** Dwell admits what Map and the queue count: a stale pending request is drawn and labelled, not dropped. */
const DWELL_ADMIT = { includeStalePending: true } as const;
const NO_WORKTREE_DATA = "no worktree data";

const setText = (n: Element, v: string): void => { if (n.textContent !== v) n.textContent = v; };
const setAttr = (n: Element, k: string, v: string | null): void => {
  if (n.getAttribute(k) === v) return;
  if (v === null) n.removeAttribute(k);
  else n.setAttribute(k, v);
};
const setClass = (n: Element, c: string, on: boolean): void => { if (n.classList.contains(c) !== on) n.classList.toggle(c, on); };
const sparkText = (counts: number[]): string => {
  const max = Math.max(...counts, 0);
  return counts.map((c) => BLOCKS[max === 0 ? 0 : Math.min(BLOCKS.length - 1, Math.ceil((c / max) * (BLOCKS.length - 1)))]).join("");
};

/** Makes `parent`'s children exactly `wanted`, in order, touching only what differs. */
function reconcile(parent: Element, wanted: readonly Element[]): void {
  const want = new Set<Element>(wanted);
  for (const c of [...parent.children]) if (!want.has(c) && c.parentNode === parent) c.remove();
  wanted.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null);
  });
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });
function guard<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

interface RowRefs { head: HTMLElement; disclose: HTMLButtonElement | undefined; glyph: HTMLElement; label: HTMLElement; needs: HTMLElement; dwell: HTMLElement; counts: HTMLElement; spark: HTMLElement; last: HTMLElement; forks: HTMLElement; rest: HTMLElement; restText: HTMLElement; showAll: HTMLButtonElement; queue: HTMLElement }
interface ForkRefs { mark: HTMLElement; state: HTMLElement; label: HTMLElement; doing: HTMLElement; age: HTMLElement }
interface NeedRefs { label: HTMLElement; dwell: HTMLElement; summary: HTMLElement }

type StatusKind = "" | "loading" | "error" | "connecting" | "unsupported" | "empty";

let activeFleetKeys: (() => void) | undefined;

export function createFleet(deps: FleetDeps): FleetPanel {
  const { store, go } = deps;
  const api: FleetApi = deps.api ?? {
    worktrees: (s) => fetchWorktrees(s),
    attention: (s) => fetchAttention(s),
    sessions: (s) => fetchSessions(s),
  };
  const nowFn = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? 15000;
  const timeoutMs = deps.loadTimeoutMs ?? READ_DEADLINE_MS;

  // Data. wt === undefined means /worktrees has not answered (or is unsupported).
  let wt: WorktreeLifetimeView[] | undefined;
  let att: AttentionSession[] | undefined;
  let summaries: SessionSummary[] = [];
  let wtUnsupported = false;
  let wtStale = false;
  let attStale = false;
  let sessStale = false;
  let wtFailed = false;
  let attFailed = false;
  let result: FleetResult = { rows: [], order: { rows: [], forks: {} }, needs: [], unattributed: [] };
  let order: FleetOrder = { rows: [], forks: {} }; // never reset on deactivate
  let attBy = new Map<string, AttentionSession>();

  // View state.
  let encoding: Encoding = "map";
  let selRow: string | undefined;
  let selNeed: string | undefined;
  /** A selected worktree, as "repo\u0000worktree". */
  let selFork: string | undefined;
  /** What the inspector was last given, so a redraw only speaks when the selection or its data changed. */
  let inspected: string | undefined;
  let connected = true;
  let failedOffline = false;
  let active = false;
  let primed = false;
  let lastKey: string | undefined;
  let lastSelPart = "";
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let redrawHeld = false;
  let statusKind: StatusKind = "";
  let lastLabels = "{}";
  // Expansion (MS-10). The user's choice per project row wins; absent that, a row starts open only if a worktree needed
  // you when it was first drawn with its data. That start is fixed then, so a refresh never opens or closes a row under
  // the pointer. Show all is the same kind of choice.
  const openChoice = new Map<string, boolean>();
  const startedOpen = new Map<string, boolean>();
  const showAll = new Set<string>();
  const isOpen = (id: string): boolean => openChoice.get(id) ?? startedOpen.get(id) ?? false;
  const expansionKey = (): string => JSON.stringify([[...openChoice], [...startedOpen], [...showAll]]);
  let kidsSeq = 0;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  // Loading.
  let loadCtl: AbortController | undefined;
  let loadToken = 0;
  let inflight = false;
  let sessCtl: AbortController | undefined;
  let sessToken = 0;
  let sessInflight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unregisterOwnKeys: (() => void) | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let lanesTimer: ReturnType<typeof setTimeout> | undefined;
  let unsub: (() => void) | undefined;
  let unsubResolver: (() => void) | undefined;
  let unsubDirectory: (() => void) | undefined;

  // Keyed nodes and transition memory. prevStates survives deactivate on purpose.
  const nodes = new Map<string, Element>();
  const rowRefs = new WeakMap<Element, RowRefs>();
  const needRefs = new WeakMap<Element, NeedRefs>();
  const forkRefs = new WeakMap<Element, ForkRefs>();
  const dwellRefs = new WeakMap<Element, Record<"label" | "where" | "status" | "bar" | "age" | "text", HTMLElement>>();
  const prevStates = new Map<string, string>();
  const expiry = new Map<Element, ReturnType<typeof setTimeout>>();
  let mapEntries: Array<{ row: FleetRow; refs: RowRefs; needs: Array<{ need: FleetNeed; refs: NeedRefs; node: Element }>; kids: Array<{ fork: FleetFork; refs: ForkRefs }> }> = [];

  // Header, built once.
  const encButtons = TAB_ENCODINGS.filter((enc) => !isHostEncoding(enc) || deps.hosts?.[enc] !== undefined).map((enc) => {
    const b = el("button", { class: "fleet-enc", type: "button", "data-enc": enc, role: "tab", "aria-selected": "false", tabindex: "-1" }, ENCODING_LABEL[enc]);
    b.addEventListener("click", () => setEncoding(enc));
    b.addEventListener("keydown", (ev) => {
      if (!LOCAL.fleetViews.matches(ev)) return;
      const i = encButtons.indexOf(b);
      const n = encButtons.length;
      const j = ev.key === "ArrowRight" ? (i + 1) % n : ev.key === "ArrowLeft" ? (i + n - 1) % n : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : -1;
      if (j < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const target = encButtons[j]!;
      setEncoding(target.getAttribute("data-enc") as Encoding);
      target.focus();
    });
    return b;
  });
  const moreEncodings = MORE_ENCODINGS.filter((enc) => isHostEncoding(enc) && deps.hosts?.[enc] !== undefined);
  const more = moreEncodings.length > 0
    ? createMoreMenu({
        label: "More views",
        items: moreEncodings.map((id) => ({ id, label: ENCODING_LABEL[id] ?? id })),
        onPick: (id) => setEncoding(id as Encoding),
        itemAttrs: (id) => ({ "data-enc": id }),
      })
    : undefined;
  const staleChip = el("span", { class: "fleet-stale", title: "Showing the last data received; a refresh is overdue" }, "stale");
  const flags = el("span", { class: "fleet-flags" });
  const statusBox = el("div", { class: "fleet-status", role: "status" });
  const toast = el("div", { class: "fleet-toast", role: "status" });
  const body = el("div", { class: "fleet-body" });
  const foot = el("div", { class: "fleet-foot" });
  const TABLE_HINT = "Click a row to open the project, a worktree glyph to list that worktree's sessions, a ? unit to open its session. Keys 1-9 pick a row, n and N walk the queue, Space jumps to the longest wait, Enter opens the pick. Press ? for all keys and symbols.";
  const EVENTS_HINT = "The live list of every captured event, newest at the bottom. Space pauses it. Press ? for all keys and symbols.";
  const hint = el("p", { class: "fleet-hint" }, TABLE_HINT);
  const root = el(
    "section",
    { class: "fleet", "aria-label": "All projects" },
    el("header", { class: "fleet-header" }, el("h2", {}, "All projects"), el("div", { class: "fleet-views" }, el("div", { class: "fleet-encs", role: "tablist", "aria-label": "Encoding" }, ...encButtons), more?.root), flags),
    statusBox,
    toast,
    body,
    foot,
    hint,
  );

  root.addEventListener("pointerdown", () => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      if (redrawHeld) { redrawHeld = false; if (active) recompute(); }
    }, HOLD_MS);
  }, true);

  function notify(msg: string): void {
    setText(toast, msg);
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastTimer = undefined; setText(toast, ""); }, TOAST_MS);
  }

  // ---- navigation -------------------------------------------------------

  const windowPatch = (): ScopePatch["window"] => {
    const w = store.get().window;
    return isLive(w) ? "live" : { from: w.from, to: w.to };
  };
  function nav(name: "project" | "sessions" | "score", p: { project?: string; worktree?: string; session?: { id: string; source?: string }; cell?: CellScope }): void {
    go(name, { project: p.project, worktree: p.worktree, session: p.session, cell: p.cell, window: windowPatch() });
  }
  const openRow = (row: FleetRow): void => {
    if (row.noRepo || !row.known) return;
    nav("project", { project: row.id, worktree: undefined, session: undefined });
  };
  const openNeed = (n: FleetNeed): void =>
    nav("score", { project: n.repoId === NOREPO_KEY ? undefined : n.repoId, worktree: n.worktreeId, session: { id: n.id, source: n.source } });
  function openSession(id: string, source?: string): void {
    const s = (source !== undefined ? attBy.get(JSON.stringify([source, id])) : undefined) ?? [...attBy.values()].find((x) => x.id === id && (source === undefined || x.source === source));
    nav("score", { project: s?.repo_id || undefined, worktree: s?.worktree_id || undefined, session: source !== undefined ? { id, source } : { id } });
  }

  // ---- selection and the inspector (MS-8) --------------------------------

  const forkSel = (repo: string, wtId: string): string => `${repo}${SEP}${wtId}`;
  function selectRow(id: string): void { selRow = id; selNeed = undefined; selFork = undefined; recompute(); }
  function selectNeed(k: string): void { selNeed = k; selRow = undefined; selFork = undefined; recompute(); }
  function selectFork(repo: string, wtId: string): void { selFork = forkSel(repo, wtId); selRow = undefined; selNeed = undefined; recompute(); }
  function dropSelection(): void { selRow = undefined; selNeed = undefined; selFork = undefined; }
  /** Opens a project row, and Show all when the worktree is not among the first children, so a worktree can be selected by key. */
  function reveal(repo: string, wtId: string): void {
    const row = result.rows.find((r) => r.id === repo);
    if (!row || !row.forks.some((f) => f.id === wtId)) return;
    openChoice.set(repo, true);
    if (!childrenOf(row.forks).some((f) => f.id === wtId)) showAll.add(repo);
  }
  /** The worktrees a row draws under its head: none collapsed, the needs-you and working ones open, all of them after Show all. */
  function drawnForks(row: FleetRow): FleetFork[] {
    if (row.forks.length === 0 || !isOpen(row.id)) return [];
    return showAll.has(row.id) ? stripOf(row.forks, true).shown : childrenOf(row.forks);
  }
  /**
   * A refresh can stop drawing the selected worktree of an open row (it went idle, so it is no longer among the first
   * children). The selection, and focus with it, then moves to the project row; nothing is expanded to keep it.
   */
  function selectedForkHidden(): boolean {
    if (selFork === undefined) return false;
    const [repo, wtId] = selFork.split(SEP);
    const row = result.rows.find((r) => r.id === repo);
    return !!row && isOpen(row.id) && row.forks.some((f) => f.id === wtId) && !drawnForks(row).some((f) => f.id === wtId);
  }
  function hideSelectedFork(): void {
    if (!selectedForkHidden()) return;
    const [repo, wtId] = selFork!.split(SEP);
    // Focus moves only when the hidden worktree itself held it; another drawn worktree keeps its focus.
    if (nodes.get("fork:" + repo + "|" + wtId)?.contains(document.activeElement)) rowRefs.get(nodes.get("row:" + repo)!)?.head.focus();
    selRow = repo; selNeed = undefined; selFork = undefined;
  }
  function setOpen(row: FleetRow, open: boolean): void {
    openChoice.set(row.id, open);
    // A selection inside a row that closes goes to the row, as in any tree.
    if (!open && selFork !== undefined && selFork.split(SEP)[0] === row.id) { selectRow(row.id); return; }
    recompute(true);
  }

  const statusOfFork = (f: FleetFork): Inspected["status"] => {
    const mark = f.kind === "needs" ? NEEDS_MARK : f.kind === "working" ? FORK_GLYPH.open : f.kind === "idle" ? IDLE_MARK : f.kind === "unknown" ? FORK_GLYPH.unknown : FORK_GLYPH[f.state];
    return { word: KIND_WORD[f.kind], mark, ...(f.reason ? { reason: f.reason } : {}), ...(f.kind === "needs" ? { needs: true } : {}) };
  };

  function inspectedNow(now: number): Inspected | undefined {
    if (selNeed !== undefined) {
      const n = result.needs.find((x) => x.key === selNeed);
      if (!n) return undefined;
      const row = result.rows.find((r) => r.id === n.repoId);
      return {
        kind: "session", key: n.key, title: n.label,
        status: { word: n.stale ? "needs you (stale)" : "needs you", mark: NEEDS_MARK, needs: true, ...(n.stale ? { reason: "no recent activity captured; the request is still pending" } : {}) },
        facts: [
          { label: "waiting", value: formatAge(n.dwellMs) },
          { label: "asked", value: n.summary || undefined },
          { label: "project", value: row?.label },
          { label: "agent", value: n.source },
        ],
        id: { label: "session id", value: n.id },
        open: { label: "Open session", run: () => { const cur = result.needs.find((x) => x.key === n.key); if (cur) openNeed(cur); } },
        actions: actionsForSession({ source: n.source, id: n.id }),
      };
    }
    if (selFork !== undefined) {
      const [repo, wtId] = selFork.split(SEP);
      const row = result.rows.find((r) => r.id === repo);
      const f = row?.forks.find((x) => x.id === wtId);
      if (!row || !f) return undefined;
      const view = (wt ?? []).find((w) => w.repo_id === repo && w.worktree_id === wtId);
      return {
        kind: "worktree", key: selFork, title: f.short || f.label,
        status: statusOfFork(f),
        facts: [
          { label: "project", value: row.label },
          { label: "state", value: f.state },
          { label: "last activity", value: f.lastMs > 0 ? formatAge(Math.max(0, now - f.lastMs)) : undefined },
          { label: "needs you", value: f.needs > 0 ? String(f.needs) : "none" },
          { label: "path", value: f.label, mono: true },
        ],
        open: { label: "Open worktree sessions", run: () => nav("sessions", { project: repo, worktree: wtId, session: undefined, cell: undefined }) },
        actions: view ? actionsForWorktree(view) : undefined,
      };
    }
    if (selRow !== undefined) {
      const row = result.rows.find((r) => r.id === selRow);
      if (!row) return undefined;
      const sum = summarize(row);
      const unknown = !row.known && !row.noRepo;
      const navigable = row.known && !row.noRepo;
      return {
        kind: "project", key: row.id, title: row.label,
        status: row.needsCount > 0
          ? { word: needYouCount(row.needsCount), mark: NEEDS_MARK, needs: true }
          : unknown
            ? { word: "unknown", mark: FORK_GLYPH.unknown, reason: "seen in the needs-you snapshot only: no worktree data captured for this project" }
            : { word: row.noRepo ? "no project" : sum.text, mark: row.noRepo ? NO_PROJECT_MARK : FORK_GLYPH.open },
        facts: [
          { label: "worktrees", value: row.known ? sum.text : undefined },
          { label: "longest wait", value: row.needsCount > 0 ? formatAge(row.longestDwellMs) : "none" },
          { label: "last activity", value: row.lastMs > 0 ? formatAge(Math.max(0, now - row.lastMs)) : undefined },
        ],
        ...(row.noRepo ? {} : { id: { label: "project id", value: row.id } }),
        open: { label: "Open project", run: () => { const r = result.rows.find((x) => x.id === row.id); if (r && navigable) openRow(r); } },
        actions: row.noRepo ? undefined : repoActions(row.id),
      };
    }
    return undefined;
  }

  /** Tells the inspector what is selected, once per change; nothing is ever shown unasked. */
  function syncInspector(now: number): void {
    if (!deps.inspect) return;
    const wants = selRow !== undefined || selNeed !== undefined || selFork !== undefined;
    let subject = wants && encoding === "map" ? inspectedNow(now) : undefined;
    if (wants && !subject && encoding === "map" && (att !== undefined || wt !== undefined) && !inflight) { dropSelection(); subject = undefined; }
    const sig = subject ? JSON.stringify([subject.kind, subject.key, subject.title, subject.status, subject.facts, subject.id, subject.open.label, (subject.actions ?? []).map((a) => a.id)]) : undefined;
    if (sig === inspected) return;
    inspected = sig;
    try { deps.inspect(subject ?? null); } catch { /* a sink must not break the view */ }
  }

  // ---- derivation -------------------------------------------------------

  const resolveLabel = (id: string): string | undefined => store.resolver()?.labels({ project: id, window: "live" } as Scope).project;

  function scopeKey(sc: Scope): string {
    return [sc.project ?? "", sc.worktree ?? "", sc.session?.source ?? "", sc.session?.id ?? ""].join(SEP);
  }

  const lastText = (r: FleetRow, now: number): string => (r.lastMs > 0 ? formatAge(Math.max(0, now - r.lastMs)) : NO_DATA_MARK);

  function encodingKey(now: number): string {
    if (encoding === "matrix") return JSON.stringify(result.rows.map((r) => [r.id, lastText(r, now)]));
    if (encoding === "airspace") return JSON.stringify(deriveAirspace(att ?? [], { now, windowMs: AIRSPACE_WINDOW_MS }).counts);
    return "";
  }

  function recompute(force = false): void {
    const now = nowFn();
    attBy = new Map((att ?? []).map((s) => [sessionKey(s), s]));
    result = buildFleet({ worktrees: wt, sessions: att ?? [], now, order, resolveLabel });
    order = result.order;
    // Mid double click the selection is part of what waits: relocating it would redraw the rows under the pointer.
    // An explicit act (force) relocates at once; otherwise the relocation runs when the hold ends.
    if (!force && holdTimer !== undefined && encoding === "map") { if (selectedForkHidden()) redrawHeld = true; }
    else hideSelectedFork();
    emitLabels();
    renderStatus();
    syncFlags();
    syncButtons();
    const selPart = [selRow ?? "", selNeed ?? "", selFork ?? ""].join("\u0001");
    const key = [encoding, scopeKey(store.get()), selPart, signature(result), expansionKey(), encodingKey(now)].join("\u0001");
    // A press just happened: data that would shift the rows waits until the double-click window has passed. A selection,
    // a toggle or any other act of the user's own is drawn at once.
    if (!force && holdTimer !== undefined && encoding === "map" && key !== lastKey && selPart === lastSelPart) {
      redrawHeld = true;
    } else if (force || key !== lastKey || encoding === "lanes" || encoding === "dwell") {
      lastKey = key;
      lastSelPart = selPart;
      draw(now);
    } else if (encoding === "map") {
      // Entries cached at the last draw are stale; read the latest derivation by id.
      const rows = new Map(result.rows.map((r) => [r.id, r]));
      const needs = new Map(result.needs.map((n) => [n.key, n]));
      for (const e of mapEntries) {
        e.row = rows.get(e.row.id) ?? e.row;
        updateTimes(e.row, e.refs, now);
        for (const k of e.kids) {
          const f = e.row.forks.find((x) => x.id === k.fork.id);
          if (f) setText(k.refs.age, ageOfFork(f, now));
        }
        for (const n of e.needs) {
          n.need = needs.get(n.need.key) ?? n.need;
          updateNeedTimes(n.need, n.refs, n.node);
        }
      }
    }
    syncInspector(now);
  }

  function emitLabels(): void {
    if (!deps.onLabels) return;
    const labels: Record<string, string> = {};
    for (const r of result.rows) if (!r.noRepo) labels[r.id] = r.label;
    const json = JSON.stringify(labels);
    if (json === lastLabels) return;
    lastLabels = json;
    try { deps.onLabels(labels); } catch { /* a label sink must not break the view */ }
  }

  // ---- header / status --------------------------------------------------

  let lastTab: HTMLElement | undefined;
  function syncButtons(): void {
    const current = encButtons.find((b) => b.getAttribute("data-enc") === encoding);
    if (current) lastTab = current;
    // In a More view no tab is selected, but the last tab used keeps the tab stop so the tablist stays reachable.
    const stop = current ?? lastTab ?? encButtons[0];
    for (const b of encButtons) {
      setAttr(b, "aria-selected", b === current ? "true" : "false");
      setAttr(b, "tabindex", b === stop ? "0" : "-1");
    }
    more?.setCurrent(MORE_ENCODINGS.includes(encoding) ? encoding : undefined);
    hint.hidden = isHostEncoding(encoding) && encoding !== "events";
    const wantHint = encoding === "events" ? EVENTS_HINT : TABLE_HINT;
    if (hint.textContent !== wantHint) hint.textContent = wantHint;
  }

  function syncFlags(): void {
    const hasData = wt !== undefined || att !== undefined;
    const stale = hasData && (wtStale || attStale || sessStale);
    const wanted: Element[] = [];
    if (stale) wanted.push(staleChip);
    reconcile(flags, wanted);
  }

  function statusFor(): StatusKind {
    const hasData = wt !== undefined || att !== undefined;
    if (!hasData && !wtUnsupported && (wtFailed || attFailed)) return failedOffline ? "connecting" : "error";
    if (wtUnsupported) return "unsupported";
    if (!hasData) return inflight ? "loading" : "";
    if (result.rows.length === 0 && result.unattributed.length === 0) return "empty";
    return "";
  }

  function renderStatus(): void {
    const kind = isHostEncoding(encoding) ? "" : statusFor();
    if (kind === statusKind) return;
    statusKind = kind;
    clear(statusBox);
    if (kind === "loading") statusBox.append(el("div", { class: "fleet-loading" }, "Loading…"));
    else if (kind === "connecting") statusBox.append(el("div", { class: "fleet-connecting" }, "Connecting to daemon…"));
    else if (kind === "empty") statusBox.append(el("div", { class: "fleet-empty" }, "No live sessions or worktrees captured yet."));
    else if (kind === "unsupported") statusBox.append(el("div", { class: "fleet-unsupported" }, "This daemon does not serve /worktrees (older daemon). Showing sessions that need you only; update Agent Firehose to see worktrees."));
    else if (kind === "error") {
      const retry = el("button", { class: "fleet-retry", type: "button" }, "Retry");
      retry.addEventListener("click", () => void load());
      statusBox.append(el("div", { class: "fleet-error" }, el("span", {}, "Could not load the fleet."), retry));
    }
  }

  // ---- rendering --------------------------------------------------------

  const keyed = <T extends Element>(key: string, make: () => T, seen: Set<string>): { node: T; fresh: boolean } => {
    seen.add(key);
    const hit = nodes.get(key) as T | undefined;
    if (hit) return { node: hit, fresh: false };
    const node = make();
    node.setAttribute("data-key", key);
    nodes.set(key, node);
    return { node, fresh: true };
  };

  function flash(node: Element): void {
    setClass(node, "changed", true);
    const old = expiry.get(node);
    if (old !== undefined) clearTimeout(old);
    expiry.set(node, setTimeout(() => { expiry.delete(node); setClass(node, "changed", false); }, CHANGE_MS));
  }
  function track(key: string, sig: string, node: Element): void {
    const prev = prevStates.get(key);
    prevStates.set(key, sig);
    if (primed && prev !== sig) flash(node);
  }

  function updateTimes(row: FleetRow, refs: RowRefs, now: number): void {
    setText(refs.dwell, row.needsCount > 0 ? formatAge(row.longestDwellMs) : "");
    setText(refs.spark, row.known ? sparkText(repoBuckets(row, now)) : "");
    setText(refs.last, lastText(row, now));
  }
  const ageOfFork = (f: FleetFork, now: number): string => (f.lastMs > 0 ? formatAge(Math.max(0, now - f.lastMs)) : NO_DATA_MARK);
  /** What a worktree row says it is doing or waiting on, as far as captured evidence goes. */
  function doingOf(row: FleetRow, f: FleetFork): string {
    if (f.kind === "needs") { const n = row.needs.find((x) => x.worktreeId === f.id); return n ? n.summary || n.label : ""; }
    if (f.kind === "working") return f.working > 0 ? `${f.working} session${f.working === 1 ? "" : "s"} working` : "";
    return f.reason ?? "";
  }
  function updateNeedTimes(n: FleetNeed, refs: NeedRefs, node: Element): void {
    const age = formatAge(n.dwellMs);
    setText(refs.dwell, age);
    setAttr(node, "aria-label", `${n.label}, waiting ${age}`);
  }

  const forkSig = (f: { state: string; idle: boolean; needs: number }): string => `${f.state}|${f.idle}|${f.needs}`;

  function rowNode(row: FleetRow, sc: Scope, seen: Set<string>, sigSeen: Set<string>, now: number) {
    const { node, fresh } = keyed("row:" + row.id, () => el("article", { class: "fleet-row" }), seen);
    let refs = rowRefs.get(node);
    if (fresh || !refs) {
      const head = el("div", { class: "fleet-row-head", tabindex: "0", role: "button" });
      const kidsId = `fleet-kids-${++kidsSeq}`;
      const showAllBtn = el("button", { class: "fleet-showall", type: "button", "aria-expanded": "false" }, "Show all");
      const restText = el("span", { class: "fleet-rest-text" });
      const disclose = el("button", { class: "fleet-disclose", type: "button", "aria-expanded": "false", "aria-controls": kidsId }) as HTMLButtonElement;
      refs = {
        head,
        disclose,
        glyph: el("span", { class: "fleet-glyph", "aria-hidden": "true" }),
        label: el("span", { class: "fleet-row-label" }),
        needs: el("span", { class: "fleet-needs-count" }),
        dwell: el("span", { class: "fleet-dwell" }),
        counts: el("span", { class: "fleet-counts" }),
        spark: el("span", { class: "fleet-spark", "aria-hidden": "true", title: "sessions per 12 hours, last 7 days" }),
        last: el("span", { class: "fleet-last", title: "last activity" }),
        forks: el("div", { class: "fleet-forks", id: kidsId }),
        rest: el("div", { class: "fleet-rest" }, restText, showAllBtn),
        restText,
        showAll: showAllBtn,
        queue: el("div", { class: "fleet-queue" }),
      };
      head.append(refs.glyph, refs.label, refs.needs, refs.dwell, refs.counts, refs.spark, refs.last);
      if (!row.noRepo) {
        head.setAttribute("data-unit", "repo");
        head.setAttribute("data-repo", row.id);
      }
      onSelectOpen(
        head,
        {
          select: () => selectRow(row.id),
          open: () => { const r = result.rows.find((x) => x.id === row.id); if (r) openRow(r); },
        },
        { siblings: () => mapEntries.map((e) => e.refs.head) },
      );
      // Tree keys (the usual disclosure pattern): Right opens, Right again enters the worktrees, Left closes.
      const treeKey = (ev: KeyboardEvent): void => {
        if (!LOCAL.rowTree.matches(ev)) return;
        const cur = result.rows.find((x) => x.id === row.id);
        if (!cur || cur.forks.length === 0) return;
        const open = isOpen(row.id);
        if (ev.key === "ArrowRight") {
          ev.preventDefault();
          if (!open) setOpen(cur, true);
          else if (ev.target === head) refs!.forks.querySelector<HTMLElement>(".fleet-fork")?.focus();
        } else if (open) {
          ev.preventDefault();
          setOpen(cur, false);
        }
      };
      head.addEventListener("keydown", treeKey);
      disclose.addEventListener("keydown", treeKey);
      disclose.addEventListener("click", () => { const cur = result.rows.find((x) => x.id === row.id); if (cur) setOpen(cur, !isOpen(row.id)); });
      showAllBtn.addEventListener("click", () => {
        if (showAll.has(row.id)) {
          showAll.delete(row.id);
          // Hiding the selected worktree moves the selection (and focus, if it was there) to the project head.
          const cur = result.rows.find((x) => x.id === row.id);
          const hiding = cur !== undefined && selFork !== undefined && selFork.split(SEP)[0] === row.id && !childrenOf(cur.forks).some((f) => forkSel(row.id, f.id) === selFork);
          const focused = hiding && refs!.forks.contains(document.activeElement);
          if (hiding) { selRow = row.id; selNeed = undefined; selFork = undefined; }
          recompute(true);
          if (focused) refs!.head.focus();
        } else {
          showAll.add(row.id);
          recompute(true);
        }
      });
      // The disclosure sits beside the head, never inside it: a button must not live inside a role=button.
      node.append(disclose, head);
      // Same affordance as Project's header: one visible Actions button per
      // repository region, a sibling of the head (never nested in role=button).
      const ui = deps.actions;
      if (ui && !row.noRepo) {
        const btn = el("button", { class: "unit-actions", type: "button", "aria-haspopup": "menu", title: "Project actions" }, "Actions");
        btn.addEventListener("click", () => ui.openMenu(repoActions(row.id), btn, { returnFocus: btn }));
        node.append(btn);
      }
      node.append(refs.forks, refs.queue);
      rowRefs.set(node, refs);
    }
    const navigable = row.known && !row.noRepo;
    setClass(node, "fog", !row.known && !row.noRepo);
    setClass(node, "norepo", !!row.noRepo);
    setClass(node, "failed", row.failed);
    setClass(node, "current", sc.project === row.id);
    setClass(node, "selected", selRow === row.id);
    setAttr(refs.head, "aria-disabled", navigable ? null : "true");
    setAttr(refs.head, "aria-label", `${row.label}${row.needsCount ? `, ${needYouCount(row.needsCount)}` : ""}`);
    setClass(node, "unregistered", row.digest);
    const base = row.noRepo ? "Sessions waiting on you that carry no project" : row.known ? `${row.forks.length} worktrees` : "Seen in the needs-you snapshot only: no worktree data captured for this project";
    setAttr(refs.head, "title", row.digest ? `${base}\nunregistered: only a digest was recorded (balanced/minimal privacy, or the project is not registered)` : base);
    setText(refs.glyph, row.noRepo ? NO_PROJECT_MARK : row.known ? FORK_GLYPH.open : FORK_GLYPH.unknown);
    setText(refs.label, row.label);
    setText(refs.needs, row.needsCount > 0 ? `${row.needsCount}?` : "");
    setText(refs.counts, summarize(row).text);
    setAttr(refs.counts, "title", "worktrees by status; unknown means no recent evidence was captured" + (row.goneUnknown > 0 ? `\n${row.goneUnknown} gone (age unknown)` : ""));
    updateTimes(row, refs, now);
    track("row:" + row.id, `${row.needsCount}|${row.failed}|${row.known}`, node);

    // A start of "open" needs the attention snapshot: until it has answered (or failed), a needs you worktree cannot be known.
    // /attention answering first leaves a provisional row with no worktrees, so the choice also waits for /worktrees (or its absence).
    if (!startedOpen.has(row.id) && (att !== undefined || attFailed) && (wt !== undefined || wtUnsupported)) startedOpen.set(row.id, row.forks.some((f) => f.kind === "needs"));
    const hasKids = row.forks.length > 0;
    const open = hasKids && isOpen(row.id);
    const all = open && showAll.has(row.id);
    const rest = restOf(row.forks);
    const disclose = refs.disclose!;
    disclose.hidden = !hasKids;
    setAttr(disclose, "aria-expanded", open ? "true" : "false");
    setAttr(disclose, "aria-label", `${open ? "Collapse" : "Expand"} ${row.label}`);
    setAttr(disclose, "title", open ? "Collapse worktrees" : "Show the worktrees that need you or are working");
    setText(disclose, open ? "▾" : "▸");
    setClass(node, "expanded", open);
    const shown = drawnForks(row);
    const kidEntries: Array<{ fork: FleetFork; refs: ForkRefs }> = [];
    const forkNodes: Element[] = shown.map((f) => {
      const k = keyed("fork:" + row.id + "|" + f.id, () => el("div", { class: "fleet-fork", tabindex: "0", role: "button" }), seen);
      let fr = forkRefs.get(k.node);
      if (k.fresh || !fr) {
        fr = { mark: el("span", { class: "fleet-fork-mark", "aria-hidden": "true" }), state: el("span", { class: "fleet-fork-state" }), label: el("span", { class: "fleet-fork-label" }), doing: el("span", { class: "fleet-fork-doing" }), age: el("span", { class: "fleet-fork-age" }) };
        k.node.append(fr.mark, fr.state, fr.label, fr.doing, fr.age);
        forkRefs.set(k.node, fr);
        // A worktree row selects like a project row; opening it narrows project and worktree and descends to Sessions.
        onSelectOpen(
          k.node,
          { select: () => selectFork(row.id, f.id), open: () => nav("sessions", { project: row.id, worktree: f.id, session: undefined, cell: undefined }) },
          { siblings: () => [...k.node.parentElement?.querySelectorAll(".fleet-fork") ?? []] },
        );
        k.node.addEventListener("keydown", (ev) => {
          if (!LOCAL.rowTree.matches(ev as KeyboardEvent) || (ev as KeyboardEvent).key !== "ArrowLeft") return;
          ev.preventDefault();
          rowRefs.get(nodes.get("row:" + row.id)!)?.head.focus();
        });
      }
      setAttr(k.node, "data-unit", "fork");
      setAttr(k.node, "data-repo", row.id);
      setAttr(k.node, "data-wt", f.id);
      setClass(k.node, "idle", f.idle);
      setClass(k.node, "current", sc.project === row.id && sc.worktree === f.id);
      setClass(k.node, "selected", selFork === forkSel(row.id, f.id));
      for (const st of ["open", "landed", "gone", "never_diverged", "unknown"]) setClass(k.node, `state-${st}`, f.state === st);
      for (const kd of ["needs", "working", "idle", "unknown"]) setClass(k.node, `kind-${kd}`, f.kind === kd);
      setAttr(k.node, "title", f.tooltip);
      setAttr(k.node, "aria-label", forkAriaLabel(f));
      setText(fr.mark, statusOfFork(f).mark);
      setText(fr.state, KIND_WORD[f.kind]);
      setText(fr.label, f.short);
      setText(fr.doing, doingOf(row, f));
      setText(fr.age, ageOfFork(f, now));
      track("fork:" + row.id + "|" + f.id, forkSig(f), k.node);
      kidEntries.push({ fork: f, refs: fr });
      return k.node;
    });
    // Signatures are kept for every fork, drawn or not, so revealing or hiding worktrees
    // is never mistaken for a state change.
    for (const f of row.forks) {
      const sk = "fork:" + row.id + "|" + f.id;
      sigSeen.add(sk);
      if (!seen.has(sk)) prevStates.set(sk, forkSig(f));
    }
    const children: Element[] = [...forkNodes];
    if (open && rest.forks.length > 0) {
      setText(refs.restText, rest.text);
      setAttr(refs.showAll, "aria-expanded", all ? "true" : "false");
      setAttr(refs.showAll, "aria-label", all ? `Show fewer of the ${rest.forks.length} other worktrees` : `Show all ${rest.forks.length} other worktrees`);
      setText(refs.showAll, all ? "Show fewer" : "Show all");
      children.push(refs.rest);
    }
    refs.forks.hidden = !open;
    reconcile(refs.forks, children);

    const needEntries = row.needs.map((n) => {
      const k = keyed("need:" + n.key, () => el("div", { class: "fleet-need", tabindex: "0", role: "button" }), seen);
      let nr = needRefs.get(k.node);
      if (k.fresh || !nr) {
        nr = { label: el("span", { class: "fleet-need-label" }), dwell: el("span", { class: "fleet-need-dwell" }), summary: el("span", { class: "fleet-need-summary" }) };
        k.node.append(el("span", { class: "fleet-need-mark", "aria-hidden": "true" }, NEEDS_MARK), nr.label, nr.dwell, nr.summary);
        needRefs.set(k.node, nr);
        onSelectOpen(
          k.node,
          { select: () => selectNeed(n.key), open: () => { const cur = result.needs.find((x) => x.key === n.key); if (cur) openNeed(cur); } },
          { siblings: () => [...root.querySelectorAll(".fleet-need")] },
        );
      }
      setAttr(k.node, "data-unit", "need");
      setAttr(k.node, "data-repo", n.repoId);
      setAttr(k.node, "data-session", n.id);
      setAttr(k.node, "data-source", n.source);
      setClass(k.node, "failed", n.failed);
      setClass(k.node, "selected", selNeed === n.key);
      setClass(k.node, "stale", n.stale);
      setAttr(k.node, "title", n.stale ? `${n.summary}\nstale: no recent activity captured, request still pending` : n.summary);
      setText(nr.label, n.label);
      setText(nr.summary, n.summary);
      updateNeedTimes(n, nr, k.node);
      track("need:" + n.key, `need|${n.failed}`, k.node);
      return { need: n, refs: nr, node: k.node };
    });
    reconcile(refs.queue, needEntries.map((e) => e.node));
    mapEntries.push({ row, refs, needs: needEntries, kids: kidEntries });
    return node;
  }

  function renderMap(now: number): void {
    const sc = store.get();
    const seen = new Set<string>();
    const sigSeen = new Set<string>();
    mapEntries = [];
    let list = body.querySelector<HTMLElement>(":scope > .fleet-map");
    if (!list) { clear(body); list = el("div", { class: "fleet-map" }); body.append(list); }
    const rows = result.rows.map((r) => rowNode(r, sc, seen, sigSeen, now));
    reconcile(list, rows);
    for (const k of [...nodes.keys()]) {
      if (!seen.has(k) && !k.startsWith("dwell:")) nodes.delete(k);
    }
    for (const k of [...prevStates.keys()]) if (!seen.has(k) && !sigSeen.has(k)) prevStates.delete(k);
    for (const k of [...nodes.keys()]) if (k.startsWith("dwell:")) nodes.delete(k);
  }

  function renderDwell(now: number): void {
    const seen = new Set<string>();
    const { rows, more } = buildDwell(att ?? [], now, DWELL_ADMIT);
    let list = body.querySelector<HTMLElement>(":scope > .fleet-dwell-list");
    if (!list) { clear(body); nodes.clear(); list = el("div", { class: "fleet-dwell-list" }); body.append(list); }
    const wanted = rows.map((r: DwellRow) => {
      const k = keyed("dwell:" + r.key, () => el("div", { class: "fleet-dwell-row", tabindex: "0", role: "button" }), seen);
      const n = k.node;
      let parts = dwellRefs.get(n);
      if (!parts) {
        parts = {
          label: el("span", { class: "fleet-dwell-label" }), where: el("span", { class: "fleet-dwell-where" }), status: el("span", { class: "fleet-dwell-status" }),
          bar: el("div", { class: "fleet-dwell-bar" }), age: el("span", { class: "fleet-dwell-age" }), text: el("span", { class: "fleet-dwell-text" }),
        };
        n.append(parts.label, parts.where, parts.status, el("div", { class: "fleet-dwell-track" }, parts.bar), parts.age, parts.text);
        dwellRefs.set(n, parts);
        onActivate(n, () => openSession(r.id, r.source));
      }
      setClass(n, "needs", r.needs);
      setClass(n, "selected", selNeed === r.key);
      setClass(n, "stale", !!r.stale);
      setAttr(n, "title", r.stale ? `${r.source} · ${r.id}\nstale: no recent activity captured, request still pending` : `${r.source} · ${r.id}`);
      setText(parts.label, r.label);
      setText(parts.where, r.where);
      setText(parts.status, r.stale ? `${r.status} (stale)` : r.status);
      setAttr(parts.bar, "style", `width:${Math.round(r.fraction * 1000) / 10}%`);
      setText(parts.age, formatAge(r.dwellMs));
      setText(parts.text, r.hasError ? `! ${r.text}` : r.text);
      return n;
    });
    reconcile(list, wanted);
    for (const k of [...nodes.keys()]) if (!seen.has(k)) nodes.delete(k);
    let more$ = body.querySelector<HTMLElement>(":scope > .fleet-dwell-more");
    if (more > 0) {
      if (!more$) { more$ = el("p", { class: "dim fleet-dwell-more" }); body.append(more$); }
      setText(more$, `+${more} more`);
    } else more$?.remove();
    if (rows.length === 0 && !body.querySelector(".fleet-dwell-none") && att !== undefined) list.append(el("p", { class: "dim fleet-dwell-none" }, "no live sessions"));
    else if (rows.length > 0) list.querySelector(".fleet-dwell-none")?.remove();
  }

  function renderMatrix(now: number): void {
    const restore = keepFocus(body);
    clear(body);
    nodes.clear();
    const table = el("table", { class: "fleet-matrix" });
    table.append(el("thead", {}, el("tr", {}, ...["project", "open", "idle", "needs you", "gone (7d)", "last activity"].map((h) => el("th", {}, h)))));
    const tbody = el("tbody");
    for (const r of result.rows) {
      const head = el("th", { scope: "row", "data-key": "matrix:" + r.id + "|head" }, r.label);
      if (r.known && !r.noRepo) {
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");
        head.setAttribute("aria-label", `${r.label}, open project`);
        onActivate(head, () => { const cur = result.rows.find((x) => x.id === r.id); if (cur) openRow(cur); });
      }
      setClass(head, "unregistered", r.digest);
      if (r.digest) head.setAttribute("title", "unregistered: only a digest was recorded");
      const count = (n: number): HTMLElement => el("td", { class: n === 0 ? "zero" : "" }, String(n));
      // Fork counts come from /worktrees only; without a row there they are unknown, not zero.
      const forkCount = (n: number, title?: string): HTMLElement => {
        if (!r.known || r.noRepo) return el("td", { class: "zero unknown", title: NO_WORKTREE_DATA }, NO_DATA_MARK);
        const c = count(n);
        if (title) c.setAttribute("title", title);
        return c;
      };
      const goneTitle = r.goneUnknown > 0 ? `${r.goneUnknown} gone (age unknown): no last observation recorded, not counted in 7d` : undefined;
      const needs = count(r.needsCount);
      if (r.needsCount > 0) {
        setClass(needs, "needs", true);
        setClass(needs, "failed", r.failed);
        needs.setAttribute("role", "button");
        needs.setAttribute("tabindex", "0");
        needs.setAttribute("data-key", `matrix:${r.id}|needs`);
        needs.setAttribute("aria-label", `${r.label}, ${needYouCount(r.needsCount)}, open the longest-waiting`);
        onActivate(needs, () => { const cur = result.rows.find((x) => x.id === r.id)?.needs[0]; if (cur) openNeed(cur); });
      }
      tbody.append(el("tr", { "data-key": "matrix:" + r.id }, head, forkCount(r.openForks), forkCount(r.idleForks), needs, forkCount(r.goneRecent, goneTitle), el("td", { class: "dim" }, lastText(r, now))));
    }
    table.append(tbody);
    body.append(table);
    restore();
  }

  function renderAirspace(now: number): void {
    clear(body);
    nodes.clear();
    const d = deriveAirspace(att ?? [], { now, windowMs: AIRSPACE_WINDOW_MS });
    body.append(
      airspaceBands(d),
      el("p", { class: "dim fleet-note" }, "Captured observations from the latest needs-you snapshot, not process monitoring. Recent activity means a working session with an event in the last 15 minutes. No observation is not proof of absence."),
    );
  }

  function renderLanes(now: number): void {
    const restore = keepFocus(body);
    clear(body);
    nodes.clear();
    // The shared scope window bounds the lanes; live keeps the trailing five minutes.
    const w = store.get().window;
    const live = isLive(w);
    const end = live ? now : w.to;
    const windowMs = live ? (store.get().liveSpanMs ?? LANE_WINDOWS_MS[1]) : Math.max(w.to - w.from, 1);
    const qualified = summaries.map((s) => ({ ...s, id: `${s.source}${SEP}${s.id}` }));
    const lanes = buildLanes(qualifyLaneInput(deps.events().filter((e) => live || !(Date.parse(e.time) > end))), qualified, end, windowMs, deps.directory ? (ref) => deps.directory!.lookup(ref) : undefined);
    // A lane nothing has named asks the directory (rate-limited there) so it is named once it is known.
    if (deps.directory) for (const l of lanes) { const ref = decodeLaneId(l.id); try { if (!deps.directory.lookup(ref)) deps.directory.ensure(ref); } catch { /* ignore */ } }
    body.append(lanesStrip(lanes, end, windowMs, body.clientWidth || FALLBACK_W, (id, source) => openSession(id, source)));
    restore();
  }

  let mountedHost: HostEncoding | undefined;
  function deactivateHosts(): void {
    const h = mountedHost;
    if (h === undefined) return;
    mountedHost = undefined;
    const host = deps.hosts?.[h];
    try { host?.deactivate(); } catch { /* a host must not break Fleet */ }
    if (host && host.root.parentNode === body) host.root.remove();
  }

  function drawHost(h: HostEncoding): void {
    const host = deps.hosts?.[h];
    clear(body);
    nodes.clear();
    mapEntries = [];
    setText(foot, "");
    if (!host) return;
    body.append(host.root);
    mountedHost = h;
    try { void host.activate?.(); } catch { /* a host must not break Fleet */ }
  }

  function draw(now: number): void {
    if (isHostEncoding(encoding) && mountedHost === encoding) return; // already mounted: a refresh must not restart the host
    deactivateHosts();
    if (isHostEncoding(encoding)) { drawHost(encoding); return; }
    if (encoding !== "map") body.querySelector(":scope > .fleet-map")?.remove();
    if (encoding === "map") renderMap(now);
    else if (encoding === "dwell") renderDwell(now);
    else if (encoding === "matrix") renderMatrix(now);
    else if (encoding === "airspace") renderAirspace(now);
    else renderLanes(now);
    setText(foot, result.unattributed.length > 0 ? `${result.unattributed.length} live sessions with no project` : "");
  }

  // ---- encodings --------------------------------------------------------

  function setEncoding(next: Encoding): void {
    if (next === encoding || !ENCODINGS.includes(next)) return;
    const wasLanes = encoding === "lanes";
    deactivateHosts();
    encoding = next;
    try { deps.onEncoding?.(); } catch { /* a sink must not break the view */ }
    if (wasLanes) stopSessions();
    clear(body);
    nodes.clear();
    mapEntries = [];
    lastKey = undefined;
    dropSelection(); // a selection is only meaningful where it is drawn
    syncInspector(nowFn());
    if (!active) return;
    recompute(true);
    if (next === "lanes") void loadSessions();
  }

  // ---- loading ----------------------------------------------------------

  const isAbort = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";

  async function load(fromTimer = false): Promise<void> {
    if (!active) return;
    if (fromTimer && inflight) return;
    loadCtl?.abort();
    const ctl = new AbortController();
    loadCtl = ctl;
    const token = ++loadToken;
    inflight = true;
    renderStatus();
    const deadline = setTimeout(() => { if (token === loadToken) ctl.abort(); }, timeoutMs);
    const live = (): boolean => token === loadToken && active;
    const call = <T>(f: () => Promise<T>): Promise<T> => {
      try { return guard(f(), ctl.signal); } catch (e) { return Promise.reject(e); }
    };

    const wtDone = call(() => api.worktrees(ctl.signal)).then(
      (d) => {
        if (!live()) return;
        wt = d; wtUnsupported = false; wtStale = false; wtFailed = false;
        recompute();
      },
      (e) => {
        if (!live()) return;
        if (!ctl.signal.aborted && e instanceof ApiError && e.status === 404) {
          wt = undefined; wtUnsupported = true; wtStale = false; wtFailed = false;
        } else {
          wtFailed = true; wtStale = true;
          if (!connected && !isAbort(e)) failedOffline = true;
        }
        recompute();
      },
    );
    const attDone = call(() => api.attention(ctl.signal)).then(
      (d) => {
        if (!live()) return;
        att = d.sessions ?? []; attStale = false; attFailed = false;
        recompute();
      },
      (e) => {
        if (!live()) return;
        attFailed = true; attStale = true;
        if (!connected && !isAbort(e)) failedOffline = true;
        recompute();
      },
    );
    try {
      await Promise.all([wtDone, attDone]);
    } finally {
      clearTimeout(deadline);
      if (token === loadToken) inflight = false;
      if (live()) {
        if (!wtFailed && !attFailed) failedOffline = false;
        recompute();
        primed = true; // only later changes are transitions; the first full picture is state
      }
    }
  }

  function stopSessions(): void {
    sessCtl?.abort();
    sessCtl = undefined;
    sessToken++;
    sessInflight = false;
    sessStale = false;
  }

  async function loadSessions(fromTimer = false): Promise<void> {
    if (!active || encoding !== "lanes") return;
    if (fromTimer && sessInflight) return;
    sessCtl?.abort();
    const ctl = new AbortController();
    sessCtl = ctl;
    const token = ++sessToken;
    sessInflight = true;
    const deadline = setTimeout(() => { if (token === sessToken) ctl.abort(); }, timeoutMs);
    const live = (): boolean => token === sessToken && active && encoding === "lanes";
    try {
      const d = await guard(Promise.resolve().then(() => undefined).then(() => api.sessions(ctl.signal)), ctl.signal);
      if (!live()) return;
      summaries = d; sessStale = false;
      // The same summaries name sessions everywhere else (crumb, lens heads); a directory sink must not break the view.
      try { deps.directory?.remember(d); } catch { /* ignore */ }
    } catch {
      if (!live()) return;
      sessStale = true;
    } finally {
      clearTimeout(deadline);
      if (token === sessToken) sessInflight = false;
    }
    if (live()) recompute();
  }

  // ---- scope / keys / events -------------------------------------------

  const windowKey = (s: Scope): string => JSON.stringify([s.window, s.liveSpanMs ?? null]);
  let seenWindow = "";
  function onScope(next: Scope, prev: Scope): void {
    const ctx = (s: Scope) => scopeKey(s);
    if (ctx(next) !== ctx(prev)) recompute();
    else {
      const w = windowKey(next);
      if (w !== seenWindow) { syncFlags(); if (encoding === "lanes") recompute(); }
    }
    seenWindow = windowKey(next);
  }

  /** Needs the active encoding actually draws; Dwell caps its list. */
  function visibleNeeds(now: number): FleetNeed[] {
    if (encoding !== "dwell") return result.needs;
    const shown = new Set(buildDwell(att ?? [], now, DWELL_ADMIT).rows.map((r) => r.key));
    return result.needs.filter((n) => shown.has(n.key));
  }
  const needNodeKey = (k: string): string => (encoding === "dwell" ? "dwell:" : "need:") + k;

  function focusKey(key: string): void {
    const n = nodes.get(key);
    if (!n) return;
    const refs = rowRefs.get(n);
    (refs ? refs.head : (n as HTMLElement)).focus();
  }

  function inScope(e: KeyboardEvent): Element | null | false {
    if (!active || !root.isConnected) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!isEscapeEligible(e)) return false;
    const t = e.target as Element | null;
    if (t !== document.body && !(t && typeof t.closest === "function" && root.contains(t))) return false;
    return t;
  }

  // ---- actions ----------------------------------------------------------

  /** Actions are built only from the last successful GET /worktrees and the roots store. */
  function repoActions(repoId: string): UnitAction[] {
    const { roots } = deps;
    return actionsForRepo({
      repoId,
      rawLabel: roots?.rawLabel(repoId),
      registered: roots ? !roots.loaded() || roots.resolved(repoId) : true,
      forks: (wt ?? []).filter((w) => w.repo_id === repoId),
    });
  }

  function actionsOfUnit(u: HTMLElement): UnitAction[] {
    const d = u.dataset;
    if (d.unit === "fork") {
      const view = (wt ?? []).find((w) => w.repo_id === d.repo && w.worktree_id === d.wt);
      return view ? actionsForWorktree(view) : [];
    }
    if (d.unit === "need") return actionsForSession({ source: d.source, id: d.session });
    if (d.unit === "repo" && d.repo !== undefined) return repoActions(d.repo);
    return [];
  }

  function onContextMenu(e: MouseEvent): void {
    const ui = deps.actions;
    const t = e.target as Element | null;
    if (!ui || !t || typeof t.closest !== "function") return;
    const u = t.closest<HTMLElement>("[data-unit]");
    if (!u || !root.contains(u)) return;
    e.preventDefault();
    ui.openMenu(actionsOfUnit(u), { x: e.clientX, y: e.clientY }, { returnFocus: u });
  }
  root.addEventListener("contextmenu", onContextMenu);

  function onActionKey(e: KeyboardEvent, t: Element | null): boolean {
    const ui = deps.actions;
    if (!ui || e.repeat) return false;
    const own = t?.closest?.<HTMLElement>("[data-unit]") ?? null;
    let unit: HTMLElement | null = own && root.contains(own) ? own : null;
    let actions: UnitAction[] | undefined = unit ? actionsOfUnit(unit) : undefined;
    // The selection fallback is only for an unfocused document: a focused
    // control or row that is not an action unit must not borrow the selection.
    const unfocused = t === null || t === document.body || t === document.documentElement;
    if (!unit && unfocused) {
      if (selNeed !== undefined && (encoding === "map" || encoding === "dwell")) {
        const n = result.needs.find((x) => x.key === selNeed);
        const node = nodes.get(needNodeKey(selNeed)) as HTMLElement | undefined;
        if (n && node) { unit = node; actions = actionsForSession({ source: n.source, id: n.id }); }
      } else if (selRow !== undefined && encoding === "map") {
        const node = nodes.get("row:" + selRow);
        const head = node ? rowRefs.get(node)?.head : undefined;
        if (head && head.hasAttribute("data-unit")) { unit = head; actions = repoActions(selRow); }
      }
    }
    if (!unit || !actions) return false;
    e.preventDefault();
    ui.openMenu(actions, unit, { returnFocus: unit });
    return true;
  }

  /** Menu, Shift+F10 and "." open the actions menu for the focused (or selected) unit. */
  function onActions(e: KeyboardEvent): boolean {
    if (e.key === "F10" && !e.shiftKey) return false;
    const t = inScope(e);
    if (t === false) return false;
    return onActionKey(e, t);
  }


  /** Each handler returns false when the key is not Fleet's to act on, so dispatch can fall through. */
  function onEnter(e: KeyboardEvent): boolean {
    const t = inScope(e);
    if (t === false) return false;
    if (t?.closest?.('button, a, select, [role="button"]')) return false;
    const selectable = encoding === "map" || encoding === "dwell";
    const need = selNeed !== undefined && selectable ? result.needs.find((n) => n.key === selNeed) : undefined;
    const row = selRow !== undefined && encoding === "map" ? result.rows.find((r) => r.id === selRow) : undefined;
    if (need) { e.preventDefault(); openNeed(need); return true; }
    if (selFork !== undefined && encoding === "map") {
      const [repo, wtId] = selFork.split(SEP);
      e.preventDefault();
      nav("sessions", { project: repo, worktree: wtId, session: undefined, cell: undefined });
      return true;
    }
    if (row && row.known && !row.noRepo) { e.preventDefault(); openRow(row); return true; }
    return false;
  }

  function onPick(e: KeyboardEvent): boolean {
    const t = inScope(e);
    if (t === false || encoding !== "map") return false;
    const row = result.rows[Number(e.key) - 1];
    if (!row) return false;
    e.preventDefault();
    selectRow(row.id);
    if (t !== document.body) focusKey("row:" + row.id);
    return true;
  }

  function onWalk(e: KeyboardEvent): boolean {
    const t = inScope(e);
    if (t === false || !(encoding === "map" || encoding === "dwell")) return false;
    const n = nextNeed(visibleNeeds(nowFn()), selNeed, e.key === "n" ? 1 : -1);
    e.preventDefault();
    if (!n) { notify(NO_NEEDS); return true; }
    selectNeed(n.key);
    if (t !== document.body) focusKey(needNodeKey(n.key));
    return true;
  }

  function onJump(e: KeyboardEvent): boolean {
    const t = inScope(e);
    if (t === false || t?.closest?.('button, a, select, [role="button"]')) return false;
    const n = longestWaiting(result.needs);
    e.preventDefault();
    if (!n) { notify(NO_NEEDS); return true; }
    openNeed(n);
    return true;
  }

  const fleetKeys = (): KeyBinding[] => {
    const enabled = (): boolean => active && root.isConnected;
    // Each predicate mirrors its handler's encoding gate, so the legend lists only live commands.
    const notHost = (): boolean => enabled() && !isHostEncoding(encoding);
    const inMapOrDwell = (): boolean => enabled() && (encoding === "map" || encoding === "dwell");
    const inMap = (): boolean => enabled() && encoding === "map";
    return [
      { scope: "fleet", ...QUEUE_KEYS.open, label: "open the selected session or lane", handler: onEnter, enabled: inMapOrDwell },
      { scope: "fleet", ...QUEUE_KEYS.pick, label: "select a project row by number", handler: onPick, enabled: inMap },
      { scope: "fleet", ...QUEUE_KEYS.walk, label: "next / previous need", handler: onWalk, enabled: inMapOrDwell },
      { scope: "fleet", ...QUEUE_KEYS.jump, label: "open the longest-waiting need", handler: onJump, enabled: notHost },
      { scope: "fleet", ...QUEUE_KEYS.actions, label: "open the actions menu for the focused or selected item", handler: onActions, enabled: () => notHost() && !!deps.actions },
    ];
  };

  // Capture phase so the claim lands before the shared bubble-phase ascent handler.
  function onEscapeCapture(e: KeyboardEvent): void {
    if (!LOCAL.fleetClear.matches(e) || !active || !root.isConnected || !isEscapeEligible(e)) return;
    if (selRow === undefined && selNeed === undefined && selFork === undefined) return;
    dropSelection();
    recompute();
    claimEscape(e);
  }

  function onEvent(ev: FirehoseEvent): void {
    if (!active) return;
    if (encoding === "lanes" && lanesTimer === undefined) {
      lanesTimer = setTimeout(() => { lanesTimer = undefined; if (active && encoding === "lanes") recompute(); }, LANES_REDRAW_MS);
    }
    if (!ev.session_id || ev.source === "firehose" || eventTimer !== undefined) return;
    eventTimer = setTimeout(() => { eventTimer = undefined; void load(true); }, EVENT_REFRESH_MS);
  }

  return {
    root,
    get encoding() { return encoding; },
    clearSelection() {
      if (selRow === undefined && selNeed === undefined && selFork === undefined) return;
      dropSelection();
      recompute();
    },
    selectedKey: () => (selNeed !== undefined ? `need:${selNeed}` : selFork !== undefined ? `fork:${selFork}` : selRow !== undefined ? `row:${selRow}` : undefined),
    // Every row, then its worktrees (revealed on demand) and its needs, in the order they are drawn.
    selectableKeys: () => result.rows.flatMap((r) => [`row:${r.id}`, ...stripOf(r.forks, true).shown.map((f) => `fork:${forkSel(r.id, f.id)}`), ...r.needs.map((n) => `need:${n.key}`)]),
    visibleKeys: () => result.rows.flatMap((r) => [`row:${r.id}`, ...drawnForks(r).map((f) => `fork:${forkSel(r.id, f.id)}`), ...r.needs.map((n) => `need:${n.key}`)]),
    selectKey(k) {
      if (k === undefined) { this.clearSelection(); return; }
      const at = k.indexOf(":");
      const kind = k.slice(0, at);
      const id = k.slice(at + 1);
      if (kind === "need") selectNeed(id);
      else if (kind === "fork") { const [repo, wtId] = id.split(SEP); reveal(repo!, wtId!); selectFork(repo!, wtId!); }
      else selectRow(id);
    },
    focusKey(k) {
      const at = k.indexOf(":");
      const [kind, id] = [k.slice(0, at), k.slice(at + 1)];
      focusKey(kind === "fork" ? `fork:${id.split(SEP).join("|")}` : k);
    },
    forkOrder: (repo: string): readonly string[] | undefined => order.forks[repo],
    effectiveLiveSpan: (): number => (encoding === "lanes" ? (store.get().liveSpanMs ?? LANE_WINDOWS_MS[1]) : DEFAULT_LIVE_SPAN_MS),
    set encoding(e: Encoding) { setEncoding(e); },
    refresh: () => (active ? load() : Promise.resolve()),
    activate() {
      if (!active) {
        active = true;
        seenWindow = windowKey(store.get());
        unsub = store.subscribe(onScope);
        unsubResolver = store.onResolver(() => { if (active) recompute(); });
        // A session named late relabels the lanes in place; nothing is refetched.
        unsubDirectory = deps.directory?.subscribe(() => { if (active && encoding === "lanes") renderLanes(nowFn()); });
        // One Fleet owns the "fleet" scope at a time; a stale instance is displaced.
        activeFleetKeys?.();
        unregisterOwnKeys = activeFleetKeys = registerKeys(fleetKeys());
        document.addEventListener("keydown", onEscapeCapture, true);
        timer = setInterval(() => { void load(true); void loadSessions(true); }, refreshMs);
      }
      recompute(true);
      void loadSessions();
      return load();
    },
    deactivate() {
      active = false;
      more?.close();
      // The shell closes the pane on a panel change. A selection is for the visit: coming back by Back restores it by key.
      inspected = undefined;
      dropSelection();
      deactivateHosts();
      unsub?.();
      unsub = undefined;
      unsubResolver?.();
      unsubResolver = undefined;
      unsubDirectory?.();
      unsubDirectory = undefined;
      unregisterOwnKeys?.();
      unregisterOwnKeys = undefined;
      document.removeEventListener("keydown", onEscapeCapture, true);
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (eventTimer !== undefined) clearTimeout(eventTimer);
      eventTimer = undefined;
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      holdTimer = undefined;
      redrawHeld = false;
      if (toastTimer !== undefined) clearTimeout(toastTimer);
      toastTimer = undefined;
      setText(toast, "");
      if (lanesTimer !== undefined) clearTimeout(lanesTimer);
      lanesTimer = undefined;
      for (const [node, t] of expiry) { clearTimeout(t); setClass(node, "changed", false); }
      expiry.clear();
      loadCtl?.abort();
      loadToken++;
      inflight = false;
      stopSessions();
    },
    setConnected(c) {
      connected = c;
      if (c && failedOffline && active) void load();
    },
    onEvent,
  };
}
