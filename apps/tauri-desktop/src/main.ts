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
import { createDoctor } from "./ui/doctor";
import { createDwell } from "./ui/dwell";
import { createFeed } from "./ui/feed";
import { createFiles } from "./ui/files";
import { createLanes } from "./ui/lanes";
import { createOnboarding, isOnboarded } from "./ui/onboarding";
import { createOrbit } from "./ui/orbit";
import { createSessions } from "./ui/sessions";
import { createSettings } from "./ui/settings";
import { createWorkspace } from "./ui/workspace";
import type { CellScope } from "./ui/workspace/model";

const app = document.querySelector<HTMLDivElement>("#app")!;

const feedState = new FeedState(5000);
const detailPane = el("aside", { class: "detail" });
// The call altitude pairs a tool call's start and end from the live buffer.
const siblings = (ev: FirehoseEvent) =>
  ev.call_id ? feedState.events().filter((o) => o.session_id === ev.session_id && o.call_id === ev.call_id) : [];
const showDetail = (ev: FirehoseEvent) =>
  renderDetail(detailPane, ev, () => renderDetail(detailPane, null, () => {}), siblings);

const sessionsPanel = createSessions(showDetail, () => feedState.events());

function openSession(id: string) {
  sessionsPanel.setScope(null);
  show("sessions");
  void sessionsPanel.openSession(id);
}

// Descending from a workspace cell scopes the sessions list to it.
function openCell(scope: CellScope) {
  sessionsPanel.setScope(scope);
  show("sessions");
}

const dwellPanel = createDwell(openSession);
const workspacePanel = createWorkspace(() => feedState.events(), openCell);
const orbitPanel = createOrbit(openSession);
const lanesPanel = createLanes(() => feedState.events(), openSession);

// Dwell bars are the landing view; orbit stays as an opt-in ambient display.
const panels = {
  dwell: dwellPanel,
  workspace: workspacePanel,
  live: createFeed(feedState, showDetail),
  lanes: lanesPanel,
  sessions: sessionsPanel,
  files: createFiles(),
  doctor: createDoctor(),
  settings: createSettings(),
  orbit: orbitPanel,
} as const;

type PanelName = keyof typeof panels;

const content = el("main", { class: "content" });
const statusDot = el("span", { class: "status-dot" });
const statusText = el("span", { class: "status-text dim" }, "connecting…");
const compatBanner = el("div", { class: "compat-banner" });
const eventCount = el("span", { class: "event-count dim" }, "");

let active: PanelName = "dwell";
const navButtons = new Map<PanelName, HTMLButtonElement>();

function show(name: PanelName) {
  if (active === "orbit" && name !== "orbit") {
    orbitPanel.dispose();
  }
  active = name;
  for (const [n, btn] of navButtons) {
    btn.classList.toggle("active", n === name);
  }
  clear(content);
  content.append(panels[name].root);
  panels[name].refresh();
}

const nav = el("nav", { class: "sidebar" }, el("div", { class: "brand" }, "AGENT", el("br"), "FIREHOSE"));
for (const name of Object.keys(panels) as PanelName[]) {
  const btn = el("button", { class: "nav-btn" }, name);
  btn.addEventListener("click", () => show(name));
  navButtons.set(name, btn);
  nav.append(btn);
}

const statusBar = el("footer", { class: "status-bar" }, statusDot, statusText, eventCount);
app.append(compatBanner, el("div", { class: "layout" }, nav, content, detailPane), statusBar);

// --- live data -------------------------------------------------------------

let received = 0;
let renderQueued = false;

function onEvent(ev: FirehoseEvent) {
  feedState.push(ev);
  received++;
  eventCount.textContent = `${received.toLocaleString()} events`;
  if (active === "orbit") {
    orbitPanel.onEvent(ev);
  }
  if (active === "dwell") {
    dwellPanel.onEvent(ev);
  }
  if (active === "workspace") {
    workspacePanel.onEvent(ev);
  }
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
    if (active === "orbit" || active === "dwell") {
      void panels[active].refresh();
    }
  },
});

void connector.connect();
setInterval(() => {
  void connector.connect();
}, 3000);
show("dwell");

if (!isOnboarded()) {
  app.append(createOnboarding(() => show("doctor")));
}
