import { capturedEvent, errorSignatures, sessionEvents, sessions } from "../../api";
import type { ErrorSignature, FirehoseEvent } from "../../api";
import { clear, el, keepFocus } from "../../dom";
import { formatDuration } from "../../format";
import { createScope, membership, selectSession } from "../../scope";
import { activeRange, inWindow, sessionKey } from "../session/context";
import type { Range, SessionTabContext } from "../session/context";
import type { ScopeStore } from "../../scope";
import { eventLabel, stripControl } from "../score/model";
import {sequenceRuns,compareSequences} from "./sequence";
import {renderSequenceComparison} from "./sequence-view";
import { buildLoops } from "./model";
import type { Interval, LoopGroup } from "./model";

export const PAGE_SIZE = 40;
export const SIGNATURE_TIMEOUT_MS = 4000;

/** A historical snapshot. Its own detail region never writes the shared pane. */
export function createLoops(store: ScopeStore = createScope()) {
  const sessionSelect = el("select", {"aria-label": "Loop session"});
  const sourceSelect = el("select", {"aria-label": "Loop source"});
  const refreshButton = el("button", {}, "Refresh history");
  const sessionStatus = el("span", {class: "dim", role: "status"});
  const body = el("div", {class: "loops-body"});
  const notice = el("p", {role:"status"});
  const detail = el("section", {class: "loops-detail", "aria-label": "Captured event detail"});
  const root = el("section", {class: "loops"},
    el("h2", {}, "Loop Observatory"),
    el("p", {class: "dim"}, "Recurring error observations in one session. Compare captured activity between recurrences; these are not proven attempts or evidence of a fix."),
    el("div", {class: "loops-controls"}, el("label", {}, "Session ", sessionSelect), el("label", {}, "Source ", sourceSelect), refreshButton, sessionStatus), body, notice, detail);
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
  // Session-tab context: the window filters timed lists; lastRef is the key of the session last delivered.
  let win: Range | null = null, lastRef: string | null = null, lockedSource = false, detailEvent: FirehoseEvent | undefined;
  // True while the scope session was written by this panel's own pickers: they stay usable and nothing reloads.
  let selfWritten = false;
  function writeScope(ref: {id: string; source?: string}) {
    const cur = store.get();
    selfWritten = true; lastRef = sessionKey(ref);
    // Adding a source to the same id refines in place; the shared window must survive it.
    if (cur.session && cur.session.id === ref.id && !cur.session.source) {
      // Refinement still answers to containment: parents stay only when the source-aware resolver confirms this exact (source, session).
      const member = cur.project || cur.worktree ? membership(store, cur) : undefined;
      if (!member || member(ref)) store.narrow({session: ref, window: cur.window});
      else store.replaceContext({session: ref, window: cur.window});
    }
    else selectSession(store, ref);
  }
  const setSourceDisabled = (v: boolean) => { sourceSelect.disabled = v || lockedSource; };

  let comparison: {a: [string,string]; b: [string,string]; view: HTMLElement; caption: string; numbering: string} | undefined;
  let referenceDraft: string | undefined, comparisonNotice = "";
  function resetComparison(message = "") { comparison = undefined; referenceDraft = undefined; comparisonNotice = message; notice.textContent=message; cancelDetail(); }
  function buildComparison(group: LoopGroup, a: Interval, b: Interval) {
    cancelDetail();
    const aIndex=group.intervals.indexOf(a)+1,bIndex=group.intervals.indexOf(b)+1;
    comparison={a:[a.from.id,a.to.id],b:[b.from.id,b.to.id],numbering:`${aIndex}:${bIndex}`,caption:`A interval ${aIndex}: ${a.from.time} → ${a.to.time}; B interval ${bIndex}: ${b.from.time} → ${b.to.time}`,view:renderSequenceComparison(compareSequences(sequenceRuns(model.events,a.fromIndex,a.toIndex),sequenceRuns(model.events,b.fromIndex,b.toIndex)),event=>void selectEvent(event),cancelDetail)};
    referenceDraft=String(bIndex);notice.textContent=comparisonNotice=`Comparing interval ${aIndex} with interval ${bIndex}.`;
  }
  const intervalInWindow = (i: Interval) => inWindow(i.from.time, win) && inWindow(i.to.time, win);
  function cancelDetail() { selection++; detailAbort?.abort(); detailAbort = undefined; detailEvent = undefined; clear(detail); }
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
    clear(detail); detailEvent = event;
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
    notice.textContent=comparisonNotice;
    if (!model.events.length) { body.append(el("p", {}, "No captured events in this session and source.")); restore(); return; }
    if (!model.groups.length) { body.append(el("p", {}, "No repeated Error Signatures in the loaded history.")); restore(); return; }
    const active = model.groups.find(g => g.key === activeKey) ?? model.groups[0];
    activeKey = active.key;
    body.append(el("h3", {}, `${model.groups.length} recurring Error Signatures`));
    const groups = el("div", {class: "loops-signatures"});
    for (const group of model.groups.slice(groupPage * PAGE_SIZE, (groupPage + 1) * PAGE_SIZE)) {
      const b = button(`${eventLabel(group.occurrences[0])} · ${group.occurrences.length} occurrences`, () => { if (group.key === activeKey) return; activeKey = group.key; occurrencePage = 0; evidencePage = 0; interval = undefined; resetComparison(); draw(); }, `signature:${group.key}`);
      b.setAttribute("aria-pressed", String(group.key === activeKey)); groups.append(b);
    }
    body.append(groups);
    pager(body, groupPage, model.groups.length, "signatures", page => { groupPage = page; draw(); });
    body.append(el("h3", {}, stripControl(active.key)), el("p", {class: "dim"}, `${active.fallbackOccurrences} of ${active.occurrences.length} selected occurrences use local fallback identity.`), overview(active));
    const visible = active.occurrences.map((event, i) => ({event, i})).filter(item => inWindow(item.event.time, win));
    occurrencePage = Math.min(occurrencePage, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1));
    if (win) body.append(el("p", {class: "dim", role: "status", "data-key": "occurrence-window"}, `${visible.length} of ${active.occurrences.length} occurrences in window`));
    const pageItems = visible.slice(occurrencePage * PAGE_SIZE, (occurrencePage + 1) * PAGE_SIZE);
    const list = el("ol", {class: "loops-occurrences", start: String((pageItems[0]?.i ?? 0) + 1)});
    pageItems.forEach(({event, i}) => {
      const row = el("li", {class: "loop-occurrence"}, button(`View occurrence ${i + 1}`, () => void selectEvent(event)), el("time", {datetime: event.time}, event.time));
      if (i === 0) row.append(el("span", {class: "dim"}, "Baseline observation"));
      else if (!intervalInWindow(active.intervals[i - 1])) row.append(el("span", {class: "dim"}, `Interval ${i} reaches outside the window`));
      else row.append(button(`Compare interval ${i} · ${formatDuration(active.intervals[i - 1].elapsedMs)}`, () => { interval = active.intervals[i - 1]; evidencePage = 0; resetComparison(); draw(); }));
      list.append(row);
    });
    body.append(list);
    pager(body, occurrencePage, visible.length, "occurrences", page => { occurrencePage = page; draw(); });
    if (interval) {
      body.append(el("h3", {}, "Captured activity between recurrences"), el("p", {}, `${interval.from.time} → ${interval.to.time} · ${formatDuration(interval.elapsedMs)}`),
        el("p", {class: "dim"}, "After the first observation through the next, ordered by time then event id. Synthetic state transitions excluded. Category counts describe captured events, not successful work."),
        el("p", {class: "loops-counts"}, Object.entries(interval.counts).map(([c, n]) => `${c}: ${n}`).join(" · ")));
      if (active.intervals.length < 2) body.append(el("p", {}, "Sequence comparison needs at least three occurrences (two intervals) of this signature."));
      else {
        const current=active.intervals.indexOf(interval), reference=el("input", {type:"number",min:"1",max:String(active.intervals.length),step:"1","aria-label":"Reference interval B","data-key":"sequence:reference"});
        reference.value=referenceDraft ?? String(current>0?current:2);
        reference.oninput=()=>{const value=reference.value;comparison?.view.remove();body.querySelector(".loops-sequence-caption")?.remove();resetComparison();referenceDraft=value;notice.textContent="";const feedback=body.querySelector(".loops-comparison-feedback");if(feedback)feedback.textContent="";};
        body.append(el("label", {}, `Compare selected interval A (${current+1}) with interval B `,reference),button("Compare sequences",()=>{
          const number=Number(reference.value);
          if (!Number.isInteger(number)||number<1||number>active.intervals.length) {resetComparison(`Enter a whole interval number from 1 to ${active.intervals.length}.`);referenceDraft=reference.value;draw();return;}
          if(!intervalInWindow(active.intervals[number-1])){resetComparison(`Interval ${number} is outside the current window.`);referenceDraft=reference.value;draw();return;}
          if(number===current+1){resetComparison("Choose a different interval for B.");referenceDraft=reference.value;draw();return;}
          buildComparison(active,interval!,active.intervals[number-1]);draw();
        },"sequence:compare"),el("p", {class:"loops-comparison-feedback"},comparisonNotice));
      }
      if(comparison) body.append(el("p", {class:"loops-sequence-caption"}, comparison.caption),comparison.view);
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
    if (activeKey && !group) { activeKey = undefined; interval = undefined; occurrencePage = 0; evidencePage = 0; resetComparison(comparison ? "Comparison cleared: selected signature membership changed." : ""); }
    if (group) {
      occurrencePage = Math.min(occurrencePage, Math.floor((group.occurrences.length - 1) / PAGE_SIZE));
      if (interval) {
        const prior = interval;
        interval = group.intervals.find(i => i.from.id === prior.from.id && i.to.id === prior.to.id);
        if (!interval) { evidencePage = 0; cancelDetail(); }
      }
    }
    if (comparison && group) {
      const prior=comparison;
      const a=group.intervals.find(i=>i.from.id===prior.a[0]&&i.to.id===prior.a[1]);
      const b=group.intervals.find(i=>i.from.id===prior.b[0]&&i.to.id===prior.b[1]);
      if(a&&b) { if(prior.numbering!==`${group.intervals.indexOf(a)+1}:${group.intervals.indexOf(b)+1}`) buildComparison(group,a,b); }
      else resetComparison("Comparison cleared: one or both interval boundaries changed with signature membership.");
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
    const current = ++version; resetComparison();
    phase = "loading"; setSourceDisabled(true);
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
      events = got; loaded = true; phase = "ready"; setSourceDisabled(false); selectSources(); derive();
    } catch (error) {
      if (current !== version) return;
      phase = "error"; setSourceDisabled(true);
      ctl.abort(); clearTimeout(signatureTimer); clear(body);
      body.append(el("p", {class: "error", role: "alert"}, `History unavailable: ${String(error)}`), button("Retry history", () => void open(sessionId, source)));
    }
  }
  async function refresh() {
    // Reconcile on every show, as Score.activate does.
    const want = store.get().session;
    if (want && (want.id !== sessionId || want.source !== source)) void open(want.id, want.source);
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
    if (sessionSelect.value) { void open(sessionSelect.value); writeScope({id: sessionSelect.value}); return; }
    store.narrow({session: undefined});
    version++; resetComparison(); historyAbort?.abort(); signatureAbort?.abort(); clearTimeout(signatureTimer);
    phase = "idle"; setSourceDisabled(true);
    sessionId = ""; source = undefined; events = []; signatures = []; activeKey = undefined; interval = undefined;
    selectSources(); derive();
  });
  sourceSelect.addEventListener("change", () => { if (phase !== "ready" || lockedSource) return; source = sourceSelect.value || undefined; writeScope(source ? {id: sessionId, source} : {id: sessionId}); resetComparison(); activeKey = undefined; interval = undefined; occurrencePage = 0; groupPage = 0; derive(); });
  refreshButton.addEventListener("click", () => { void refresh(); if (sessionId) void open(sessionId, source); });
  setSourceDisabled(true); selectSources(); draw();
  function windowChanged() {
    occurrencePage = 0;
    const outside = (e: FirehoseEvent) => !inWindow(e.time, win);
    const events = (ids: [string, string]) => model.events.filter(e => e.id === ids[0] || e.id === ids[1]);
    let dropped = false;
    if (comparison && (events(comparison.a).some(outside) || events(comparison.b).some(outside))) { resetComparison(); dropped = true; }
    if (interval && (outside(interval.from) || outside(interval.to))) { interval = undefined; evidencePage = 0; resetComparison(); dropped = true; }
    if (dropped || (detailEvent && outside(detailEvent))) cancelDetail();
    draw();
  }
  /** Session-tab context: the scope session is opened once per key; a window-only change redraws without refetching. */
  function setContext(ctx: SessionTabContext) {
    const next = activeRange(ctx.window);
    const changed = (next?.from ?? null) !== (win?.from ?? null) || (next?.to ?? null) !== (win?.to ?? null);
    win = next;
    const ref = ctx.session;
    const key = ref ? sessionKey(ref) : null;
    if (key !== lastRef) selfWritten = false;
    sessionSelect.disabled = !!ref && !selfWritten; lockedSource = !!ref?.source && !selfWritten;
    if (!ref) { lastRef = null; selfWritten = false; setSourceDisabled(phase !== "ready"); if (changed) windowChanged(); return; }
    setSourceDisabled(phase !== "ready");
    if (key !== lastRef) { lastRef = key; void open(ref.id, ref.source); return; }
    if (changed) windowChanged();
  }
  function deactivate() {
    lastRef = null; selfWritten = false;
    if (phase === "loading") {
      version++; historyAbort?.abort(); signatureAbort?.abort(); clearTimeout(signatureTimer); cancelDetail();
      phase = "error"; setSourceDisabled(true); clear(body);
      body.append(el("p", {class: "error", role: "alert"}, "History load paused."), button("Retry history", () => void open(sessionId, source)));
    }
  }
  return {root, open, refresh, setContext, deactivate};
}
