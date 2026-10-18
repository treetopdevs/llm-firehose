import { attention, sessionEvents, capturedEvent } from "../../api";
import type { FirehoseEvent } from "../../api";
import { clear, el } from "../../dom";
import { buildEcosystem, replayBeds, patchPhase } from "./model";
import type { PatchBed } from "./model";
import { renderEcosystemMap } from "./map";
export function createEcosystem(openScore: (id: string, source: string) => void = () => { }) {
    const choice = el("select", { "aria-label": "Known session" }), source = el("input", { "aria-label": "Source" }), session = el("input", { "aria-label": "Session ID" }), filter = el("input", { type: "search", "aria-label": "Filter file beds" }), slider = el("input", { type: "range", min: "0", max: "0", value: "0", step: "1", "aria-label": "Replay observation cursor" });
    const choiceStatus = el("p", { role: "status" }), status = el("p", { role: "status" }), replayStatus = el("p", { role: "status" }), board = el("section"), selected = el("section", { "aria-label": "Selected file bed", tabindex: "-1" }), evidence = el("section", { class: "ecosystem-evidence" }), other = el("section");
    const play = button("Play", togglePlay);
    const root = el("section", { class: "ecosystem" }, el("h2", {}, "Patch Ecosystem"), el("p", { class: "dim" }, "Observed file paths, not canonical filesystem identities. Stems count observations, not edits, changed lines, or patch quality. Reversions and net content changes are unavailable."), el("p", { class: "dim" }, "Explicit load reads full stored session history because reduced views omit file paths. Transfer and the existing server history scan are unbounded. No filesystem or Git reads."), el("div", { class: "ecosystem-controls" }, choice, button("Refresh session choices", () => void refresh())), choiceStatus, el("div", { class: "ecosystem-controls" }, el("label", {}, "Source ", source), el("label", {}, "Session ID ", session), button("Load file history", () => void load())), status, selected, evidence, el("div", { class: "ecosystem-controls" }, button("Beginning", () => setCursor(0)), button("Previous observation", () => setCursor(cursor - 1)), play, button("Next observation", () => setCursor(cursor + 1)), button("Latest", () => setCursor(model?.events.length ?? 0)), slider), replayStatus, el("p", { class: "dim" }, "Playback advances one dated observation every250ms, not wall time. Invalid clocks are listed separately. Completion means source-reported file-tool completion, not verified content. Failure overrides attempt; unknown status stays unknown."), el("label", {}, "Filter paths / workspace ", filter), board, other);
    let model: ReturnType<typeof buildEcosystem> | undefined, cursor = 0, bedPage = 0, memberPage = 0, undatedPage = 0, unknownPage = 0, bedKey: string | undefined, loadedSource = "", loadedSession = "";
    let choiceVersion = 0, loadVersion = 0, receiptVersion = 0;
    let choiceAbort: AbortController | undefined, loadAbort: AbortController | undefined, receiptAbort: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined;
    function button(text: string, action: () => void, label?: string) { const b = el("button", label ? { "aria-label": label } : {}, text); b.addEventListener("click", action); return b; }
    function pause() { if (timer !== undefined)
        clearInterval(timer); timer = undefined; play.textContent = "Play"; }
    function cancelReceipt() { receiptVersion++; receiptAbort?.abort(); clear(evidence); }
    function clearScope() { pause(); loadVersion++; loadAbort?.abort(); cancelReceipt(); model = undefined; bedKey = undefined; cursor = 0; bedPage = 0; memberPage = 0; undatedPage = 0; unknownPage = 0; loadedSource = ""; loadedSession = ""; clear(selected); draw(); status.textContent = "Scope changed. Load file history explicitly."; }
    function pager(host: HTMLElement, page: number, total: number, size: number, name: string, change: (p: number) => void) { if (total <= size)
        return; const previous = button(`Previous ${name}`, () => change(page - 1)), next = button(`Next ${name}`, () => change(page + 1)); previous.disabled = page === 0; next.disabled = (page + 1) * size >= total; host.append(el("div", { class: "ecosystem-controls" }, previous, el("span", {}, `${page * size + 1}–${Math.min((page + 1) * size, total)} of ${total}`), next)); }
    function observations(host: HTMLElement, events: FirehoseEvent[], page: number, name: string, change: (p: number) => void) { const list = el("ol", { class: `ecosystem-${name}`, start: String(page * 40 + 1) }); for (const event of events.slice(page * 40, page * 40 + 40))
        list.append(el("li", {}, el("span", {}, `${event.time} · ${event.id} · ${patchPhase(event)} · native phase: ${typeof event.payload?.phase === "string" ? event.payload.phase : "not recorded"}; status: ${typeof event.payload?.status === "string" ? event.payload.status : "not recorded"}`), button("Inspect captured receipt", () => void inspect(event), `Inspect ${event.source} / ${event.session_id} / ${event.id}`))); host.append(list); pager(host, page, events.length, 40, name, change); }
    function draw() {
        clear(board);
        clear(other);
        slider.max = String(model?.events.length ?? 0);
        slider.value = String(cursor);
        slider.disabled = !model;
        play.disabled = !model || !model.events.length;
        replayStatus.textContent = `${cursor} of ${model?.events.length ?? 0} dated file observations visible.`;
        if (!model)
            return;
        const visible = model.events.slice(0, cursor), beds = replayBeds(model, cursor), needle = filter.value.toLocaleLowerCase();
        const matching = beds.filter(b => `${b.path} ${b.workspace}`.toLocaleLowerCase().includes(needle));
        bedPage = Math.min(bedPage, Math.max(0, Math.ceil(matching.length / 20) - 1));
        const page = matching.slice(bedPage * 20, bedPage * 20 + 20);
        board.append(el("h3", {}, `${matching.length} filtered / ${beds.length} file beds`), el("p", { class: "dim" }, "Map and list show the same stable page of20 beds. Empty beds retain position during replay; density does not imply conflict or quality."), renderEcosystemMap(page, visible, selectBed));
        const list = el("ul", { class: "ecosystem-beds" });
        for (const bed of page)
            list.append(el("li", { class: "ecosystem-bed" }, el("span", {}, `${bed.path} · ${bed.workspace} · ${bed.eventIds.length} visible observations`), button("Select file bed", () => selectBed(bed), `Select file bed ${bed.workspace} / ${bed.path}`)));
        board.append(list);
        if (!matching.length)
            board.append(el("p", {}, "No file beds match. Unknown-path and undated file observations remain below."));
        pager(board, bedPage, matching.length, 20, "beds", page => { pause(); cancelReceipt(); bedKey = undefined; clear(selected); bedPage = page; draw(); });
        const known = new Set(model.beds.flatMap(b => b.eventIds)), unknown = visible.filter(e => !known.has(e.id));
        unknownPage = Math.min(unknownPage, Math.max(0, Math.ceil(unknown.length / 40) - 1));
        other.append(el("h3", {}, `${unknown.length} replay-visible observations without usable paths`));
        observations(other, unknown, unknownPage, "unknown", page => { pause(); cancelReceipt(); unknownPage = page; draw(); });
        other.append(el("h3", {}, `${model.undated.length} undated file observations — excluded from timed growth`));
        observations(other, model.undated, undatedPage, "undated", page => { pause(); cancelReceipt(); undatedPage = page; draw(); });
        drawSelected();
    }
    function selectBed(bed: PatchBed) { pause(); cancelReceipt(); bedKey = bed.key; memberPage = 0; drawSelected(); selected.focus(); }
    function drawSelected() { clear(selected); if (!model || !bedKey)
        return; const bed = replayBeds(model, cursor).find(b => b.key === bedKey); if (!bed)
        return; const ids = new Set(bed.eventIds), events = model.events.slice(0, cursor).filter(e => ids.has(e.id)); memberPage = Math.min(memberPage, Math.max(0, Math.ceil(events.length / 40) - 1)); const counts = { attempt: 0, complete: 0, failed: 0, unknown: 0 }; for (const event of events)
        counts[patchPhase(event)]++; selected.append(el("h3", {}, bed.path), el("p", {}, `Workspace: ${bed.workspace}`), el("p", {}, `${events.length} visible observations · attempts ${counts.attempt} · reported-complete ${counts.complete} · failures ${counts.failed} · unknown ${counts.unknown}`)); if (!events.length)
        selected.append(el("p", {}, "No observations for this bed at the replay cursor.")); observations(selected, events, memberPage, "members", page => { pause(); cancelReceipt(); memberPage = page; drawSelected(); }); }
    function setCursor(next: number, playing = false) { if (!playing)
        pause(); cancelReceipt(); cursor = Math.min(model?.events.length ?? 0, Math.max(0, next)); memberPage = 0; unknownPage = 0; draw(); }
    function togglePlay() { if (timer !== undefined) {
        pause();
        return;
    } if (!model || cursor >= model.events.length) {
        replayStatus.textContent = `${cursor} of ${model?.events.length ?? 0} dated file observations visible. At latest observation. Choose Beginning or an earlier cursor before playing.`;
        return;
    } play.textContent = "Pause"; timer = setInterval(() => { setCursor(cursor + 1, true); if (!model || cursor >= model.events.length)
        pause(); }, 250); }
    async function inspect(event: FirehoseEvent) { pause(); cancelReceipt(); const token = receiptVersion, scope = loadVersion, ctl = new AbortController(); receiptAbort = ctl; evidence.append(el("p", { role: "status" }, "Loading captured receipt…")); try {
        const full = await capturedEvent(event.id, ctl.signal);
        if (ctl.signal.aborted || token !== receiptVersion || scope !== loadVersion)
            return;
        if (full.id !== event.id || full.source !== loadedSource || full.session_id !== loadedSession)
            throw Error("Receipt identity mismatch");
        clear(evidence);
        evidence.append(el("h3", {}, "Full captured receipt — not verified file content"), el("pre", {}, JSON.stringify(full, null, 2)), button("Open Score", () => { cancelReceipt(); openScore(loadedSession, loadedSource); }));
    }
    catch (error) {
        if (ctl.signal.aborted || token !== receiptVersion || scope !== loadVersion)
            return;
        clear(evidence);
        evidence.append(el("p", { role: "alert" }, `Receipt unavailable or conflicting: ${error instanceof Error ? error.message : String(error)}. File metadata retained; no content verification.`));
    } }
    async function load() { clearScope(); const s = source.value, id = session.value; if (!s.trim() || !id.trim()) {
        status.textContent = "Enter exact source and session ID.";
        return;
    } const token = loadVersion, ctl = new AbortController(); loadAbort = ctl; status.textContent = `Loading full captured file history for ${s} / ${id}…`; try {
        const events = await sessionEvents(id, undefined, ctl.signal);
        if (ctl.signal.aborted || token !== loadVersion || source.value !== s || session.value !== id)
            return;
        cancelReceipt();
        model = buildEcosystem(events, s, id);
        loadedSource = s;
        loadedSession = id;
        cursor = model.events.length;
        status.textContent = `Snapshot ${s} / ${id}; loaded ${new Date().toISOString()}. ${model.missingPaths} file observations without usable paths; ${model.missingIds} missing captured IDs omitted; ${model.duplicates} duplicate records; ${model.conflicts} conflicting captured IDs excluded. Paths are labels as stored, not canonical identities.`;
        draw();
    }
    catch (error) {
        if (ctl.signal.aborted || token !== loadVersion)
            return;
        status.textContent = `File history unavailable: ${error instanceof Error ? error.message : String(error)}. Load again to retry.`;
    } }
    async function refresh() { pause(); cancelReceipt(); const token = ++choiceVersion; choiceAbort?.abort(); const ctl = new AbortController(); choiceAbort = ctl; choiceStatus.textContent = "Loading session choices…"; try {
        const result = await attention(ctl.signal);
        if (ctl.signal.aborted || token !== choiceVersion)
            return;
        clear(choice);
        choice.append(el("option", { value: "" }, "Choose source/session"));
        for (const row of result.sessions)
            choice.append(el("option", { value: JSON.stringify([row.source, row.id]) }, `${row.source} / ${row.id}`));
        choiceStatus.textContent = `${result.sessions.length} source/session choices. Choosing fills fields only.`;
    }
    catch (error) {
        if (ctl.signal.aborted || token !== choiceVersion)
            return;
        choiceStatus.textContent = `Session choices unavailable: ${error instanceof Error ? error.message : String(error)}. Manual exact scope is available.`;
    } }
    source.addEventListener("input", clearScope);
    session.addEventListener("input", clearScope);
    choice.addEventListener("change", () => { if (!choice.value)
        return; clearScope(); const [s, id] = JSON.parse(choice.value) as [
        string,
        string
    ]; source.value = s; session.value = id; });
    filter.addEventListener("input", () => { pause(); cancelReceipt(); bedPage = 0; bedKey = undefined; clear(selected); draw(); });
    slider.addEventListener("input", () => setCursor(Number(slider.value)));
    function deactivate() { pause(); choiceVersion++; choiceAbort?.abort(); loadVersion++; loadAbort?.abort(); cancelReceipt(); if (!model)
        status.textContent = "No loaded file snapshot. Load file history explicitly."; }
    choice.append(el("option", { value: "" }, "Choose source/session"));
    status.textContent = "Choose exact scope, then Load file history.";
    draw();
    return { root, refresh, deactivate };
}
