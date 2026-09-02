import { sessions } from "../../api";
import type { FirehoseEvent, SessionSummary } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { sessionHue } from "../../spark";
import { LANE_WINDOWS_MS, axisTicks, buildLanes } from "./model";
import type { Lane } from "./model";

export type LanesPanel = {
  root: HTMLElement;
  refresh(): Promise<void>;
  onEvent(ev: FirehoseEvent): void;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_W = 180;
const AXIS_H = 20;
const ROW_H = 24;
const PAD = 8;
const FALLBACK_W = 800;
const LABEL_PX = 56; // room for "HH:MM:SS"; a label that would spill past the edge is dropped

// Everything event-derived is a text node; attribute values are numbers and
// class names we choose.
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

function windowLabel(ms: number): string {
  return ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`;
}

// Wall time across, now at the right edge, one lane per live session. Tool
// calls are spans, events are ticks, and an empty stretch is the idle signal.
export function createLanes(
  recentEvents: () => readonly FirehoseEvent[],
  onOpenSession: (id: string) => void,
): LanesPanel {
  const chart = el("div", { class: "lanes-chart" });
  const bar = el("div", { class: "lanes-bar" }, el("span", { class: "dim" }, "window"));
  const root = el("section", { class: "lanes" }, bar, chart);

  let windowMs: number = LANE_WINDOWS_MS[1];
  let summaries: SessionSummary[] = [];
  let queued = false;
  const buttons: HTMLButtonElement[] = [];
  for (const ms of LANE_WINDOWS_MS) {
    const btn = el("button", {}, windowLabel(ms));
    btn.addEventListener("click", () => {
      windowMs = ms;
      draw();
    });
    buttons.push(btn);
    bar.append(btn);
  }

  function draw() {
    const now = Date.now();
    buttons.forEach((btn, i) => btn.classList.toggle("active", LANE_WINDOWS_MS[i] === windowMs));
    const width = Math.max(chart.clientWidth || FALLBACK_W, LABEL_W + 100);
    const laneW = width - LABEL_W - PAD;
    const x = (t: number) => LABEL_W + ((t - (now - windowMs)) / windowMs) * laneW;
    const lanes = buildLanes(recentEvents(), summaries, now, windowMs);
    const height = AXIS_H + Math.max(lanes.length, 1) * ROW_H + PAD;

    const canvas = svg("svg", {
      viewBox: `0 0 ${width} ${height}`,
      width: "100%",
      height,
      role: "group",
      "aria-label": "session lanes",
    });
    const axis = svg("g", { class: "lane-axis" });
    for (const tick of axisTicks(now, windowMs, laneW)) {
      const tx = x(tick.at);
      axis.append(svg("line", { x1: tx, x2: tx, y1: AXIS_H - 4, y2: height - PAD }));
      if (tx + LABEL_PX <= width - PAD) {
        axis.append(svg("text", { x: tx + 3, y: AXIS_H - 7 }, tick.label));
      }
    }
    canvas.append(axis);
    if (lanes.length === 0) {
      canvas.append(svg("text", { class: "lane-empty", x: LABEL_W, y: AXIS_H + ROW_H / 2 + 4 }, "no live sessions"));
    }
    lanes.forEach((lane, i) => canvas.append(laneRow(lane, i, x, width)));
    const refocus = keepFocus(chart);
    clear(chart);
    chart.append(canvas);
    refocus();
  }

  function laneRow(lane: Lane, i: number, x: (t: number) => number, width: number): SVGGElement {
    const y = AXIS_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    const needs = lane.state === "needs_input";
    const g = svg("g", { class: "lane-row", tabindex: 0, role: "button", "aria-label": `open session ${lane.label}`, "data-key": lane.id });
    onActivate(g, () => onOpenSession(lane.id));
    g.append(
      svg("title", {}, `${lane.label} · ${lane.state || "?"}${lane.reason ? ` · ${lane.reason}` : ""}`),
      svg("rect", { class: "lane-hit", x: 0, y, width, height: ROW_H }),
      svg("rect", { x: 0, y: y + 4, width: 3, height: ROW_H - 8, fill: `hsl(${sessionHue(lane.id)} 55% 55%)` }),
      svg("text", { class: "lane-label", x: 10, y: mid + 4 }, lane.label),
      svg("text", { class: `lane-state${needs ? " needs" : ""}`, x: 100, y: mid + 4 }, needs ? "NEEDS YOU" : lane.state),
      svg("line", { class: "lane-base", x1: LABEL_W, x2: width - PAD, y1: mid, y2: mid }),
    );
    for (const sp of lane.spans) {
      const x1 = x(sp.from);
      const x2 = Math.max(x(sp.to), x1 + 1);
      g.append(svg("rect", { class: `lane-span${sp.open ? " open" : ""}`, x: x1, y: mid - 3, width: x2 - x1, height: 6 }));
    }
    for (const t of lane.ticks) {
      const tx = x(t.at);
      switch (t.kind) {
        case "error":
          g.append(svg("rect", { class: "lane-tick error", x: tx - 1.5, y: mid - 9, width: 3, height: 18 }));
          break;
        case "needs":
          g.append(svg("circle", { class: "lane-tick needs", cx: tx, cy: mid, r: 4 }));
          break;
        default:
          g.append(svg("rect", { class: "lane-tick", x: tx - 1, y: mid - 6, width: 2, height: 12 }));
      }
    }
    return g;
  }

  async function refresh() {
    try {
      summaries = await sessions();
    } catch {
      // The live buffer alone still draws; the status bar reports daemon health.
    }
    draw();
  }

  function onEvent(_ev: FirehoseEvent) {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  // The axis slides once a second while the panel is on screen.
  setInterval(() => {
    if (root.isConnected) draw();
  }, 1000);

  return { root, refresh, onEvent };
}
