import { attention } from "../../api";
import type { AttentionSession, FirehoseEvent } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { formatAge, sessionHue } from "../../spark";
import { DWELL_HAIRLINE_MS, DWELL_MAX_MS, buildDwell } from "./model";

export type DwellPanel = {
  root: HTMLElement;
  refresh(): Promise<void>;
  onEvent(ev: FirehoseEvent): void;
};

const TICK_MS = 1000;
const FETCH_EVERY_TICKS = 3;

// The supervision view: one horizontal bar per live session, sorted by
// urgency, with a hairline at five minutes. A pending request is measured from
// when it was captured; any other session from its last activity. It reads the
// same /attention snapshot as the strip and inbox, so all three agree.
export function createDwell(onOpenSession: (id: string, source?: string) => void, clock: () => number = Date.now): DwellPanel {
  const hairPct = (DWELL_HAIRLINE_MS / DWELL_MAX_MS) * 100;
  const scale = el(
    "div",
    { class: "dwell-scale" },
    el("span", { class: "dim" }, "waiting or quiet for"),
    el(
      "span",
      { class: "dwell-scale-track" },
      el("span", { class: "dwell-scale-mark", style: `left:${hairPct}%` }, "5m"),
      el("span", { class: "dwell-scale-mark end" }, "10m"),
    ),
  );
  const rowsBox = el("div", { class: "dwell-rows" });
  const root = el("section", { class: "dwell" }, scale, rowsBox);

  let sessions: AttentionSession[] = [];
  let ticks = 0;
  let inFlight: Promise<void> | null = null;
  let again = false;

  function draw() {
    const { rows, more } = buildDwell(sessions, clock());
    const refocus = keepFocus(rowsBox);
    clear(rowsBox);
    if (rows.length === 0) {
      rowsBox.append(el("p", { class: "dim" }, "no live sessions"));
      return;
    }
    for (const r of rows) {
      const row = el(
        "div",
        { class: "dwell-row", style: `--hue:${sessionHue(r.id)}`, tabindex: "0", role: "button", title: `${r.source} · ${r.id}`, "data-key": r.key },
        el("span", { class: "cell agent" }, r.label),
        el("span", { class: "cell where" }, r.where),
        el("span", { class: `cell state${r.needs ? " needs" : ""}` }, r.status),
        el(
          "div",
          { class: "dwell-track" },
          el("div", { class: "dwell-bar", style: `width:${Math.round(r.fraction * 1000) / 10}%` }),
          el("div", { class: "dwell-hair", style: `left:${hairPct}%` }),
        ),
        el("span", { class: "cell dwell-label" }, formatAge(r.dwellMs)),
        el("span", { class: "cell err", title: r.hasError ? "a session failure was captured" : "" }, r.hasError ? "!" : ""),
        el("span", { class: "cell summary" }, r.text),
      );
      onActivate(row, () => onOpenSession(r.id, r.source));
      rowsBox.append(row);
    }
    if (more > 0) {
      rowsBox.append(el("p", { class: "dim" }, `+${more} more`));
    }
    refocus();
  }

  async function load() {
    try {
      sessions = (await attention()).sessions;
    } catch {
      // Keep the last picture; the status bar reports daemon health.
    }
    draw();
  }

  // One fetch at a time; anything asked for mid-flight earns one follow-up.
  function refresh(): Promise<void> {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    const task = load().finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        void refresh();
      }
    });
    inFlight = task;
    return task;
  }

  function onEvent(ev: FirehoseEvent) {
    // Captured session activity can open or resolve an episode. The engine's
    // own synthetic frames carry the older session semantics, so skip them.
    if (!ev.session_id || ev.source === "firehose") return;
    void refresh();
  }

  // Bars grow once a second while the panel is on screen; the snapshot is
  // refetched every few seconds so changes the stream did not announce appear.
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
