import { capturedEvent, errorSignatures, errorSignatureSessions } from "../../api";
import type { ErrorSignature, ErrorSignatureSession, ErrorSignatureSessions } from "../../api";
import { clear, el, keepFocus } from "../../dom";
import { disambiguateSessionLabel, sessionRefLabel } from "../../format";
import type { SessionDirectory } from "../../session-directory";

const PAGE_SIZE = 50;
type Navigate = (session: string, source: string) => void;

/** Historical cross-session evidence. No live history scans or inferred retries. */
export function createStrata(openLoops: Navigate = () => {}, openScore: Navigate = () => {}, directory?: SessionDirectory) {
  const search = el("input", {type: "search", "aria-label": "Search Error Signatures", placeholder: "Search signatures"});
  const source = el("select", {"aria-label": "Signature source"});
  const status = el("p", {role: "status", class: "dim"});
  const signatures = el("div", {class: "strata-signatures"});
  const signaturePager = el("div");
  const history = el("section", {"aria-label": "Matching sessions", class: "strata-history"});
  const detail = el("section", {"aria-label": "Captured event evidence", class: "strata-detail"});
  const root = el("section", {class: "strata"}, el("h2", {}, "Session stratigraphy"),
    el("p", {class: "dim"}, "Find earlier sessions sharing an Error Signature. Matching observations do not prove retries, a shared strategy, or a fix."),
    el("div", {class: "strata-controls"}, el("label", {}, "Search ", search), el("label", {}, "Source ", source), button("Refresh signatures", () => void refresh())),
    status, signatures, signaturePager, history, detail);
  let items: ErrorSignature[] = [];
  let shown: { row: ErrorSignatureSession; name: HTMLElement }[] = [];
  let unsubscribe: (() => void) | undefined;
  let initialized = false;
  let signaturePage = 0;
  let active: ErrorSignature | undefined;
  let listVersion = 0, sessionVersion = 0, detailVersion = 0;
  let listAbort: AbortController | undefined, sessionAbort: AbortController | undefined, detailAbort: AbortController | undefined;
  function button(text: string, action: () => void, key = text) {
    const b = el("button", {"data-key": key}, text); b.addEventListener("click", action); return b;
  }
  function cancelDetail() { detailVersion++; detailAbort?.abort(); clear(detail); }
  function clearSelection() { sessionVersion++; sessionAbort?.abort(); cancelDetail(); active = undefined; clear(history); }
  function pager(host: HTMLElement, offset: number, total: number, label: string, change: (offset: number) => void) {
    const previous = button(`Previous ${label}`, () => change(Math.max(0, offset - PAGE_SIZE)));
    const next = button(`Next ${label}`, () => change(offset + PAGE_SIZE));
    previous.disabled = offset === 0; next.disabled = offset + PAGE_SIZE >= total;
    host.append(el("div", {class: "strata-pager"}, previous, el("span", {}, offset >= total ? `0 rows on this page · ${total} total` : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`), next));
  }
  function drawSignatures() {
    const restore = keepFocus(root); clear(signatures); clear(signaturePager);
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = items.filter(s => s.sessions >= 2 && (!source.value || source.value === s.source) && [s.key,s.sample,s.class,s.name].join(" ").toLocaleLowerCase().includes(query));
    if (!filtered.length) signatures.append(el("p", {}, "No recurring signatures match these filters."));
    for (const s of filtered.slice(signaturePage * PAGE_SIZE, (signaturePage + 1) * PAGE_SIZE)) {
      const b = button(`${s.sample || s.class || s.key} · ${s.key} · ${s.count} global observations · ${s.sessions} global sessions`, () => {
        active = s; drawSignatures(); void loadSessions(0);
      }, `signature:${s.key}`);
      b.setAttribute("aria-pressed", String(active?.key === s.key)); signatures.append(b);
    }
    if (filtered.length > PAGE_SIZE) pager(signaturePager, signaturePage * PAGE_SIZE, filtered.length, "signatures", offset => { clearSelection(); signaturePage = offset / PAGE_SIZE; drawSignatures(); });
    restore();
  }
  async function showEvidence(row: ErrorSignatureSession) {
    cancelDetail(); const token = detailVersion, scope = sessionVersion;
    const ctl = new AbortController(); detailAbort = ctl;
    detail.append(el("p", {role: "status"}, "Loading captured evidence…"));
    try {
      const event = await capturedEvent(row.sample_event_id, ctl.signal);
      if (ctl.signal.aborted || token !== detailVersion || scope !== sessionVersion) return;
      if (event.id !== row.sample_event_id || event.session_id !== row.session_id || event.source !== row.source) throw new Error("Evidence identity mismatch");
      clear(detail); detail.append(el("h3", {}, "Captured event evidence"), button("Close evidence", cancelDetail), el("pre", {}, JSON.stringify(event, null, 2)));
    } catch {
      if (ctl.signal.aborted || token !== detailVersion || scope !== sessionVersion) return;
      clear(detail); detail.append(el("p", {role: "alert"}, "Evidence unavailable. The captured event could not be loaded or did not match this session."), button("Retry evidence", () => void showEvidence(row)));
    }
  }
  /** Names the rows on screen in place; the page, selection and scroll are untouched. */
  function relabel() {
    const names = shown.map(({row}) => [`${row.source}\0${row.session_id}`, sessionRefLabel({id: row.session_id, source: row.source}, directory?.lookup({id: row.session_id, source: row.source})).label] as const);
    shown.forEach(({name}, i) => {
      const label = disambiguateSessionLabel(names[i]![0], names[i]![1], names);
      if (name.textContent !== label) name.textContent = label;
    });
  }
  function drawSessions(page: ErrorSignatureSessions, signature: ErrorSignature) {
    clear(history); shown = [];
    history.append(el("h3", {}, signature.sample || signature.class || signature.key), el("p", {class: "dim"}, signature.key),
      el("p", {class: "dim", role: "status"}, `Snapshot loaded ${new Date().toLocaleTimeString()}. Each page is a fresh snapshot; new arrivals can move rows between pages.`),
      button("Refresh sessions", () => void loadSessions(0)),
      el("p", {class: "dim"}, "Range strips show first-to-last matching error on this page’s shared time axis, not session duration or productive effort. The interior is not continuous activity; gaps do not prove capture completeness. Newest last observation first."));
    if (!page.sessions.length) history.append(el("p", {}, "No matching sessions on this page. Refresh to return to the latest snapshot."));
    const times = page.sessions.flatMap(r => [Date.parse(r.first_time), Date.parse(r.last_time)]).filter(Number.isFinite);
    const start = Math.min(...times), end = Math.max(...times);
    if (times.length) history.append(el("p", {class: "dim strata-axis"}, `${new Date(start).toISOString()} → ${new Date(end).toISOString()} (page axis)`));
    const list = el("ol", {class: "strata-sessions", start: String(page.offset + 1)});
    for (const row of page.sessions.slice(0, PAGE_SIZE)) {
      const first = Date.parse(row.first_time), last = Date.parse(row.last_time);
      const strip = el("div", {class: "strata-range", "aria-hidden": "true"});
      if (Number.isFinite(first) && Number.isFinite(last)) {
        const span = Math.max(1, end - start);
        strip.append(el("span", {style: `left:${(first-start)/span*100}%;width:${(last-first)/span*100}%`}));
      }
      const name = el("strong", {title: row.session_id}, row.session_id);
      shown.push({row, name}); directory?.ensure({id: row.session_id, source: row.source});
      list.append(el("li", {class: "strata-row"},
        el("div", {class: "strata-row-heading"}, name, el("span", {}, `${row.source} · ${row.count} matching observations`)),
        strip, el("div", {class: "strata-times"}, el("time", {datetime: row.first_time}, `First ${row.first_time}`), el("time", {datetime: row.last_time}, `Last ${row.last_time}`)),
        el("div", {class: "strata-actions"}, button("View evidence", () => void showEvidence(row), `evidence:${row.session_id}`), button("Open Loops", () => openLoops(row.session_id, row.source), `loops:${row.session_id}`), button("Open Score", () => openScore(row.session_id, row.source), `score:${row.session_id}`))));
    }
    history.append(list); relabel();
    if (page.total > PAGE_SIZE || page.offset) pager(history, page.offset, page.total, "sessions", offset => void loadSessions(offset));
  }
  async function loadSessions(offset: number) {
    if (!active) return;
    const signature = active, token = ++sessionVersion;
    sessionAbort?.abort(); cancelDetail(); const ctl = new AbortController(); sessionAbort = ctl;
    clear(history); history.append(el("p", {role: "status"}, "Loading matching sessions…"));
    try {
      const page = await errorSignatureSessions(signature.key, offset, PAGE_SIZE, ctl.signal);
      if (ctl.signal.aborted || token !== sessionVersion || active?.key !== signature.key) return;
      if (page.key !== signature.key || page.offset !== offset || page.limit !== PAGE_SIZE) throw new Error("Mismatched session page");
      drawSessions(page, signature);
    } catch (error) {
      if (ctl.signal.aborted || token !== sessionVersion || active?.key !== signature.key) return;
      clear(history); history.append(el("p", {role: "alert"}, `Matching sessions unavailable: ${String(error)}. ${/\b404\b/.test(String(error)) ? "An older daemon may not support this endpoint, or the signature may no longer exist in the current projection. Refresh signatures; if this persists, update or restart the daemon." : "Retry or refresh signatures to load a new snapshot."}`), button("Retry sessions", () => void loadSessions(offset)));
    }
  }
  async function refresh() {
    initialized = true;
    const token = ++listVersion; listAbort?.abort(); clearSelection(); items = []; signaturePage = 0;
    clear(signatures); clear(signaturePager); status.textContent = "Loading Error Signatures…";
    const ctl = new AbortController(); listAbort = ctl;
    try {
      const result = await errorSignatures("", ctl.signal);
      if (ctl.signal.aborted || token !== listVersion) return;
      items = result; const selected = source.value; clear(source); source.append(el("option", {value: ""}, "All sources"));
      for (const name of [...new Set(items.map(s => s.source))].sort()) source.append(el("option", {value: name}, name));
      if ([...source.options].some(o => o.value === selected)) source.value = selected;
      status.textContent = "Signatures observed in at least two sessions. Counts here are global; session rows show exact local counts."; drawSignatures();
    } catch (error) {
      if (ctl.signal.aborted || token !== listVersion) return;
      initialized = false;
      status.textContent = `Signatures unavailable: ${String(error)}. Refresh to retry.`;
    }
  }
  function filter() { clearSelection(); signaturePage = 0; drawSignatures(); }
  search.addEventListener("input", filter); source.addEventListener("change", filter);
  source.append(el("option", {value: ""}, "All sources"));
  // Navigation retains the historical snapshot and its selected page. Explicit
  // refresh controls intentionally discard that scope and cancel pending work.
  async function activate() {
    if (!unsubscribe) { unsubscribe = directory?.subscribe(relabel); relabel(); }
    if (!initialized) await refresh();
  }
  /** Stops following the directory; the page and selection stay for the next visit. */
  function deactivate() { unsubscribe?.(); unsubscribe = undefined; }
  return {root, refresh, activate, deactivate};
}
