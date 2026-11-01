// App shell: sidebar navigation, status bar with daemon health + schema
// compatibility, live SSE feed into FeedState, and the first-run onboarding
// overlay. The daemon (bundled as the firehosed sidecar) is the only data
// source — this UI never touches spool files.

import { CLIENT_SCHEMA_VERSION, health, recent, stream } from "./api";
import type { FirehoseEvent } from "./api";
import { checkCompat } from "./compat";
import { createConnector } from "./connect";
import { clear, el } from "./dom";
import { FeedState } from "./state";
import { renderDetail } from "./ui/detail";
import { createAttention } from "./ui/attention";
import { createCourt } from "./ui/court";
import { createDoctor } from "./ui/doctor";
import { createFeed } from "./ui/feed";
import { createFiles } from "./ui/files";
import { createOnboarding, isOnboarded } from "./ui/onboarding";
import { createLoops } from "./ui/loops";
import { createScore } from "./ui/score";
import { createHandoffs } from "./ui/handoffs";
import { createLoom } from "./ui/loom";
import { createEcosystem } from "./ui/ecosystem";
import { createReplay } from "./ui/replay";
import { createStrata } from "./ui/strata";
import { createFleet } from "./ui/fleet";
import { createProject } from "./ui/project";
import { createSessions } from "./ui/sessions";
import { createSettings } from "./ui/settings";
import { createWorkspaceGraph } from "./ui/graph";
import { graphAPI } from "./ui/graph/api";
import { createActions } from "./ui/actions";
import { createRoots } from "./ui/actions/roots";
import { membership, scope, selectSession } from "./scope";
import type { Scope, ScopePatch, SessionRef } from "./scope";
import { createEscapeHandler } from "./escape";
import { createBreadcrumb } from "./breadcrumb";

const app = document.querySelector<HTMLDivElement>("#app")!;

const feedState = new FeedState(5000);
const detailPane = el("aside", { class: "detail" });
// The call altitude pairs a tool call's start and end from the live buffer.
const siblings = (ev: FirehoseEvent) =>
  ev.call_id ? feedState.events().filter((o) => o.source === ev.source && o.session_id === ev.session_id && o.call_id === ev.call_id) : [];
const showDetail = (ev: FirehoseEvent) =>
  renderDetail(detailPane, ev, () => renderDetail(detailPane, null, () => {}), siblings, undefined, offerEvidence);

// The score replays one finished session, so its detail pairs calls from
// that session's history rather than the live buffer.
const scorePanel = createScore((ev, sessionSiblings, signature, dismiss) =>
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
  ),
  scope,
);

const refOf = (id: string, source?: string): SessionRef => (source === undefined ? { id } : { id, source });

// The single Score opener is scorePanel.activate(), run by show("score"): it
// opens scope.session unless that session is already loaded.
function openScore(id: string, source?: string) {
  selectSession(scope, refOf(id, source));
  show("score");
}

const courtPanel = createCourt(openScore);
function offerEvidence(id: string) {
  renderDetail(detailPane, null, () => {});
  show("court");
  courtPanel.offerEvent(id);
}

const loopsPanel = createLoops(scope);
function openLoops(id: string, source?: string) {
  // open() first so the panel's first-show preselect sees a session and skips.
  void loopsPanel.open(id, source);
  selectSession(scope, refOf(id, source));
  show("loops");
}

const sessionsPanel = createSessions(showDetail, () => feedState.events(), openScore, openLoops, scope);

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

const workspacePanel = createWorkspaceGraph(openSession, scope);

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

const attentionPanel=createAttention({onSelect:showDetail,onOpenSession:openSession,onDoctor:()=>show("doctor"),onOpenInbox:()=>show("attention")});
attentionPanel.setConnected(false);
// Altitudes (D94-D98): Fleet > Project > Worktree (sessions) > Session (score).
// The old fleet panels are encodings inside Fleet. Landing is Project, then once
// to Fleet when there is more than one repository (see onRows below). The
// attention strip is visible at every altitude.
let fleetLabels: Record<string, string> = {};
let repoCount = 0;
let landingPending = false;
const isUntouchedLive = (sc: Scope): boolean =>
  sc.window === "live" && !sc.project && !sc.worktree && !sc.session && !sc.cell;
