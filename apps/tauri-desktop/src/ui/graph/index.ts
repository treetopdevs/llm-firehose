import { disambiguateSessionLabel, sessionName } from "../../format";
import {
  attention,
  getConfig,
  type AttentionSession,
  type FirehoseEvent,
} from "../../api";
import { el, clear, onActivate, keepFocus } from "../../dom";
import { renderDetail } from "../detail";
import {
  graphAPI,
  type Snapshot,
  type Repository,
  type Workspace,
} from "./api";
import {
  createGraphCanvas,
  type AgentInfo,
  type CanvasGraph,
  type CanvasState,
  type CanvasWorkspace,
} from "./canvas";
import {
  createInspector,
  type AgentRow,
  type InspectorContext,
} from "./inspector";
import { TimelineState, eventWorkspace, orderBy, type GraphNode } from "./model";
import {
  aggregateState,
  branchName,
  displayText,
  fullPath,
  isDigest,
  relativeAge,
  repoNames,
  sessionState,
  sessionStateWord,
  shortDigest,
  stateRank,
  truncateName,
  workspaceName,
  workspacePath,
} from "./names";
import { createToolbar, type SearchResult, type WorkspaceTab } from "./toolbar";
import { createActivityMap } from "../activity";
import { createScope, formatRange, formatSpan, liveSpanOf, type Scope, type ScopePatch, type ScopeStore } from "../../scope";
import { claimEscape, isEscapeEligible } from "../../escape";

/** Workspaces beyond this many on one revision collapse into a counted cluster. */
const MAX_STACK = 3;
/** How long the first draw waits for agent activity before framing every tip instead. */
const SESSIONS_WAIT_MS = 1500;
const SEARCH_LIMIT = 200;
/** The Timeline tab's page, and the small scoped page behind the inspector's "Captured activity". */
const TIMELINE_PAGE = "250";
const ACTIVITY_PAGE = "20";

function button(label: string, action: () => void) {
  const b = el("button", {}, label);
  b.onclick = action;
  return b;
}
function select(
  label: string,
  options: [string, string][],
  value: string,
  change: (v: string) => void,
) {
  const s = el("select", { "aria-label": label });
  for (const [v, l] of options) s.append(el("option", { value: v }, l));
  s.value = value;
  s.onchange = () => change(s.value);
  return s;
}

export interface WorkspaceGraphOptions {
  /**
   * Hosted by Project: scope.project is the sole repository identity, there is no
   * repository picker or tab strip, and nothing is requested until show().
   */
  hosted?: boolean;
  now?: () => number;
  /** Events timeline bound (D110); defaults to TIMELINE_CAP. */
  timelineCap?: number;
}
export type GraphView = "graph" | "events";

