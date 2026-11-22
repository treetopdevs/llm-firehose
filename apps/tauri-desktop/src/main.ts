// App shell: sidebar navigation, status bar with daemon health + schema
// compatibility, live SSE feed into FeedState, and the first-run onboarding
// overlay. The daemon (bundled as the firehosed sidecar) is the only data
// source — this UI never touches spool files.

import { CLIENT_SCHEMA_VERSION, getConfig, health, recent, sessions, stream } from "./api";
import type { FirehoseEvent } from "./api";
import { checkCompat } from "./compat";
import { createConnector } from "./connect";
import { clear, el } from "./dom";
import { FEED_RING, FeedState } from "./state";
import { renderDetail } from "./ui/detail";
import { inspectorShowing, renderInspector } from "./ui/inspector";
import type { Inspected } from "./ui/inspector";
import { createAttention } from "./ui/attention";
import { createCourt } from "./ui/court";
import { createDoctor } from "./ui/doctor";
import { createEventList } from "./ui/events";
import { liveSource } from "./ui/events/model";
import { createFiles } from "./ui/files";
import { createOnboarding, isOnboarded } from "./ui/onboarding";
import { createLoops } from "./ui/loops";
import { createScore } from "./ui/score";
import { createSession } from "./ui/session";
import type { SessionTab } from "./ui/session/context";
import type { SessionLens } from "./ui/session";
import { createHandoffs } from "./ui/handoffs";
import { createLoom } from "./ui/loom";
import { createEcosystem } from "./ui/ecosystem";
import { createReplay } from "./ui/replay";
import { createStrata } from "./ui/strata";
import { createFleet } from "./ui/fleet";
import { isHostEncoding } from "./ui/fleet/model";
import { createProject, splitGoPatch, type ProjectEncoding } from "./ui/project";
import { createSessions } from "./ui/sessions";
import { createSettings } from "./ui/settings";
import { createWorkspaceGraph } from "./ui/graph";
import { liveSpanOf, membership, scope, selectSession } from "./scope";
import { createTransport } from "./transport";
import { graphAPI } from "./ui/graph/api";
import { createActions } from "./ui/actions";
import { createRoots } from "./ui/actions/roots";
import { remapPlace, remapScope } from "./privacy-remap";
import type { IdentitySet } from "./privacy-remap";
import type { ScopePatch, SessionRef } from "./scope";
import { ascentTarget, createEscapeHandler, isEscapeEligible } from "./escape";
import { QUEUE_KEYS, registerKeys } from "./keys";
import { toggleLegend, openLegend, type PanelContext } from "./ui/legend";
import { createBreadcrumb } from "./breadcrumb";
import { applyWindowChrome, macOverlayActive } from "./window";
import { createSidebar, createToolbar, type ProjectRow, type SidebarCurrent, type SidebarTarget } from "./chrome";
import { projectName } from "./format";
import { createSessionDirectory } from "./session-directory";
import { inspectorBelongsTo, isAlias, resolveAlias } from "./nav";
import { createHistory, markOf, restoreScroll, samePlace, type Place } from "./history";
import type { CellScope } from "./ui/workspace/model";
import type { AliasName } from "./nav";

const app = document.querySelector<HTMLDivElement>("#app")!;

const feedState = new FeedState(FEED_RING);
const detailPane = el("aside", { class: "detail" });
// The call altitude pairs a tool call's start and end from the live buffer.
const siblings = (ev: FirehoseEvent) =>
  ev.call_id ? feedState.events().filter((o) => o.source === ev.source && o.session_id === ev.session_id && o.call_id === ev.call_id) : [];
const showDetail = (ev: FirehoseEvent) =>
  renderDetail(detailPane, ev, () => renderDetail(detailPane, null, () => {}), siblings, undefined, offerEvidence, sessionDirectory);

// A selection (click or arrow) fills the shared pane; nothing navigates until Open. Closing the pane drops the
// selection in the panel that made it, and each change is written into the current history entry (MS-8).
const inspectFor = (clear: () => void) => (s: Inspected | null): void => {
  if (!s && !inspectorShowing(detailPane)) return;
  const close = () => {
    // The Close button is about to leave the DOM: hand focus back to the row the pane described.
    const sel = content.querySelector<HTMLElement>(".selected, .picked");
    const target = sel?.matches("[tabindex]") ? sel : sel?.querySelector<HTMLElement>('[tabindex="0"]');
    const held = detailPane.contains(document.activeElement);
    clear();
    if (held) target?.focus();
  };
  renderInspector(detailPane, s, { onClose: close, menu: actions });
  rememberSelection();
};
/** Writes the selection into the current history entry right away, so a move made a moment later still returns to it. */
function rememberSelection(): void {
  const cur = places.current();
  if (!cur || cur.place.panel !== active) return;
  const { sel: _gone, at: _at, ...rest } = cur.state;
  places.record(cur.place, { ...rest, ...selectionState() });
}
/** The panel whose rows a selection lives in: Fleet's list, or the Worktree list (its own panel, or Project's Sessions view). */
const selectionPanelFor = (name: string) =>
  name === "fleet" ? fleetPanel : name === "sessions" || (name === "project" && projectPanel.encoding() === "sessions") ? sessionsPanel : undefined;
