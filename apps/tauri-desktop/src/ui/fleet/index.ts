// Fleet altitude: one row per repository, forks as branches off the row, the
// needs-you queue as units you click. The old fleet panels (dwell, matrix,
// lanes, airspace) are encodings of this one view. Reads scope for highlight
// and window; navigates only through deps.go, always with every scope key explicit.
import { ApiError, attention as fetchAttention, sessions as fetchSessions, worktrees as fetchWorktrees } from "../../api";
import type { AttentionSession, AttentionSnapshot, FirehoseEvent, SessionSummary, WorktreeLifetimeView } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { claimEscape, isEscapeEligible } from "../../escape";
import { DEFAULT_LIVE_SPAN_MS, isLive } from "../../scope";
import type { Scope, ScopePatch, ScopeStore } from "../../scope";
import type { CellScope } from "../workspace/model";
import { formatAge } from "../../spark";
import { deriveAirspace } from "../airspace/model";
import { buildDwell, sessionKey } from "../dwell/model";
import type { DwellRow } from "../dwell/model";
import { LANE_WINDOWS_MS, buildLanes } from "../lanes/model";
import { airspaceBands, lanesStrip, qualifyLaneInput } from "./encodings";
import { ENCODINGS, IDLE_MARK, NOREPO_KEY, buildFleet, longestWaiting, nextNeed, repoBuckets, signature, stripOf } from "./model";
import type { Encoding, FleetNeed, FleetOrder, FleetResult, FleetRow } from "./model";

export type { Encoding } from "./model";

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
  api?: FleetApi;
  now?: () => number;
  refreshMs?: number;
  /** A load that has not settled by then is aborted and its slot released. */
  loadTimeoutMs?: number;
  /** Repo id to display label, whenever the set changes. */
  onLabels?: (labels: Record<string, string>) => void;
  /** The encoding changed, so effectiveLiveSpan may have too. */
  onEncoding?: () => void;
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
}

const SEP = "\u0000"; // matches qualifyLaneInput
const CHANGE_MS = 1600;
const EVENT_REFRESH_MS = 1000;
const LANES_REDRAW_MS = 250;
const AIRSPACE_WINDOW_MS = 15 * 60_000;
const BLOCKS = "▁▂▃▄▅▆▇█";
const ENCODING_LABEL: Record<Encoding, string> = { map: "Map", dwell: "Dwell", matrix: "Matrix", lanes: "Lanes", airspace: "Airspace" };
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

interface RowRefs { head: HTMLElement; glyph: HTMLElement; label: HTMLElement; needs: HTMLElement; dwell: HTMLElement; counts: HTMLElement; spark: HTMLElement; forks: HTMLElement; queue: HTMLElement }
interface NeedRefs { label: HTMLElement; dwell: HTMLElement; summary: HTMLElement }

type StatusKind = "" | "loading" | "error" | "connecting" | "unsupported" | "empty";

