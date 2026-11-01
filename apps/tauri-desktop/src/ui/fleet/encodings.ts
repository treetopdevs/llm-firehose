// Fleet encodings: pure renderers over already-derived data. They draw only;
// derivation stays in ui/lanes/model and ui/airspace/model.

import type { FirehoseEvent } from "../../api";
import { clear, el, onActivate } from "../../dom";
import { isTransition, sessionHue } from "../../spark";
import { axisTicks } from "../lanes/model";
import type { Lane } from "../lanes/model";
import { BANDS } from "../airspace/model";
import type { deriveAirspace } from "../airspace/model";

const SEP = "\u0000";
const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_W = 150;
const LABEL_CHARS = 18;
const AXIS_H = 16;
const ROW_H = 22;
const PAD = 6;

/** Namespaces session_id by source so two sources reusing an id never share a lane or pair a call. */
export function qualifyLaneInput(events: readonly FirehoseEvent[]): FirehoseEvent[] {
  const out: FirehoseEvent[] = [];
  for (const e of events) {
    if (!e.session_id) { out.push(e); continue; }
    if (isTransition(e)) {
      // Synthetic transitions carry the originating adapter in payload.source.
      const origin = typeof e.payload?.source === "string" && e.payload.source ? e.payload.source : e.source;
      out.push({ ...e, session_id: `${origin}${SEP}${e.session_id}` });
    } else if (e.category === "meta") {
      continue; // adapter noise is not fleet activity (D95)
    } else out.push({ ...e, session_id: `${e.source}${SEP}${e.session_id}` });
  }
  return out;
}

function decode(key: string, sourceOf?: (id: string) => string | undefined): { id: string; source?: string } {
  const i = key.indexOf(SEP);
  if (i >= 0) return { id: key.slice(i + 1), source: key.slice(0, i) || undefined };
  return { id: key, source: sourceOf?.(key) };
}

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

function cut(s: string): string {
  const chars = [...s];
  return chars.length > LABEL_CHARS ? chars.slice(0, LABEL_CHARS - 1).join("") + "…" : s;
}

/** Wall-clock lanes ending at `now`; each row is a button that opens its session. */
export function lanesStrip(
  lanes: readonly Lane[],
  now: number,
  windowMs: number,
  width: number,
  onOpen: (id: string, source?: string) => void,
  sourceOf?: (id: string) => string | undefined,
): SVGSVGElement {
  const w = Math.max(width, LABEL_W + 100);
  const laneW = w - LABEL_W - PAD;
  const height = AXIS_H + Math.max(lanes.length, 1) * ROW_H + PAD;
  const x = (t: number) => LABEL_W + ((t - (now - windowMs)) / windowMs) * laneW;
  const canvas = svg("svg", {
    class: "fleet-lanes",
    viewBox: `0 0 ${w} ${height}`,
    width: "100%",
    height,
    role: "group",
    "aria-label": "session lanes",
  });
  const axis = svg("g", { class: "lane-axis" });
  for (const tick of axisTicks(now, windowMs, laneW)) {
    const tx = x(tick.at);
    axis.append(svg("line", { x1: tx, x2: tx, y1: AXIS_H - 4, y2: height - PAD }));
    if (tx + 56 <= w - PAD) axis.append(svg("text", { x: tx + 3, y: AXIS_H - 6 }, tick.label));
  }
  canvas.append(axis);
  if (lanes.length === 0) {
    canvas.append(svg("text", { class: "lane-empty", x: LABEL_W, y: AXIS_H + ROW_H / 2 + 4 }, "no live sessions"));
  }
  lanes.forEach((lane, i) => {
    const y = AXIS_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    const { id, source } = decode(lane.id, sourceOf);
    const needs = lane.state === "needs_input";
    const g = svg("g", { class: "fleet-lane-row", tabindex: 0, role: "button", "aria-label": `open session ${lane.label}`, "data-key": lane.id });
    onActivate(g, () => onOpen(id, source));
    g.append(
      svg("title", {}, `${lane.label} · ${lane.state || "?"}${lane.reason ? ` · ${lane.reason}` : ""}`),
      svg("rect", { class: "lane-hit", x: 0, y, width: w, height: ROW_H }),
      svg("rect", { x: 0, y: y + 4, width: 3, height: ROW_H - 8, fill: `hsl(${sessionHue(lane.id)} 55% 55%)` }),
      svg("text", { class: `lane-label${needs ? " needs" : ""}`, x: 8, y: mid + 4 }, cut(lane.label)),
      svg("line", { class: "lane-base", x1: LABEL_W, x2: w - PAD, y1: mid, y2: mid }),
    );
    for (const sp of lane.spans) {
      const x1 = x(sp.from);
      g.append(svg("rect", { class: `lane-span${sp.open ? " open" : ""}`, x: x1, y: mid - 3, width: Math.max(x(sp.to) - x1, 1), height: 6 }));
    }
    for (const t of lane.ticks) {
      const tx = x(t.at);
      if (t.kind === "error") g.append(svg("rect", { class: "lane-tick error", x: tx - 1.5, y: mid - 8, width: 3, height: 16 }));
      else if (t.kind === "needs") g.append(svg("circle", { class: "lane-tick needs", cx: tx, cy: mid, r: 4 }));
      else g.append(svg("rect", { class: "lane-tick", x: tx - 1, y: mid - 5, width: 2, height: 10 }));
    }
    g.append(svg("rect", { class: "fleet-lane-focus", x: 1, y: y + 1, width: w - 2, height: ROW_H - 2 }));
    canvas.append(g);
  });
  return canvas;
}

/** One chip per attention band, in band order. Wording is about captured observations only. */
export function airspaceBands(d: ReturnType<typeof deriveAirspace>): HTMLElement {
  const root = el("div", { class: "fleet-bands", role: "group", "aria-label": "Attention bands" });
  clear(root);
  for (const band of BANDS) {
    const n = d.counts[band.id];
    root.append(
      el("span", { class: `fleet-band band-${band.id}${n === 0 ? " zero" : ""}` }, el("span", { class: "fleet-band-n" }, String(n)), ` ${band.label}`),
    );
  }
  return root;
}