/** The selected row of the panel being shown, if it has one. */
const selectedKeyHere = (): string | undefined => selectionPanelFor(active)?.selectedKey();
/** The shown panel's drawn rows, when it has any: a selection's place in the list is counted among what is on screen. */
const visibleHere = (): string[] => selectionPanelFor(active)?.visibleKeys() ?? [];
/** What a history entry keeps of the selection: its key and its place in the list. */
function selectionState(): { sel?: string; at?: number } {
  const sel = selectedKeyHere();
  if (!sel) return {};
  const at = visibleHere().indexOf(sel);
  return at >= 0 ? { sel, at } : { sel };
}

const refOf = (id: string, source?: string): SessionRef => (source === undefined ? { id } : { id, source });

// Score, Loops, Loom, Replay, Handoffs and Court are tabs of the Session altitude.
// Openers record the session in scope, then show the Session altitude on a tab.
function openScore(id: string, source?: string) {
  selectSession(scope, refOf(id, source));
  show("session", { tab: "score" });
}

function offerEvidence(id: string) {
  renderDetail(detailPane, null, () => {});
  show("session", { tab: "court" });
  (sessionPanel.lens("court") as SessionLens & { offerEvent(id: string): void }).offerEvent(id);
}

function openLoops(id: string, source?: string) {
  selectSession(scope, refOf(id, source));
  show("session", { tab: "loops" });
}

// The one place sessions are named: /sessions and /attention feed it, the lens head and crumb read it.
const sessionDirectory = createSessionDirectory(() => sessions());
// Bumped on every real panel change and every scope change. A delayed inspection (Attention's
// evidence fetch) is dropped unless it was started in the current generation.
let navGeneration = 0;
scope.subscribe(() => {
  navGeneration++;
});
// Attention's evidence fetch resolves later: remember the generation at click time (capture phase,
// before the panel's own handler) and drop the pane if the user has navigated since.
let inspectClickGeneration = navGeneration;
const showInspected = (ev: FirehoseEvent): void => {
  if (inspectClickGeneration === navGeneration) showDetail(ev);
};
const attentionPanel=createAttention({onSelect:showInspected,onOpenSession:openSessionAltitude,onDoctor:()=>show("doctor"),onOpenInbox:()=>go("attention"),onSessions:(l)=>sessionDirectory.remember(l),labels:{worktree:(id,repoId)=>id?scope.resolver()?.labels({...scope.get(),project:repoId,worktree:id}).worktree:undefined,project:(id)=>id?scope.resolver()?.labels({...scope.get(),project:id,worktree:undefined}).project:undefined}});
attentionPanel.setConnected(false);
attentionPanel.root.addEventListener("click", (e) => {
  // Only an Inspect click starts an inspection; Working, Snooze and the rest must not revalidate a stale one.
  if ((e.target as Element | null)?.closest?.('[data-key^="inspect:"]')) inspectClickGeneration = navGeneration;
}, true);
const sessionsPanel = createSessions(showDetail, () => feedState.events(), openScore, openLoops, scope, sessionDirectory, (ref) => selectSession(scope, ref), { inbox: attentionPanel, inspect: inspectFor(() => sessionsPanel.clearSelection()) });

// Opening a session from elsewhere keeps the project/worktree parents only
// when the graph resolver says the session belongs to them; otherwise the
// context is replaced.
function openSession(id: string, source?: string) {
  const cur = scope.get();
  const ref = refOf(id, source);
  const member = cur.project || cur.worktree ? membership(scope, cur) : undefined;
  if (member?.(ref)) go("sessions", { session: ref, cell: undefined });
  else go("sessions", { session: ref }, true);
  void sessionsPanel.openSession(id, source);
}

// Attention's "Session history": same membership rule as openSession, but the
// destination is the Session altitude.
function openSessionAltitude(id: string, source?: string, tab: SessionTab = "score") {
  const cur = scope.get();
  const ref = refOf(id, source);
  const member = cur.project || cur.worktree ? membership(scope, cur) : undefined;
  if (member?.(ref)) go("session", { session: ref, cell: undefined }, false, tab);
  else go("session", { session: ref }, true, tab);
}

const workspacePanel = createWorkspaceGraph(openSession, scope, { hosted: true });

// One roots store and one actions controller for the whole shell, independent of
// the Graph panel: Fleet and Project read raw repo labels from here, so Register
// and Prune are correct before the Graph panel is ever opened.
const roots = createRoots({ repos: () => graphAPI.repos() });
const actions = createActions({
  registerRoot: async (path) => {
    await graphAPI.register(path, "");
    await roots.refresh();
    void workspacePanel.refresh();
  },
  onChanged: () => {
    void roots.refresh();
    void fleetPanel.refresh();
    void projectPanel.refresh();
  },
});
void roots.refresh();
// A roots refresh can rename a project without any scope change: redraw every name drawn from the resolver.
roots.subscribe(() => scope.touchResolver());
scope.onResolver(() => attentionPanel.redraw());

