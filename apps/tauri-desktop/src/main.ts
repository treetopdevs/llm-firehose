// App shell: sidebar navigation, status bar with daemon health + schema
// compatibility, live SSE feed into FeedState, and the first-run onboarding
// overlay. The daemon (bundled as the firehosed sidecar) is the only data
// source — this UI never touches spool files.

import { CLIENT_SCHEMA_VERSION, health, recent, stream } from "./api";
import type { FirehoseEvent } from "./api";
import { checkCompat } from "./compat";
import { clear, el } from "./dom";
import { FeedState } from "./state";
import { renderDetail } from "./ui/detail";
import { createDoctor } from "./ui/doctor";
import { createFeed } from "./ui/feed";
import { createFiles } from "./ui/files";
import { createOnboarding, isOnboarded } from "./ui/onboarding";
import { createOrbit } from "./ui/orbit";
import { createSessions } from "./ui/sessions";
import { createSettings } from "./ui/settings";

const app = document.querySelector<HTMLDivElement>("#app")!;

const feedState = new FeedState(5000);
const detailPane = el("aside", { class: "detail" });
const showDetail = (ev: FirehoseEvent) => renderDetail(detailPane, ev, () => renderDetail(detailPane, null, () => {}));

const sessionsPanel = createSessions(showDetail);

function openSessionFromOrbit(id: string) {
  show("sessions");
  void sessionsPanel.openSession(id);
}

const orbitPanel = createOrbit(openSessionFromOrbit);

const panels = {
  orbit: orbitPanel,
  live: createFeed(feedState, showDetail),
  sessions: sessionsPanel,
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

let active: PanelName = "orbit";
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
  if (active === "live" && !renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      panels.live.refresh();
    });
  }
}

let stopStream: (() => void) | null = null;

async function connect() {
  try {
    const h = await health();
    const compat = checkCompat(h, CLIENT_SCHEMA_VERSION);
    if (!compat.compatible) {
      compatBanner.textContent = `incompatible: ${compat.reason}`;
      compatBanner.classList.add("visible");
      statusDot.className = "status-dot err";
      statusText.textContent = `daemon ${h.version} — blocked`;
      return;
    }
    compatBanner.classList.remove("visible");
    statusDot.className = "status-dot ok";
    statusText.textContent = `daemon ${h.version} · schema v${h.schema_version} · LIVE`;

    if (!stopStream) {
      const history = await recent(500);
      for (const ev of history) {
        onEvent(ev);
      }
      stopStream = stream(onEvent, (open) => {
        statusDot.className = `status-dot ${open ? "ok" : "warn"}`;
        if (open) {
          statusText.textContent = `daemon ${h.version} · schema v${h.schema_version} · LIVE`;
          if (active === "orbit") {
            void orbitPanel.refresh();
          }
        } else {
          statusText.textContent = "stream interrupted — reconnecting…";
        }
      });
    }
  } catch {
    statusDot.className = "status-dot err";
    statusText.textContent = "engine offline — waiting for firehosed…";
    stopStream?.();
    stopStream = null;
  }
}

connect();
setInterval(connect, 3000);
show("orbit");

if (!isOnboarded()) {
  app.append(createOnboarding(() => show("doctor")));
}
