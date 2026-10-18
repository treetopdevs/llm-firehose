// Session Score: replay one finished session as time-aligned tracks, one per
// envelope category, over GET /sessions/{id}. Everything in the window is
// drawn, marks sharing a pixel column as one mark with a count, so a session
// of any size draws tracks × width nodes. The playhead is a cursor over the
// full event list that highlights the event under it and drives the detail
// pane. Gaps are real time at every speed.

import { capturedEvent, errorSignatures, sessionEvents, sessions } from "../../api";
import type { ErrorSignature, FirehoseEvent, SessionSummary } from "../../api";
import { clear, el, keepFocus } from "../../dom";
import { formatClockMs, formatDuration, sessionName, sessionWhere, shortId } from "../../format";
import { sessionIdChip } from "../session-chip";
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
  timelineProjection,
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

/** How long the optional GET /errors fetch may take before it is aborted; the score then renders without daemon signatures. */
export const SIGNATURES_TIMEOUT_MS = 4_000;

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

/**
 * `onSelect` renders the detail pane; `dismiss` is the score's half of that
 * pane's close button, so a fetch still in flight never reopens it.
 */
export function createScore(onSelect: (ev: FirehoseEvent, siblings: Siblings, signature: ErrorSignature | undefined, dismiss: () => void) => void): ScorePanel {
  const head = el("div", { class: "score-head dim" });
  const clock = el("span", { class: "score-clock" });
  const bar = el("div", { class: "score-bar" });
  const overview = el("div", { class: "score-overview" });
  const chart = el("div", { class: "score-chart" });
  const root = el("section", { class: "score", tabindex: "0" }, head, bar, overview, chart);
  const clipId = `score-clip-${++clipSeq}`;

  let sessionId = "";
  /** The /sessions summary of the open session, when the daemon lists it; it names the score. */
  let summary: SessionSummary | undefined;
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
  /** Full envelopes fetched for the detail pane, by id, for the open session only. */
  let fullById = new Map<string, FirehoseEvent>();
  /** The one in-flight full-detail fetch group; starting another aborts it. */
  let detailAbort: AbortController | undefined;
  /**
   * Which selection owns the detail pane. A new selection, dismissing the
   * pane, opening a session, and the view being shown again each bump it; a
   * fetched result renders only under the token it started with.
   */
  let selection = 0;
  /** Whether the detail pane shows the score's current event (not dismissed, not taken by another view). */
  let shown = false;
  /** The pane was closed; the frame loop's moves leave it closed until an explicit selection. */
  let dismissed = false;
  let currentSignature: ErrorSignature | undefined;

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
    const wasPlaying = playing;
    playing = on && loaded();
    playBtn.setAttribute("aria-pressed", String(playing));
    playBtn.textContent = playing ? "❚❚" : "▶";
    if (playing) {
      // Starting playback: no detail fetch may be in flight while the cursor
      // moves, and a pane showing full fields drops back to projected ones.
      cancelDetail();
      const cur = currentId ? byId.get(currentId) : undefined;
      if (cur && shown && root.isConnected && [cur, ...siblings(cur)].some(beyondProjection)) render(cur);
      frameStamp = 0;
      requestAnimationFrame(frame);
    } else if (wasPlaying && root.isConnected) {
      // Playback stopped on the event under the cursor: render its full detail
      // now, cached or fetched, unless the pane was dismissed. A detached view
      // (the user left the Score) is paused silently instead, so the shared
      // detail pane is never written from a hidden panel.
      const cur = currentId ? byId.get(currentId) : undefined;
      if (cur && shown) render(cur);
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
    if (at >= score.end) setPlayhead(score.start, true);
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

  /**
   * Moves the cursor; the event under it is the latest at or before it.
   * Playback's moves only mark the event when the pane was closed.
   */
  function setPlayhead(next: number, fromPlayback = false) {
    at = next;
    // Follow the cursor when it leaves the window; this redraws once per window width.
    if (at < view.from || at > view.to) setView(panView(view, at, bounds()));
    updatePlayhead();
    const under = eventAt(score, at);
    if (!under) return;
    if (under.event.id !== currentId) {
      if (fromPlayback && dismissed) mark(under);
      else highlight(under);
    } else if (!fromPlayback && !shown) {
      // An explicit move onto the current event reopens a pane it does not hold.
      render(under.event);
    }
  }

  /** Puts the cursor on one specific event, even when several share its instant. */
  function select(target: ScoreEvent) {
    at = target.at;
    if (at < view.from || at > view.to) setView(panView(view, at, bounds()));
    updatePlayhead();
    if (target.event.id !== currentId) highlight(target);
    else if (!shown) render(target.event);
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

  /** Drops any in-flight detail fetch and the selection it was for. */
  function cancelDetail() {
    selection++;
    detailAbort?.abort();
    detailAbort = undefined;
  }
  /** The pane's close button: nothing in flight, nor pausing, may reopen it. */
  const dismiss = () => {
    shown = false;
    dismissed = true;
    cancelDetail();
  };

  /** Whether the pane renders more of `ev` than its projection: a fetched envelope, or an older daemon's full one. */
  const beyondProjection = (ev: FirehoseEvent) => {
    const shownEv = fuller(ev);
    return JSON.stringify(shownEv) !== JSON.stringify(timelineProjection(shownEv));
  };

  /** The full envelope when one was fetched, else the projected event the session loaded with. */
  const fuller = (ev: FirehoseEvent) => fullById.get(ev.id) ?? ev;
  const fullSiblings: Siblings = (ev) => siblings(ev).map(fuller);

  /**
   * Fetches the full envelopes of an event and its call siblings that are not
   * cached, then re-renders the detail if that event is still the current one.
   * One group at a time, and only while paused; failures leave the projected
   * rendering standing. The result renders only under the selection token
   * `sel` and while the score is the shown view.
   */
  function fetchFull(ev: FirehoseEvent, sel: number) {
    detailAbort?.abort();
    detailAbort = undefined;
    if (playing) return;
    const wanted = [ev, ...siblings(ev)].map((e) => e.id).filter((id, i, all) => !fullById.has(id) && all.indexOf(id) === i);
    if (wanted.length === 0) return;
    const v = version;
    const ctl = new AbortController();
    detailAbort = ctl;
    void Promise.all(wanted.map((id) => capturedEvent(id, ctl.signal).then((full) => full, () => undefined))).then((got) => {
      if (v !== version || sel !== selection || ctl.signal.aborted || !root.isConnected) return;
      if (detailAbort === ctl) detailAbort = undefined;
      let any = false;
      got.forEach((full, i) => {
        if (full && full.id === wanted[i]) {
          fullById.set(full.id, full);
          any = true;
        }
      });
      if (any && currentId === ev.id && !playing) onSelect(fuller(ev), fullSiblings, currentSignature, dismiss);
    });
  }

  /** Makes `target` current and renders it. */
  function highlight(target: ScoreEvent) {
    mark(target);
    render(target.event);
  }

  /**
   * Renders the current event as a new pane selection. Playback shows
   * projected fields only, explicit steps included; full envelopes, cached or
   * fetched, render while paused.
   */
  function render(ev: FirehoseEvent) {
    cancelDetail();
    shown = true;
    dismissed = false;
    if (playing) {
      // Projected even when an older daemon sent full envelopes.
      onSelect(timelineProjection(ev), (e) => siblings(e).map(timelineProjection), currentSignature, dismiss);
      return;
    }
    onSelect(fuller(ev), fullSiblings, currentSignature, dismiss);
    fetchFull(ev, selection);
  }

  /** Moves the current mark, its motif kin, and its signature to `target` without rendering. */
  function mark(target: ScoreEvent) {
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
    currentSignature = signature;
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
    setPlayhead(step.at, true);
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
      chart.append(el("p", { class: "dim" }, sessionId ? `no drawable events in ${name()}` : "open a session from the sessions panel to see its score"));
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

  /** What the open session is called: its summary's name, else the agent and a short id. The uuid is never the name. */
  function name(): string {
    if (summary) return sessionName(summary);
    const first = events[0];
    // Only the agent is taken from the events: the timeline view carries no
    // workspace, so a name derived from one would differ between daemons.
    return sessionName({ id: sessionId, source: first?.source ?? "", agent: first?.agent });
  }

  function drawHead() {
    clear(head);
    if (!sessionId) return;
    const first = events[0];
    const where = summary ? sessionWhere(summary) : { label: "", full: undefined };
    const facts = [
      summary?.agent || summary?.source || (first ? first.agent || first.source : ""),
      where.label,
      `${events.length} events`,
      loaded() ? `${formatClockMs(new Date(score.start).toISOString())} → ${formatClockMs(new Date(score.end).toISOString())} · ${formatDuration(score.end - score.start)}` : "",
    ].filter(Boolean);
    head.append(
      el("span", { class: "score-name", title: name() }, stripControl(name())),
      el("span", { class: "score-facts", title: where.full ?? "" }, stripControl(facts.join(" · "))),
      sessionIdChip(sessionId),
    );
  }

  // --- data -----------------------------------------------------------------------

  async function open(id: string, source?: string) {
    const v = ++version;
    // Drop the previous session's detail state before pausing, so stopping
    // playback cannot fetch that session's current event into the new cache.
    cancelDetail();
    fullById = new Map();
    currentId = undefined;
    setPlaying(false);
    // Closing the pane, or another selection, while this loads keeps the load from rendering.
    const sel = selection;
    sessionId = id;
    summary = undefined;
    clear(head);
    clear(overview);
    clear(chart);
    chart.append(el("p", { class: "dim" }, `loading session ${shortId(id)}…`));
    // Opened by id from another panel: fetch the summary alongside the
    // history so the heading is the session's name, not its id. An older
    // daemon, or a session no longer listed, just leaves the fallback name.
    const summaryLoad = Promise.resolve()
      .then(() => sessions())
      .then((list) => list?.find((s) => s.id === id))
      .catch(() => undefined);
    // GET /errors is additive (2026-10-16) and pure enrichment: fetched
    // alongside the events but never awaited, so an older daemon without the
    // route — or one that hangs on it — costs the score nothing. A hung fetch
    // is aborted after SIGNATURES_TIMEOUT_MS. Motifs group on the locally
    // mirrored keys either way; when the signatures land, their member ids
    // replace the mirror and the current event's detail gains the
    // cross-session facts.
    sigs = new Map();
    memberKeys = new Map();
    let ready = false;
    const sigAbort = new AbortController();
    const sigTimer = setTimeout(() => sigAbort.abort(), SIGNATURES_TIMEOUT_MS);
    void errorSignatures(id, sigAbort.signal)
      .then((sigList) => {
        if (v !== version) return;
        sigs = new Map(sigList.map((s) => [s.key, s]));
        memberKeys = memberSignatureKeys(sigList);
        if (!ready) return; // the events' load picks the keys up
        score = buildScore(events, memberKeys);
        draw();
        const cur = currentId ? eventById(currentId) : undefined;
        if (cur && tickKind(cur.event) === "error") {
          // Late signatures re-render only a pane this score still owns.
          mark(cur);
          if (shown && root.isConnected) render(cur.event);
        }
      })
      .catch(() => {})
      .finally(() => clearTimeout(sigTimer));
    try {
      const [fetched, found] = await Promise.all([sessionEvents(id, "timeline"), summaryLoad]);
      if (v !== version) return;
      summary = found;
      const evs = fetched.filter((ev) => !source || ev.source === source);
      events = evs;
      byId = new Map(evs.map((e) => [e.id, e]));
      score = buildScore(evs, memberKeys);
      ready = true;
      view = bounds();
      currentId = undefined;
      kinSig = undefined;
      at = score.start;
      drawHead();
      draw();
      // A load that lands after the user left the Score, or closed the pane,
      // draws but leaves the shared detail pane alone.
      const under = eventAt(score, at);
      if (under) {
        mark(under);
        if (root.isConnected && sel === selection) render(under.event);
      }
    } catch (err) {
      if (v !== version) return;
      clear(chart);
      chart.append(el("p", { class: "error" }, String(err)));
    }
  }

  async function refresh() {
    // Shown again: another view may have taken the pane meanwhile, and
    // whatever was in flight predates that.
    shown = false;
    cancelDetail();
    drawHead();
    draw();
  }

  return { root, refresh, open, tick, playhead: () => at };
}