// Altitudes (D94-D98): Fleet > Project > Worktree (sessions) > Session (score).
// The nav is those four plus Files, Doctor and Settings; the retired lens names
// (live, attention, strata, ecosystem, workspace) are aliases (see nav.ts).
// The old fleet panels are encodings inside Fleet. Launch lands on Fleet (All projects, MS-8) and
// never moves afterwards. The attention strip is visible at every altitude.
let fleetLabels: Record<string, string> = {};
// Privacy mode for the Map encoding's names; refreshed whenever Project reloads rows.
let privacyMode: string | undefined;
const loadPrivacyMode = (): void => {
  void getConfig().then((c) => { privacyMode = c.privacy_mode; }, () => {});
};
loadPrivacyMode();
const projectPanel = createProject({
  store: scope,
  graph: workspacePanel,
  worktreeOrder: (repo) => fleetPanel.forkOrder(repo),
  privacyMode: () => privacyMode,
  actions,
  roots,
  go: (name, patch): void => {
    go(name, patch);
  },
  onRows: () => {
    loadPrivacyMode();
  },
  projectLabel: (id) => fleetLabels[id],
  onEncoding: () => syncTransport(),
  // The Sessions chip (MS-9) shows the Worktree list in place. Leaving closes the pane its selection filled but keeps the selection for the history entry (clearing it would erase that); the next activate() starts a visit clean.
  sessions: { root: sessionsPanel.root, activate: () => sessionsPanel.activate({ needsOnly: false }), deactivate: () => { if (inspectorShowing(detailPane)) renderDetail(detailPane, null, () => {}); } },
});
projectPanel.setConnected(false);
// The lens panels Fleet hosts as its Strata and Patches encodings.
const strataPanel = createStrata(openLoops, openScore, sessionDirectory);
const ecosystemPanel = createEcosystem(openScore);
// Fleet Events honours a retained historical window like Project Events does; live follows the whole ring.
const feedPanel = createEventList(liveSource(feedState, { renderLimit: 1000 }), {
  onSelect: showDetail,
  heading: false,
  window: () => {
    const w = scope.get().window;
    return w === "live" ? undefined : { from: w.from, to: w.to };
  },
  resetWindow: () => scope.narrow({ window: "live" }),
});
const fleetPanel = createFleet({
  store: scope,
  actions,
  roots,
  inspect: inspectFor(() => fleetPanel.clearSelection()),
  go: (name, patch): void => {
    go(name, patch);
  },
  events: () => feedState.events(),
  directory: sessionDirectory,
  onLabels: (labels) => {
    fleetLabels = labels;
  },
  onEncoding: () => syncTransport(),
  hosts: {
    events: { root: feedPanel.root, activate: () => feedPanel.activate(), deactivate: () => {} },
    strata: strataPanel,
    ecosystem: { root: ecosystemPanel.root, activate: () => { renderDetail(detailPane, null, () => {}); return ecosystemPanel.refresh(); }, deactivate: () => ecosystemPanel.deactivate() },
  },
});
fleetPanel.setConnected(false);
// The score replays one finished session, so its detail pairs calls from
// that session's history rather than the live buffer.
const makeScore = () => createScore((ev, sessionSiblings, signature, dismiss) =>
  renderDetail(
    detailPane,
    ev,
    () => {
      dismiss();
      renderDetail(detailPane, null, () => {});
    },
    sessionSiblings,
    signature,
    offerEvidence,
    sessionDirectory,
  ),
  scope,
);
// A host that owns subscriptions brings its own deactivate; the rest re-run refresh to settle.
const adapt = (p: { root: HTMLElement; refresh(): unknown; deactivate?(): unknown }) => ({ root: p.root, refresh: p.refresh, deactivate: p.deactivate ?? p.refresh });
const sessionPanel = createSession({
  store: scope,
  directory: sessionDirectory,
  lenses: {
    // Factories: each lens is built on first entry (or via sessionPanel.lens), not at boot.
    score: makeScore,
    loops: () => createLoops(scope, sessionDirectory),
    loom: () => createLoom(openScore),
    replay: () => createReplay(openScore, sessionDirectory),
    handoffs: () => adapt(createHandoffs(openScore, () => feedState.events(), undefined, sessionDirectory)),
    court: () => {
      const court = createCourt(openScore);
      return { ...adapt(court), offerEvent: court.offerEvent };
    },
  },
  onTabShown: (tab) => {
    if (tab === "loom" || tab === "court" || tab === "handoffs" || tab === "replay") renderDetail(detailPane, null, () => {});
    recordPlace();
  },
});
const panels = {
  fleet: fleetPanel,
  project: projectPanel,
  sessions: sessionsPanel,
  session: sessionPanel,
  files: createFiles(sessionDirectory),
  doctor: createDoctor({
    issues: () => attentionPanel.captureIssues(),
    onInspectWarning: (id) => void attentionPanel.inspectWarning(id),
    onInspectGap: (gap) => attentionPanel.inspectGap(gap),
  }),
  settings: createSettings({ onPrivacySaving: () => snapshotBeforeSave(), onPrivacyChanged: (_mode, before) => handlePrivacyChange(before as IdentitySet | undefined) }),
} as const;

type PanelName = keyof typeof panels;
type GoName = PanelName | "score" | "loops" | AliasName;

// --- privacy-mode change: the shell is the single scope writer -------------------------------------------------
// Repository ids change with the mode (service.go identity()) while labels stay raw. After a verified
// roots snapshot, the project is remapped by unique raw label+vcs (see privacy-remap.ts); worktree and
// session are always cleared and the window is preserved. Panels refresh only after the one narrow.
const shellNote = el("p", { class: "shell-note dim", role: "status" });
shellNote.hidden = true;
const showShellNote = (text: string): void => {
  shellNote.textContent = text;
  shellNote.hidden = false;
};
// Cleared on the next scope change; the privacy narrow itself fires before the note is set.
scope.subscribe(() => {
  if (!shellNote.hidden) {
    shellNote.textContent = "";
    shellNote.hidden = true;
  }
});
const REMAP_ATTEMPTS = 4;
const REMAP_RETRY_MS = 150;
let privacyGeneration = 0;
const identitySet = (repos: { id: string; label: string; vcs?: string }[]): IdentitySet => ({
  repos: repos.map((r) => ({ id: r.id, label: r.label, vcs: r.vcs ?? "" })),
});

