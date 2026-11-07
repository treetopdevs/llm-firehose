import type { ErrorSignature, FirehoseEvent } from "../api";
import { clear, el } from "../dom";
import { formatClockMs, formatDuration, formatValue, latencyLabel, sessionRefLabel, workspaceLabel } from "../format";
import type { SessionDirectory } from "../session-directory";
import { coalesce } from "../state";

/** Finds the other observations of an event's tool call (same session and call id). */
export type Siblings = (ev: FirehoseEvent) => readonly FirehoseEvent[];

function phaseOf(ev: FirehoseEvent): string | undefined {
  const phase = ev.payload?.phase;
  return typeof phase === "string" ? phase : undefined;
}

// The first start and the first end at or after it. Dual observations of one
// phase (a hook push and a rollout tail) are coalesced first, exactly as the
// feed coalesces them, so the pair agrees with the row.
function pairCall(ev: FirehoseEvent, siblings: Siblings): { start?: FirehoseEvent; end?: FirehoseEvent } {
  let start: FirehoseEvent | undefined;
  let end: FirehoseEvent | undefined;
  const same = siblings(ev).filter((o) => o.source === ev.source && o.session_id === ev.session_id && o.call_id === ev.call_id);
  for (const row of coalesce(same)) {
    const other = row.event;
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
/** What a pane subscribed to the directory with; a pane shows one event, so one subscription. */
const paneOff = new WeakMap<HTMLElement, () => void>();

export function renderDetail(pane: HTMLElement, ev: FirehoseEvent | null, onClose: () => void, siblings: Siblings = () => [], signature?: ErrorSignature, offerEvidence?: (id: string) => void, directory?: SessionDirectory): void {
  paneOff.get(pane)?.();
  paneOff.delete(pane);
  clear(pane);
  if (!ev) {
    pane.classList.remove("open");
    return;
  }
  pane.classList.add("open");

  const toolName = typeof ev.payload?.tool_name === "string" ? ev.payload.tool_name : "";
  // The session is named when the directory knows it; the full id stays in the ids row's tooltip.
  const sessionName = () => (ev.session_id ? sessionRefLabel({ id: ev.session_id, source: ev.source }, directory?.lookup({ id: ev.session_id, source: ev.source })) : { label: "", resolved: false });
  const crumbText = () => [
    workspaceLabel(ev.repo, ev.cwd),
    ev.agent || ev.source,
    ev.session_id ? `session ${sessionName().label}` : "",
  ].filter(Boolean).join(" · ");
  const idsText = () => [
    ev.session_id && `session ${sessionName().resolved ? sessionName().label : ev.session_id}`,
    ev.turn_id && `turn ${ev.turn_id}`,
    ev.call_id && `call ${ev.call_id}`,
    ev.trace_id && `trace ${ev.trace_id}`,
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
  add("ids", idsText());
  const idsValue = meta.lastElementChild;
  if (ev.session_id && idsValue?.tagName === "DD") idsValue.setAttribute("title", `session id ${ev.session_id}`);
  add("source", ev.source);
  add("source time", ev.source_time);
  add("capture time", ev.capture_time);
  add("project identity", ev.repo_id);
  add("worktree identity", ev.worktree_id);
  add("repo", ev.repo);
  add("cwd", ev.cwd);
  if (ev.severity && ev.severity !== "info") add("severity", ev.severity);
  add("id", ev.id);

  // Keys the headline and timing rows already express are not repeated.
  const omit = new Set<string>();
  if (toolName) omit.add("tool_name");
  const sections: Node[] = [];
  if (signature) {
    // The daemon's Error Signature for this error: counts are global across the
    // whole captured history, not scoped to the open session.
    const dl = el("dl", { class: "detail-kv signature" });
    if (signature.sample) dl.append(el("dt", {}, "sample"), el("dd", {}, signature.sample));
    dl.append(
      el("dt", {}, "seen"),
      el("dd", {}, `${signature.count} ${signature.count === 1 ? "time" : "times"} across ${signature.sessions} ${signature.sessions === 1 ? "session" : "sessions"}`),
    );
    dl.append(el("dt", {}, "signature"), el("dd", {}, signature.key));
    // A signature exists from the first occurrence; it is only "recurring" past it.
    sections.push(el("h3", {}, signature.count > 1 ? "recurring error" : "error signature"), dl);
  }
  if (start || end) {
    omit.add("phase");
    if (start) sections.push(...kvTable("request", start.payload, omit));
    if (end) sections.push(...kvTable("response", end.payload, omit));
    const phase = phaseOf(ev);
    if (phase !== "start" && phase !== "end") sections.push(...kvTable("payload", ev.payload, omit));
  } else {
    sections.push(...kvTable("payload", ev.payload, omit));
  }

  const pre = el("pre", { class: "detail-payload" });
  pre.textContent = JSON.stringify(ev, null, 2);
  const json = el("details", {}, el("summary", {}, "json"), pre);

  const close = el("button", { class: "detail-close", title: "close" }, "×");
  close.addEventListener("click", onClose);

  if (offerEvidence && ev.id) {
    const offer = el("button", {}, "Use in Evidence Court");
    offer.addEventListener("click", () => offerEvidence(ev.id));
    sections.push(offer);
  }

  const crumbEl = el("div", { class: "detail-crumb dim", ...(ev.session_id ? { title: `session id ${ev.session_id}` } : {}) }, crumbText());
  pane.append(
    close,
    el("h2", {}, ev.summary || ev.name || ev.category),
    crumbEl,
    el("div", { class: "detail-headline" }, headline),
    meta,
    ...sections,
    json,
  );
  if (directory && ev.session_id) {
    // A name that arrives later replaces the short id in place; nothing else is redrawn.
    const ref = { id: ev.session_id, source: ev.source };
    directory.ensure(ref);
    const idsDd = idsValue?.tagName === "DD" ? idsValue : null;
    paneOff.set(pane, directory.subscribe(() => {
      crumbEl.textContent = crumbText();
      if (idsDd) idsDd.textContent = idsText();
    }));
  }
}
