// App shell: sidebar navigation, status bar with daemon health + schema
// compatibility, live SSE feed into FeedState, and the first-run onboarding
// overlay. The daemon (bundled as the firehosed sidecar) is the only data
// source — this UI never touches spool files.

import { CLIENT_SCHEMA_VERSION, getConfig, health, recent, stream } from "./api";
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
import { createSession } from "./ui/session";
import type { SessionTab } from "./ui/session/context";
import type { SessionLens } from "./ui/session";
import { createHandoffs } from "./ui/handoffs";
import { createLoom } from "./ui/loom";
import { createEcosystem } from "./ui/ecosystem";
import { createReplay } from "./ui/replay";
import { createStrata } from "./ui/strata";
import { createFleet } from "./ui/fleet";
import { createProject, splitGoPatch, type ProjectEncoding } from "./ui/project";
import { createSessions } from "./ui/sessions";
import { createSettings } from "./ui/settings";
import { createWorkspaceGraph } from "./ui/graph";
import { liveSpanOf, membership, scope, selectSession } from "./scope";
import { createTransport } from "./transport";
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

const attentionPanel=createAttention({onSelect:showDetail,onOpenSession:openSessionAltitude,onDoctor:()=>show("doctor"),onOpenInbox:()=>show("attention")});
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
});
projectPanel.setConnected(false);
// Sessions reached by clicking a Fleet fork: Escape retraces Project then Fleet
// instead of widening scope while the panel stays on Sessions.
let sessionsViaFleet = false;
const fleetPanel = createFleet({
  store: scope,
  go: (name, patch): void => {
    go(name, patch);
    sessionsViaFleet = name === "sessions";
  },
  events: () => feedState.events(),
  onLabels: (labels) => {
    fleetLabels = labels;
  },
  onEncoding: () => transport.refresh(),
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
  ),
  scope,
);
const adapt = (p: { root: HTMLElement; refresh(): unknown }) => ({ root: p.root, refresh: p.refresh, deactivate: p.refresh });
const sessionPanel = createSession({
  store: scope,
  lenses: {
    // Factories: each lens is built on first entry (or via sessionPanel.lens), not at boot.
    score: makeScore,
    loops: () => createLoops(scope),
    loom: () => createLoom(openScore),
    replay: () => createReplay(openScore),
    handoffs: () => adapt(createHandoffs(openScore, () => feedState.events())),
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
  live: createFeed(feedState, showDetail),
  attention: attentionPanel,
  sessions: sessionsPanel,
  session: sessionPanel,
  strata: createStrata(openLoops, openScore),
  ecosystem: createEcosystem(openScore),
  files: createFiles(),
  doctor: createDoctor(),
  settings: createSettings(),
} as const;

type PanelName = keyof typeof panels;
type GoName = PanelName | "score" | "loops";

const content = el("main", { class: "content" });
const statusDot = el("span", { class: "status-dot" });
const statusText = el("span", { class: "status-text dim" }, "connecting…");
const compatBanner = el("div", { class: "compat-banner" });
const eventCount = el("span", { class: "event-count dim" }, "");

let active: PanelName = "project";
const NAV_GROUPS: ReadonlyArray<readonly [string, readonly PanelName[]]> = [
  ["Altitudes", ["fleet", "project", "sessions", "session"]],
  ["Lenses", ["live", "attention", "strata", "ecosystem"]],
  ["Housekeeping", ["files", "doctor", "settings"]],
];
const navButtons = new Map<PanelName, HTMLButtonElement>();

/** Panels that read scope.window; the shell transport is shown only over these. */
export const TRANSPORT_PANELS: ReadonlySet<string> = new Set(["project", "fleet", "session"]);
// Fleet knows its own default live span; every other panel reads the user's preference.
const transport = createTransport({
  store: scope,
  effectiveLiveSpan: () => (active === "fleet" ? fleetPanel.effectiveLiveSpan() : liveSpanOf(scope.get())),
});

/** Narrows (or, with replace, replaces) the shared scope, then shows the panel. */
function go(name: GoName, rawPatch?: ScopePatch & { encoding?: ProjectEncoding }, replace = false, tab?: SessionTab) {
  const { scopePatch: patch, encoding: patchEncoding } = splitGoPatch(rawPatch);
  if (patch) {
    if (replace) scope.replaceContext(patch as ScopePatch);
    else scope.narrow(patch as ScopePatch);
  }
  const encoding = patchEncoding;
  if (name === "score" || name === "loops") show("session", { tab: name });
  else show(name, tab || encoding ? { ...(tab ? { tab } : {}), ...(encoding ? { encoding } : {}) } : undefined);
}

function show(name: PanelName, opts?: { tab?: SessionTab; encoding?: ProjectEncoding }) {
  // Any navigation other than the boot landing decides the landing rule.
  if (name !== "project") landingPending = false;
  if (!["fleet", "project", "sessions", "session"].includes(name)) sessionsViaFleet = false;
  if (active === "project" && name !== "project") projectPanel.deactivate();
  if (active === "fleet" && name !== "fleet") fleetPanel.deactivate();
  if (name === "project" || name === "fleet") renderDetail(detailPane, null, () => {});
  if (active === "session" && name !== "session") sessionPanel.deactivate();
  if (active === "ecosystem" && name !== "ecosystem") panels.ecosystem.deactivate();
  if (name === "ecosystem") renderDetail(detailPane, null, () => {});

  if (active === "files" && name !== "files") panels.files.deactivate();
  active = name;
  transport.setPanel(name);
  transport.refresh();
  transport.setVisible(TRANSPORT_PANELS.has(name));
  for (const [n, btn] of navButtons) {
    btn.classList.toggle("active", n === name);
  }
  clear(content);
  content.append(panels[name].root);
  if (name === "fleet") void fleetPanel.activate();
  else if (name === "project") void projectPanel.activate(opts?.encoding ? { encoding: opts.encoding } : undefined);
  else if (name === "strata") void panels.strata.activate();
  else if (name === "session") sessionPanel.activate(opts?.tab);
  else panels[name].refresh();
}

const SCOPE_PANELS: ReadonlySet<string> = new Set(["sessions", "session", "project", "fleet"]);
document.addEventListener(
  "keydown",
  createEscapeHandler({
    store: scope,
    // Only the Score and Loops tabs are scope lenses; the notebook tabs own Escape.
    activePanel: () => (active === "session" && !sessionPanel.escapes() ? "session-nonscope" : active),
    scopePanels: SCOPE_PANELS,
    afterAscend: (alt, from) => {
      if (from === "session" && alt !== "session") show("sessions");
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
app.append(compatBanner, attentionPanel.strip, transport.root, el("div", { class: "layout" }, nav, content, detailPane), statusBar);

// --- live data -------------------------------------------------------------

let received = 0;
let renderQueued = false;

function onEvent(ev: FirehoseEvent) {
  feedState.push(ev);
  received++;
  eventCount.textContent = `${received.toLocaleString()} events`;
  projectPanel.onEvent(ev);
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