// Taken when the save STARTS: a roots refresh landing while POST /config is pending already carries new ids.
const snapshotBeforeSave = (): IdentitySet => identitySet(roots.loaded() ? roots.list() : []);
// One bounded attempt: the first applied roots snapshot (this call's or a newer refresh's) wins; a hung
// request or a failure resolves undefined so the caller retries. Late responses are ignored.
const REMAP_REFRESH_TIMEOUT_MS = 1200;
function verifiedRoots(): Promise<IdentitySet | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: IdentitySet | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(v);
    };
    const unsub = roots.subscribe(() => finish(identitySet(roots.list())));
    const timer = setTimeout(() => finish(undefined), REMAP_REFRESH_TIMEOUT_MS);
    roots.refresh().then((r) => finish(r.ok ? identitySet(r.repos) : undefined), () => finish(undefined));
  });
}

async function handlePrivacyChange(before: IdentitySet = snapshotBeforeSave()): Promise<void> {
  const mine = ++privacyGeneration;
  let after: IdentitySet | undefined;
  for (let attempt = 0; attempt < REMAP_ATTEMPTS && !after; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, REMAP_RETRY_MS * attempt));
    if (mine !== privacyGeneration) return; // a newer privacy change owns the remap
    after = await verifiedRoots();
  }
  if (mine !== privacyGeneration) return;
  const current = scope.get();
  const result = after
    ? remapScope(current, before, after)
    : current.project || current.worktree || current.session
      ? { kind: "cleared" as const, note: "Privacy mode changed: project identities could not be verified, so the selection was cleared." }
      : { kind: "unchanged" as const };
  if (result.kind === "remapped") scope.narrow(result.patch);
  else if (result.kind === "cleared") scope.narrow({ project: undefined, worktree: undefined, session: undefined, window: current.window });
  if (result.kind !== "unchanged") showShellNote(result.note);
  // Back and Forward must not return to a place that names an identity the new mode no longer has.
  places.rewrite((p) => remapPlace(p, before, after));
  here = places.current()?.place ?? here;
  // Panels re-read only after the scope is settled.
  void projectPanel.refresh();
  void workspacePanel.refresh();
}

const content = el("main", { class: "content" });
const compatBanner = el("div", { class: "compat-banner" });

let active: PanelName = "fleet";
/** The load the last show() started; a restore waits for it, because the rows on screen may be the previous visit's. */
let activation: Promise<unknown> = Promise.resolve();
/** The Worktree panel opened as the Needs you queue: the sidebar item, not a level, owns that view. */
const needsView = (): boolean => active === "sessions" && sessionsPanel.needsOnly();
/** Toolbar titles: the place the window is showing. Worktree and Session are reached by opening one, not from the sidebar. */
export const PANEL_TITLES: Record<PanelName, string> = {
  fleet: "All projects",
  project: "Project",
  sessions: "Worktree",
  session: "Session",
  files: "Files",
  doctor: "Doctor",
  settings: "Settings",
};

/** Panels that read scope.window; the shell transport is shown only over these. */
export const TRANSPORT_PANELS: ReadonlySet<string> = new Set(["project", "fleet", "session"]);
// Fleet knows its own default live span; every other panel reads the user's preference.
const transport = createTransport({
  store: scope,
  effectiveLiveSpan: () => (active === "fleet" ? fleetPanel.effectiveLiveSpan() : liveSpanOf(scope.get())),
  sessionSpan: (ref) => {
    const s = sessionDirectory.lookup(ref);
    const t = (v: string | undefined): number | undefined => {
      const n = v ? Date.parse(v) : NaN;
      return Number.isFinite(n) ? n : undefined;
    };
    return s ? { from: t(s.first_time), to: t(s.last_time) } : undefined;
  },
});
// A session named late (the directory fills from /sessions and /attention) can change whether the range covers it.
sessionDirectory.subscribe(() => transport.refresh());

/** Whether the shell transport is shown: scope-window panels, minus Fleet's host encodings (Events, Strata, Patches). */
const transportShown = (): boolean => TRANSPORT_PANELS.has(active) && !(active === "fleet" && isHostEncoding(fleetPanel.encoding));
function syncTransport(): void {
  transport.setApplies(transportShown());
  transport.refresh();
  // Every show() and every encoding switch passes through here.
  recordPlace();
}

/** Narrows (or, with replace, replaces) the shared scope, then shows the panel. */
export function go(name: GoName, rawPatch?: ScopePatch & { encoding?: ProjectEncoding }, replace = false, tab?: SessionTab) {
  const { scopePatch: patch, encoding: patchEncoding } = splitGoPatch(rawPatch);
  if (patch) {
    if (replace) scope.replaceContext(patch as ScopePatch);
    else scope.narrow(patch as ScopePatch);
  }
  const encoding = patchEncoding;
  if (isAlias(name)) {
    const land = resolveAlias(name, scope.get(), (id) => projectPanel.registered(id));
    // Only an explicit alias landing on Fleet selects its encoding; ascent never writes it.
    if (land.fleetEncoding) fleetPanel.encoding = land.fleetEncoding;
    // The strip and the alias are the same entry as the Worktree nav button: no stale Fleet retrace.
    const o = { ...(land.encoding ? { encoding: land.encoding as ProjectEncoding } : {}), ...(land.needsOnly ? { needsOnly: true } : {}) };
    show(land.panel, Object.keys(o).length > 0 ? o : undefined);
    return;
  }
  if (name === "score" || name === "loops") show("session", { tab: name });
  else show(name, tab || encoding ? { ...(tab ? { tab } : {}), ...(encoding ? { encoding } : {}) } : undefined);
}

