// Session Score: replay one finished session as time-aligned tracks, one per
// envelope category, over GET /sessions/{id}. Everything in the window is
// drawn, marks sharing a pixel column as one mark with a count, so a session
// of any size draws tracks × width nodes. The playhead is a cursor over the
// full event list that highlights the event under it and drives the detail
// pane. Gaps are real time at every speed.

import { errorSignatures, sessionEvents } from "../../api";
import type { ErrorSignature, FirehoseEvent } from "../../api";
import { clear, el, keepFocus } from "../../dom";
import { formatClockMs, formatDuration } from "../../format";
import type { Siblings } from "../detail";
import {
  SPEEDS,
  advance,
  buildScore,
  clampView,
  coalesce,
  columnOf,
  digestLabel,
  errorSignatureKey,
  eventAt,
  eventLabel,
  memberSignatureKeys,
  nextEventAfter,
  panView,
  prevEventBefore,
  scoreAxisTicks,
  stripControl,
  tickKind,
  zoomView,
} from "./model";
import type { DrawnTrack, Score, ScoreEvent, View } from "./model";

export type ScorePanel = {
  root: HTMLElement;
  /** Redraws the open session, or the empty state. Never refetches. */
  refresh(): Promise<void>;
  /** Fetches one session and replaces whatever was open. */
  open(id: string, source?: string): Promise<void>;
  /** Advances playback by elapsed wall-clock milliseconds; what the frame loop calls. */
  tick(elapsedMs: number): void;
  playhead(): number;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_W = 110;
const AXIS_H = 20;
const ROW_H = 28;
const PAD = 8;
const FALLBACK_W = 800;
/** Width of one axis label character at the 11px axis font. */
const LABEL_CH = 6.5;
const MINI_ROW_H = 6;
const ZOOM_STEP = 2;

let clipSeq = 0;

// Everything event-derived is a text node; attribute values are numbers and
// class names we choose, plus the event id the view needs to find a tick.
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

// Tool, then summary, then duration. In minimal mode the tool name is a
// digest and prints as a short hash; the summary stays readable in every mode.
function spanTitle(byId: Map<string, FirehoseEvent>, from: number, to: number, open: boolean, startId: string, count: number): string {
  const start = byId.get(startId);
  const tool = start ? digestLabel(start.payload?.tool_name) : "";
  const what = start ? eventLabel(start) : "";
  const how = open ? `open · no end captured · ${formatDuration(to - from)}+` : formatDuration(to - from);
  const many = count > 1 ? `×${count} calls, first` : "";
  return [many, tool, what, how].filter(Boolean).join(" · ");
}

export function createScore(onSelect: (ev: FirehoseEvent, siblings: Siblings, signature?: ErrorSignature) => void): ScorePanel {
  const head = el("div", { class: "score-head dim" });
  const clock = el("span", { class: "score-clock" });
  const bar = el("div", { class: "score-bar" });
  const overview = el("div", { class: "score-overview" });
  const chart = el("div", { class: "score-chart" });
  const root = el("section", { class: "score", tabindex: "0" }, head, bar, overview, chart);
  const clipId = `score-clip-${++clipSeq}`;

  let sessionId = "";
  let events: FirehoseEvent[] = [];
  let byId = new Map<string, FirehoseEvent>();
  /** The daemon's Error Signatures for this session, by key; empty when the daemon has none or lacks GET /errors. */
  let sigs = new Map<string, ErrorSignature>();
  /** The daemon's member assignment (event id → signature key); the mirrored keying is only the fallback. */
  let memberKeys = new Map<string, string>();
  /** The motif the current event belongs to, lit on every member tick in view. */
  let kinSig: string | undefined;
  let kinNodes: SVGElement[] = [];
  let sigNodes = new Map<string, SVGElement[]>();
  let score: Score = buildScore([]);
  let view: View = { from: NaN, to: NaN };
  let at = NaN;
  let currentId: string | undefined;
  let playing = false;
  let speed: number = SPEEDS[0];
  let version = 0;
  /** Drawn tick per track, kind, and pixel column; the current event's node is found by its column. */
  let tickNodes = new Map<string, SVGElement>();
  /** Lane width the chart was last drawn at; columns are computed against it, not the live width. */
  let drawnLaneW = 0;
  let playheadLine: SVGLineElement | undefined;
  let frameStamp = 0;

  const siblings: Siblings = (ev) =>
    ev.call_id ? events.filter((o) => o.source === ev.source && o.session_id === ev.session_id && o.call_id === ev.call_id) : [];

  const bounds = (): View => ({ from: score.start, to: score.end });
  const loaded = () => score.events.length > 0;

  // --- transport ------------------------------------------------------------

  const playBtn = el("button", { "aria-label": "play", "aria-pressed": "false", title: "play / pause (space)" }, "▶");
  const prevBtn = el("button", { "aria-label": "jump to previous event", title: "previous event (←)" }, "⏮");
  const nextBtn = el("button", { "aria-label": "jump to next event", title: "next event (→)" }, "⏭");
  const speedSel = el("select", { "aria-label": "speed", title: "replay speed" });
  for (const s of SPEEDS) speedSel.append(el("option", { value: String(s) }, `${s}×`));
  speedSel.value = String(speed);
  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value) || SPEEDS[0];
  });
  const zoomIn = el("button", { "aria-label": "zoom in", title: "zoom in around the playhead" }, "+");
  const zoomOut = el("button", { "aria-label": "zoom out", title: "zoom out around the playhead" }, "−");
  const fitBtn = el("button", { "aria-label": "fit", title: "show the whole session" }, "fit");
  bar.append(playBtn, prevBtn, nextBtn, speedSel, el("span", { class: "score-gap" }), zoomIn, zoomOut, fitBtn, clock);

  function setPlaying(on: boolean) {
    playing = on && loaded();
    playBtn.setAttribute("aria-pressed", String(playing));
    playBtn.textContent = playing ? "❚❚" : "▶";
    if (playing) {
      frameStamp = 0;
      requestAnimationFrame(frame);
    }
  }

  function frame(now: number) {
    if (!playing) return;
    if (!root.isConnected) {
      // Leaving the view pauses the replay rather than running it blind.
      setPlaying(false);
      return;
    }
    if (frameStamp) tick(now - frameStamp);
    frameStamp = now;
    if (playing) requestAnimationFrame(frame);
  }

  function play() {
    if (!loaded()) return;
    if (at >= score.end) setPlayhead(score.start);
    setPlaying(true);
  }

  playBtn.addEventListener("click", () => (playing ? setPlaying(false) : play()));
  prevBtn.addEventListener("click", () => jump(prevEventBefore(score, at)));
  nextBtn.addEventListener("click", () => jump(nextEventAfter(score, at)));
  zoomIn.addEventListener("click", () => setView(zoomView(view, ZOOM_STEP, anchor(), bounds())));
  zoomOut.addEventListener("click", () => setView(zoomView(view, 1 / ZOOM_STEP, anchor(), bounds())));
  fitBtn.addEventListener("click", () => setView(bounds()));

  root.addEventListener("keydown", (e) => {
    if (!loaded()) return;
    const target = e.target as HTMLElement | null;
    const inControl = target?.tagName === "BUTTON" || target?.tagName === "SELECT";
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        jump(nextEventAfter(score, at));
        break;
      case "ArrowLeft":
        e.preventDefault();
        jump(prevEventBefore(score, at));
        break;
      case " ":
        if (inControl) return;
        e.preventDefault();
        if (playing) setPlaying(false);
        else play();
        break;
    }
  });

  /** The instant zoom keeps still: the playhead when it is on screen, else the window's middle. */
  function anchor(): number {
    return at >= view.from && at <= view.to ? at : (view.from + view.to) / 2;
  }

  function jump(target: ScoreEvent | undefined) {
    if (!target) return;
    select(target);
  }

  // --- playhead ---------------------------------------------------------------

  /** Moves the cursor; the event under it is the latest at or before it. */
  function setPlayhead(next: number) {
    at = next;
    // Follow the cursor when it leaves the window; this redraws once per window width.
    if (at < view.from || at > view.to) setView(panView(view, at, bounds()));
    updatePlayhead();
    const under = eventAt(score, at);
    if (under && under.event.id !== currentId) highlight(under);
  }

  /** Puts the cursor on one specific event, even when several share its instant. */
  function select(target: ScoreEvent) {
    at = target.at;
    if (at < view.from || at > view.to) setView(panView(view, at, bounds()));
    updatePlayhead();
    if (target.event.id !== currentId) highlight(target);
  }

  function nodeKey(category: string, kind: string, column: number): string {
    return `${category}\u0000${kind}\u0000${column}`;
  }
  function nodeFor(ev: FirehoseEvent): SVGElement | undefined {
    const at = Date.parse(ev.time);
    if (Number.isNaN(at) || at < view.from || at > view.to) return undefined;
    return tickNodes.get(nodeKey(ev.category, tickKind(ev), columnOf(at, view, drawnLaneW)));
  }
  function eventById(id: string): ScoreEvent | undefined {
    const ev = byId.get(id);
    if (!ev) return undefined;
    const at = Date.parse(ev.time);
    return Number.isNaN(at) ? undefined : { at, event: ev };
  }

  function highlight(target: ScoreEvent) {
    const was = currentId ? byId.get(currentId) : undefined;
    if (was) nodeFor(was)?.classList.remove("current");
    currentId = target.event.id;
    nodeFor(target.event)?.classList.add("current");
    const ev = target.event;
    let signature: ErrorSignature | undefined;
    kinSig = undefined;
    if (tickKind(ev) === "error") {
      const key = memberKeys.get(ev.id) ?? errorSignatureKey(ev);
      signature = sigs.get(key);
      if (score.motifs.has(key)) kinSig = key;
    }
    applyKin();
    onSelect(ev, siblings, signature);
  }

  /** Lights every in-view member of the current event's motif; redraws re-apply it like .current. */
  function applyKin() {
    for (const n of kinNodes) n.classList.remove("kin");
    kinNodes = kinSig ? [...(sigNodes.get(kinSig) ?? [])] : [];
    for (const n of kinNodes) n.classList.add("kin");
  }

  function updatePlayhead() {
    clock.textContent = Number.isNaN(at) ? "" : formatClockMs(new Date(at).toISOString());
    if (!playheadLine) return;
    const px = xFor(at);
    playheadLine.setAttribute("x1", String(px));
    playheadLine.setAttribute("x2", String(px));
    const marker = overview.querySelector(".score-view-playhead");
    if (marker) {
      const ox = overviewX(at);
      marker.setAttribute("x1", String(ox));
      marker.setAttribute("x2", String(ox));
    }
  }

  function tick(elapsedMs: number) {
    if (!playing || !loaded()) return;
    const step = advance(score, at, elapsedMs, speed);
    setPlayhead(step.at);
    if (step.done) setPlaying(false);
  }

  // --- geometry -----------------------------------------------------------------

  function width(): number {
    return Math.max(chart.clientWidth || FALLBACK_W, LABEL_W + 100);
  }
  function laneW(): number {
    return width() - LABEL_W - PAD;
  }
  function xFor(t: number): number {
    return LABEL_W + ((t - view.from) / (view.to - view.from)) * laneW();
  }
  function overviewX(t: number): number {
    const b = bounds();
    const span = Math.max(b.to - b.from, 1);
    return LABEL_W + ((t - b.from) / span) * laneW();
  }

  function setView(next: View) {
    view = clampView(next, bounds());
    draw();
  }

  // --- drawing --------------------------------------------------------------------

  function draw() {
    const refocus = keepFocus(root);
    clear(chart);
    clear(overview);
    tickNodes = new Map();
    sigNodes = new Map();
    kinNodes = [];
    playheadLine = undefined;
    if (!loaded()) {
      chart.append(el("p", { class: "dim" }, sessionId ? `no drawable events in session ${sessionId}` : "open a session from the sessions panel to see its score"));
      refocus();
      return;
    }
    chart.append(drawChart());
    overview.append(drawOverview());
    updatePlayhead();
    applyKin();
    refocus();
  }

  function drawChart(): SVGSVGElement {
    const w = width();
    drawnLaneW = laneW();
    const height = AXIS_H + score.tracks.length * ROW_H + PAD;
    const canvas = svg("svg", { viewBox: `0 0 ${w} ${height}`, width: "100%", height, role: "group", "aria-label": "session score" });
    canvas.append(
      svg("defs", {}, svg("clipPath", { id: clipId }, svg("rect", { x: LABEL_W, y: 0, width: laneW(), height }))),
    );
    const axis = svg("g", { class: "score-axis" });
    let labelled = 0;
    let lastLabelEnd = -Infinity;
    for (const tk of scoreAxisTicks(view, drawnLaneW)) {
      const tx = xFor(tk.at);
      axis.append(svg("line", { x1: tx, x2: tx, y1: AXIS_H - 4, y2: height - PAD }));
      // Dated labels are wider than clock labels; size the spill check to the text.
      const lw = tk.label.length * LABEL_CH + 6;
      if (tx + lw <= w - PAD) {
        axis.append(svg("text", { x: tx + 3, y: AXIS_H - 7 }, tk.label));
        lastLabelEnd = tx + lw;
        labelled++;
      } else if (tx - lw >= lastLabelEnd || labelled < 2) {
        // A label that would spill past the right edge is written to the
        // left of its tick when that does not cover the previous label, and
        // always when fewer than two labels have been drawn.
        axis.append(svg("text", { x: tx - 3, y: AXIS_H - 7, "text-anchor": "end" }, tk.label));
        labelled++;
      }
    }
    canvas.append(axis);
    coalesce(score, view, drawnLaneW).forEach((tr, i) => canvas.append(trackRow(tr, i, w)));
    playheadLine = svg("line", { class: "score-playhead", x1: 0, x2: 0, y1: AXIS_H - 4, y2: height - PAD });
    canvas.append(playheadLine);
    // Clicking empty track space puts the cursor there.
    canvas.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".score-tick")) return;
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width > 0 ? w / rect.width : 1;
      const px = (e.clientX - rect.left) * scale;
      if (px < LABEL_W) return;
      setPlayhead(view.from + ((px - LABEL_W) / laneW()) * (view.to - view.from));
    });
    return canvas;
  }

  function trackRow(tr: DrawnTrack, i: number, w: number): SVGGElement {
    const y = AXIS_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    const full = score.tracks[i];
    const g = svg("g", {
      class: "score-track",
      tabindex: 0,
      role: "button",
      "aria-label": `track ${tr.category}: ${full.ticks.length} events, ${full.spans.length} calls; activate to step to its next event`,
      "data-key": tr.category,
    });
    // Enter or Space on a row steps to that category's next event after the
    // cursor; a click on the row puts the cursor where it landed (see drawChart).
    g.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key !== "Enter" && key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      const next = score.events.find((e) => e.at > at && e.event.category === tr.category);
      if (next) select(next);
    });
    g.append(
      svg("rect", { class: "score-hit", x: 0, y, width: w, height: ROW_H }),
      svg("text", { class: "score-label", x: 10, y: mid + 4 }, tr.category),
      svg("line", { class: "score-base", x1: LABEL_W, x2: w - PAD, y1: mid, y2: mid }),
    );
    const marks = svg("g", { "clip-path": `url(#${clipId})` });
    for (const sp of tr.spans) {
      const x1 = xFor(sp.from);
      const x2 = Math.max(xFor(sp.to), x1 + 1);
      marks.append(
        svg(
          "rect",
          { class: `score-span${sp.open ? " open" : ""}`, x: x1, y: mid - 4, width: x2 - x1, height: 8 },
          svg("title", {}, stripControl(spanTitle(byId, sp.from, sp.to, sp.open, sp.startId, sp.count))),
        ),
      );
    }
    // Plain ticks first so an error or needs-you mark in the same column stays on top.
    const ticks = [...tr.ticks].sort((a, b) => (a.kind === "event" ? 0 : 1) - (b.kind === "event" ? 0 : 1));
    for (const tk of ticks) {
      const tx = xFor(tk.at);
      const ev = byId.get(tk.id);
      const label = ev ? eventLabel(ev) : "";
      const many = tk.count > 1 ? `×${tk.count} · first ` : "";
      // A repeating Error Signature is a motif: every member shares the taller
      // marker and lights up together when one of them is current.
      const motif = tk.sig !== undefined ? score.motifs.get(tk.sig) : undefined;
      let node: SVGElement;
      switch (tk.kind) {
        case "error":
          node = motif
            ? svg("rect", { class: "score-tick error motif", "data-id": tk.id, x: tx - 1.5, y: mid - 12, width: 3, height: 24 })
            : svg("rect", { class: "score-tick error", "data-id": tk.id, x: tx - 1.5, y: mid - 10, width: 3, height: 20 });
          break;
        case "needs":
          node = svg("circle", { class: "score-tick needs", "data-id": tk.id, cx: tx, cy: mid, r: 4 });
          break;
        default:
          node = svg("rect", { class: "score-tick", "data-id": tk.id, x: tx - 1, y: mid - 7, width: 2, height: 14 });
      }
      const sameError = motif ? ` · same error ×${motif} in this session` : "";
      node.append(svg("title", {}, `${many}${formatClockMs(ev?.time ?? "")}  ${label}${sameError}`));
      if (motif && tk.sig !== undefined) {
        const nodes = sigNodes.get(tk.sig) ?? [];
        nodes.push(node);
        sigNodes.set(tk.sig, nodes);
      }
      // A merged tick selects its earliest event; stepping from there visits the rest.
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = eventById(tk.id);
        if (target) select(target);
      });
      tickNodes.set(nodeKey(tr.category, tk.kind, tk.column), node);
      marks.append(node);
    }
    const cur = currentId ? byId.get(currentId) : undefined;
    if (cur && cur.category === tr.category) nodeFor(cur)?.classList.add("current");
    g.append(marks);
    return g;
  }

  function drawOverview(): SVGSVGElement {
    const w = width();
    const height = score.tracks.length * MINI_ROW_H + PAD;
    const canvas = svg("svg", { viewBox: `0 0 ${w} ${height}`, width: "100%", height, role: "img", "aria-label": "whole session overview" });
    canvas.append(svg("text", { class: "score-label", x: 10, y: height / 2 + 4 }, "whole session"));
    coalesce(score, bounds(), laneW()).forEach((tr, i) => {
      const y = PAD / 2 + i * MINI_ROW_H;
      const g = svg("g", { class: "score-track-mini" });
      for (const sp of tr.spans) {
        const x1 = overviewX(sp.from);
        g.append(svg("rect", { class: `score-span${sp.open ? " open" : ""}`, x: x1, y: y + 1, width: Math.max(overviewX(sp.to) - x1, 1), height: MINI_ROW_H - 2 }));
      }
      for (const tk of tr.ticks) {
        const tx = overviewX(tk.at);
        g.append(svg("line", { class: `score-tick-mini${tk.kind === "error" ? " error" : ""}`, x1: tx, x2: tx, y1: y, y2: y + MINI_ROW_H }));
      }
      canvas.append(g);
    });
    const vx1 = overviewX(view.from);
    const vx2 = overviewX(view.to);
    canvas.append(svg("rect", { class: "score-view", x: vx1, y: 0, width: vx2 - vx1, height }));
    canvas.append(svg("line", { class: "score-view-playhead", x1: 0, x2: 0, y1: 0, y2: height }));
    // Clicking the strip centres the window there.
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width > 0 ? w / rect.width : 1;
      const px = (e.clientX - rect.left) * scale;
      if (px < LABEL_W) return;
      const b = bounds();
      setView(panView(view, b.from + ((px - LABEL_W) / laneW()) * (b.to - b.from), b));
    });
    return canvas;
  }

  function drawHead() {
    clear(head);
    if (!sessionId) return;
    const first = events[0];
    const parts = [
      `session ${sessionId}`,
      first ? first.agent || first.source : "",
      `${events.length} events`,
      loaded() ? `${formatClockMs(new Date(score.start).toISOString())} → ${formatClockMs(new Date(score.end).toISOString())} · ${formatDuration(score.end - score.start)}` : "",
    ].filter(Boolean);
    head.textContent = stripControl(parts.join(" · "));
  }

  // --- data -----------------------------------------------------------------------

  async function open(id: string, source?: string) {
    const v = ++version;
    setPlaying(false);
    sessionId = id;
    clear(head);
    clear(overview);
    clear(chart);
    chart.append(el("p", { class: "dim" }, `loading ${id}…`));
    try {
      // GET /errors is additive (2026-10-16): against an older daemon it fails,
      // and that must not cost the score anything — motifs then group on the
      // locally mirrored keys alone, with no cross-session counts to show. The
      // same fallback covers ids the daemon's member lists do not carry.
      const [fetched, sigList] = await Promise.all([
        sessionEvents(id),
        errorSignatures(id).catch(() => [] as ErrorSignature[]),
      ]);
      if (v !== version) return;
      const evs = fetched.filter((ev) => !source || ev.source === source);
      events = evs;
      byId = new Map(evs.map((e) => [e.id, e]));
      sigs = new Map(sigList.map((s) => [s.key, s]));
      memberKeys = memberSignatureKeys(sigList);
      score = buildScore(evs, memberKeys);
      view = bounds();
      currentId = undefined;
      kinSig = undefined;
      at = score.start;
      drawHead();
      draw();
      const under = eventAt(score, at);
      if (under) highlight(under);
    } catch (err) {
      if (v !== version) return;
      clear(chart);
      chart.append(el("p", { class: "error" }, String(err)));
    }
  }

  async function refresh() {
    drawHead();
    draw();
  }

  return { root, refresh, open, tick, playhead: () => at };
}
