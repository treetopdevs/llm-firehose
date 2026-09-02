import { sessions } from "../../api";
import type { FirehoseEvent, SessionSummary } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { formatAge, sessionHue } from "../../spark";
import { DWELL_HAIRLINE_MS, DWELL_MAX_MS, applyTransition, buildDwell } from "./model";

export type DwellPanel = {
  root: HTMLElement;
  refresh(): Promise<void>;
  onEvent(ev: FirehoseEvent): void;
};

const TICK_MS = 1000;
const FETCH_EVERY_TICKS = 5;

// The supervision view: one horizontal bar per live session, length equal to
// time in its state, sorted by urgency, with a hairline at five minutes. It
// carries what the orbit encoded in depth and motion, in one dimension.
export function createDwell(onOpenSession: (id: string) => void, clock: () => number = Date.now): DwellPanel {
  const hairPct = (DWELL_HAIRLINE_MS / DWELL_MAX_MS) * 100;
  const scale = el(
    "div",
    { class: "dwell-scale" },
    el("span", { class: "dim" }, "time in state"),
    el(
      "span",
      { class: "dwell-scale-track" },
      el("span", { class: "dwell-scale-mark", style: `left:${hairPct}%` }, "5m"),
      el("span", { class: "dwell-scale-mark end" }, "10m"),
    ),
  );
  const rowsBox = el("div", { class: "dwell-rows" });
  const root = el("section", { class: "dwell" }, scale, rowsBox);

  let summaries: SessionSummary[] = [];
  let queued = false;
  let ticks = 0;

  function draw() {
    const { rows, more } = buildDwell(summaries, clock());
    const refocus = keepFocus(rowsBox);
    clear(rowsBox);
    if (rows.length === 0) {
      rowsBox.append(el("p", { class: "dim" }, "no live sessions"));
      return;
    }
    for (const r of rows) {
      const row = el(
        "div",
        { class: "dwell-row", style: `--hue:${sessionHue(r.id)}`, tabindex: "0", role: "button", title: r.id, "data-key": r.id },
        el("span", { class: "cell agent" }, r.label),
        el("span", { class: "cell where" }, r.where),
        el("span", { class: `cell state${r.needs ? " needs" : ""}` }, r.needs ? "NEEDS YOU" : r.state),
        el(
          "div",
          { class: "dwell-track" },
          el("div", { class: "dwell-bar", style: `width:${Math.round(r.fraction * 1000) / 10}%` }),
          el("div", { class: "dwell-hair", style: `left:${hairPct}%` }),
        ),
        el("span", { class: "cell dwell-label" }, formatAge(r.dwellMs)),
        el("span", { class: "cell err", title: r.hasError ? "an error was captured in this session" : "" }, r.hasError ? "!" : ""),
        el("span", { class: "cell summary" }, r.text),
      );
      onActivate(row, () => onOpenSession(r.id));
      rowsBox.append(row);
    }
    if (more > 0) {
      rowsBox.append(el("p", { class: "dim" }, `+${more} more`));
    }
    refocus();
  }

  async function refresh() {
    try {
      summaries = await sessions();
    } catch {
      // Keep the last picture; the status bar reports daemon health.
    }
    draw();
  }

  function onEvent(ev: FirehoseEvent) {
    // Every transition is kept, even several inside one frame; the frame
    // already queued draws the latest picture.
    const next = applyTransition(summaries, ev);
    if (next === summaries) return;
    summaries = next;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  // Bars grow once a second while the panel is on screen; summaries are
  // refetched every few seconds so sessions the stream did not announce appear.
  setInterval(() => {
    if (!root.isConnected) return;
    ticks++;
    if (ticks % FETCH_EVERY_TICKS === 0) {
      void refresh();
    } else {
      draw();
    }
  }, TICK_MS);

  return { root, refresh, onEvent };
}