function show(name: PanelName, opts?: { tab?: SessionTab; encoding?: ProjectEncoding; needsOnly?: boolean }) {
  // All projects reads the range, not a session. A session left for it by the sidebar (which writes no scope) must
  // give the held range back, or the session's own zoom would be drawn over every project (MS-7). A session installed
  // whole (scope.set) holds no range and keeps what it was given.
  if (name === "fleet" && scope.get().session && scope.held() !== undefined) scope.narrow({ session: undefined });
  // An open menu, a pending confirmation or an in-flight action belongs to the panel that started it.
  if (name !== active) actions.cancelAll();
  // Registration can happen elsewhere (Workspace toolbar): re-read roots on arrival.
  if ((name === "fleet" || name === "project") && name !== active) void roots.refresh();
  if (active === "project" && name !== "project") projectPanel.deactivate();
  if (active === "fleet" && name !== "fleet") fleetPanel.deactivate();
  // Only a real panel change closes the shared pane, and not on the panel the inspector belongs to.
  if (name !== active) navGeneration++;
  // An event detail may follow into the Session altitude; a selection's inspector never leaves its panel.
  if (name !== active && (!inspectorBelongsTo(name) || inspectorShowing(detailPane))) renderDetail(detailPane, null, () => {});
  if (active === "session" && name !== "session") sessionPanel.deactivate();
  if (active === "files" && name !== "files") panels.files.deactivate();
  active = name;
  transport.setPanel(name);
  clear(content);
  content.append(panels[name].root);
  content.dataset.panel = name;
  hostViews();
  activation = Promise.resolve();
  if (name === "fleet") activation = fleetPanel.activate();
  else if (name === "project") activation = projectPanel.activate(opts?.encoding ? { encoding: opts.encoding } : undefined);
  else if (name === "sessions") activation = sessionsPanel.activate({ needsOnly: !!opts?.needsOnly });
  else if (name === "session") sessionPanel.activate(opts?.tab);
  else panels[name].refresh();
  activation.catch(() => {});
  // After the panel has taken its mode (Needs you is the Worktree panel's own state).
  syncChrome();
  syncTransport();
}

// --- places: back, forward, scroll memory and focus hand-off (MS-8) ------------------------------------------
// A place is the panel, its view and what is in scope. Every show(), view switch and scope change
// asks for a record; they are coalesced so one user move is one entry. The range is not part of a
// place, so changing it never adds an entry and going back never changes it.
// `sel` is the selected row's key and `at` its place in the list when it was recorded: a key that is gone
// comes back as the row now at that place.
const places = createHistory<{ cell?: CellScope; sel?: string; at?: number }>();
let here: Place | undefined;
let travelling = false;
let recordQueued = false;
let cancelScrollRestore: () => void = () => {};
// While a scroll restore is pending the content is still short or just cleared: the scroll events that reports
// belong to the clearing, not to the user, and must not overwrite the place's stored marks.
let restoringScroll = false;
const viewOf = (): string | undefined =>
  active === "fleet" ? fleetPanel.encoding : active === "project" ? projectPanel.encoding() : active === "session" ? sessionPanel.tab() : active === "sessions" && sessionsPanel.needsOnly() ? "needs" : undefined;
