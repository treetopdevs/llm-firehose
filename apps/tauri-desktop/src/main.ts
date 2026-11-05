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
import { remapScope } from "./privacy-remap";
import type { IdentitySet } from "./privacy-remap";
import type { Scope, ScopePatch, SessionRef } from "./scope";
import { ascentTarget, createEscapeHandler } from "./escape";
import { QUEUE_KEYS, registerKeys } from "./keys";
import { toggleLegend, openLegend, type PanelContext } from "./ui/legend";
import { createBreadcrumb } from "./breadcrumb";
import { createSessionDirectory } from "./session-directory";
import { inspectorBelongsTo, isAlias, resolveAlias } from "./nav";
import type { AliasName } from "./nav";

const app = document.querySelector<HTMLDivElement>("#app")!;

const feedState = new FeedState(FEED_RING);
const detailPane = el("aside", { class: "detail" });
// The call altitude pairs a tool call's start and end from the live buffer.
const siblings = (ev: FirehoseEvent) =>
  ev.call_id ? feedState.events().filter((o) => o.source === ev.source && o.session_id === ev.session_id && o.call_id === ev.call_id) : [];
const showDetail = (ev: FirehoseEvent) =>
  renderDetail(detailPane, ev, () => renderDetail(detailPane, null, () => {}), siblings, undefined, offerEvidence, sessionDirectory);

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
  if ((e.target as Element | null)?.closest?.('[data-key^="inspect:"], [data-key^="warning:"]')) inspectClickGeneration = navGeneration;
}, true);
const sessionsPanel = createSessions(showDetail, () => feedState.events(), openScore, openLoops, scope, sessionDirectory, (ref) => selectSession(scope, ref), { inbox: attentionPanel });

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
// The old fleet panels are encodings inside Fleet. Landing is Project, then once
// to Fleet when there is more than one repository (see onRows below). The
// attention strip is visible at every altitude.
let fleetLabels: Record<string, string> = {};
let repoCount = 0;
let landingPending = false;
const isUntouchedLive = (sc: Scope): boolean =>
  sc.window === "live" && !sc.project && !sc.worktree && !sc.session && !sc.cell;
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
  onRows: (rows) => {
    loadPrivacyMode();
    repoCount = new Set(rows.map((r) => r.repo_id)).size;
    if (!landingPending) return;
    landingPending = false;
    if (active === "project" && repoCount > 1 && isUntouchedLive(scope.get())) show("fleet");
  },
  // The landing rule judges the first load only; a later recovery must not move the user.
  onLoadFailed: () => {
    landingPending = false;
  },
  projectLabel: (id) => fleetLabels[id],
  onEncoding: () => syncTransport(),
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
  },
});
const panels = {
  fleet: fleetPanel,
  project: projectPanel,
  sessions: sessionsPanel,
  session: sessionPanel,
  files: createFiles(sessionDirectory),
  doctor: createDoctor(),
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
  // Panels re-read only after the scope is settled.
  void projectPanel.refresh();
  void workspacePanel.refresh();
}

const content = el("main", { class: "content" });
const statusDot = el("span", { class: "status-dot" });
const statusText = el("span", { class: "status-text dim" }, "connecting…");
const compatBanner = el("div", { class: "compat-banner" });
const eventCount = el("span", { class: "event-count dim" }, "");

let active: PanelName = "project";
const NAV_GROUPS: ReadonlyArray<readonly [string, readonly PanelName[]]> = [
  ["Altitudes", ["fleet", "project", "sessions", "session"]],
  ["Housekeeping", ["files", "doctor", "settings"]],
];
/** Sidebar labels and each panel's visible h2: one name per panel, sentence case. */
export const NAV_LABELS: Record<PanelName, string> = {
  fleet: "Fleet",
  project: "Project",
  sessions: "Worktree",
  session: "Session",
  files: "Files",
  doctor: "Doctor",
  settings: "Settings",
};
const navButtons = new Map<PanelName, HTMLButtonElement>();

/** Panels that read scope.window; the shell transport is shown only over these. */
export const TRANSPORT_PANELS: ReadonlySet<string> = new Set(["project", "fleet", "session"]);
// Fleet knows its own default live span; every other panel reads the user's preference.
const transport = createTransport({
  store: scope,
  effectiveLiveSpan: () => (active === "fleet" ? fleetPanel.effectiveLiveSpan() : liveSpanOf(scope.get())),
});

