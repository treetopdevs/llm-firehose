import type { FirehoseEvent } from "../api";
import { clear, el } from "../dom";
import { formatClockMs, formatDuration, formatValue, latencyLabel, workspaceLabel } from "../format";

/** Finds the other observations of an event's tool call (same session and call id). */
export type Siblings = (ev: FirehoseEvent) => readonly FirehoseEvent[];

function phaseOf(ev: FirehoseEvent): string | undefined {
  const phase = ev.payload?.phase;
  return typeof phase === "string" ? phase : undefined;
}

// The first start and the first end at or after it.
function pairCall(ev: FirehoseEvent, siblings: Siblings): { start?: FirehoseEvent; end?: FirehoseEvent } {
  let start: FirehoseEvent | undefined;
  let end: FirehoseEvent | undefined;
  for (const other of siblings(ev)) {
    if (other.session_id !== ev.session_id || other.call_id !== ev.call_id) continue;
    const phase = phaseOf(other);
    if (phase === "start" && !start) {
      start = other;
    } else if (phase === "end" && !end && (!start || Date.parse(other.time) >= Date.parse(start.time))) {
      end = other;
    }
  }
  return { start, end };
}

function kvTable(title: string, payload: Record<string, unknown> | undefined, omit: Set<string>): Node[] {
  const keys = Object.keys(payload ?? {}).filter((k) => !omit.has(k)).sort();
  if (keys.length === 0) return [];
  const dl = el("dl", { class: `detail-kv ${title}` });
  for (const k of keys) {
    dl.append(el("dt", {}, k), el("dd", {}, formatValue(payload![k])));
  }
  return [el("h3", {}, title), dl];
}

// The call altitude: one event as a designed table rather than a marshalled
// dump. Start and end are paired by call id, the duration is the difference,
// and the start payload is the request, the end payload the response. The
// full JSON stays behind a disclosure for when it is really wanted.
export function renderDetail(pane: HTMLElement, ev: FirehoseEvent | null, onClose: () => void, siblings: Siblings = () => []): void {
  clear(pane);
  if (!ev) {
    pane.classList.remove("open");
    return;
  }
  pane.classList.add("open");

  const toolName = typeof ev.payload?.tool_name === "string" ? ev.payload.tool_name : "";
  const crumb = [
    workspaceLabel(ev.repo, ev.cwd),
    ev.agent || ev.source,
    ev.session_id ? `session ${ev.session_id.slice(0, 8)}` : "",
  ].filter(Boolean).join(" · ");
  const headline = [
    formatClockMs(ev.time),
    ev.category + (!toolName && ev.name ? ` / ${ev.name}` : ""),
    toolName,
  ].filter(Boolean).join("  ");

  const meta = el("dl", { class: "detail-meta" });
  const add = (label: string, value: string | undefined) => {
    if (!value) return;
    meta.append(el("dt", {}, label), el("dd", {}, value));
  };
  let start: FirehoseEvent | undefined;
  let end: FirehoseEvent | undefined;
  if (ev.call_id) {
    ({ start, end } = pairCall(ev, siblings));
  }
  if (start) add("started", formatClockMs(start.time));
  if (start && end) {
    add("ended", `${formatClockMs(end.time)}  ${formatDuration(Date.parse(end.time) - Date.parse(start.time))}`);
  } else if (start) {
    add("ended", "no end captured");
  } else if (end) {
    add("ended", `${formatClockMs(end.time)}  no start captured`);
  } else {
    add("time", formatClockMs(ev.time));
  }
  if (ev.source_time && ev.capture_time) {
    const d = Date.parse(ev.capture_time) - Date.parse(ev.source_time);
    if (Number.isFinite(d)) add("captured", latencyLabel(d));
  }
  add(
    "ids",
    [
      ev.session_id && `session ${ev.session_id}`,
      ev.turn_id && `turn ${ev.turn_id}`,
      ev.call_id && `call ${ev.call_id}`,
      ev.trace_id && `trace ${ev.trace_id}`,
    ].filter(Boolean).join(" · "),
  );
  add("repo", ev.repo);
  add("cwd", ev.cwd);
  if (ev.severity && ev.severity !== "info") add("severity", ev.severity);
  add("id", ev.id);

  // Keys the headline and timing rows already express are not repeated.
  const omit = new Set<string>();
  if (toolName) omit.add("tool_name");
  const sections: Node[] = [];
  if (start || end) {
    omit.add("phase");
    if (start) sections.push(...kvTable("request", start.payload, omit));
    if (end) sections.push(...kvTable("response", end.payload, omit));
    if (ev.id !== start?.id && ev.id !== end?.id) sections.push(...kvTable("payload", ev.payload, omit));
  } else {
    sections.push(...kvTable("payload", ev.payload, omit));
  }

  const pre = el("pre", { class: "detail-payload" });
  pre.textContent = JSON.stringify(ev, null, 2);
  const json = el("details", {}, el("summary", {}, "json"), pre);

  const close = el("button", { class: "detail-close", title: "close" }, "×");
  close.addEventListener("click", onClose);

  pane.append(
    close,
    el("h2", {}, ev.summary || ev.name || ev.category),
    el("div", { class: "detail-crumb dim" }, crumb),
    el("div", { class: "detail-headline" }, headline),
    meta,
    ...sections,
    json,
  );
}