function placeNow(): Place {
  const sc = scope.get();
  return { panel: active, view: viewOf(), project: sc.project, worktree: sc.worktree, session: sc.session };
}
/** Focus must never be left on <body> or on a node the move removed: the new view's heading takes it. */
function handFocus(): void {
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const target = content.querySelector<HTMLElement>("h2") ?? (content.firstElementChild as HTMLElement | null);
  if (!target) return;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
function recordPlace(): void {
  if (recordQueued) return;
  recordQueued = true;
  queueMicrotask(() => {
    recordQueued = false;
    const place = placeNow();
    const first = here === undefined;
    const moved = !here || !samePlace(here, place);
    const cell = scope.get().cell;
    places.record(place, { ...(cell ? { cell } : {}), ...selectionState() });
    travelling = false;
    here = place;
    syncHistory();
    if (!moved || first) return;
    cancelScrollRestore();
    restoringScroll = false;
    const marks = places.recall(place);
    if (marks) {
      restoringScroll = true;
      cancelScrollRestore = restoreScroll(content, marks, { done: () => { restoringScroll = false; } });
    } else cancelScrollRestore = () => {};
    handFocus();
  });
}
/** A row of the shown panel by its key, and the node a keyboard user lands on in it. */
function focusKey(key: string): void {
  // Fleet draws a worktree under a different attribute than it selects by.
  if (selectionPanelFor(active) === fleetPanel) return fleetPanel.focusKey(key);
  const node = [...content.querySelectorAll("[data-key]")].find((n) => n.getAttribute("data-key") === key);
  const target = node?.matches("[tabindex]") ? node : node?.querySelector('[tabindex="0"]');
  (target as HTMLElement | null | undefined)?.focus({ preventScroll: true });
}
let cancelSelectionRestore: () => void = () => {};
/**
 * The selection comes back by key once its row is drawn. A key that is gone falls to the row now at its old
 * place, and focus goes to that row. Rows load after the panel is shown, so this retries for a short while;
 * a click or another selection of the user's own ends it.
 */
function restoreSelection(name: PanelName, sel: string | undefined, at: number | undefined, frames = 90): void {
  cancelSelectionRestore();
  const panel = selectionPanelFor(name);
  if (!panel || sel === undefined) return;
  let cancelled = false;
  let left = frames;
  const end = (): void => {
    cancelled = true;
    content.removeEventListener("pointerdown", end, true);
  };
  /** The key this restore last selected: a different selection afterwards is the user's own, and ends it. */
  let ours: string | undefined;
  /** True once a row is selected. */
  const attempt = (): boolean => {
    // A redraw that dropped our pick (its row is gone) leaves nothing selected; a different row is the user's own choice.
    const cur = panel.selectedKey();
    if (ours !== undefined && cur !== undefined && cur !== ours) { end(); return true; }
    // The exact key may be a worktree behind a collapsed row (it is then revealed); only the fallback is by what is drawn,
    // so a project is never opened because another row disappeared.
    const keys = panel.visibleKeys();
    const pick = panel.selectableKeys().includes(sel) ? sel : keys.length > 0 ? keys[Math.min(Math.max(at ?? 0, 0), keys.length - 1)] : undefined;
    if (pick === undefined) return false;
    if (panel.selectedKey() !== pick) panel.selectKey(pick);
    ours = panel.selectedKey();
    focusKey(pick);
    return true;
  };
  const poll = (): void => {
    if (cancelled) return;
    if (active !== name) return end();
    if (!attempt() && left-- > 0) requestAnimationFrame(poll);
    else if (left < 0) end();
  };
  content.addEventListener("pointerdown", end, true);
  cancelSelectionRestore = end;
  // Rows already on screen may be the last visit's: take them now, and again once this visit's load has settled.
  const settled = activation;
  poll();
  const again = (): void => {
    if (cancelled || active !== name) return;
    if (!attempt()) poll();
    else end();
  };
  settled.then(again, again);
}
/** Back or forward one place. False when there is nowhere to go. */
function travel(dir: "back" | "forward"): boolean {
  const entry = dir === "back" ? places.back() : places.forward();
  if (!entry) return false;
  travelling = true;
  const p = entry.place;
  scope.replaceContext({ project: p.project, worktree: p.worktree, session: p.session, cell: entry.state.cell });
  if (p.panel === "fleet" && p.view) fleetPanel.encoding = p.view as typeof fleetPanel.encoding;
  const name = p.panel as PanelName;
  show(
    name,
    name === "session" && p.view
      ? { tab: p.view as SessionTab }
      : name === "project" && p.view
        ? { encoding: p.view as ProjectEncoding }
        : name === "sessions"
          ? { needsOnly: p.view === "needs" }
          : undefined,
  );
  // The Worktree panel shows a session's history only once it has been told to open it; a place that has a session
  // in scope there (Back into an opened session) brings that history back, as the list's own Open does.
  if (name === "sessions" && p.session) void sessionsPanel.openSession(p.session.id, p.worktree ? p.session.source : undefined);
  restoreSelection(name, entry.state.sel, entry.state.at);
  syncHistory();
  return true;
}
scope.subscribe(() => recordPlace());
// Scroll events do not bubble; capture sees every scroller inside the content area.
content.addEventListener(
  "scroll",
  (e) => {
    if (!here || travelling || restoringScroll || !(e.target instanceof Element)) return;
    const el = e.target;
    const kept = (places.recall(here) ?? []).filter((m) => (m.sel ? content.querySelector(m.sel) : content) !== el);
    const mark = markOf(content, el);
    places.remember(here, mark ? [...kept, mark] : kept);
  },
  true,
);

const SCOPE_PANELS: ReadonlySet<string> = new Set(["sessions", "session", "project", "fleet"]);
const ascendOnEscape = createEscapeHandler({
  store: scope,
  // Only the Score and Loops tabs are scope lenses; the notebook tabs own Escape.
  activePanel: () => (active === "session" && !sessionPanel.escapes() ? "session-nonscope" : active),
  scopePanels: SCOPE_PANELS,
  afterAscend: (alt, from, prev) => {
    const target = ascentTarget(prev, alt, from, sessionsPanel.hasWorktreeList());
    if (target !== "stay") show(target);
    else if (from === "sessions" || (from === "project" && projectPanel.encoding() === "sessions")) void sessionsPanel.refresh();
  },
});
/** The panel and encoding the legend scopes its key lists to. */
function legendContext(): PanelContext {
  if (active === "fleet") return { panel: active, encoding: fleetPanel.encoding };
  if (active === "project") return { panel: active, encoding: projectPanel.encoding() };
  if (active === "session") return { panel: active, tab: sessionPanel.tab() };
  return { panel: active };
}

/** A dialog (legend, prune confirmation, onboarding) owns the keyboard while it is open. */
const dialogOpen = (): boolean => document.querySelector('[aria-modal="true"], .action-dialog, .onboarding-overlay') !== null;
const navEnabled = (): boolean => app.isConnected && !dialogOpen();

registerKeys([
  {
    scope: "global",
    keys: ["["],
    display: "⌘[",
    label: "go back to the previous place",
    // A shell that is no longer mounted must not answer for the one that is.
    enabled: navEnabled,
    modifiers: "any",
    handler: (e) => {
      if (!e.metaKey || !travel("back")) return false;
      e.preventDefault();
    },
  },
  {
    scope: "global",
    keys: ["]"],
    display: "⌘]",
    label: "go forward again",
    // A shell that is no longer mounted must not answer for the one that is.
    enabled: navEnabled,
    modifiers: "any",
    handler: (e) => {
      if (!e.metaKey || !travel("forward")) return false;
      e.preventDefault();
    },
  },
  {
    scope: "global",
    keys: ["s", "S"],
    display: "⌃⌘S",
    label: "show or hide the sidebar",
    enabled: navEnabled,
    modifiers: "any",
    handler: (e) => {
      if (!e.metaKey || !e.ctrlKey) return false;
      e.preventDefault();
      toggleSidebar();
    },
  },
  {
    scope: "global",
    keys: [","],
    display: "⌘,",
    label: "open Settings",
    enabled: navEnabled,
    modifiers: "any",
    handler: (e) => {
      if (!e.metaKey) return false;
      e.preventDefault();
      show("settings");
    },
  },
  {
    scope: "global",
    ...QUEUE_KEYS.escape,
    label: "go up one level (clear a selection, then leave the view)",
    modifiers: "any",
    handler: (e) => {
      // The narrow-window sidebar overlay is the topmost thing: Escape dismisses it before anything else.
      if (overlayOpen() && isEscapeEligible(e)) {
        e.preventDefault();
        closeOverlay();
        return;
      }
      ascendOnEscape(e);
    },
  },
  {
    scope: "global",
    ...QUEUE_KEYS.legend,
    label: "show keys and symbols",
    enabled: () => app.isConnected,
    handler: () => {
      toggleLegend({ opener: document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : undefined, fallbackFocus: legendOpener(), context: legendContext });
    },
  },
]);

// --- chrome: sidebar (where), toolbar (history, title, view, range) ------------------------------------------
const crumb = createBreadcrumb(scope, { directory: sessionDirectory });

function selectSidebar(t: SidebarTarget): void {
  // Under 900px the sidebar is an overlay: choosing a place dismisses it.
  if (sidebarMode === "shown" && narrowQuery?.matches) {
    sidebarMode = "auto";
    applySidebar();
  }
  switch (t.kind) {
    case "needs": go("attention"); break;
    case "fleet": show("fleet"); break;
    case "project": go("project", { project: t.id }, true); break;
    case "files": show("files"); break;
    case "doctor": show("doctor"); break;
    case "settings": show("settings"); break;
  }
}
const legendOpener = (): HTMLElement | undefined => document.querySelector<HTMLElement>(".legend-btn") ?? undefined;
const sidebar = createSidebar({
  onSelect: selectSidebar,
  onLegend: () => {
    const opener = legendOpener();
    openLegend({ opener, fallbackFocus: opener, context: legendContext });
  },
});

// Sidebar visibility: automatic by window width (under 900px it collapses behind the toolbar toggle),
// overridden by the toggle.
type SidebarMode = "auto" | "shown" | "hidden";
let sidebarMode: SidebarMode = "auto";
const narrowQuery = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 899px)") : undefined;
const sidebarShown = (): boolean => sidebarMode === "shown" || (sidebarMode === "auto" && !narrowQuery?.matches);
function applySidebar(): void {
  shell.dataset.sidebar = sidebarMode;
  shell.dataset.sidebarVisible = String(sidebarShown());
  toolbar.setSidebarShown(sidebarShown());
}
const overlayOpen = (): boolean => sidebarMode === "shown" && !!narrowQuery?.matches;
function closeOverlay(): void {
  sidebarMode = "auto";
  applySidebar();
}
function toggleSidebar(): void {
  sidebarMode = sidebarShown() ? "hidden" : "shown";
  applySidebar();
}
const toolbar = createToolbar({
  onBack: () => {
    travel("back");
  },
  onForward: () => {
    travel("forward");
  },
  onToggleSidebar: toggleSidebar,
});
toolbar.crumbSlot.append(el("span", { class: "scope-crumb dim" }, crumb.root));
toolbar.rangeSlot.append(transport.root);
// The Needs you toggle inside the Worktree panel changes the view without a show(): keep the chrome and history in step.
content.addEventListener("click", (e) => {
  if (!(e.target as Element | null)?.closest?.(".sessions-needs")) return;
  queueMicrotask(() => {
    syncChrome();
    recordPlace();
  });
});
const stage = el("div", { class: "stage" }, toolbar.root, shellNote, el("div", { class: "layout" }, content, detailPane));
// Under 900px the open sidebar covers its own toggle: a click outside it closes it.
const sidebarScrim = el("div", { class: "sidebar-scrim", "aria-hidden": "true" });
sidebarScrim.addEventListener("click", closeOverlay);
const shell = el("div", { class: "shell", "data-sidebar": "auto" }, sidebar.root, sidebarScrim, stage);
narrowQuery?.addEventListener?.("change", applySidebar);
applySidebar();
applyWindowChrome(shell, toolbar.root, sidebar.root, macOverlayActive(window, navigator.userAgent));
app.append(compatBanner, shell, actions.root);