const projectPanel = createProject({
  store: scope,
  actions,
  roots,
  go: (name, patch): void => {
    go(name, patch);
  },
  onRows: (rows) => {
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
});
projectPanel.setConnected(false);
// Sessions reached by clicking a Fleet fork: Escape retraces Project then Fleet
// instead of widening scope while the panel stays on Sessions.
let sessionsViaFleet = false;
const fleetPanel = createFleet({
  store: scope,
  actions,
  roots,
  go: (name, patch): void => {
    go(name, patch);
    sessionsViaFleet = name === "sessions";
  },
  events: () => feedState.events(),
  onLabels: (labels) => {
    fleetLabels = labels;
  },
});
fleetPanel.setConnected(false);
const panels = {
  fleet: fleetPanel,
  project: projectPanel,
  live: createFeed(feedState, showDetail),
  attention: attentionPanel,
  workspace: workspacePanel,
  sessions: sessionsPanel,
  score: scorePanel,
  loops: loopsPanel,
  strata: createStrata(openLoops, openScore),
  court: courtPanel,
  handoffs: createHandoffs(openScore, () => feedState.events()),
  loom: createLoom(openScore),
  ecosystem: createEcosystem(openScore),
  replay: createReplay(openScore),
  files: createFiles(),
  doctor: createDoctor(),
  settings: createSettings(),
} as const;

type PanelName = keyof typeof panels;

const content = el("main", { class: "content" });
const statusDot = el("span", { class: "status-dot" });
const statusText = el("span", { class: "status-text dim" }, "connecting…");
const compatBanner = el("div", { class: "compat-banner" });
const eventCount = el("span", { class: "event-count dim" }, "");

let active: PanelName = "project";
const NAV_GROUPS: ReadonlyArray<readonly [string, readonly PanelName[]]> = [
  ["Altitudes", ["fleet", "project", "sessions", "score"]],
  ["Lenses", ["live", "attention", "workspace", "loops", "strata", "court", "handoffs", "loom", "ecosystem", "replay"]],
  ["Housekeeping", ["files", "doctor", "settings"]],
];
const navButtons = new Map<PanelName, HTMLButtonElement>();

/** Narrows (or, with replace, replaces) the shared scope, then shows the panel. */
function go(name: PanelName, patch?: ScopePatch, replace = false) {
  if (patch) {
    if (replace) scope.replaceContext(patch);
    else scope.narrow(patch);
  }
  show(name);
}

function show(name: PanelName) {
  // An open menu, a pending confirmation or an in-flight action belongs to the panel that started it.
  if (name !== active) actions.cancelAll();
  // Registration can happen elsewhere (Workspace toolbar): re-read roots on arrival.
  if ((name === "fleet" || name === "project") && name !== active) void roots.refresh();
  // Any navigation other than the boot landing decides the landing rule.
  if (name !== "project") landingPending = false;
  if (!["fleet", "project", "sessions", "score", "loops"].includes(name)) sessionsViaFleet = false;
  if (active === "project" && name !== "project") projectPanel.deactivate();
  if (active === "fleet" && name !== "fleet") fleetPanel.deactivate();
  if (name === "project" || name === "fleet") renderDetail(detailPane, null, () => {});
  if (active === "score" && name !== "score") scorePanel.deactivate();
  if (active === "court" && name !== "court") courtPanel.refresh();
  if (name === "court") renderDetail(detailPane, null, () => {});
  if (active === "handoffs" && name !== "handoffs") panels.handoffs.refresh();
  if (active === "loom" && name !== "loom") panels.loom.deactivate();
  if (name === "loom") renderDetail(detailPane, null, () => {});
  if (active === "ecosystem" && name !== "ecosystem") panels.ecosystem.deactivate();
  if (name === "ecosystem") renderDetail(detailPane, null, () => {});
  if (active === "replay" && name !== "replay") panels.replay.deactivate();
  if (name === "replay") renderDetail(detailPane, null, () => {});

  if (active === "files" && name !== "files") panels.files.deactivate();
  active = name;
  for (const [n, btn] of navButtons) {
    btn.classList.toggle("active", n === name);
  }
  clear(content);
  content.append(panels[name].root);
  if (name === "handoffs") renderDetail(detailPane, null, () => {});
  if (name === "fleet") void fleetPanel.activate();
  else if (name === "project") void projectPanel.activate();
  else if (name === "strata") void panels.strata.activate();
  else {
    panels[name].refresh();
    if (name === "score") scorePanel.activate();
  }
}

const SCOPE_PANELS: ReadonlySet<string> = new Set(["sessions", "score", "loops", "workspace", "project", "fleet"]);
document.addEventListener(
  "keydown",
  createEscapeHandler({
    store: scope,
    activePanel: () => active,
    scopePanels: SCOPE_PANELS,
    afterAscend: (alt, from) => {
      if ((from === "score" || from === "loops") && alt !== "session") show("sessions");
      else if (from === "sessions" && sessionsViaFleet && alt === "project") show("project");
      else if (from === "sessions" && sessionsViaFleet && alt === "fleet") {
        sessionsViaFleet = false;
        show(repoCount > 1 ? "fleet" : "live");
      } else if (from === "sessions") void sessionsPanel.refresh();
      else if (from === "project" && alt === "fleet") {
        sessionsViaFleet = false;
        show(repoCount > 1 ? "fleet" : "live");
      }
    },
  }),
);

// A row click is a context-narrowing action: it records the session in scope.
sessionsPanel.root.addEventListener("click", (e) => {
  const item = (e.target as Element | null)?.closest?.<HTMLElement>(".session-item");
  const id = item?.dataset.id;
  if (id) selectSession(scope, refOf(id, item?.dataset.source));
});

const nav = el("nav", { class: "sidebar" }, el("div", { class: "brand" }, "AGENT", el("br"), "FIREHOSE"));
for (const [heading, names] of NAV_GROUPS) {
  nav.append(el("div", { class: "nav-heading" }, heading));
  for (const name of names) {
    const btn = el("button", { class: "nav-btn" }, name);
    btn.addEventListener("click", () => {
      sessionsViaFleet = false;
      show(name);
    });
    navButtons.set(name, btn);
    nav.append(btn);
  }
}

const crumb = createBreadcrumb(scope);
const statusBar = el("footer", { class: "status-bar" }, statusDot, statusText, el("span", { class: "scope-crumb dim" }, crumb.root), eventCount);
app.append(compatBanner, attentionPanel.strip, el("div", { class: "layout" }, nav, content, detailPane), statusBar, actions.root);

// --- live data -------------------------------------------------------------

let received = 0;
let renderQueued = false;

function onEvent(ev: FirehoseEvent) {
  feedState.push(ev);
  received++;
  eventCount.textContent = `${received.toLocaleString()} events`;
  workspacePanel.onEvent(ev);
  if (active === "fleet") fleetPanel.onEvent(ev);
  if (active === "live" && !renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      panels.live.refresh();
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
