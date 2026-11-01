// Project altitude: one repository, worktree lanes that leave and rejoin the
// default branch through the shared scope window. Sessions are beads, commits
// are ticks. Reads scope, never writes it on mount; claims Escape only for its own
// brush/lane pick, otherwise the shared handler ascends.
import { ApiError, worktree as fetchWorktree, worktrees as fetchWorktrees } from "../../api";
import type { WorktreeCommit, WorktreeDetail, WorktreeLifetimeView } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { idLabel, shortId } from "../../format";
import { displayRepoLabel } from "../fleet/model";
import type { Scope, ScopePatch, ScopeStore } from "../../scope";
import { claimEscape, isEscapeEligible } from "../../escape";
import { LOCAL, QUEUE_KEYS, registerKeys } from "../../keys";
import type { KeyBinding } from "../../keys";
import { LABEL_X, MIN_BRUSH_PX, axisTicks, labelMaxChars, brushWindow, layoutLanes, orderLanes, pickRepo, repoIds, resolveWindow, viewX } from "./model";
import type { LaneGeom, TimeRange } from "./model";
import { CLIP, COMMIT_TICK, DASH, GONE_MARK, HATCH, IDLE_BANG, LANDED_UNKNOWN, laneMarkPath, rejoinPath } from "../../glyphs";
import { createActivityMap } from "../activity";
import type { ActivityMap, MapWorkspace } from "../activity";

/** The four encodings of one repository at Project altitude; Lanes is the default. */
export type ProjectEncoding = "lanes" | "graph" | "map" | "events";
export const ENCODING_LABELS: Readonly<Record<ProjectEncoding, string>> = { lanes: "Lanes", graph: "Graph", map: "Map", events: "Events" };
const ENCODINGS: readonly ProjectEncoding[] = ["lanes", "graph", "map", "events"];

/** The workspace graph as Project hosts it: no picker, no project of its own (scope.project is the identity). */
export interface ProjectGraphHost {
  root: HTMLElement;
  show(view: "graph" | "events"): void;
  hide(): void;
  setWorktreeOrder(ids: readonly string[] | undefined): void;
  onEvent(ev: import("../../api").FirehoseEvent): void;
  onView(fn: (view: "graph" | "events") => void): void;
  currentRepo?(): string;
  registeredRepos?(): string[];
}

/** Splits a go() patch into the scope patch and the Project encoding it asks for. */
export function splitGoPatch<P extends object>(patch: (P & { encoding?: ProjectEncoding }) | undefined): { scopePatch: Omit<P, "encoding"> | undefined; encoding?: ProjectEncoding } {
  if (!patch) return { scopePatch: undefined };
  const { encoding, ...scopePatch } = patch;
  return encoding === undefined ? { scopePatch } : { scopePatch, encoding };
}

const IDLE_REASON = "idle: ahead of the default branch and quiet for hours";

export interface ProjectApi {
  worktrees(signal?: AbortSignal): Promise<WorktreeLifetimeView[]>;
  worktree(id: string, signal?: AbortSignal): Promise<WorktreeDetail>;
}

export interface ProjectDeps {
  store: ScopeStore;
  go(name: "sessions" | "score" | "live", patch?: ScopePatch): void;
  api?: ProjectApi;
  /** Fires with the rows after each successful load. A throw is ignored. */
  onRows?(rows: readonly WorktreeLifetimeView[]): void;
  /** Fires when a current (not superseded, not aborted) load fails, including a 404. A throw is ignored. */
  onLoadFailed?(): void;
  /** Display label for a repository id; undefined falls back to the id. */
  projectLabel?(id: string): string | undefined;
  now?: () => number;
  refreshMs?: number;
  /** The workspace graph, hosted under the Graph and Events chips. Without it Project has no chips. */
  graph?: ProjectGraphHost;
  /** The shared fork order for a repository (Fleet's); undefined falls back to Project's own memory. */
  worktreeOrder?(repo: string): readonly string[] | undefined;
  /** The daemon privacy mode, passed to the Activity Map. */
  privacyMode?(): string | undefined;
}

export interface ProjectPanel {
  root: HTMLElement;
  refresh(): Promise<void>;
  activate(opts?: { encoding?: ProjectEncoding }): Promise<void>;
  deactivate(): void;
  onEvent(ev: import("../../api").FirehoseEvent): void;
  encoding(): ProjectEncoding;
  setEncoding(e: ProjectEncoding): void;
  setConnected(connected: boolean): void;
}

type Status = "idle" | "loading" | "ready" | "unsupported" | "error" | "connecting";

const VIEW_W = 960;
const LABEL_W = 170;
const X0 = LABEL_W;
const X1 = VIEW_W - 90;
const BASE_Y = 36;
const ROW_H = 30;
const AXIS_H = 22;
const NS = "http://www.w3.org/2000/svg";

type SvgChild = Node | string | null | undefined;
function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: SvgChild[]): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const isAbort = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
const outcomeText = (o: string | undefined): string =>
  o === "landed" ? "landed" : o === "abandoned" ? "abandoned" : o === "never_diverged" ? "never diverged" : o === "unknown" ? "outcome unknown" : "removed";