export function createWorkspaceGraph(
  onOpenSession: (id: string, source?: string) => void,
  store: ScopeStore = createScope(),
  opts: WorkspaceGraphOptions = {},
) {
  const hosted = !!opts.hosted;
  const nowMs = (): number => (opts.now ?? Date.now)();
  /** Hosted and not currently shown: nothing is fetched, polled or claimed. */
  let shown = !hosted;
  const hidden = () => hosted && !shown;
  /** The host's worktree order (Fleet's fork order); undefined keeps the snapshot order. */
  let worktreeOrder: readonly string[] | undefined;
  /** A project change landed while hidden, or a refresh failed: the next show() refreshes. */
  let pendingRefresh = false;
  /** Live events delivered while hidden (not merged): the next show() restarts pagination at the head. */
  let missedWhileHidden = 0;
  /** Bumped by every navigation or hide; an async handler that began earlier must not apply. */
  let navGen = 0;
  let viewListener: ((v: GraphView) => void) | undefined;
  /** Hosted: the scope names a project the workspace graph does not know. */
  let unregistered = false;
  const root = el("section", { class: "workspace-graph" });
  const status = el("div", { class: "graph-status", role: "status" });
  const body = el("div", { class: "graph-body" });
  const main = el("div", { class: "graph-main" }, status, body);
  let repos: Repository[] = [];
  let privacyMode: string | undefined;
  let repo = "";
  let snapshot: Snapshot | undefined;
  let sessions: AttentionSession[] = [];
  let tab: WorkspaceTab = "graph";
  let workspace = "";
  let revision = "";
  let session = "";
  let source = "";
  let category = "";
  let search = "";
  let graphSearch = "";
  let descendant = false;
  let cursor = "";
  let hasMore = false;
  let historyError = "";
  let topologyEpoch = 0;
  /** True while the graph applies a store change (or remaps it): nothing is published back. */
  let applying = false;
  /** Repository ids this panel has seen, so a vanished one is told apart from one it never tracked. */
  const knownRepos = new Set<string>();
  /** The one history request in flight, if any. Starting another aborts it. */
  let historyRequest: AbortController | undefined;
  let busy = false;
  /** The initial (or Fit) view has not been applied to the current repository yet. */
  let needsInitialFit = true;
  /** The first Fit was drawn before the sessions arrived: re-fit once they do (if the view is still automatic). */
  let initialFitPending = false;
  let timelineScrollTop = 0;
  /** Revisions whose workspace cluster the user expanded. */
  const expandedClusters = new Set<string>();
  const timeline = new TimelineState(opts.timelineCap);

  // Derived per snapshot / per attention poll; never touches the DOM.
  let nodesByKey = new Map<string, GraphNode>();
  let indexed: Snapshot | undefined;
  let agentInfo = new Map<string, AgentInfo>();
  let agentSessions = new Map<string, AttentionSession[]>();
  let unassigned = 0;

  const selectedWorkspace = () =>
    snapshot?.workspaces.find((w) => w.id === workspace);
  /** Hosted: the shared scope.window as a closed-or-open range. Live is open-ended so fresh arrivals count. */
  function windowRange(): { from?: number; to?: number } | undefined {
    if (!hosted) return undefined;
    const sc = store.get();
    if (sc.window === "live") return { from: nowMs() - liveSpanOf(sc) };
    return { from: sc.window.from, to: sc.window.to };
  }
  /** Hosted: whether the session's last activity falls in the window (halo, counts). Standalone: always. */
  function inWindow(s: AttentionSession, range = windowRange()): boolean {
    if (!range) return true;
    const t = Date.parse(s.last?.source_time ?? s.last?.time ?? s.last_observed_at ?? "");
    if (Number.isNaN(t)) return false;
    return (range.from === undefined || t >= range.from) && (range.to === undefined || t <= range.to);
  }
  /** Snapshot workspaces in the host's shared order. Canvas tip order is NOT shared: its layout sorts by id. */
  const orderedWorkspaces = (): Workspace[] =>
    orderBy(worktreeOrder, snapshot?.workspaces ?? [], (w) => w.id);
  function sessionAssociation(s: AttentionSession) {
    const last = s.last?.event_id ? timeline.event(s.last.event_id) : undefined;
    if (last && (last.repo_id || last.jj_repo_id))
      return timeline.association(last, repo);
    const observed = snapshot?.attention_associations?.[`${s.source}\0${s.id}`];
    return (
      (observed?.event_id === s.last?.event_id ? observed : undefined) ?? {
        repo_id: snapshot?.repository.vcs === "git" ? s.repo_id : s.jj_repo_id,
        workspace_id:
          snapshot?.repository.vcs === "git"
            ? s.worktree_id
            : s.jj_workspace_id,
      }
    );
  }
  /**
   * The human name for a `source\0id` key: the attention entry's name, else the
   * agent seen on its events and a short id. Memoized per render (the cache is
   * dropped in render()), so a live arrival costs one pass over the events, not one per row.
   */
  let labelCache = new Map<string, string>();
  let eventIndex: Map<string, FirehoseEvent> | undefined;
  function sessionLabel(key: string): string {
    const cached = labelCache.get(key);
    if (cached !== undefined) return cached;
    const [src, id] = key.split("\0");
    const known = sessions.find((s) => s.source === src && s.id === id);
    let label: string;
    if (known) label = sessionName(known);
    else {
      if (!eventIndex) {
        eventIndex = new Map();
        for (const e of timeline.all()) {
          const k = `${e.source}\0${e.session_id}`;
          if (e.session_id && !eventIndex.has(k)) eventIndex.set(k, e);
        }
      }
      const seen = eventIndex.get(key);
      label = sessionName({ id, source: src, agent: seen?.agent, repo: seen?.repo, cwd: seen?.cwd });
    }
    labelCache.set(key, label);
    return label;
  }
  const scopedSessions = () =>
    sessions.filter(
      (s) =>
        inWindow(s) &&
        sessionAssociation(s).repo_id === repo &&
        (!workspace || sessionAssociation(s).workspace_id === workspace),
    );

  // ---- derived data ------------------------------------------------------

  function index() {
    if (indexed === snapshot) return;
    indexed = snapshot;
    nodesByKey = new Map((snapshot?.nodes ?? []).map((n) => [n.key, n]));
  }
  function computeAgents() {
    const now = nowMs();
    const range = windowRange();
    const known = new Set((snapshot?.workspaces ?? []).map((w) => w.id));
    agentSessions = new Map();
    unassigned = 0;
    for (const s of sessions) {
      if (!inWindow(s, range)) continue;
      const a = sessionAssociation(s);
      if (a.repo_id !== repo) continue;
      if (!a.workspace_id || !known.has(a.workspace_id)) {
        unassigned++;
        continue;
      }
      const list = agentSessions.get(a.workspace_id);
      if (list) list.push(s);
      else agentSessions.set(a.workspace_id, [s]);
    }
    agentInfo = new Map();
    for (const [id, list] of agentSessions)
      agentInfo.set(id, {
        state: aggregateState(list.map((s) => sessionState(s, now))),
        count: list.length,
      });
  }
  const vcs = () => snapshot?.repository.vcs ?? "git";
  function displayName(w: Workspace): string {
    return workspaceName(w, vcs(), privacyMode, nodesByKey.get(w.revision)?.commit_id);
  }
  function canvasWorkspace(w: Workspace): CanvasWorkspace {
    const name = displayName(w);
    // locked, pruned and inaccessible checkouts are stated, never drawn as ordinary ones
    const unavailable =
      w.availability && w.availability !== "available" ? w.availability : "";
    return {
      id: w.id,
      revision_key:
        !w.unborn && w.revision && nodesByKey.has(w.revision)
          ? w.revision
          : undefined,
      name: truncateName(name),
      fullName: [name, w.unborn ? "unborn" : "", unavailable]
        .filter(Boolean)
        .join(" · "),
      path: workspacePath(w, vcs()),
      badges: [
        unavailable,
        w.dirty ? "dirty" : "",
        w.conflicted ? "conflict" : "",
      ].filter(Boolean),
    };
  }
  /** Expand the counted cluster hiding a workspace, so selecting it never leaves it out of sight. */
  function revealWorkspace(w: Workspace | undefined) {
    if (!w?.revision || w.unborn || !snapshot) return;
    const here = snapshot.workspaces.filter(
      (x) => x.revision === w.revision && !x.unborn,
    ).length;
    if (here > MAX_STACK) expandedClusters.add(w.revision);
  }
  function graphInput(): CanvasGraph {
    return {
      nodes: snapshot?.nodes ?? [],
      workspaces: (snapshot?.workspaces ?? []).map(canvasWorkspace),
      trunkTip: snapshot?.default_target || undefined,
      expanded: new Set(expandedClusters),
      hasMore: !!snapshot?.next_cursor,
      boundaryCount: snapshot?.boundaries?.length ?? 0,
    };
  }
  function matchSet(): Set<string> | null {
    const needle = graphSearch.trim().toLowerCase();
    if (!needle || !snapshot) return null;
    const out = new Set<string>();
    for (const w of snapshot.workspaces)
      if (workspaceMatches(w, needle)) out.add(w.id);
    return out;
  }
  function workspaceMatches(w: Workspace, needle: string): boolean {
    const n = nodesByKey.get(w.revision);
    return [
      displayName(w),
      w.label,
      ...(w.refs ?? []),
      w.revision,
      n?.commit_id,
      n?.description,
      w.dirty ? "dirty" : "",
      w.conflicted ? "conflict" : "",
    ]
      .join("\n")
      .toLowerCase()
      .includes(needle);
  }
  function canvasState(): CanvasState {
    return {
      workspace,
      revision: revision || selectedWorkspace()?.revision || "",
      descendants: descendant,
      matches: matchSet(),
      agents: agentInfo,
    };
  }

  /** Active tips for the initial view and Fit: fresh working or needs-attention workspaces, else all. */
  function activeIds(): string[] | undefined {
    if (!snapshot) return undefined;
    const attached = snapshot.workspaces.filter(
      (w) => !w.unborn && nodesByKey.has(w.revision),
    );
    const active = attached.filter((w) => {
      const s = agentInfo.get(w.id)?.state;
      return s === "attention" || s === "working";
    });
    const ids = (active.length ? active : attached).map((w) => w.id).slice(0, 50);
    return ids.length ? ids : undefined;
  }

  // ---- the graph pane ----------------------------------------------------

  const canvas = createGraphCanvas({
    fit: () => canvas.fit(activeIds()),
    selectWorkspace: (id) => selectWorkspace(id),
    selectRevision: (key) => selectRevision(key),
    toggleCluster: (rev) => {
      if (expandedClusters.has(rev)) expandedClusters.delete(rev);
      else expandedClusters.add(rev);
      sync(rev);
    },
    clearSelection,
    expandHistory: () => {
      if (snapshot?.next_cursor) void refresh(false, snapshot.next_cursor);
    },
  });
  const inspector = createInspector({
    openSession: (id, src) => onOpenSession(id, src),
    filterTimeline: (src, id) => {
      session = `${src}\0${id}`;
      switchTab("timeline");
      render();
      void loadHistory();
    },
    openTimeline: () => {
      switchTab("timeline");
      render();
      void loadHistory();
    },
    selectRevision: (key) => selectRevision(key, true),
    highlightAncestry: () => {
      descendant = false;
      sync();
      canvas.fitRevisions(canvas.highlighted() ?? []);
    },
    toggleDescendants: () => {
      descendant = !descendant;
      sync();
    },
  });
  const graphPane = el("div", { class: "graph-pane" }, canvas.root, inspector.root);
  const activityMap = hosted ? undefined : createActivityMap();
  /** Every tab change the graph makes itself goes through here, so a host can follow it. */
  function switchTab(next: WorkspaceTab) {
    if (hosted && next !== "map") viewListener?.(next === "timeline" ? "events" : "graph");
    tab = next;
  }

  const toolbar = createToolbar({
    selectRepo: (id) => {
      repo = id;
      resetForRepo();
      publish();
      void refresh();
    },
    setTab: (name) => {
      switchTab(name);
      render();
      void loadHistory();
    },
    fit: () => canvas.fit(activeIds()),
    all: () => canvas.fitAll(),
    search: (q) => searchResults(q),
    pick: pickResult,
    register: async (rootPath, kind) => {
      const gen = navGen;
      const stale = () => gen !== navGen || hidden();
      try {
        const r = await graphAPI.register(rootPath, kind);
        // The user navigated (or the view was hidden) while the daemon worked: the
        // registration stands, but it must not take the scope or the view over.
        if (stale()) return;
        const list = await graphAPI.repos();
        if (stale()) return;
        repo = r.id;
        repos = list;
        resetForRepo();
        publish();
        // Publishing can move the host to another encoding (hiding this one).
        if (stale()) {
          pendingRefresh = true;
          return;
        }
        await refresh();
      } catch {
        throw new Error(
          "Unable to register repository. Check the local root and VCS availability.",
        );
      }
    },
    refresh: () => void refresh(true),
  }, { hosted });
  root.append(toolbar.root, main);

  /** A new repository: nothing from the previous one survives, and its history requests are cancelled. */
  function resetForRepo() {
    source = "";
    discardTopology();
  }
  /**
   * Forget the snapshot and everything derived from it (a repository switch, a
   * privacy-mode change, a repository that disappeared). The next render shows the
   * loading state, so the header never keeps the previous repository's counts.
   */
  function discardTopology() {
    abortHistory();
    snapshot = undefined;
    workspace = "";
    revision = "";
    session = "";
    cursor = "";
    hasMore = false;
    historyError = "";
    graphSearch = "";
    expandedClusters.clear();
    needsInitialFit = true;
    clearGraph();
  }
  /** Drop everything drawn from the previous repository or privacy mode. */
  function clearGraph() {
    inspector.reset();
    canvas.setGraph({
      nodes: [],
      workspaces: [],
      expanded: new Set(),
      hasMore: false,
      boundaryCount: 0,
    });
  }

  /** Publish the user's explicit choice (never a default pick or a store-driven change). */
  function publish() {
    if (applying) return;
    if (hosted && !repo) return; // never erase scope.project on behalf of a project the graph does not know
    applying = true; // our own publication is not echoed back into the view
    try {
      // The window is carried explicitly: clearing the session (a graph selection) would otherwise reset a frozen range to live.
      store.narrow({
        project: repo || undefined,
        worktree: workspace || undefined,
        cell: undefined,
        window: store.get().window,
      });
    } finally {
      applying = false;
    }
  }
  function applyWorkspace(id: string) {
    workspace = id;
    revision = selectedWorkspace()?.revision ?? "";
    revealWorkspace(selectedWorkspace());
    session = "";
    cursor = "";
    void loadHistory();
    render();
  }
  function selectWorkspace(id: string) {
    applyWorkspace(id);
    publish();
  }
  function selectRevision(key: string, center = false) {
    revision = key;
    workspace = "";
    session = "";
    cursor = "";
    void loadHistory(); // no workspace selected any more: nothing to load, and anything in flight is dropped
    render();
    publish();
    if (center) canvas.centerOnRevision(key, canvas.view().scale);
  }
  function clearLocal(): boolean {
    if (!workspace && !revision) return false;
    workspace = "";
    revision = "";
    session = "";
    cursor = "";
    void loadHistory();
    render();
    return true;
  }
  /** Clear the selection on the user's behalf. True when there was one to clear. */
  function clearSelection(): boolean {
    if (!clearLocal()) return false;
    publish();
    return true;
  }
  /** A store-driven repository change: the previous repository's in-flight work is discarded. */
  function switchRepo(id: string) {
    repo = id;
    ++topologyEpoch;
    busy = false;
    resetForRepo();
    void refresh();
  }
  store.subscribe((next: Scope, prev: Scope) => {
    if (hosted && shown && (!sameWindow(next.window, prev.window) || next.liveSpanMs !== prev.liveSpanMs)) {
      // The shared window drives the halo, the Events rows and their copy.
      if (tab === "timeline") render();
      else syncActivity();
    }
    if (applying) return;
    if (hosted && next.project !== prev.project) {
      // scope.project is the sole repository identity: whatever was in flight for the
      // previous one (snapshots, a registration) is now stale.
      navGen++;
      ++topologyEpoch;
      busy = false;
      repo = "";
      unregistered = false;
      source = ""; // the Events source filter belongs to the previous repository
      discardTopology();
      if (hidden()) {
        pendingRefresh = true; // defer: nothing is requested until show()
      } else void refresh();
      return;
    }
    if (hidden()) return;
    applying = true;
    try {
      if (
        next.project !== prev.project &&
        next.project &&
        next.project !== repo &&
        repos.some((r) => r.id === next.project)
      ) {
        switchRepo(next.project); // a worktree in the same patch is selected once the snapshot lands
        return;
      }
      if (next.worktree !== prev.worktree) {
        if (!next.worktree) clearLocal();
        else if (
          snapshot &&
          workspace !== next.worktree &&
          snapshot.workspaces.some((w) => w.id === next.worktree)
        )
          applyWorkspace(next.worktree);
        else if (hosted && tab === "timeline") {
          // A worktree the topology does not hold (a removed one) still narrows the feed.
          cursor = "";
          hasMore = false;
          render();
          void loadHistory();
        }
      }
    } finally {
      applying = false;
    }
  });
  const sameWindow = (a: Scope["window"], b: Scope["window"]) =>
    a === "live" || b === "live" ? a === b : a.from === b.from && a.to === b.to;
  /**
   * After a snapshot lands: the scope may name ids the graph no longer knows (a
   * privacy-mode change replaces them, a repository or workspace vanished). Remap
   * with one atomic narrow so the scope never holds them.
   */
  function reconcileScope(privacyChanged: boolean) {
    const sc = store.get();
    let patch: ScopePatch | undefined;
    if (
      !hosted && // hosted: an explicit scope.project is never rewritten
      sc.project &&
      sc.project !== repo &&
      !repos.some((r) => r.id === sc.project) &&
      (knownRepos.has(sc.project) || privacyChanged)
    )
      patch = { project: repo || undefined, worktree: undefined };
    else if (
      sc.worktree &&
      snapshot &&
      (!sc.project || sc.project === repo) &&
      !snapshot.workspaces.some((w) => w.id === sc.worktree) &&
      // A worktree another resolver still knows (Project's lifetime view, including
      // removed worktrees) is a valid historical identity, not a stale graph id.
      !store.resolver()?.knows?.(sc)
    )
      patch = { worktree: undefined };
    if (!patch) return;
    // The local selection goes with the scope entry, before consumers hear of it.
    if (workspace && sc.worktree === workspace && "worktree" in patch && patch.worktree === undefined) clearLocal();
    applying = true;
    try {
      store.narrow(patch);
    } finally {
      applying = false;
    }
  }
  function sessionIdsFor(sc: Scope): Set<string> | undefined {
    const keys = memberKeys(sc);
    if (!keys) return undefined;
    return new Set([...keys].map((k) => k.slice(k.indexOf("\0") + 1)));
  }
  function memberKeys(sc: Scope): Set<string> | undefined {
    if (!sc.project && !sc.worktree) return undefined;
    if ((sc.project ?? repo) !== repo || !repo) return undefined;
    const known = snapshot ? new Set(snapshot.workspaces.map((w) => w.id)) : undefined;
    const out = new Set<string>();
    for (const s of sessions) {
      const a = sessionAssociation(s);
      if (a.repo_id !== repo) continue;
      if (sc.worktree) {
        if (a.workspace_id !== sc.worktree) continue;
        if (known && !known.has(a.workspace_id)) continue;
      }
      out.add(`${s.source}\0${s.id}`);
    }
    return out;
  }
  // While a hosted graph is hidden it answers nothing, so the host's fallback resolver
  // (lifetime rows, removed worktrees included) decides membership and labels.
  store.setResolver({
    sessions: (sc) => (hidden() ? undefined : sessionIdsFor(sc)),
    matcher(sc) {
      if (hidden()) return undefined;
      const keys = memberKeys(sc);
      if (!keys) return undefined;
      const ids = new Set([...keys].map((k) => k.slice(k.indexOf("\0") + 1)));
      return (ref) => (ref.source !== undefined ? keys.has(`${ref.source}\0${ref.id}`) : ids.has(ref.id));
    },
    knows: (sc) => !hidden() && (!sc.worktree || ((sc.project ?? repo) === repo && !!snapshot?.workspaces.some((w) => w.id === sc.worktree))),
    async refresh() {
      if (hidden()) return;
      try {
        sessions = (await attention()).sessions ?? sessions;
      } catch {
        /* keep the last membership */
      }
    },
    labels(sc) {
      const out: { project?: string; worktree?: string } = {};
      if (hidden()) return out;
      if (sc.project) {
        const r = repos.find((x) => x.id === sc.project);
        if (r) out.project = r.label;
      }
      if (sc.worktree) {
        const w = snapshot?.workspaces.find((x) => x.id === sc.worktree);
        if (w) out.worktree = displayName(w);
      }
      return out;
    },
  });
  store.touchResolver();

  // Search: workspaces (every one is listed when the query is empty), then revisions.
  /**
   * 0 a workspace name or ref matches, 1 a commit ID, 2 anything else (a commit
   * description, dirty, conflict). Names come first so "cache" finds the cache
   * branches before whatever merely mentions it in a commit message.
   */
  function matchTier(w: Workspace, needle: string): number {
    const has = (v: string | undefined) => !!v && v.toLowerCase().includes(needle);
    if (has(displayName(w)) || has(w.label) || (w.refs ?? []).some(has)) return 0;
    if (has(w.revision) || has(nodesByKey.get(w.revision)?.commit_id)) return 1;
    return 2;
  }
  function searchResults(q: string): SearchResult[] {
    graphSearch = q;
    canvas.setState(canvasState());
    if (!snapshot) return [];
    const needle = q.trim().toLowerCase();
    const out: SearchResult[] = [];
    const base = orderedWorkspaces();
    let ordered = base;
    if (needle) {
      // stable sort: tier, then (for names) the shorter, closer match, then the shared (else snapshot) order
      ordered = base
        .filter((w) => workspaceMatches(w, needle))
        .map((w, i) => ({ w, i, tier: matchTier(w, needle) }))
        .sort(
          (a, b) =>
            a.tier - b.tier ||
            (a.tier === 0 ? displayName(a.w).length - displayName(b.w).length : 0) ||
            a.i - b.i,
        )
        .map((x) => x.w);
    }
    for (const w of ordered) {
      const n = nodesByKey.get(w.revision);
      const ref = branchName(w.refs);
      out.push({
        kind: "workspace",
        id: w.id,
        title: displayName(w),
        detail: [
          ref ? shortDigest(ref) : w.unborn ? "unborn" : "detached",
          n ? n.commit_id.slice(0, 8) : "",
          w.dirty ? "dirty" : "",
        ]
          .filter(Boolean)
          .join(" · "),
        state: agentInfo.get(w.id)?.state ?? "none",
      });
      if (out.length >= SEARCH_LIMIT) break;
    }
    if (needle) {
      let revisions = 0;
      for (const n of snapshot.nodes) {
        if (revisions >= 8) break;
        if (
          n.commit_id.toLowerCase().startsWith(needle) ||
          (n.change_id ?? "").toLowerCase().startsWith(needle) ||
          n.description.toLowerCase().includes(needle)
        ) {
          out.push({
            kind: "revision",
            id: n.key,
            title: n.commit_id.slice(0, 8),
            detail: displayText(n.description.split("\n")[0]).slice(0, 60),
          });
          revisions++;
        }
      }
    }
    return out;
  }
  function pickResult(r: SearchResult) {
    if (tab !== "graph") {
      switchTab("graph");
    }
    if (r.kind === "workspace") {
      selectWorkspace(r.id);
      canvas.centerOnWorkspace(r.id, Math.max(canvas.view().scale, 0.8));
      canvas.focusWorkspace(r.id);
    } else {
      selectRevision(r.id, true);
    }
  }

  // ---- render ------------------------------------------------------------

  function setStatus() {
    if (!snapshot) return;
    status.textContent = [
      snapshot.stale ? "Stale snapshot — last successful scan retained" : "",
      workspace && !selectedWorkspace()
        ? "Selected workspace is no longer available."
        : "",
      ...(snapshot.warnings ?? []),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  function updateToolbar() {
    const names = repoNames(repos, privacyMode);
    toolbar.update({
      repos: repos.map((r, i) => ({
        id: r.id,
        name: names[i],
        title: fullPath(r.label),
      })),
      repo,
      count: snapshot
        ? `${snapshot.workspaces.length} ${
            snapshot.repository.vcs === "jj" ? "workspace" : "worktree"
          }${snapshot.workspaces.length === 1 ? "" : "s"}`
        : busy && repo
          ? "Loading…"
          : "",
      tab,
    });
  }
  function render() {
    labelCache = new Map();
    eventIndex = undefined;
    const oldTimeline = body.querySelector<HTMLElement>(".graph-timeline");
    if (oldTimeline) timelineScrollTop = oldTimeline.scrollTop;
    const restore = keepFocus(root);
    main.classList.toggle("is-timeline", tab === "timeline");
    main.classList.toggle("is-map", tab === "map");
    updateToolbar();
    if (!snapshot) {
      // Nothing is known about this repository yet: no warnings, no counts, no graph.
      status.textContent = "";
      clear(body);
      body.append(
        el(
          "p",
          { class: "dim graph-empty" },
          busy
            ? "Loading repository topology…"
            : unregistered
              ? "This project is not registered in the workspace graph. Register its root under More."
              : repos.length
              ? "Repository topology unavailable. The next refresh retries automatically."
              : "Register a local repository to inspect its ancestry. Discovery stays on this machine.",
        ),
      );
      restore();
      return;
    }
    setStatus();
    if (tab === "graph") {
      if (body.firstElementChild !== graphPane || body.childElementCount !== 1) {
        clear(body);
        body.append(graphPane);
      }
      sync();
    } else if (tab === "map") {
      if (!activityMap) return;
      if (body.firstElementChild !== activityMap.root || body.childElementCount !== 1) {
        clear(body);
        body.append(activityMap.root);
      }
      activityMap.update(
        repo,
        snapshot.workspaces.map((w) => ({ id: w.id, name: displayName(w) })),
        privacyMode,
      );
    } else {
      clear(body);
      renderTimeline();
    }
    const nextTimeline = body.querySelector<HTMLElement>(".graph-timeline");
    if (nextTimeline) nextTimeline.scrollTop = timelineScrollTop;
    restore();
  }

  function inspectorContext(): InspectorContext {
    const w = selectedWorkspace();
    const key = revision || w?.revision || "";
    const now = nowMs();
    const node = nodesByKey.get(key);
    let branch = "";
    let copyValue = "";
    if (w) {
      const ref = branchName(w.refs);
      if (ref) {
        branch = shortDigest(ref);
        copyValue = ref;
      } else if (w.unborn) {
        branch = "Unborn branch";
        copyValue = w.label;
      } else {
        const id = node?.commit_id ?? "";
        branch = vcs() === "jj" ? "No bookmark" : `Detached HEAD ${id.slice(0, 7)}`.trim();
        copyValue = id;
      }
    }
    const rows: AgentRow[] = w
      ? (agentSessions.get(w.id) ?? [])
          .map((s) => ({
            source: s.source,
            id: s.id,
            name: sessionName(s),
            state: sessionState(s, now),
            word: sessionStateWord(s, now),
            uncertainty: s.uncertainty,
          }))
          .sort(
            (a, b) =>
              stateRank(b.state) - stateRank(a.state) ||
              a.source.localeCompare(b.source) ||
              a.id.localeCompare(b.id),
          )
      : [];
    const activity = w
      ? timeline
          .rows({ repo, workspace: w.id })
          .slice(0, 3)
          .map((e) => ({
            id: e.id,
            text: e.summary || e.name || e.category,
            age: relativeAge(e.time, now),
          }))
      : [];
    return {
      repo,
      snapshot: snapshot!,
      workspace: w,
      name: w ? displayName(w) : "",
      workspacePath: w ? workspacePath(w, vcs()) : undefined,
      repoPath: fullPath(snapshot?.repository.label ?? ""),
      branch,
      copyValue,
      state: w ? (agentInfo.get(w.id)?.state ?? "none") : "none",
      agents: rows,
      activity,
      revision: key,
      descendants: descendant,
      unassigned,
      others: (snapshot?.workspaces ?? [])
        .filter((x) => x.id !== w?.id && x.revision && !x.unborn)
        .map((x) => ({ id: x.id, name: displayName(x), revision: x.revision })),
    };
  }
  /** Push the current data into the canvas, toolbar and inspector without rebuilding what has not changed. */
  function sync(anchor?: string) {
    if (!snapshot) return;
    index();
    computeAgents();
    canvas.setGraph(graphInput(), anchor);
    if (needsInitialFit) {
      needsInitialFit = false;
      canvas.fit(activeIds());
    }
    canvas.setState(canvasState());
    toolbar.refreshOpenResults();
    inspector.update(inspectorContext());
  }
  /** Attention and event arrivals: classes and the inspector only. */
  function syncActivity() {
    if (!snapshot || tab !== "graph") return;
    computeAgents();
    canvas.setState(canvasState());
    inspector.update(inspectorContext());
  }

  // ---- timeline (unchanged behaviour) ---------------------------------------

  function renderTimeline() {
    const panel = el("div", { class: "graph-timeline" });
    const filters = el("div", { class: "graph-controls" });
    function changed() {
      cursor = "";
      void loadHistory();
      render();
    }
    const names = new Map<string, number>();
    for (const w of snapshot!.workspaces)
      names.set(displayName(w), (names.get(displayName(w)) ?? 0) + 1);
    /** The pill name, plus a short tail of the identity only when two workspaces read alike. */
    const caption = (w: Workspace) => {
      const n = displayName(w);
      if ((names.get(n) ?? 0) < 2) return n;
      const tail = isDigest(w.label)
        ? shortDigest(w.label)
        : `…/${w.label.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}`;
      return `${n} · ${tail}`;
    };
    filters.append(
      select(
        "Workspace",
        [
          ["", "Whole repository"],
          ...orderedWorkspaces().map(
            (w) => [w.id, caption(w)] as [string, string],
          ),
        ],
        workspace,
        (v) => {
          workspace = v;
          revision = selectedWorkspace()?.revision ?? "";
          session = "";
          changed();
          publish();
        },
      ),
      select(
        "Source",
        [
          ["", "All sources"],
          ...Array.from(
            new Set([
              ...timeline.all().map((e) => e.source),
              ...sessions.map((s) => s.source),
            ]),
          )
            .sort()
            .map((s) => [s, s] as [string, string]),
        ],
        source,
        (v) => {
          source = v;
          session = "";
          changed();
        },
      ),
      select(
        "Session",
        [
          ["", "All sessions"],
          ...Array.from(
            new Set([
              ...scopedSessions().map((s) => `${s.source}\0${s.id}`),
              ...timeline
                .all()
                .filter(
                  (e) =>
                    e.session_id &&
                    (!eventsWorkspace() ||
                      timeline.association(e, repo).workspace_id === eventsWorkspace()),
                )
                .map((e) => `${e.source}\0${e.session_id}`),
            ]),
          )
            .filter((s) => !source || s.startsWith(source + "\0"))
            .map((s) => [s, sessionLabel(s)] as [string, string])
            .map(([key, label], _i, all) => [key, disambiguateSessionLabel(key, label, all)] as [string, string]),
        ],
        session,
        (v) => {
          session = v;
          changed();
        },
      ),
      select(
        "Category",
        [
          ["", "All categories"],
          ...Array.from(new Set(timeline.all().map((e) => e.category)))
            .sort()
            .map((s) => [s, s] as [string, string]),
        ],
        category,
        (v) => {
          category = v;
          changed();
        },
      ),
    );
    const searchInput = el("input", {
      "aria-label": "Search captured events",
      placeholder: "Search hooks and events",
      value: search,
    });
    let timeout: ReturnType<typeof setTimeout>;
    searchInput.oninput = () => {
      search = searchInput.value;
      clearTimeout(timeout);
      timeout = setTimeout(changed, 250);
    };
    // Hosted: the shared window decides what is followed, so there is no pause/resume.
    if (hosted) filters.append(searchInput);
    else
      filters.append(
        searchInput,
        button(
          timeline.paused
            ? `Resume · ${timeline.unreadFor({ repo, workspace, source, session, category, search })} arrivals`
            : "● Live · pause",
          () => {
            if (timeline.paused) {
              timeline.resume();
              void loadHistory();
            } else timeline.pause();
            render();
          },
        ),
      );
    const range = windowRange();
    const rowsShown = timeline.rows({ repo, workspace: eventsWorkspace(), source, session, category, search, ...range });
    if (hosted) {
      const sc = store.get();
      const now = nowMs();
      const state =
        sc.window === "live"
          ? `Following live · last ${formatSpan(liveSpanOf(sc))}`
          : `Frozen range ${formatRange(sc.window, now).text}`;
      panel.append(el("p", { class: "graph-events-state", role: "status" }, `${state} · ${rowsShown.length} shown`));
    }
    panel.append(
      filters,
      el(
        "p",
        { class: "dim" },
        "Newest captured events first · source clocks do not establish cross-provider causal order. Captured content only.",
      ),
    );
    if (historyError)
      panel.append(el("p", { class: "graph-warning" }, historyError));
    const table = el("table", { class: "graph-events" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...[
            "Time",
            "Session",
            "Native hook / event",
            "Category",
            "Summary",
            "",
          ].map((s) => el("th", {}, s)),
        ),
      ),
    );
    const rows = el("tbody");
    const filtered = rowsShown;
    for (const e of filtered) {
      const row = el("tr", {
        "data-key": `event:${e.id}`,
        tabindex: "0",
        class: timeline.selected?.id === e.id ? "selected" : "",
      });
      row.append(
        el("td", {}, new Date(e.time).toLocaleTimeString()),
        el("td", { class: "timeline-session", title: e.session_id ? `${e.source} · ${e.session_id}` : "" }, e.session_id ? sessionLabel(`${e.source}\0${e.session_id}`) : `${e.source} · unassigned`),
        el("td", {}, e.name ?? "—"),
        el("td", {}, e.category),
        el("td", {}, e.summary ?? ""),
      );
      const graph = button("Show in Graph", () => showInGraph(e));
      graph.onclick = (evt) => {
        evt.stopPropagation();
        showInGraph(e);
      };
      row.append(el("td", {}, graph));
      onActivate(row, () => {
        timeline.select(e.id);
        render();
      });
      rows.append(row);
    }
    table.append(rows);
    panel.append(table);
    if (!filtered.length)
      panel.append(
        el(
          "p",
          { class: "dim" },
          hosted
            ? "No captured events in this window. Load older events to look further back."
            : "No captured events match this scope. Events with missing identity stay unassigned.",
        ),
      );
    panel.append(
      button(
        hasMore ? "Load older events" : "Reconcile durable history",
        () => void loadHistory(hasMore),
      ),
      el(
        "p",
        { class: "dim" },
        hasMore
          ? "Older durable history available."
          : "Loaded history boundary reached; capture gaps may still exist.",
      ),
    );
    const detail = el("aside", { class: "graph-event-detail" });
    if (timeline.selected) {
      renderDetail(
        detail,
        timeline.selected,
        () => {
          timeline.selected = undefined;
          render();
        },
        (e) =>
          timeline
            .all()
            .filter(
              (o) =>
                o.source === e.source &&
                o.session_id === e.session_id &&
                o.call_id === e.call_id,
            ),
      );
      detail.append(
        button("Show in Graph", () => showInGraph(timeline.selected!)),
        el(
          "p",
          {},
          `Observed workspace: ${timeline.selected.worktree_id ?? "unassigned"}`,
        ),
      );
      if (/permission/i.test(timeline.selected.name ?? ""))
        detail.append(
          el("p", {}, "Respond in the agent’s existing approval flow."),
        );
    }
    body.append(panel, detail);
  }
  function showInGraph(e: FirehoseEvent) {
    if (timeline.association(e, repo).repo_id !== repo) {
      status.textContent = "Workspace unavailable in the selected repository.";
      return;
    }
    const w = eventWorkspace(
      {
        ...e,
        worktree_id: timeline.association(e, repo).workspace_id,
        jj_workspace_id: undefined,
      },
      snapshot?.workspaces ?? [],
    );
    if (!w) {
      status.textContent =
        "Workspace unavailable: no discovered checkout matches this event’s observed identity.";
      return;
    }
    workspace = w.id;
    revision = w.revision;
    revealWorkspace(w);
    switchTab("graph");
    render();
    canvas.centerOnWorkspace(w.id, 1);
    void loadHistory();
    publish();
  }
  /** Which history the current view shows: the Timeline tab's page, or a workspace's recent activity. */
  /**
   * The worktree the Events feed is narrowed to. Hosted, the shared scope is the
   * authority, so a worktree the current topology no longer contains (a removed one
   * retained from Lanes) still narrows the feed instead of silently widening it.
   */
  function eventsWorkspace(): string {
    if (workspace) return workspace;
    if (!hosted) return "";
    const sc = store.get();
    return sc.worktree && (!sc.project || sc.project === repo) ? sc.worktree : "";
  }
  function historyKind(): "timeline" | "activity" | undefined {
    if (!repo || !root.isConnected || hidden()) return undefined;
    if (tab === "timeline") return "timeline";
    // The Map fetches its own aggregate; it needs no event history.
    if (tab === "map") return undefined;
    return workspace ? "activity" : undefined;
  }
  function abortHistory() {
    const request = historyRequest;
    historyRequest = undefined;
    request?.abort();
  }
  /**
   * Load the history the current view needs, aborting the request already in flight
   * (so there is never more than one), or just aborting it when the view needs none.
   * The Timeline tab asks for a full page with its filters; the Graph tab with a
   * workspace selected asks for one small page scoped to that workspace.
   */
  async function loadHistory(older = false) {
    abortHistory();
    if (hidden()) return;
    const kind = historyKind();
    if (!kind) return;
    const controller = new AbortController();
    historyRequest = controller;
    const params: Record<string, string> = {
      repo_id: repo,
      limit: kind === "timeline" ? TIMELINE_PAGE : ACTIVITY_PAGE,
    };
    const scoped = kind === "timeline" ? eventsWorkspace() : workspace;
    if (scoped) params.workspace_id = scoped;
    if (kind === "timeline") {
      if (source) params.source = source;
      if (session) {
        const [s, id] = session.split("\0");
        params.source = s;
        params.session_id = id;
      }
      if (category) params.category = category;
      if (search) params.search = search;
      if (older && cursor) params.cursor = cursor;
    }
    try {
      const page = await graphAPI.timeline(params, controller.signal);
      if (historyRequest !== controller) return;
      // A cursor page is older history: at the cap it evicts the newest, not itself.
      const evicted = timeline.merge(page.events ?? [], page.associations, { older: !!params.cursor });
      if (kind === "timeline") {
        if (older || !cursor) {
          cursor = page.next_cursor ?? "";
          hasMore = page.has_more;
        } else if (evicted.older) olderEvicted();
        if (!older) missedWhileHidden = 0; // the head is current again
        historyError = page.capture_gap
          ? "Capture gaps reported; this feed may be incomplete."
          : "";
      }
      if (tab === "timeline") render();
      else syncActivity();
    } catch {
      // A superseded or cancelled request is not a failure.
      if (controller.signal.aborted || historyRequest !== controller) return;
      if (kind === "timeline") {
        historyError =
          "Durable history unavailable — live capture continues. Retry reconciliation.";
        if (tab === "timeline") render();
      }
    } finally {
      if (historyRequest === controller) historyRequest = undefined;
    }
  }
  /**
   * D110: the oldest events were evicted, so a held cursor points past a gap. Restart
   * pagination at the head; "Load older" walks back with daemon cursors, deduped by ID.
   */
  function olderEvicted() {
    cursor = "";
    hasMore = true;
  }
  /** Reconcile from a periodic refresh: only what the view needs, and never on top of a request in flight. */
  function ensureHistory() {
    if (hidden()) return;
    if (!historyRequest && historyKind()) void loadHistory();
  }
  async function refresh(force = false, expand = "") {
    if (hidden()) {
      pendingRefresh = true; // a hidden encoding requests nothing; show() restarts it
      return;
    }
    const epoch = ++topologyEpoch;
    busy = true;
    watchLeaving();
    if (!snapshot) render(); // a repository is loading: say so instead of showing stale header data
    const done = () => {
      if (epoch === topologyEpoch) busy = false;
    };
    try {
      const [config, available] = await Promise.all([
        getConfig(),
        graphAPI.repos(),
      ]);
      if (epoch !== topologyEpoch) return;
      let privacyChanged = false;
      if (privacyMode !== undefined && privacyMode !== config.privacy_mode) {
        privacyChanged = true;
        discardTopology();
        render();
      }
      privacyMode = config.privacy_mode;
      repos = available;
      for (const r of repos) knownRepos.add(r.id);
      if (hosted) {
        // scope.project is the sole repository identity; with none, the first registered repository.
        const project = store.get().project;
        const target = project ?? repos[0]?.id ?? "";
        unregistered = !!project && !repos.some((r) => r.id === project);
        if (unregistered || repo !== target) {
          repo = "";
          discardTopology();
        }
        if (!unregistered) repo = target;
        if (unregistered || !repo) {
          pendingRefresh = false;
          done();
          render();
          store.touchResolver();
          return;
        }
      } else {
        if (repo && !repos.some((r) => r.id === repo)) {
          repo = "";
          discardTopology();
          render();
        }
        if (!repo) {
          const wanted = store.get().project;
          repo = repos.some((r) => r.id === wanted) ? wanted! : (repos[0]?.id ?? "");
        }
        if (!repo) {
          done();
          render();
          reconcileScope(privacyChanged);
          store.touchResolver();
          return;
        }
      }
      // The first view frames the active tips, so know who is active before drawing:
      // ask in parallel with the scan, and wait only briefly for a slow answer.
      const sessionsReady = needsInitialFit ? loadSessions() : undefined;
      const next = await graphAPI.snapshot(repo, expand, force);
      if (epoch !== topologyEpoch) return;
      if (sessionsReady) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arrived = await Promise.race([
          sessionsReady.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), SESSIONS_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
        initialFitPending = !arrived;
      }
      if (epoch !== topologyEpoch) return;
      if (next.repository?.id !== repo) return; // another repository's answer never lands on this one
      snapshot = {
        ...next,
        nodes: next.nodes ?? [],
        workspaces: next.workspaces ?? [],
      };
      reconcileScope(privacyChanged);
      const want = store.get();
      if (
        want.worktree &&
        workspace !== want.worktree &&
        (!want.project || want.project === repo)
      ) {
        const w = snapshot.workspaces.find((x) => x.id === want.worktree);
        if (w) {
          workspace = w.id;
          revision = w.revision;
          revealWorkspace(w);
          session = "";
          cursor = "";
        }
      }
      pendingRefresh = false; // only a refresh that landed clears the deferral
      store.touchResolver();
      if (workspace && selectedWorkspace())
        revision = selectedWorkspace()!.revision;
      if (workspace && !selectedWorkspace())
        status.textContent = "Selected workspace is no longer available.";
      done();
      render();
      ensureHistory();
      void refreshActivity();
    } catch {
      if (epoch === topologyEpoch) {
        if (snapshot) snapshot.stale = true;
        done();
        render();
        status.textContent = snapshot
          ? "Topology scan unavailable — last successful snapshot retained."
          : "Topology scan unavailable.";
      }
    } finally {
      done();
    }
  }
  async function loadSessions() {
    try {
      sessions = (await attention()).sessions ?? [];
    } catch {
      /* Existing shared attention strip shows connectivity. */
    }
  }
  async function refreshActivity() {
    if (hidden()) return;
    try {
      const a = await attention();
      if (hidden()) return;
      sessions = a.sessions ?? [];
      if (initialFitPending) {
        initialFitPending = false;
        computeAgents();
        if (canvas.autoActive()) canvas.fit(activeIds());
      }
      if (root.isConnected && !hidden()) {
        // The graph tab only recolors; the timeline keeps its full redraw. The
        // map follows the 15 s poll, not attention arrivals.
        if (tab === "graph") syncActivity();
        else if (tab === "timeline") render();
      }
      if (a.gaps?.length) {
        setStatus();
        status.textContent +=
          " · Capture gaps reported by attention projection";
      }
    } catch {
      /* Existing shared attention strip shows connectivity. */
    }
  }

  /**
   * The shell swaps panels by removing this root from its content area. Nothing tells
   * us, so watch the parent: once the root is gone, in-flight history is cancelled
   * (returning to the view refreshes and loads again).
   */
  let leaving: MutationObserver | undefined;
  let watched: Node | null = null;
  function watchLeaving() {
    const parent = root.parentNode;
    if (parent === watched) return;
    leaving?.disconnect();
    leaving = undefined;
    watched = parent;
    if (!parent || typeof MutationObserver === "undefined") return;
    leaving = new MutationObserver(() => {
      if (!root.isConnected) abortHistory();
    });
    leaving.observe(parent, { childList: true });
  }

  // ---- keyboard: ⌘K / Ctrl+K and "/" focus search --------------------------

  const typing = (t: EventTarget | null) => {
    const e = t as HTMLElement | null;
    return (
      !!e &&
      (e.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(e.tagName))
    );
  };
  document.addEventListener(
    "keydown",
    (e) => {
      if (!root.isConnected || !snapshot || hidden()) return;
      if (e.key === "Escape") {
        // Clear the selection from anywhere in the graph (a button in the header, the
        // inspector...), but leave fields, selects, dialogs and the More menu their own Escape.
        if (tab !== "graph" || !isEscapeEligible(e)) return;
        if (clearSelection()) {
          claimEscape(e);
          e.preventDefault();
        }
        return;
      }
      const k = e.key.toLowerCase();
      const hotkey = (e.metaKey || e.ctrlKey) && k === "k";
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !typing(e.target);
      if (!hotkey && !slash) return;
      e.preventDefault();
      if (tab !== "graph") {
        switchTab("graph");
        render();
      }
      toolbar.focusSearch();
    },
    true,
  );
  window.addEventListener("focus", () => {
    if (root.isConnected && !busy && !hidden()) void refresh(true);
  });
  setInterval(() => {
    if (root.isConnected && !busy && !hidden()) void refresh(true);
  }, 15000);
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    root,
    refresh: () => (hidden() ? Promise.resolve() : refresh()),
    /** Hosted only: Project shows the graph in one of its two encodings. */
    show(view: GraphView) {
      if (!hosted) return;
      const wasShown = shown;
      shown = true;
      tab = view === "events" ? "timeline" : "graph";
      // Events missed while hidden were not merged: restart pagination at the head so
      // "Load older" walks contiguously from there.
      if (missedWhileHidden > 0 || (!wasShown && cursor)) {
        cursor = "";
        hasMore = false;
      }
      if (!wasShown || pendingRefresh || !snapshot) void refresh();
      else {
        render();
        void loadHistory();
      }
    },
    hide() {
      if (!hosted || !shown) return;
      shown = false;
      navGen++;
      // A refresh still in flight must not carry on fetching for a hidden encoding; show() restarts it.
      if (busy) pendingRefresh = true;
      ++topologyEpoch;
      busy = false;
      abortHistory();
      tab = "graph";
      workspace = "";
      revision = "";
      session = "";
      toolbar.closeMenu();
    },
    setWorktreeOrder(ids: readonly string[] | undefined) {
      worktreeOrder = ids;
      if (!shown || !snapshot) return;
      if (tab === "timeline") render();
      else toolbar.refreshOpenResults();
    },
    /** Hosted: called with 'graph' | 'events' whenever the graph switches views itself. */
    onView(fn: (v: GraphView) => void) {
      viewListener = fn;
    },
    currentRepo: () => repo,
    registeredRepos: () => repos.map((r) => r.id),
    onEvent: (e: FirehoseEvent) => {
      if (hidden()) {
        missedWhileHidden++;
        return;
      }
      if (timeline.merge([e]).older) olderEvicted();
      if (tab === "timeline" && root.isConnected) render();
      if (!activityTimer)
        activityTimer = setTimeout(() => {
          activityTimer = undefined;
          // Live events are merged above; only the attention state is refreshed. History
          // is never fetched in response to events.
          if (root.isConnected && !hidden()) void refreshActivity();
        }, 500);
    },
  };
}