export function createFleet(deps: FleetDeps): FleetPanel {
  const { store, go } = deps;
  const api: FleetApi = deps.api ?? {
    worktrees: (s) => fetchWorktrees(s),
    attention: (s) => fetchAttention(s),
    sessions: (s) => fetchSessions(s),
  };
  const nowFn = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? 15000;
  const timeoutMs = deps.loadTimeoutMs ?? 10000;

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
  let connected = true;
  let failedOffline = false;
  let active = false;
  let primed = false;
  let lastKey: string | undefined;
  let statusKind: StatusKind = "";
  let lastLabels = "{}";
  const expanded = new Set<string>(); // rows whose fork strip is open; kept across refreshes
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  // Loading.
  let loadCtl: AbortController | undefined;
  let loadToken = 0;
  let inflight = false;
  let sessCtl: AbortController | undefined;
  let sessToken = 0;
  let sessInflight = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  let lanesTimer: ReturnType<typeof setTimeout> | undefined;
  let unsub: (() => void) | undefined;
  let unsubResolver: (() => void) | undefined;

  // Keyed nodes and transition memory. prevStates survives deactivate on purpose.
  const nodes = new Map<string, Element>();
  const rowRefs = new WeakMap<Element, RowRefs>();
  const needRefs = new WeakMap<Element, NeedRefs>();
  const forkRefs = new WeakMap<Element, { glyph: HTMLElement; label: HTMLElement; needs: HTMLElement }>();
  const dwellRefs = new WeakMap<Element, Record<"label" | "where" | "status" | "bar" | "age" | "text", HTMLElement>>();
  const prevStates = new Map<string, string>();
  const expiry = new Map<Element, ReturnType<typeof setTimeout>>();
  let mapEntries: Array<{ row: FleetRow; refs: RowRefs; needs: Array<{ need: FleetNeed; refs: NeedRefs; node: Element }> }> = [];

  // Header, built once.
  const encButtons = ENCODINGS.map((enc) => {
    const b = el("button", { class: "fleet-enc", type: "button", "data-enc": enc, "aria-pressed": "false" }, ENCODING_LABEL[enc]);
    b.addEventListener("click", () => setEncoding(enc));
    return b;
  });
  const staleChip = el("span", { class: "fleet-stale", title: "Showing the last data received; a refresh is overdue" }, "stale");
  const flags = el("span", { class: "fleet-flags" });
  const statusBox = el("div", { class: "fleet-status", role: "status" });
  const toast = el("div", { class: "fleet-toast", role: "status" });
  const body = el("div", { class: "fleet-body" });
  const foot = el("div", { class: "fleet-foot" });
  const hint = el("p", { class: "fleet-hint" }, "Click a row to open the project, a fork glyph to list that worktree's sessions, a ? unit to open its session. Keys 1-9 pick a row, n and N walk the queue, Space jumps to the longest wait, Enter opens the pick.");
  const root = el(
    "section",
    { class: "fleet", "aria-label": "Fleet" },
    el("header", { class: "fleet-header" }, el("h2", {}, "Fleet"), el("div", { class: "fleet-encs", role: "group", "aria-label": "Encoding" }, ...encButtons), flags),
    statusBox,
    toast,
    body,
    foot,
    hint,
  );

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

  // ---- derivation -------------------------------------------------------

  const resolveLabel = (id: string): string | undefined => store.resolver()?.labels({ project: id, window: "live" } as Scope).project;

  function scopeKey(sc: Scope): string {
    return [sc.project ?? "", sc.worktree ?? "", sc.session?.source ?? "", sc.session?.id ?? ""].join(SEP);
  }

  const lastText = (r: FleetRow, now: number): string => (r.lastMs > 0 ? formatAge(Math.max(0, now - r.lastMs)) : "–");

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
    emitLabels();
    renderStatus();
    syncFlags();
    syncButtons();
    const key = [encoding, scopeKey(store.get()), selRow ?? "", selNeed ?? "", signature(result), encodingKey(now)].join("\u0001");
    if (force || key !== lastKey || encoding === "lanes" || encoding === "dwell") {
      lastKey = key;
      draw(now);
    } else if (encoding === "map") {
      // Entries cached at the last draw are stale; read the latest derivation by id.
      const rows = new Map(result.rows.map((r) => [r.id, r]));
      const needs = new Map(result.needs.map((n) => [n.key, n]));
      for (const e of mapEntries) {
        e.row = rows.get(e.row.id) ?? e.row;
        updateTimes(e.row, e.refs, now);
        for (const n of e.needs) {
          n.need = needs.get(n.need.key) ?? n.need;
          updateNeedTimes(n.need, n.refs, n.node);
        }
      }
    }
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

  function syncButtons(): void {
    for (const b of encButtons) setAttr(b, "aria-pressed", b.getAttribute("data-enc") === encoding ? "true" : "false");
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
    const kind = statusFor();
    if (kind === statusKind) return;
    statusKind = kind;
    clear(statusBox);
    if (kind === "loading") statusBox.append(el("div", { class: "fleet-loading" }, "Loading…"));
    else if (kind === "connecting") statusBox.append(el("div", { class: "fleet-connecting" }, "Connecting to daemon…"));
    else if (kind === "empty") statusBox.append(el("div", { class: "fleet-empty" }, "No live sessions or worktrees captured yet."));
    else if (kind === "unsupported") statusBox.append(el("div", { class: "fleet-unsupported" }, "This daemon does not serve /worktrees (older daemon). Showing attention only; update Agent Firehose to see forks."));
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
      refs = {
        head,
        glyph: el("span", { class: "fleet-glyph", "aria-hidden": "true" }),
        label: el("span", { class: "fleet-row-label" }),
        needs: el("span", { class: "fleet-needs-count" }),
        dwell: el("span", { class: "fleet-dwell" }),
        counts: el("span", { class: "fleet-counts" }),
        spark: el("span", { class: "fleet-spark", "aria-hidden": "true", title: "sessions per 12 hours, last 7 days" }),
        forks: el("div", { class: "fleet-forks" }),
        queue: el("div", { class: "fleet-queue" }),
      };
      head.append(refs.glyph, refs.label, refs.needs, refs.dwell, refs.counts);
      onActivate(head, () => { const r = result.rows.find((x) => x.id === row.id); if (r) openRow(r); });
      node.append(head, refs.forks, refs.spark, refs.queue);
      rowRefs.set(node, refs);
    }
    const navigable = row.known && !row.noRepo;
    setClass(node, "fog", !row.known && !row.noRepo);
    setClass(node, "norepo", !!row.noRepo);
    setClass(node, "failed", row.failed);
    setClass(node, "current", sc.project === row.id);
    setClass(node, "selected", selRow === row.id);
    setAttr(refs.head, "aria-disabled", navigable ? null : "true");
    setAttr(refs.head, "aria-label", `${row.label}${row.needsCount ? `, ${row.needsCount} need you` : ""}`);
    setClass(node, "unregistered", row.digest);
    const base = row.noRepo ? "Sessions waiting on you that carry no repository id" : row.known ? `${row.forks.length} worktrees` : "Seen by attention only: no worktree data captured for this repository";
    setAttr(refs.head, "title", row.digest ? `${base}\nunregistered: only a digest was recorded (balanced/minimal privacy, or the repository is not registered)` : base);
    setText(refs.glyph, row.noRepo ? "–" : row.known ? "●" : "?");
    setText(refs.label, row.label);
    setText(refs.needs, row.needsCount > 0 ? `${row.needsCount}?` : "");
    setText(refs.counts, row.known ? `${row.openForks}● ${row.idleForks}${IDLE_MARK}` : "");
    setAttr(refs.counts, "title", "open forks, idle forks (ahead of main, quiet for hours)" + (row.goneUnknown > 0 ? `\n${row.goneUnknown} gone (age unknown)` : ""));
    updateTimes(row, refs, now);
    track("row:" + row.id, `${row.needsCount}|${row.failed}|${row.known}`, node);

    const open = expanded.has(row.id);
    const strip = stripOf(row.forks, open);
    const forkNodes: Element[] = strip.shown.map((f) => {
      const k = keyed("fork:" + row.id + "|" + f.id, () => el("div", { class: "fleet-fork", tabindex: "0", role: "button" }), seen);
      let fr = forkRefs.get(k.node);
      if (k.fresh || !fr) {
        fr = { glyph: el("span", { class: "fleet-fork-glyph", "aria-hidden": "true" }), label: el("span", { class: "fleet-fork-label" }), needs: el("span", { class: "fleet-fork-needs" }) };
        k.node.append(fr.glyph, fr.label, fr.needs);
        forkRefs.set(k.node, fr);
        // A fork narrows project and worktree and descends to Sessions.
        onActivate(k.node, () => nav("sessions", { project: row.id, worktree: f.id, session: undefined, cell: undefined }));
      }
      setClass(k.node, "idle", f.idle);
      setClass(k.node, "current", sc.project === row.id && sc.worktree === f.id);
      for (const st of ["open", "landed", "gone", "never_diverged", "unknown"]) setClass(k.node, `state-${st}`, f.state === st);
      setAttr(k.node, "title", f.tooltip);
      setAttr(k.node, "aria-label", f.ariaLabel);
      setText(fr.glyph, f.glyph + (f.idle ? IDLE_MARK : ""));
      setText(fr.label, f.state === "open" ? f.short : "");
      setText(fr.needs, f.needs > 0 ? `${f.needs}?` : "");
      track("fork:" + row.id + "|" + f.id, forkSig(f), k.node);
      return k.node;
    });
    // Signatures are kept for every fork, drawn or not, so revealing or hiding forks
    // behind +N is never mistaken for a state change.
    for (const f of row.forks) {
      const sk = "fork:" + row.id + "|" + f.id;
      sigSeen.add(sk);
      if (!seen.has(sk)) prevStates.set(sk, forkSig(f));
    }
    if (strip.more > 0 || (open && stripOf(row.forks, false).more > 0)) {
      const m = keyed("more:" + row.id, () => el("button", { class: "fleet-more", type: "button" }), seen);
      if (m.fresh) {
        m.node.addEventListener("click", () => {
          if (expanded.has(row.id)) expanded.delete(row.id);
          else expanded.add(row.id);
          recompute(true);
        });
      }
      setText(m.node, open ? "collapse" : `+${strip.more}`);
      setAttr(m.node, "aria-expanded", open ? "true" : "false");
      setAttr(m.node, "aria-label", open ? "collapse forks" : `show ${strip.more} more forks`);
      forkNodes.push(m.node);
    }
    reconcile(refs.forks, forkNodes);

    const needEntries = row.needs.map((n) => {
      const k = keyed("need:" + n.key, () => el("div", { class: "fleet-need", tabindex: "0", role: "button" }), seen);
      let nr = needRefs.get(k.node);
      if (k.fresh || !nr) {
        nr = { label: el("span", { class: "fleet-need-label" }), dwell: el("span", { class: "fleet-need-dwell" }), summary: el("span", { class: "fleet-need-summary" }) };
        k.node.append(el("span", { class: "fleet-need-mark", "aria-hidden": "true" }, "?"), nr.label, nr.dwell, nr.summary);
        needRefs.set(k.node, nr);
        onActivate(k.node, () => { const cur = result.needs.find((x) => x.key === n.key); if (cur) openNeed(cur); });
      }
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
    mapEntries.push({ row, refs, needs: needEntries });
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
    table.append(el("thead", {}, el("tr", {}, ...["repository", "open", "idle", "needs you", "gone (7d)", "last activity"].map((h) => el("th", {}, h)))));
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
        if (!r.known || r.noRepo) return el("td", { class: "zero unknown", title: NO_WORKTREE_DATA }, "–");
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
        needs.setAttribute("aria-label", `${r.label}, ${r.needsCount} need you, open the longest-waiting`);
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
      el("p", { class: "dim fleet-note" }, "Captured observations from the latest attention snapshot, not process monitoring. Recent activity means a working session with an event in the last 15 minutes. No observation is not proof of absence."),
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
    const lanes = buildLanes(qualifyLaneInput(deps.events().filter((e) => live || !(Date.parse(e.time) > end))), qualified, end, windowMs);
    body.append(lanesStrip(lanes, end, windowMs, body.clientWidth || FALLBACK_W, (id, source) => openSession(id, source)));
    restore();
  }

  function draw(now: number): void {
    if (encoding !== "map") body.querySelector(":scope > .fleet-map")?.remove();
    if (encoding === "map") renderMap(now);
    else if (encoding === "dwell") renderDwell(now);
    else if (encoding === "matrix") renderMatrix(now);
    else if (encoding === "airspace") renderAirspace(now);
    else renderLanes(now);
    setText(foot, result.unattributed.length > 0 ? `${result.unattributed.length} live sessions with no repository id` : "");
  }

  // ---- encodings --------------------------------------------------------

  function setEncoding(next: Encoding): void {
    if (next === encoding || !ENCODINGS.includes(next)) return;
    const wasLanes = encoding === "lanes";
    encoding = next;
    try { deps.onEncoding?.(); } catch { /* a sink must not break the view */ }
    if (wasLanes) stopSessions();
    clear(body);
    nodes.clear();
    mapEntries = [];
    lastKey = undefined;
    selRow = undefined; // a selection is only meaningful where it is drawn
    selNeed = undefined;
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

  function onDocKey(e: KeyboardEvent): void {
    if (e.key === "Escape" || e.key === "Tab") return;
    const t = inScope(e);
    if (t === false) return;
    const onControl = !!t?.closest?.('button, a, select, [role="button"]');
    const inside = t !== document.body;
    const selectable = encoding === "map" || encoding === "dwell";
    if (e.key === "Enter") {
      if (onControl) return;
      const need = selNeed !== undefined && selectable ? result.needs.find((n) => n.key === selNeed) : undefined;
      const row = selRow !== undefined && encoding === "map" ? result.rows.find((r) => r.id === selRow) : undefined;
      if (need) { e.preventDefault(); openNeed(need); }
      else if (row && row.known && !row.noRepo) { e.preventDefault(); openRow(row); }
      return;
    }
    if (/^[1-9]$/.test(e.key)) {
      if (encoding !== "map") return;
      const row = result.rows[Number(e.key) - 1];
      if (!row) return;
      e.preventDefault();
      selRow = row.id; selNeed = undefined;
      recompute();
      if (inside) focusKey("row:" + row.id);
      return;
    }
    if (e.key === "n" || e.key === "N") {
      if (!selectable) return;
      const n = nextNeed(visibleNeeds(nowFn()), selNeed, e.key === "n" ? 1 : -1);
      if (!n) { e.preventDefault(); notify(NO_NEEDS); return; }
      e.preventDefault();
      selNeed = n.key; selRow = undefined;
      recompute();
      if (inside) focusKey(needNodeKey(n.key));
      return;
    }
    if (e.key === " ") {
      if (onControl) return;
      const n = longestWaiting(result.needs);
      if (!n) { e.preventDefault(); notify(NO_NEEDS); return; }
      e.preventDefault();
      openNeed(n);
    }
  }

  // Capture phase so the claim lands before the shared bubble-phase ascent handler.
  function onEscapeCapture(e: KeyboardEvent): void {
    if (e.key !== "Escape" || !active || !root.isConnected || !isEscapeEligible(e)) return;
    if (selRow === undefined && selNeed === undefined) return;
    selRow = undefined; selNeed = undefined;
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
    effectiveLiveSpan: (): number => (encoding === "lanes" ? (store.get().liveSpanMs ?? LANE_WINDOWS_MS[1]) : DEFAULT_LIVE_SPAN_MS),
    set encoding(e: Encoding) { setEncoding(e); },
    refresh: () => (active ? load() : Promise.resolve()),
    activate() {
      if (!active) {
        active = true;
        seenWindow = windowKey(store.get());
        unsub = store.subscribe(onScope);
        unsubResolver = store.onResolver(() => { if (active) recompute(); });
        document.addEventListener("keydown", onDocKey);
        document.addEventListener("keydown", onEscapeCapture, true);
        timer = setInterval(() => { void load(true); void loadSessions(true); }, refreshMs);
      }
      recompute(true);
      void loadSessions();
      return load();
    },
    deactivate() {
      active = false;
      unsub?.();
      unsub = undefined;
      unsubResolver?.();
      unsubResolver = undefined;
      document.removeEventListener("keydown", onDocKey);
      document.removeEventListener("keydown", onEscapeCapture, true);
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (eventTimer !== undefined) clearTimeout(eventTimer);
      eventTimer = undefined;
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
