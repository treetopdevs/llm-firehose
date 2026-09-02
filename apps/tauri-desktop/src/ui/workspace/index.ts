import { sessions } from "../../api";
import type { FirehoseEvent, SessionSummary } from "../../api";
import { clear, el, keepFocus, onActivate } from "../../dom";
import { sparkline } from "../../spark";
import { buildMatrix, stateGlyph } from "./model";
import type { CellScope } from "./model";

export type WorkspacePanel = {
  root: HTMLElement;
  refresh(): Promise<void>;
  onEvent(ev: FirehoseEvent): void;
};

const REFRESH_MS = 5000;

// The top altitude: one row per workspace, one column per agent, and in each
// occupied cell the band's sparkline over every live session in the pair, the
// worst of their states as a glyph, and a count when there is more than one.
export function createWorkspace(
  recentEvents: () => readonly FirehoseEvent[],
  onOpenCell: (scope: CellScope) => void,
): WorkspacePanel {
  const box = el("div", { class: "workspace-table" });
  const root = el("section", { class: "workspace" }, box);
  let summaries: SessionSummary[] = [];
  let queued = false;

  function draw() {
    const mx = buildMatrix(summaries, recentEvents(), Date.now());
    const refocus = keepFocus(box);
    clear(box);
    if (mx.cells.length === 0) {
      box.append(el("p", { class: "dim" }, "no live sessions"));
      return;
    }
    let scale = 0;
    for (const c of mx.cells) {
      for (const n of c.buckets) scale = Math.max(scale, n);
    }
    const head = el("tr", {}, el("th", {}, ""));
    for (const a of mx.agents) head.append(el("th", {}, a));
    const body = el("tbody");
    for (const w of mx.wheres) {
      const tr = el("tr", {}, el("th", { title: w.key }, w.label));
      for (const a of mx.agents) {
        const c = mx.at(w.key, a);
        if (!c) {
          tr.append(el("td", { class: "empty" }));
          continue;
        }
        const needs = c.state === "needs_input";
        const td = el(
          "td",
          {
            class: "matrix-cell",
            tabindex: "0",
            role: "button",
            "data-key": `${c.agent}@${c.where}`,
            title: `${c.whereLabel} · ${c.agent} · ${c.sessions} session${c.sessions === 1 ? "" : "s"}`,
          },
          el("span", { class: "spark", "aria-hidden": "true" }, sparkline(c.buckets, scale)),
          el("span", { class: `glyph${needs ? " needs" : ""}` }, stateGlyph(c.state)),
          el("span", { class: "count" }, c.sessions > 1 ? String(c.sessions) : ""),
        );
        onActivate(td, () => onOpenCell({ where: c.where, agent: c.agent, label: `${c.whereLabel} · ${c.agent}` }));
        tr.append(td);
      }
      body.append(tr);
    }
    box.append(el("table", { class: "matrix" }, el("thead", {}, head), body));
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

  function onEvent(_ev: FirehoseEvent) {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }

  setInterval(() => {
    if (root.isConnected) void refresh();
  }, REFRESH_MS);

  return { root, refresh, onEvent };
}