/** Whether the shell transport is shown: scope-window panels, minus Fleet's host encodings (Events, Strata, Patches). */
const transportShown = (): boolean => TRANSPORT_PANELS.has(active) && !(active === "fleet" && isHostEncoding(fleetPanel.encoding));
function syncTransport(): void {
  transport.setVisible(transportShown());
  transport.refresh();
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
  // An open menu, a pending confirmation or an in-flight action belongs to the panel that started it.
  if (name !== active) actions.cancelAll();
  // Registration can happen elsewhere (Workspace toolbar): re-read roots on arrival.
  if ((name === "fleet" || name === "project") && name !== active) void roots.refresh();
  // Any navigation other than the boot landing decides the landing rule.
  if (name !== "project") landingPending = false;
  if (active === "project" && name !== "project") projectPanel.deactivate();
  if (active === "fleet" && name !== "fleet") fleetPanel.deactivate();
  // Only a real panel change closes the shared pane, and not on the panel the inspector belongs to.
  if (name !== active) navGeneration++;
  if (name !== active && !inspectorBelongsTo(name)) renderDetail(detailPane, null, () => {});
  if (active === "session" && name !== "session") sessionPanel.deactivate();
  if (active === "files" && name !== "files") panels.files.deactivate();
  active = name;
  transport.setPanel(name);
  for (const [n, btn] of navButtons) {
    btn.classList.toggle("active", n === name);
    if (n === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  clear(content);
  content.append(panels[name].root);
  if (name === "fleet") void fleetPanel.activate();
  else if (name === "project") void projectPanel.activate(opts?.encoding ? { encoding: opts.encoding } : undefined);
  else if (name === "sessions") void sessionsPanel.activate({ needsOnly: !!opts?.needsOnly });
  else if (name === "session") sessionPanel.activate(opts?.tab);
  else panels[name].refresh();
  syncTransport();
}

const SCOPE_PANELS: ReadonlySet<string> = new Set(["sessions", "session", "project", "fleet"]);
const ascendOnEscape = createEscapeHandler({
  store: scope,
  // Only the Score and Loops tabs are scope lenses; the notebook tabs own Escape.
  activePanel: () => (active === "session" && !sessionPanel.escapes() ? "session-nonscope" : active),
  scopePanels: SCOPE_PANELS,
  afterAscend: (alt, from, prev) => {
    const target = ascentTarget(prev, alt, from);
    if (target !== "stay") show(target);
    else if (from === "sessions") void sessionsPanel.refresh();
  },
});
/** The panel and encoding the legend scopes its key lists to. */
function legendContext(): PanelContext {
  if (active === "fleet") return { panel: active, encoding: fleetPanel.encoding };
  if (active === "project") return { panel: active, encoding: projectPanel.encoding() };
  if (active === "session") return { panel: active, tab: sessionPanel.tab() };
  return { panel: active };
}

registerKeys([
  {
    scope: "global",
    ...QUEUE_KEYS.escape,
    label: "go up one level (clear a selection, then leave the view)",
    modifiers: "any",
    handler: (e) => {
      ascendOnEscape(e);
    },
  },
  {
    scope: "global",
    ...QUEUE_KEYS.legend,
    label: "show keys and symbols",
    enabled: () => app.isConnected,
    handler: () => {
      toggleLegend({ opener: document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement : undefined, fallbackFocus: legendBtn, context: legendContext });
    },
  },
]);

const nav = el("nav", { class: "sidebar" }, el("div", { class: "brand" }, "AGENT", el("br"), "FIREHOSE"));
for (const [heading, names] of NAV_GROUPS) {
  nav.append(el("div", { class: "nav-heading" }, heading));
  for (const name of names) {
    const btn = el("button", { class: "nav-btn", "data-panel": name }, NAV_LABELS[name]);
    btn.addEventListener("click", () => {
      show(name);
    });
    navButtons.set(name, btn);
    nav.append(btn);
  }
}

const crumb = createBreadcrumb(scope, { directory: sessionDirectory });
const legendBtn = el("button", { type: "button", class: "legend-btn", "aria-haspopup": "dialog" }, "Keys and symbols");
legendBtn.addEventListener("click", () => {
  openLegend({ opener: legendBtn, fallbackFocus: legendBtn, context: legendContext });
});
const statusBar = el("footer", { class: "status-bar" }, statusDot, statusText, el("span", { class: "scope-crumb dim" }, crumb.root), eventCount, legendBtn);
app.append(compatBanner, attentionPanel.strip, transport.root, el("div", { class: "layout" }, nav, content, detailPane), shellNote, statusBar, actions.root);

// --- live data -------------------------------------------------------------

let received = 0;
let renderQueued = false;

function onEvent(ev: FirehoseEvent) {
  feedState.push(ev);
  received++;
  eventCount.textContent = `${received.toLocaleString()} events`;
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
    statusDot.className = `status-dot ${kind}`;
    statusText.textContent = text;
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
show("project");
landingPending = true;

if (!isOnboarded()) {
  app.append(createOnboarding(() => show("doctor")));
}
