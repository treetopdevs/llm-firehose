import { capturedEvent, errorSignatures, sessionEvents, sessions } from "../../api";
import type { ErrorSignature, FirehoseEvent } from "../../api";
import { clear, el, keepFocus } from "../../dom";
import { formatDuration } from "../../format";
import { eventLabel, stripControl } from "../score/model";
import { buildLoops } from "./model";
import type { Interval, LoopGroup } from "./model";

export const PAGE_SIZE = 40;
export const SIGNATURE_TIMEOUT_MS = 4000;

/** A historical snapshot. Its own detail region never writes the shared pane. */
export function createLoops() {
  const sessionSelect = el("select", {"aria-label": "Loop session"});
  const sourceSelect = el("select", {"aria-label": "Loop source"});
  const refreshButton = el("button", {}, "Refresh history");
  const sessionStatus = el("span", {class: "dim", role: "status"});
  const body = el("div", {class: "loops-body"});
  const detail = el("section", {class: "loops-detail", "aria-label": "Captured event detail"});
  const root = el("section", {class: "loops"},
    el("h2", {}, "Loop Observatory"),
    el("p", {class: "dim"}, "Recurring error observations in one session. Compare captured activity between recurrences; these are not proven attempts or evidence of a fix."),
    el("div", {class: "loops-controls"}, el("label", {}, "Session ", sessionSelect), el("label", {}, "Source ", sourceSelect), refreshButton, sessionStatus), body, detail);
  let phase: "idle" | "loading" | "error" | "ready" = "idle";
  let sessionId = "";
  let source: string | undefined;
  let events: FirehoseEvent[] = [];
  let signatures: ErrorSignature[] = [];
  let signatureStatus = "pending";
  let version = 0;
  let listingVersion = 0;
  let selection = 0;
  let detailAbort: AbortController | undefined;
  let signatureAbort: AbortController | undefined;
  let historyAbort: AbortController | undefined;
  let signatureTimer: ReturnType<typeof setTimeout> | undefined;
  let model = buildLoops([], "");
  let activeKey: string | undefined;
  let occurrencePage = 0;
  let groupPage = 0;
  let evidencePage = 0;
  let interval: Interval | undefined;

  function cancelDetail() { selection++; detailAbort?.abort(); detailAbort = undefined; clear(detail); }
  function button(text: string, handler: () => void, key = text) {
    const b = el("button", {"data-key": key}, text); b.addEventListener("click", handler); return b;
  }
  function pager(host: HTMLElement, page: number, total: number, label: string, change: (page: number) => void) {
    if (total <= PAGE_SIZE) return;
    const previous = button(`Previous ${label}`, () => change(page - 1)); previous.disabled = page === 0;
    const next = button(`Next ${label}`, () => change(page + 1)); next.disabled = (page + 1) * PAGE_SIZE >= total;
    host.append(el("div", {class: "loops-pager"}, previous, el("span", {}, `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`), next));
  }
  function renderDetail(event: FirehoseEvent, message: string) {
    clear(detail);
    const close = button("Close detail", cancelDetail);
    detail.append(el("h3", {}, "Captured event"), close, el("p", {role: "status"}, message), el("pre", {}, JSON.stringify(event, null, 2)));
  }
  async function selectEvent(event: FirehoseEvent) {
    cancelDetail();
    const token = selection;
    const current = version;
    const ctl = new AbortController(); detailAbort = ctl;
    renderDetail(event, "Loading full detail… Showing the loaded envelope.");
    try {
      const full = await capturedEvent(event.id, ctl.signal);
      if (current !== version || token !== selection || ctl.signal.aborted) return;
      if (full.id !== event.id || full.session_id !== sessionId || full.source !== event.source) throw new Error("mismatched event");
      renderDetail(full, "Full captured envelope");
    } catch {
      if (current !== version || token !== selection || ctl.signal.aborted) return;
      renderDetail(event, "Full detail unavailable. Showing the loaded envelope.");
    }
  }
  function overview(group: LoopGroup) {
    // One mark per pixel column, retaining the true time gaps. All occurrences
    // remain accessible through the paginated list, even when marks coalesce.
    const strip = el("div", {class: "loops-overview", role: "img", "aria-label": `${group.occurrences.length} occurrences positioned in time; nearby marks coalesce`});
    const start = Date.parse(group.occurrences[0].time);
    const end = Date.parse(group.occurrences[group.occurrences.length - 1].time);
    const columns = new Map<number, number>();
    for (const event of group.occurrences) {
      const column = Math.floor((Date.parse(event.time) - start) / Math.max(end - start, 1) * 599);
      columns.set(column, (columns.get(column) ?? 0) + 1);
    }
    for (const [column, count] of columns) strip.append(el("span", {class: "loops-mark", style: `left:${column / 599 * 100}%`, title: `${count} occurrence${count === 1 ? "" : "s"}`}));
    return el("div", {}, strip, el("p", {class: "dim"}, `${group.occurrences[0].time} → ${group.occurrences[group.occurrences.length - 1].time}`));
  }
  function draw() {
    if (phase === "loading" || phase === "error") return;
    const restore = keepFocus(root); clear(body);
    if (!sessionId) { body.append(el("p", {}, "Choose a session to inspect recurring errors.")); return; }
    body.append(el("p", {class: "dim"}, `Session ${sessionId} · ${source || "all sources (signatures stay separate)"} · ${model.events.length} captured events in this snapshot`));
    body.append(el("p", {class: "loops-disclosure", role: "status"},
      model.fallbackCount ? `${model.fallbackCount} error observations across this loaded session/source use local fallback identity. Authoritative membership is missing, unavailable, pending, or capped; local grouping may differ.` : "All loaded error observations use authoritative signature membership.",
      signatureStatus === "pending" ? " Signature lookup pending." : signatureStatus === "unavailable" ? " Signature lookup unavailable." : ""));
    if (model.excluded.invalidTime) body.append(el("p", {class: "loops-disclosure"}, `${model.excluded.invalidTime} observations excluded because their timestamps are invalid; recurrence counts may be understated.`));
    if (model.excluded.duplicate) body.append(el("p", {class: "dim"}, `${model.excluded.duplicate} duplicate event ids removed; counts reflect unique captured events.`));
    if (!model.events.length) { body.append(el("p", {}, "No captured events in this session and source.")); restore(); return; }
    if (!model.groups.length) { body.append(el("p", {}, "No repeated Error Signatures in the loaded history.")); restore(); return; }
    const active = model.groups.find(g => g.key === activeKey) ?? model.groups[0];
    activeKey = active.key;
    body.append(el("h3", {}, `${model.groups.length} recurring Error Signatures`));
    const groups = el("div", {class: "loops-signatures"});
    for (const group of model.groups.slice(groupPage * PAGE_SIZE, (groupPage + 1) * PAGE_SIZE)) {
      const b = button(`${eventLabel(group.occurrences[0])} · ${group.occurrences.length} occurrences`, () => { activeKey = group.key; occurrencePage = 0; interval = undefined; cancelDetail(); draw(); }, `signature:${group.key}`);
      b.setAttribute("aria-pressed", String(group.key === activeKey)); groups.append(b);
    }
    body.append(groups);
    pager(body, groupPage, model.groups.length, "signatures", page => { groupPage = page; draw(); });
    body.append(el("h3", {}, stripControl(active.key)), el("p", {class: "dim"}, `${active.fallbackOccurrences} of ${active.occurrences.length} selected occurrences use local fallback identity.`), overview(active));
    const list = el("ol", {class: "loops-occurrences", start: String(occurrencePage * PAGE_SIZE + 1)});
    active.occurrences.slice(occurrencePage * PAGE_SIZE, (occurrencePage + 1) * PAGE_SIZE).forEach((event, offset) => {
      const i = occurrencePage * PAGE_SIZE + offset;
      const row = el("li", {class: "loop-occurrence"}, button(`View occurrence ${i + 1}`, () => void selectEvent(event)), el("time", {datetime: event.time}, event.time));
      if (i === 0) row.append(el("span", {class: "dim"}, "Baseline observation"));
      else row.append(button(`Compare interval ${i} · ${formatDuration(active.intervals[i - 1].elapsedMs)}`, () => { interval = active.intervals[i - 1]; evidencePage = 0; cancelDetail(); draw(); }));
      list.append(row);
    });
    body.append(list);
    pager(body, occurrencePage, active.occurrences.length, "occurrences", page => { occurrencePage = page; draw(); });
    if (interval) {
      body.append(el("h3", {}, "Captured activity between recurrences"), el("p", {}, `${interval.from.time} → ${interval.to.time} · ${formatDuration(interval.elapsedMs)}`),
        el("p", {class: "dim"}, "After the first observation through the next, ordered by time then event id. Synthetic state transitions excluded. Category counts describe captured events, not successful work."),
        el("p", {class: "loops-counts"}, Object.entries(interval.counts).map(([c, n]) => `${c}: ${n}`).join(" · ")));
      const n = interval.toIndex - interval.fromIndex;
      body.append(el("p", {class: "dim"}, `${n} captured events in interval. Browse every event below.`));
      const evidence = el("ul", {class: "loops-evidence"});
      const evidenceStart = interval.fromIndex + 1 + evidencePage * PAGE_SIZE;
      for (const event of model.events.slice(evidenceStart, Math.min(interval.toIndex + 1, evidenceStart + PAGE_SIZE))) evidence.append(el("li", {}, button(`${event.time} · ${event.category} · ${eventLabel(event)}`, () => void selectEvent(event), `event:${event.id}`)));
      body.append(evidence);
      pager(body, evidencePage, n, "evidence", page => { evidencePage = page; draw(); });
    }
    restore();
  }
  function derive() {
    if (phase === "loading" || phase === "error") return;
    model = buildLoops(events, sessionId, source, signatures);
    const group = model.groups.find(g => g.key === activeKey);
    if (activeKey && !group) { activeKey = undefined; interval = undefined; occurrencePage = 0; evidencePage = 0; cancelDetail(); }
    if (group) {
      occurrencePage = Math.min(occurrencePage, Math.floor((group.occurrences.length - 1) / PAGE_SIZE));
      if (interval) {
        const prior = interval;
        interval = group.intervals.find(i => i.from.id === prior.from.id && i.to.id === prior.to.id);
        if (!interval) { evidencePage = 0; cancelDetail(); }
      }
    }
    groupPage = Math.min(groupPage, Math.max(0, Math.floor((model.groups.length - 1) / PAGE_SIZE)));
    draw();
  }
  function selectSources() {
    clear(sourceSelect); sourceSelect.append(el("option", {value: ""}, "All sources"));
    for (const name of [...new Set(events.filter(e => e.session_id === sessionId).map(e => e.source))].sort()) sourceSelect.append(el("option", {value: name}, name));
    if (source && ![...sourceSelect.options].some(o => o.value === source)) sourceSelect.append(el("option", {value: source}, source));
    sourceSelect.value = source || "";
  }
  async function open(id: string, selectedSource?: string) {
    const current = ++version; cancelDetail();
    phase = "loading"; sourceSelect.disabled = true;
    historyAbort?.abort();
    const historyCtl = new AbortController(); historyAbort = historyCtl;
    signatureAbort?.abort(); clearTimeout(signatureTimer);
    sessionId = id; source = selectedSource; events = []; signatures = []; signatureStatus = "pending"; activeKey = undefined; interval = undefined; occurrencePage = 0; groupPage = 0;
    if (![...sessionSelect.options].some(o => o.value === id)) sessionSelect.append(el("option", {value: id}, id));
    sessionSelect.value = id; selectSources(); clear(body); body.append(el("p", {role: "status"}, `Loading ${id}…`));
    const ctl = new AbortController(); signatureAbort = ctl;
    let loaded = false;
    signatureTimer = setTimeout(() => { ctl.abort(); if (current === version) { signatureStatus = "unavailable"; if (loaded) derive(); } }, SIGNATURE_TIMEOUT_MS);
    void errorSignatures(id, ctl.signal).then(got => {
      if (current !== version || ctl.signal.aborted) return;
      signatures = got; signatureStatus = "ready";
      if (loaded) derive();
    }).catch(() => { if (current === version) { signatureStatus = "unavailable"; if (loaded) derive(); } }).finally(() => { if (current === version) clearTimeout(signatureTimer); });
    try {
      const got = await sessionEvents(id, "timeline", historyCtl.signal);
      if (current !== version) return;
      events = got; loaded = true; phase = "ready"; sourceSelect.disabled = false; selectSources(); derive();
    } catch (error) {
      if (current !== version) return;
      phase = "error"; sourceSelect.disabled = true;
      ctl.abort(); clearTimeout(signatureTimer); clear(body);
      body.append(el("p", {class: "error", role: "alert"}, `History unavailable: ${String(error)}`), button("Retry history", () => void open(sessionId, source)));
    }
  }
  async function refresh() {
    const token = ++listingVersion; sessionStatus.textContent = "Loading session list…";
    try {
      const list = await sessions(); if (token !== listingVersion) return;
      clear(sessionSelect); sessionSelect.append(el("option", {value: ""}, "Choose a session"));
      for (const s of list) sessionSelect.append(el("option", {value: s.id}, `${s.agent || s.source} · ${s.id}`));
      if (sessionId && !list.some(s => s.id === sessionId)) sessionSelect.append(el("option", {value: sessionId}, sessionId));
      sessionSelect.value = sessionId; sessionStatus.textContent = list.length ? "" : "No sessions available.";
    } catch { if (token === listingVersion) sessionStatus.textContent = "Session list unavailable. Refresh to retry."; }
  }
  sessionSelect.addEventListener("change", () => {
    if (sessionSelect.value) { void open(sessionSelect.value); return; }
    version++; cancelDetail(); historyAbort?.abort(); signatureAbort?.abort(); clearTimeout(signatureTimer);
    phase = "idle"; sourceSelect.disabled = true;
    sessionId = ""; source = undefined; events = []; signatures = []; activeKey = undefined; interval = undefined;
    selectSources(); derive();
  });
  sourceSelect.addEventListener("change", () => { if (phase !== "ready") return; source = sourceSelect.value || undefined; cancelDetail(); activeKey = undefined; interval = undefined; occurrencePage = 0; groupPage = 0; derive(); });
  refreshButton.addEventListener("click", () => { void refresh(); if (sessionId) void open(sessionId, source); });
  sourceSelect.disabled = true; selectSources(); draw();
  return {root, open, refresh};
}