const MAX_LABEL_CHARS = labelMaxChars(X0);
const shortLabel = (s: string): string => (s.length > MAX_LABEL_CHARS ? `…${s.slice(1 - MAX_LABEL_CHARS)}` : s);

let activeProjectKeys: (() => void) | undefined;

export function createProject(deps: ProjectDeps): ProjectPanel {
  const { store, go } = deps;
  const api: ProjectApi = deps.api ?? {
    worktrees: (s) => fetchWorktrees(s),
    worktree: (id, s) => fetchWorktree(id, s),
  };
  const nowFn = deps.now ?? Date.now;
  const refreshMs = deps.refreshMs ?? 15000;

  let rows: WorktreeLifetimeView[] = [];
  let status: Status = "idle";
  let connected = true;
  let failedOffline = false;
  const orders = new Map<string, string[]>();
  const details = new Map<string, readonly WorktreeCommit[]>();
  let cursor: string | undefined;
  let listCtl: AbortController | undefined;
  let detailCtl: AbortController | undefined;
  let loadToken = 0;
  let inflight = false;
  let active = false;
  let unregisterOwnKeys: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsub: (() => void) | undefined;
  let unsubResolver: (() => void) | undefined;
  let laneIds: string[] = [];
  let optionKey = "";
  let suppressClick = false;
  let drag: { startX: number; curX: number; range: TimeRange } | undefined;
  let brushRect: SVGElement | undefined;
  const graph = deps.graph;
  let encoding: ProjectEncoding = "lanes";
  const byRepo = new Map<string, ProjectEncoding>();
  let lastRepo: string | undefined;
  let pendingBind = false;
  let passedOrderKey = "";

  const detailKey = (repo: string, wt: string): string => `${repo}\0${wt}`;

  // Header is built once; only its state is refreshed.
  const select = el("select", { class: "project-repo", "aria-label": "Repository" });
  const statusBox = el("div", { class: "project-status", role: "status" });
  const chart = el("div", { class: "project-chart" });
  const hint = el("p", { class: "project-hint" }, "Click a lane to open its sessions, a bead to open its score. Arrow keys or 1-9 pick a lane, Enter opens it. Drag on the time axis to narrow the window; the time bar above sets the span. Press ? for all keys and symbols.");
  const chips = el("div", { class: "project-chips", role: "tablist", "aria-label": "Encoding" });
  const chipBtns = new Map<ProjectEncoding, HTMLButtonElement>();
  const lanesBody = el("div", { class: "project-lanes-body" }, chart, hint);
  const encodingBody = el("div", { class: "project-encoding-body" });
  encodingBody.hidden = true;
  const header = el("header", { class: "project-header" }, el("h2", {}, "Project"), select);
  if (graph) header.append(chips);
  const root = el("section", { class: "project", "aria-label": "Project" }, header, statusBox, lanesBody, encodingBody);
  const noteBox = el("p", { class: "project-map-note" });
  const map: ActivityMap | undefined = graph
    ? createActivityMap({
        onWindow: (w) => store.narrow({ window: w }),
        onPickWorktree: (id) => {
          const sc = store.get();
          store.narrow({ project: repoNow() ?? sc.project, worktree: id, cell: undefined, window: sc.window });
        },
        now: nowFn,
      })
    : undefined;
  map?.setActive(false);

  // Membership is exactly what /worktrees returned: the per-lane session list is
  // capped, so a lane with sessions_total > sessions.length is partial. Nothing is
  // inferred beyond that. Unknown project/worktree answers undefined (unrestricted).
  const memberKey = (source: string, id: string): string => `${source}\0${id}`;
  const scopedRows = (sc: Scope): WorktreeLifetimeView[] | undefined => {
    if (sc.project === undefined) return undefined;
    const inRepo = rows.filter((r) => r.repo_id === sc.project);
    if (inRepo.length === 0) return undefined;
    if (sc.worktree === undefined) return inRepo;
    const hit = inRepo.filter((r) => r.worktree_id === sc.worktree);
    return hit.length ? hit : undefined;
  };
  // A lane whose session list is capped (sessions_total > sessions.length) only
  // samples its membership: unknown sessions are admitted, never excluded.
  const partialOf = (sel: readonly WorktreeLifetimeView[]): { known: number; total: number } | undefined => {
    const known = sel.reduce((n, r) => n + r.sessions.length, 0);
    const total = sel.reduce((n, r) => n + Math.max(r.sessions_total, r.sessions.length), 0);
    return total > known ? { known, total } : undefined;
  };
  store.setFallbackResolver({
    sessions(sc) {
      const sel = scopedRows(sc);
      if (!sel || partialOf(sel)) return undefined;
      return new Set(sel.flatMap((r) => r.sessions.map((s) => s.session_id)));
    },
    matcher(sc) {
      const sel = scopedRows(sc);
      if (!sel) return undefined;
      const keys = new Set(sel.flatMap((r) => r.sessions.map((s) => memberKey(s.source, s.session_id))));
      if (!partialOf(sel)) return (ref) => ref.source !== undefined && keys.has(memberKey(ref.source, ref.id));
      // Partial: only sessions known to sit in another lane are excluded.
      const elsewhere = new Set(rows.filter((r) => !sel.includes(r)).flatMap((r) => r.sessions.map((s) => memberKey(s.source, s.session_id))));
      return (ref) => {
        if (ref.source === undefined) return true;
        const k = memberKey(ref.source, ref.id);
        return keys.has(k) || !elsewhere.has(k);
      };
    },
    knows: (sc) => scopedRows(sc) !== undefined,
    partial(sc) {
      const sel = scopedRows(sc);
      return sel ? partialOf(sel) : undefined;
    },
    refresh: () => (active ? load() : refreshRows()),
    labels(sc) {
      const sel = scopedRows(sc);
      const label = sc.worktree !== undefined ? sel?.[0]?.label : undefined;
      const out: { project?: string; worktree?: string } = label ? { worktree: label } : {};
      // A project the rows do not know (registered only): a short id, marked, never a guess at a name.
      if (graph && sc.project !== undefined && status === "ready" && !rows.some((r) => r.repo_id === sc.project)) out.project = `${shortId(sc.project)} (unknown)`;
      return out;
    },
  });

  select.addEventListener("change", () => {
    if (select.value) store.narrow({ project: select.value, cell: undefined });
  });

  // With the graph hosted, scope.project is the sole repository identity: an explicit
  // project is never replaced by a guess, even when no lifetime row carries it.
  function repoNow(): string | undefined {
    const p = store.get().project;
    return graph ? (p ?? pickRepo(rows)) : pickRepo(rows, p);
  }
  const pickedRepo = repoNow;

  function selection(): string | undefined {
    const repo = pickedRepo();
    if (repo === undefined) return undefined;
    const isLane = (id: string | undefined): id is string =>
      id !== undefined && rows.some((r) => r.repo_id === repo && r.worktree_id === id);
    if (isLane(cursor)) return cursor;
    const wt = store.get().worktree;
    return isLane(wt) ? wt : undefined;
  }

  function pickerIds(): string[] {
    const ids = repoIds(rows);
    if (!graph) return ids;
    const extra = [...(graph.registeredRepos?.() ?? []), ...(store.get().project !== undefined ? [store.get().project!] : [])];
    for (const id of extra) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  function syncSelect(ids: string[], repo: string | undefined): void {
    // A name beats a fallback: the store resolver first, then the host's label unless it is
    // only the fallback form (which a later resolved name must be able to outrank).
    const nameOf = (id: string): string => {
      const fallback = displayRepoLabel(idLabel(id));
      let resolved: string | undefined;
      try { resolved = store.resolver()?.labels({ project: id, window: "live" } as Scope).project || undefined; } catch { resolved = undefined; }
      // The panel's own "<shortid> (unknown)" placeholder is not a name: fall through to the host's label.
      if (resolved !== undefined && !resolved.endsWith(" (unknown)")) return displayRepoLabel(resolved);
      let hosted: string | undefined;
      try { hosted = deps.projectLabel?.(id) || undefined; } catch { hosted = undefined; }
      return hosted !== undefined && displayRepoLabel(hosted) !== fallback ? displayRepoLabel(hosted) : fallback;
    };
    const key = ids.map((id) => `${id}\u0001${nameOf(id)}`).join("\0");
    if (key !== optionKey) {
      optionKey = key;
      clear(select);
      for (const id of ids) select.append(el("option", { value: id }, nameOf(id)));
    }
    select.disabled = ids.length === 0;
    if (repo !== undefined) select.value = repo;
  }

  function renderStatus(laneCount: number, repoRows: number, pending = 0): void {
    clear(statusBox);
    if (encoding !== "lanes" && status === "ready") return;
    if (status === "unsupported") {
      statusBox.append(
        el(
          "div",
          { class: "project-unsupported" },
          el("span", {}, "This daemon does not serve /worktrees (older daemon). Update Agent Firehose to see worktree lanes."),
          el("button", { type: "button" }, "Open live"),
        ),
      );
      statusBox.querySelector("button")!.addEventListener("click", () => go("live"));
      return;
    }
    if (status === "error") {
      const retry = el("button", { class: "project-retry", type: "button" }, "Retry");
      retry.addEventListener("click", () => void load());
      statusBox.append(el("div", { class: "project-error" }, el("span", {}, "Could not load worktrees."), retry));
      return;
    }
    if (status === "connecting") {
      statusBox.append(el("div", { class: "project-connecting" }, "Connecting to daemon…"));
      return;
    }
    if (status !== "ready") return;
    if (rows.length === 0) statusBox.append(el("div", { class: "project-empty" }, "No worktrees captured yet."));
    else if (laneCount === 0 && repoRows > 0) statusBox.append(el("div", { class: "project-empty" }, "No worktree activity in this window."));
    if (pending > 0) statusBox.append(el("div", { class: "project-pending" }, `States pending: ${pending} of ${repoRows} lanes not classified yet (graph_unavailable)`));
  }

  function laneNode(l: LaneGeom, y: number, selected: boolean, repoId: string): SVGElement {
    const cls = ["project-lane", `state-${l.state}`];
    if (l.end === "flat") cls.push("flat");
    if (l.end === "hatched") cls.push("hatched");
    if (selected) cls.push("selected");
    if (l.idle) cls.push("idle");
    const g = svg("g", { class: cls.join(" "), "data-key": l.id, tabindex: 0, role: "group", "aria-label": l.ariaLabel }, svg("title", {}, l.tooltip));
    g.append(svg("rect", { class: "project-hit", x: 0, y: y - ROW_H / 2, width: VIEW_W, height: ROW_H, fill: "transparent" }));
    g.append(svg("text", { class: "project-label", x: LABEL_X, y: y + 4, "font-size": 11, fill: "currentColor" }, shortLabel(l.label)));
    const stroke = { stroke: "currentColor", fill: "none" };
    if (l.end === "hatched") {
      g.append(svg("rect", { class: "project-run", x: l.forkX, y: y - 4, width: Math.max(4, l.endX - l.forkX), height: 8, fill: "url(#project-hatch)", stroke: "currentColor" }));
    } else {
      g.append(svg("line", { class: "project-run", x1: l.forkX, x2: Math.max(l.endX, l.forkX + 2), y1: y, y2: y, ...stroke, "stroke-width": 2, ...(l.end === "flat" ? { "stroke-dasharray": DASH.flat } : {}) }));
    }
    if (!l.clippedLeft && (l.end === "rejoin" || l.end === "open" || l.end === "gone")) {
      g.append(svg("path", { class: "project-fork", d: `M ${l.forkX} ${BASE_Y} C ${l.forkX} ${y}, ${l.forkX} ${y}, ${l.forkX + 10} ${y}`, ...stroke }));
    }
    if (l.end === "rejoin") {
      // Activity ends at endX. The rejoin sits at a pr_merge mark's time when one exists;
      // otherwise the landing time is unknown and the curve is dashed with the landed-unknown mark.
      if (l.rejoinKnown && l.rejoinX > l.endX) {
        g.append(svg("line", { class: "project-landgap", x1: l.endX, x2: l.rejoinX, y1: y, y2: y, ...stroke, "stroke-dasharray": DASH.landgap }));
      }
      const rx = l.rejoinX;
      g.append(svg("path", { class: l.rejoinKnown ? "project-rejoin" : "project-rejoin unknown-time", d: rejoinPath(rx - 10, y, rx, BASE_Y), ...stroke, ...(l.rejoinKnown ? {} : { "stroke-dasharray": DASH.unknownRejoin }) }));
      if (!l.rejoinKnown) g.append(svg("text", { class: "project-landed-unknown", x: rx + 4, y: y - 6, "font-size": 10, fill: "currentColor" }, LANDED_UNKNOWN));
    }
    if (l.end === "open" && l.tailX !== undefined) {
      g.append(svg("line", { class: "project-tail", x1: l.endX, x2: l.tailX, y1: y, y2: y, ...stroke, "stroke-dasharray": DASH.tail }));
    }
    if (l.end === "gone") {
      g.append(svg("text", { class: "project-gone", x: l.endX, y: y + 4, "text-anchor": "middle", fill: "currentColor" }, GONE_MARK));
      g.append(svg("text", { class: "project-outcome", x: l.endX + 10, y: y + 4, "font-size": 10, fill: "currentColor" }, outcomeText(l.outcome)));
    }
    for (const b of l.beads) {
      const bead = svg("rect", {
        class: "project-bead", x: b.x, y: y - 5, width: b.w, height: 10, rx: 2, "data-session": b.session, "data-source": b.source, "data-key": `${l.id}\0${b.source}\0${b.session}`,
        tabindex: 0, role: "button", "aria-label": `open score for session ${shortId(b.session)}, ${l.label} ${l.state}`, fill: "currentColor",
      });
      // stop: a bead is not its lane; its click and keys never reach the lane's handler.
      onActivate(
        bead,
        () => {
          if (consumeSuppress()) return;
          go("score", { project: repoId, worktree: l.id, session: { id: b.session, source: b.source }, cell: undefined });
        },
        { stop: true },
      );
      g.append(bead);
    }
    for (const t of l.ticks) {
      g.append(svg("line", { class: "project-tick", "data-kind": t.kind, "data-id": t.id, x1: t.x, x2: t.x, y1: y - COMMIT_TICK.half, y2: y + COMMIT_TICK.half, stroke: "currentColor" }));
    }
    for (const gl of l.glyphs) {
      g.append(svg("path", { class: "project-glyph", "data-kind": gl.kind, "data-id": gl.id, d: laneMarkPath(gl.kind, gl.x, y), fill: "currentColor" }));
    }
    if (l.clippedLeft) g.append(svg("text", { class: "project-clip", x: X0 - 4, y: y - 8, "font-size": 9, fill: "currentColor" }, CLIP.left));
    if (l.clippedRight) g.append(svg("text", { class: "project-clip", x: X1 + 2, y: y - 8, "font-size": 9, fill: "currentColor" }, CLIP.right));
    if (l.badge) g.append(svg("text", { class: "project-badge", x: X1 + 8, y: y + 4, "font-size": 10, fill: "currentColor" }, l.badge));
    if (l.idle) {
      g.append(
        svg("text", { class: "project-idle", role: "img", "aria-label": "idle", x: VIEW_W - 12, y: y + 4, fill: "currentColor" }, svg("title", {}, IDLE_REASON), IDLE_BANG),
      );
    }
    onActivate(g, () => {
      if (consumeSuppress()) return;
      go("sessions", { project: repoId, worktree: l.id, cell: undefined });
    }, { self: true });
    return g;
  }

  function laneOrder(repo: string, repoRows: readonly WorktreeLifetimeView[]): string[] {
    const order = orderLanes(deps.worktreeOrder?.(repo) ?? orders.get(repo), repoRows);
    orders.set(repo, order);
    return order;
  }

  function passOrder(repo: string, repoRows: readonly WorktreeLifetimeView[]): void {
    if (!graph) return;
    const order = laneOrder(repo, repoRows);
    const key = `${repo}\0${order.join("\0")}`;
    if (key === passedOrderKey) return;
    passedOrderKey = key;
    graph.setWorktreeOrder(order);
  }

  const baseName = (s: string): string => s.split(/[/\\]/).filter(Boolean).pop() ?? s;
  function updateMap(repo: string | undefined, repoRows: readonly WorktreeLifetimeView[]): void {
    if (!map) return;
    if (repo === undefined || (status === "ready" && repoRows.length === 0)) {
      map.cancel();
      noteBox.textContent = repo === undefined ? "Select a project" : "No lifetimes for this project";
      if (noteBox.parentNode !== encodingBody) encodingBody.replaceChildren(noteBox);
      return;
    }
    if (map.root.parentNode !== encodingBody) encodingBody.replaceChildren(map.root);
    const sc = store.get();
    const workspaces: MapWorkspace[] = repoRows.map((r) => ({ id: r.worktree_id, name: r.label ? baseName(r.label) : idLabel(r.worktree_id) }));
    map.update(repo, workspaces, deps.privacyMode?.(), { window: sc.window, ...(sc.liveSpanMs !== undefined ? { liveSpanMs: sc.liveSpanMs } : {}), ...(sc.worktree !== undefined ? { worktree: sc.worktree } : {}) });
  }

  // Keeps per-repository encoding memory. Returns true when it switched encoding (the switch rendered).
  function syncRepo(repo: string | undefined): boolean {
    if (repo === lastRepo) return false;
    const first = lastRepo === undefined;
    lastRepo = repo;
    if (repo === undefined) return false;
    if (first && pendingBind) {
      pendingBind = false;
      byRepo.set(repo, encoding);
      if (encoding !== "lanes" && store.get().project === undefined) {
        store.narrow({ project: repo, window: store.get().window });
      }
      return false;
    }
    const mem = byRepo.get(repo) ?? "lanes";
    if (mem === encoding) return false;
    encoding = mem;
    mountEncoding();
    return true;
  }

  // Adopts the remembered encoding of the current repository without mounting anything,
  // so a reactivation never mounts the previous repository's encoding first.
  function restoreRepoMemory(): void {
    const repo = repoNow();
    if (repo === undefined || repo === lastRepo) return;
    if (lastRepo === undefined && pendingBind) return; // syncRepo binds the pending encoding to this repository
    lastRepo = repo;
    encoding = byRepo.get(repo) ?? "lanes";
    syncChips();
  }

  function syncChips(): void {
    for (const [e, b] of chipBtns) {
      b.setAttribute("aria-selected", String(e === encoding));
      b.tabIndex = e === encoding ? 0 : -1;
    }
  }

  // Makes the DOM and the hosted views match `encoding`; idempotent.
  function mountEncoding(): void {
    if (!graph || !map) return;
    syncChips();
    if (!active) return;
    lanesBody.hidden = encoding !== "lanes";
    encodingBody.hidden = encoding === "lanes";
    if (encoding !== "lanes") endDrag(); // leaving Lanes mid-brush: drop the document listeners
    if (encoding === "lanes") {
      graph.hide();
      map.cancel();
      map.setActive(false);
      encodingBody.replaceChildren();
      render();
      loadDetail();
      return;
    }
    const repo = repoNow();
    const repoRows = repo === undefined ? [] : rows.filter((r) => r.repo_id === repo);
    if (encoding === "map") {
      graph.hide();
      map.setActive(true);
      renderStatus(0, repoRows.length);
      updateMap(repo, repoRows);
      return;
    }
    map.cancel();
    map.setActive(false);
    if (graph.root.parentNode !== encodingBody) encodingBody.replaceChildren(graph.root);
    if (repo !== undefined) {
      passedOrderKey = "";
      passOrder(repo, repoRows);
    }
    renderStatus(0, repoRows.length);
    graph.show(encoding);
  }

  function setEncodingTo(next: ProjectEncoding): void {
    if (!graph) return;
    if (next === encoding) {
      if (active) mountEncoding();
      return;
    }
    const prev = encoding;
    if (active) {
      const sc = store.get();
      const patch: ScopePatch = { window: sc.window };
      let extra = false;
      if (prev === "lanes" && cursor !== undefined) {
        patch.project = repoNow();
        patch.worktree = cursor;
        patch.cell = undefined;
        extra = true;
      }
      if (sc.project === undefined && patch.project === undefined) {
        const d = pickRepo(rows);
        if (d !== undefined) { patch.project = d; extra = true; }
      }
      cursor = undefined;
      if (extra) store.narrow(patch);
    }
    encoding = next;
    const repo = repoNow();
    if (repo === undefined) pendingBind = true;
    else byRepo.set(repo, next);
    mountEncoding();
  }

  for (const e of ENCODINGS) {
    const b = el("button", { type: "button", role: "tab", class: "project-chip", "data-encoding": e, "aria-selected": String(e === encoding), tabindex: e === encoding ? "0" : "-1" }, ENCODING_LABELS[e]);
    b.addEventListener("click", () => setEncodingTo(e));
    b.addEventListener("keydown", (ev) => {
      const i = ENCODINGS.indexOf(e);
      if (!LOCAL.projectViews.matches(ev)) return;
      const j = ev.key === "ArrowRight" ? (i + 1) % ENCODINGS.length : ev.key === "ArrowLeft" ? (i + ENCODINGS.length - 1) % ENCODINGS.length : ev.key === "Home" ? 0 : ENCODINGS.length - 1;
      ev.preventDefault();
      setEncodingTo(ENCODINGS[j]!);
      chipBtns.get(ENCODINGS[j]!)?.focus();
    });
    chipBtns.set(e, b);
    chips.append(b);
  }
  graph?.onView((v) => {
    if (!active || (encoding !== "graph" && encoding !== "events") || v === encoding) return;
    encoding = v;
    const repo = repoNow();
    if (repo !== undefined) byRepo.set(repo, v);
    syncChips();
    renderStatus(0, 0);
  });

  function render(): void {
    const sc: Scope = store.get();
    const now = nowFn();
    const range = resolveWindow(sc.window, now, sc.liveSpanMs);
    const repo = repoNow();
    syncSelect(pickerIds(), repo);
    if (graph && syncRepo(repo)) return;

    const repoRows = repo === undefined ? [] : rows.filter((r) => r.repo_id === repo);
    let lanes: LaneGeom[] = [];
    let baseLabel = "default branch";
    if (encoding !== "lanes") {
      renderStatus(0, repoRows.length);
      if (encoding === "map") updateMap(repo, repoRows);
      else if (repo !== undefined) passOrder(repo, repoRows);
      return;
    }
    if (repo !== undefined) {
      const order = laneOrder(repo, repoRows);
      const sel = selection();
      const cs = sel !== undefined ? details.get(detailKey(repo, sel)) : undefined;
      lanes = layoutLanes(repoRows, order, range, X0, X1, now, sel !== undefined && cs ? { [sel]: cs } : undefined);
      baseLabel = repoRows.find((r) => r.default_target_ref)?.default_target_ref ?? baseLabel;
    }
    laneIds = lanes.map((l) => l.id);
    renderStatus(lanes.length, repoRows.length, repoRows.filter((r) => r.state === "unknown" && r.state_reason === "graph_unavailable").length);

    const restore = keepFocus(chart);
    clear(chart);
    if (repo === undefined) return restore();
    const height = BASE_Y + (lanes.length + 1) * ROW_H + 8;
    const sel = selection();
    const s = svg("svg", { class: "project-svg", viewBox: `0 0 ${VIEW_W} ${height}`, role: "group", "aria-label": `Worktree lanes for ${idLabel(repo)}`, width: "100%" });
    s.append(svg("defs", {}, svg("pattern", { id: "project-hatch", width: HATCH.size, height: HATCH.size, patternUnits: "userSpaceOnUse" }, svg("path", { d: HATCH.d, stroke: "currentColor", "stroke-width": 1 }))));
    for (const t of axisTicks(range, X0, X1, 6)) {
      s.append(svg("g", { class: "project-axis-tick" }, svg("line", { x1: t.x, x2: t.x, y1: AXIS_H - 4, y2: height - 4, stroke: "currentColor", "stroke-opacity": 0.12 }), svg("text", { x: t.x, y: AXIS_H - 8, "text-anchor": "middle", "font-size": 10, fill: "currentColor" }, t.label)));
    }
    s.append(svg("g", { class: "project-baseline" }, svg("line", { x1: X0, x2: X1, y1: BASE_Y, y2: BASE_Y, stroke: "currentColor", "stroke-width": 2 }), svg("text", { x: 8, y: BASE_Y + 4, "font-size": 11, fill: "currentColor" }, baseLabel)));
    lanes.forEach((l, i) => s.append(laneNode(l, BASE_Y + (i + 1) * ROW_H, l.id === sel, repo)));
    s.addEventListener("mousedown", onBrushDown);
    chart.append(s);
    brushRect = undefined;
    updateBrush();
    restore();
  }

  // Scope membership must stay fresh while Project is not visible (the resolver
  // is read by Sessions, Score and Loops). Updates rows only: no render, no detail.
  async function refreshRows(): Promise<void> {
    // Shares loadToken with load(): only the newest rows request may apply.
    const token = ++loadToken;
    try {
      const data = await api.worktrees();
      if (token === loadToken && !active) rows = data;
    } catch {
      // keep the last known membership
    }
  }

  async function load(fromTimer = false): Promise<void> {
    if (fromTimer && inflight) return;
    listCtl?.abort();
    const ctl = new AbortController();
    listCtl = ctl;
    const token = ++loadToken;
    inflight = true;
    if (rows.length === 0 && status !== "error" && status !== "unsupported" && status !== "connecting") status = "loading";
    try {
      const data = await api.worktrees(ctl.signal);
      if (token !== loadToken || ctl.signal.aborted || !active) return;
      rows = data;
      status = "ready";
      failedOffline = false;
      render();
      loadDetail();
      try { deps.onRows?.(rows); } catch { /* a consumer must not break the panel */ }
    } catch (e) {
      if (token !== loadToken || ctl.signal.aborted || !active || isAbort(e)) return;
      try { deps.onLoadFailed?.(); } catch { /* a consumer must not break the panel */ }
      if (e instanceof ApiError && e.status === 404) {
        rows = [];
        status = "unsupported";
        failedOffline = false;
      } else if (!connected) {
        status = "connecting";
        failedOffline = true;
      } else {
        status = "error";
      }
      render();
    } finally {
      if (token === loadToken) inflight = false;
    }
  }

  function loadDetail(): void {
    detailCtl?.abort();
    detailCtl = undefined;
    if (!active || encoding !== "lanes") return;
    const repo = pickedRepo();
    const wt = selection();
    if (repo === undefined || wt === undefined) return;
    const ctl = new AbortController();
    detailCtl = ctl;
    api.worktree(wt, ctl.signal).then(
      (d) => {
        if (ctl.signal.aborted || !active) return;
        if (pickedRepo() !== repo || selection() !== wt) return;
        if (!rows.some((r) => r.repo_id === repo && r.worktree_id === wt)) return;
        details.set(detailKey(repo, wt), d.commits ?? []);
        render();
      },
      () => {},
    );
  }

  function onScope(next: Scope, prev: Scope): void {
    if (next.worktree !== prev.worktree || next.project !== prev.project) {
      cursor = undefined;
      render();
      loadDetail();
    } else {
      render();
    }
  }

  function consumeSuppress(): boolean {
    if (!suppressClick) return false;
    suppressClick = false;
    return true;
  }

  function plotSvg(): SVGSVGElement | null {
    return chart.querySelector<SVGSVGElement>("svg.project-svg");
  }

  function plotX(clientX: number): number {
    const s = plotSvg();
    if (!s) return clientX;
    return viewX(clientX, s.getBoundingClientRect(), VIEW_W);
  }

  function updateBrush(): void {
    const s = plotSvg();
    const shown = drag !== undefined && Math.abs(drag.curX - drag.startX) >= MIN_BRUSH_PX;
    if (!shown || !s || !drag) {
      brushRect?.remove();
      brushRect = undefined;
      return;
    }
    if (!brushRect || brushRect.parentNode !== s) {
      brushRect = svg("rect", { class: "project-brush", y: 0, fill: "currentColor", "fill-opacity": 0.12, stroke: "currentColor", "pointer-events": "none" });
      s.append(brushRect);
    }
    const lo = Math.min(drag.startX, drag.curX);
    brushRect.setAttribute("x", String(lo));
    brushRect.setAttribute("width", String(Math.abs(drag.curX - drag.startX)));
    brushRect.setAttribute("height", s.viewBox.baseVal && s.viewBox.baseVal.height ? String(s.viewBox.baseVal.height) : "100%");
  }

  function endDrag(): void {
    document.removeEventListener("mousemove", onBrushMove);
    document.removeEventListener("mouseup", onBrushUp);
    drag = undefined;
    updateBrush();
  }

  function onBrushDown(e: MouseEvent): void {
    if (!active || encoding !== "lanes" || e.button !== 0 || drag) return;
    const t = e.target as Element | null;
    if (t?.closest?.(".project-bead")) return;
    const x = plotX(e.clientX);
    if (x < X0 || x > X1) return;
    drag = { startX: x, curX: x, range: resolveWindow(store.get().window, nowFn(), store.get().liveSpanMs) };
    document.addEventListener("mousemove", onBrushMove);
    document.addEventListener("mouseup", onBrushUp);
  }

  function onBrushMove(e: MouseEvent): void {
    if (!drag) return;
    drag.curX = Math.min(X1, Math.max(X0, plotX(e.clientX)));
    if (Math.abs(drag.curX - drag.startX) >= MIN_BRUSH_PX && e.cancelable) e.preventDefault();
    updateBrush();
  }

  function onBrushUp(e: MouseEvent): void {
    const d = drag;
    if (!d) return;
    if (!active || encoding !== "lanes") { // a brush that outlived its encoding never commits
      endDrag();
      return;
    }
    const x = plotX(e.clientX);
    endDrag();
    const win = brushWindow(d.startX, x, d.range, X0, X1);
    if (!win) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    store.narrow({ window: win });
  }

  function moveCursor(id: string, focus: boolean): void {
    if (id !== cursor) {
      cursor = id;
      render();
      loadDetail();
    }
    if (!focus) return;
    for (const n of chart.querySelectorAll<SVGElement>("[data-key]")) {
      if (n.getAttribute("data-key") === id) { n.focus(); break; }
    }
  }

  // Capture phase so the claim lands before the shared bubble-phase ascent handler.
  // Local state first: an in-progress brush, then a keyboard-picked lane not yet in scope.
  function onEscapeCapture(e: KeyboardEvent): void {
    if (!LOCAL.laneClear.matches(e) || !active || encoding !== "lanes" || !root.isConnected || !isEscapeEligible(e)) return;
    if (drag) {
      endDrag();
      claimEscape(e);
    } else if (cursor !== undefined) {
      cursor = undefined;
      render();
      loadDetail();
      claimEscape(e);
    }
  }

  /** The target when the key belongs to the lanes view, else false. */
  function inLanes(e: KeyboardEvent): Element | null | false {
    if (!active || encoding !== "lanes" || !root.isConnected) return false;
    if (!isEscapeEligible(e)) return false;
    const t = e.target as Element | null;
    if (t !== document.body && !(t && typeof t.closest === "function" && root.contains(t))) return false;
    return t;
  }

  // Each handler returns false when the key is not the lanes view's, so dispatch can fall through.
  function onOpen(e: KeyboardEvent): boolean {
    const t = inLanes(e);
    if (t === false || t?.closest?.('button, a, select, [role="button"], .project-lane')) return false;
    const id = selection();
    const repo = pickedRepo();
    if (id === undefined || repo === undefined) return false;
    e.preventDefault();
    go("sessions", { project: repo, worktree: id, cell: undefined });
    return true;
  }

  function onPick(e: KeyboardEvent): boolean {
    const t = inLanes(e);
    if (t === false) return false;
    const id = laneIds[Number(e.key) - 1];
    if (id === undefined) return false;
    e.preventDefault();
    moveCursor(id, !!t?.closest?.(".project-lane"));
    return true;
  }

  function onArrow(e: KeyboardEvent): boolean {
    const t = inLanes(e);
    if (t === false || laneIds.length === 0) return false;
    const i = selection() === undefined ? -1 : laneIds.indexOf(selection()!);
    const j = i < 0 ? 0 : Math.min(laneIds.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    moveCursor(laneIds[j]!, !!t?.closest?.(".project-lane"));
    return true;
  }

  // Listed in the legend only while the lanes encoding is showing.
  const projectKeys = (): KeyBinding[] => {
    const enabled = (): boolean => active && encoding === "lanes" && root.isConnected;
    return [
      { scope: "project", ...QUEUE_KEYS.open, label: "open the selected lane's sessions", handler: onOpen, enabled },
      { scope: "project", ...QUEUE_KEYS.pick, label: "select a lane by number", handler: onPick, enabled },
      { scope: "project", keys: ["ArrowDown", "ArrowUp"], display: "↑ / ↓", label: "move between lanes", handler: onArrow, enabled },
    ];
  };

  return {
    root,
    refresh: () => (active ? load() : Promise.resolve()),
    onEvent(ev) {
      if (active && (encoding === "graph" || encoding === "events")) graph?.onEvent(ev);
    },
    encoding: () => encoding,
    setEncoding: setEncodingTo,
    activate(opts) {
      if (!active) {
        active = true;
        unsub = store.subscribe(onScope);
        unsubResolver = store.onResolver(() => syncSelect(pickerIds(), repoNow()));
        // One Project owns the "project" scope at a time; a stale instance is displaced.
        activeProjectKeys?.();
        unregisterOwnKeys = activeProjectKeys = registerKeys(projectKeys());
        document.addEventListener("keydown", onEscapeCapture, true);
        timer = setInterval(() => void load(true), refreshMs);
      }
      if (graph) {
        restoreRepoMemory();
        if (opts?.encoding !== undefined) setEncodingTo(opts.encoding);
        else mountEncoding();
      }
      render();
      return load();
    },
    deactivate() {
      if (graph && map) {
        graph.hide();
        map.cancel();
        map.setActive(false);
        encodingBody.replaceChildren();
      }
      active = false;
      cursor = undefined;
      unsub?.();
      unsub = undefined;
      unsubResolver?.();
      unsubResolver = undefined;
      unregisterOwnKeys?.();
      unregisterOwnKeys = undefined;
      document.removeEventListener("keydown", onEscapeCapture, true);
      endDrag();
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      listCtl?.abort();
      detailCtl?.abort();
      loadToken++;
      inflight = false;
    },
    setConnected(c) {
      connected = c;
      if (c && failedOffline && active) void load();
    },
  };
}