function syncHistory(): void {
  toolbar.setHistory(places.canBack(), places.canForward());
}

// The panel's own view switcher (Fleet encodings, Project chips, Session tabs) is hosted in the toolbar:
// one control for "what", moved back into its panel when another panel is shown.
let hosted: { node: HTMLElement; parent: Node; next: Node | null } | undefined;
function hostViews(): void {
  if (hosted) {
    const { node, parent, next } = hosted;
    parent.insertBefore(node, next && next.parentNode === parent ? next : null);
    hosted = undefined;
  }
  const node = panels[active].root.querySelector<HTMLElement>(".fleet-views, .project-chips, .session-views");
  if (!node?.parentNode) return;
  hosted = { node, parent: node.parentNode, next: node.nextSibling };
  toolbar.viewSlot.append(node);
}

// Sidebar rows: projects from the roots store, per-project counts from the attention poll that already runs.
let projectKey = "";
let projectIds = new Set<string>();
function syncSidebar(): void {
  const counts = attentionPanel.byProject();
  const rows: ProjectRow[] = roots
    .list()
    .filter((r) => !roots.view?.(r.id))
    .map((r) => {
      let resolved: string | undefined;
      try {
        resolved = scope.resolver()?.labels({ ...scope.get(), project: r.id, worktree: undefined }).project;
      } catch {
        resolved = undefined;
      }
      const c = counts.get(r.id);
      return { id: r.id, label: projectName(r.id, resolved || roots.rawLabel(r.id)).label, needs: c?.needs ?? 0, active: c?.active ?? 0 };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  projectIds = new Set(rows.map((r) => r.id));
  const key = JSON.stringify(rows);
  if (key !== projectKey) {
    projectKey = key;
    sidebar.setProjects(rows);
  }
  sidebar.setProjectCount(rows.length);
  sidebar.setNeeds(attentionPanel.count());
  sidebar.setWarnings(attentionPanel.warnings());
  syncChrome();
}
function currentItem(): SidebarCurrent {
  if (active === "files" || active === "doctor" || active === "settings") return active;
  if (needsView()) return "needs";
  const project = scope.get().project;
  if (active !== "fleet" && project !== undefined && projectIds.has(project)) return { project };
  return "fleet";
}
function syncChrome(): void {
  sidebar.setCurrent(currentItem());
  toolbar.setPlace(needsView() ? "Needs you" : PANEL_TITLES[active]);
  // With something in scope the crumb is the title; the level word stays for assistive tech.
  const sc = scope.get();
  const scoped = active === "project" || active === "sessions" || active === "session";
  toolbar.setNamed(scoped && !needsView() && !!(sc.project || sc.worktree || sc.session));
}
roots.subscribe(syncSidebar);
scope.onResolver(syncSidebar);
scope.subscribe(() => syncChrome());
attentionPanel.onCount(syncSidebar);
// Capture warnings are Doctor's: it redraws them from each snapshot while it is on screen. Inspecting one starts an
// inspection like Needs you's Inspect does, so a delayed fetch is dropped once the user has moved on.
attentionPanel.onCount(() => { if (active === "doctor") panels.doctor.redraw(); });
panels.doctor.root.addEventListener("click", (e) => {
  if ((e.target as Element | null)?.closest?.('[data-key^="warning:"], [data-key^="gap:"]')) inspectClickGeneration = navGeneration;
}, true);
syncSidebar();

// --- live data -------------------------------------------------------------

let received = 0;
let renderQueued = false;

function onEvent(ev: FirehoseEvent) {
  feedState.push(ev);
  received++;
  sidebar.setEventCount(`${received.toLocaleString()} events`);
  projectPanel.onEvent(ev);
  if (active === "fleet") fleetPanel.onEvent(ev);
  // The feed is only drawn on Fleet Events; every other encoding and rung skips it.
  if (active === "fleet" && fleetPanel.encoding === "events" && !renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (active === "fleet" && fleetPanel.encoding === "events") feedPanel.onEvent(ev);
    });
  }
}

