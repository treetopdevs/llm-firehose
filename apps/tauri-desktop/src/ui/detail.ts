import type { FirehoseEvent } from "../api";
import { clear, el } from "../dom";
import { formatClock, shortPath } from "../format";

// Renders the detail pane for one event: header metadata plus the full
// structured payload as pretty-printed JSON.
export function renderDetail(pane: HTMLElement, ev: FirehoseEvent | null, onClose: () => void): void {
  clear(pane);
  if (!ev) {
    pane.classList.remove("open");
    return;
  }
  pane.classList.add("open");

  const meta = el("dl", { class: "detail-meta" });
  const addRow = (label: string, value: string | undefined) => {
    if (!value) return;
    meta.append(el("dt", {}, label), el("dd", {}, value));
  };
  addRow("time", `${formatClock(ev.time)} (${ev.time})`);
  addRow("source", ev.source + (ev.agent ? ` (${ev.agent})` : ""));
  addRow("category", ev.category + (ev.name ? ` / ${ev.name}` : ""));
  addRow("severity", ev.severity);
  addRow("session", ev.session_id);
  addRow("trace", ev.trace_id);
  addRow("turn", ev.turn_id);
  addRow("call", ev.call_id);
  addRow("repo", ev.repo);
  addRow("cwd", ev.cwd ? shortPath(ev.cwd) : undefined);

  const payload = el("pre", { class: "detail-payload" });
  payload.textContent = JSON.stringify(ev, null, 2);

  const close = el("button", { class: "detail-close", title: "close" }, "×");
  close.addEventListener("click", onClose);

  pane.append(
    close,
    el("h2", {}, ev.summary || ev.name || ev.category),
    meta,
    payload,
  );
}
