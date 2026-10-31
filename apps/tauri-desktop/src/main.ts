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
import { createDwell } from "./ui/dwell";
import { createFeed } from "./ui/feed";
import { createFiles } from "./ui/files";
import { createLanes } from "./ui/lanes";
import { createOnboarding, isOnboarded } from "./ui/onboarding";
import { createLoops } from "./ui/loops";
import { createScore } from "./ui/score";
import { createHandoffs } from "./ui/handoffs";
import { createAirspace } from "./ui/airspace";
import { createLoom } from "./ui/loom";
import { createEcosystem } from "./ui/ecosystem";
import { createReplay } from "./ui/replay";
import { createStrata } from "./ui/strata";
import { createSessions } from "./ui/sessions";
import { createSettings } from "./ui/settings";
import { createWorkspace } from "./ui/workspace";
import { createWorkspaceGraph } from "./ui/graph";
import type { CellScope } from "./ui/workspace/model";
import { membership, scope, selectSession } from "./scope";
import type { ScopePatch, SessionRef } from "./scope";
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

// Descending from a workspace cell scopes the sessions list to it.
function openCell(cell: CellScope) {
  go("sessions", { cell }, true);
}

const dwellPanel = createDwell(openSession);
const workspacePanel = createWorkspaceGraph(openSession, scope);
const matrixPanel = createWorkspace(() => feedState.events(), openCell);
const lanesPanel = createLanes(() => feedState.events(), openSession);

const attentionPanel=createAttention({onSelect:showDetail,onOpenSession:openSession,onDoctor:()=>show("doctor"),onOpenInbox:()=>show("attention")});
attentionPanel.setConnected(false);
const airspacePanel = createAirspace(openScore, () => show("attention"));
airspacePanel.setConnected(false);
// Live is home; attention remains visible at every altitude.
const panels = {
  live: createFeed(feedState, showDetail),
  attention: attentionPanel,
  dwell: dwellPanel,
  workspace: workspacePanel,
  matrix: matrixPanel,
  lanes: lanesPanel,
  sessions: sessionsPanel,
  score: scorePanel,
  loops: loopsPanel,
  strata: createStrata(openLoops, openScore),
  court: courtPanel,
  handoffs: createHandoffs(openScore, () => feedState.events()),
  airspace: airspacePanel,
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

let active: PanelName = "live";
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
  if (active === "score" && name !== "score") scorePanel.deactivate();
  if (active === "court" && name !== "court") courtPanel.refresh();
  if (name === "court") renderDetail(detailPane, null, () => {});
  if (active === "handoffs" && name !== "handoffs") panels.handoffs.refresh();
  if (active === "airspace" && name !== "airspace") airspacePanel.deactivate();
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
  if (name === "airspace") {
    renderDetail(detailPane, null, () => {});
    void airspacePanel.activate();
  } else if (name === "strata") void panels.strata.activate();
  else {
    panels[name].refresh();
    if (name === "score") scorePanel.activate();
  }
}

const SCOPE_PANELS: ReadonlySet<string> = new Set(["sessions", "score", "loops", "workspace"]);
document.addEventListener(
  "keydown",
  createEscapeHandler({
    store: scope,
    activePanel: () => active,
    scopePanels: SCOPE_PANELS,
    afterAscend: (alt, from) => {
      if ((from === "score" || from === "loops") && alt !== "session") show("sessions");
      else if (from === "sessions") void sessionsPanel.refresh();
    },
  }),
);

// A row click is a context-narrowing action: it records the session in scope.
sessionsPanel.root.addEventListener("click", (e) => {
  const item = (e.target as Element | null)?.closest?.<HTMLElement>(".session-item");
  const id = item?.dataset.id;
  if (id) selectSession(scope, refOf(id));
});

const nav = el("nav", { class: "sidebar" }, el("div", { class: "brand" }, "AGENT", el("br"), "FIREHOSE"));
for (const name of Object.keys(panels) as PanelName[]) {
  const btn = el("button", { class: "nav-btn" }, name);
  btn.addEventListener("click", () => show(name));
  navButtons.set(name, btn);
  nav.append(btn);
}

const crumb = createBreadcrumb(scope);
const statusBar = el("footer", { class: "status-bar" }, statusDot, statusText, el("span", { class: "scope-crumb dim" }, crumb.root), eventCount);
app.append(compatBanner, attentionPanel.strip, el("div", { class: "layout" }, nav, content, detailPane), statusBar);

// --- live data -------------------------------------------------------------

let received = 0;
let renderQueued = false;

function onEvent(ev: FirehoseEvent) {
  feedState.push(ev);
  received++;
  eventCount.textContent = `${received.toLocaleString()} events`;
  if (active === "dwell") {
    dwellPanel.onEvent(ev);
  }
  workspacePanel.onEvent(ev);
  if (active === "matrix") matrixPanel.onEvent(ev);
  if (active === "lanes") {
    lanesPanel.onEvent(ev);
  }
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
    attentionPanel.setConnected(kind === "ok");
    airspacePanel.setConnected(kind === "ok");
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
    if (active === "dwell") {
      void panels.dwell.refresh();
    }
  },
});

void connector.connect();
setInterval(() => {
  void connector.connect();
}, 3000);
show("live");

if (!isOnboarded()) {
  app.append(createOnboarding(() => show("doctor")));
}