const connector = createConnector({
  health,
  recent,
  stream,
  checkCompat,
  clientSchemaVersion: CLIENT_SCHEMA_VERSION,
  onEvent,
  setStatus: ({ kind, text, compatReason }) => {
    if (kind === "ok" && !roots.loaded()) void roots.refresh();
    attentionPanel.setConnected(kind === "ok");
    projectPanel.setConnected(kind === "ok");
    fleetPanel.setConnected(kind === "ok");
    if (compatReason) {
      compatBanner.textContent = compatReason;
      compatBanner.classList.add("visible");
    } else {
      compatBanner.classList.remove("visible");
    }
    sidebar.setStatus(kind, text);
  },
  onStreamOpen: () => {
    void roots.refresh();
    if (active === "project") void projectPanel.refresh();
    if (active === "fleet") void fleetPanel.refresh();
  },
});

void connector.connect();
setInterval(() => {
  void connector.connect();
}, 3000);
show("fleet");
// Membership, worktree names and lifetimes come from the Project panel's rows. Load them here so
// they do not depend on which panel is shown first (the landing is Fleet, not Project). After
// show(): leaving the initial Project state deactivates it, which would drop an earlier request.
void scope.resolver()?.refresh?.();

if (!isOnboarded()) {
  app.append(
    createOnboarding(() => {
      show("doctor");
      // The overlay took the focused button with it.
      panels.doctor.root.focus();
    }),
  );
}
