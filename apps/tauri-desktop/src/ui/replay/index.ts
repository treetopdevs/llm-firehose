import { attention, sessionEvents, capturedEvent } from "../../api";
import type { FirehoseEvent } from "../../api";
import { clear, el, keepControlFocus } from "../../dom";
import { buildReplayRoute, replayTimeLabel } from "./model";
import { readReplayBook, saveReplayBook } from "./notebook";
import type { ReplayBook, ReplayBranch } from "./notebook";
import { renderReplayMap } from "./map";
import { sessionRefLabel } from "../../format";
import type { SessionDirectory } from "../../session-directory";
import { activeRange, inWindow, sessionKey } from "../session/context";
import type { Range, SessionTabContext } from "../session/context";
export function createReplay(openScore: (id: string, source: string) => void = () => { }, directory?: SessionDirectory) {
    let unsubscribe: (() => void) | undefined;
    // The loaded route is one session; its name replaces the id in labels, and event ids stay event ids.
    const routeName = () => { const ref = { id: loadedSession, source: loadedSource }; return sessionRefLabel(ref, directory?.lookup(ref)).label; };
    let selectionLine: HTMLElement | undefined;
    const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
    const source = el("input", { "aria-label": "Source" }), session = el("input", { "aria-label": "Session ID" }), choices = el("select", { "aria-label": "Known session" }), search = el("input", { type: "search", "aria-label": "Search captured route" }), title = el("input", { "aria-label": "Branch title", maxlength: "120" }), steps = el("textarea", { "aria-label": "Hypothetical steps", rows: "5" });
    const choicesStatus = el("p", { role: "status" }), routeStatus = el("p", { role: "status" }), bookStatus = el("p", { role: "status" }), recovery = el("section"), selection = el("section", { tabindex: "-1", "aria-label": "Selected observation" }), evidence = el("section", { class: "replay-evidence" }), map = el("section"), routeList = el("section"), branchList = el("section"), editorRegion = el("section", { tabindex: "-1", "aria-label": "Hypothetical branch editor" }), reference = el("p"), confirmation = el("section", { class: "replay-confirmation" });
    const saveButton = button("Save branch", save), loadBranchButton = button("Load branch route", () => { if (!editor)
        return; clearScope(); source.value = editor.source; session.value = editor.sessionId; void loadRoute(); });
    editorRegion.append(el("h3", {}, "Hypothetical branch — outcome and timing unknown"), reference, el("label", {}, "Branch title ", title), el("label", {}, "One hypothetical step per line (1–12; no blank lines)", steps), saveButton, button("Discard edits", discard), loadBranchButton);
    const root = el("section", { class: "replay" }, el("h2", {}, "Replay lab"), el("p", { class: "dim" }, "Retrospective annotations only. Hypothetical steps are not executed and have unknown outcomes and timing. Captured order is not task causality."), el("p", { class: "dim" }, "Notebook text and references remain in this local browser/app origin and profile, outside capture privacy. No sync or encryption guarantee; clearing app data loses annotations. Cross-window conflicts are detected best effort, not transactionally."), el("div", { class: "replay-controls" }, choices, button("Refresh session choices", () => void refresh())), choicesStatus, el("div", { class: "replay-controls" }, el("label", {}, "Source ", source), el("label", {}, "Session ID ", session), button("Load captured route", () => void loadRoute())), routeStatus, selection, evidence, map, el("label", {}, "Search captured route ", search), routeList, el("h3", {}, "Saved hypothetical branches"), button("Refresh notebook", refreshNotebook), bookStatus, recovery, branchList, editorRegion, confirmation);
    let book: ReplayBook = { version: 1, branches: [] }, token: string | null = null, writable = false, dirty = false, editor: ReplayBranch | undefined;
    let route: ReturnType<typeof buildReplayRoute> | undefined, loadedSource = "", loadedSession = "", routePage = 0, branchPage = 0, focus: FirehoseEvent | undefined, verified: FirehoseEvent | undefined;
    let win: Range | null = null, lastRef: string | null = null, ctxRef: SessionTabContext["session"] = null;
    let choiceVersion = 0, loadVersion = 0, receiptVersion = 0, choiceAbort: AbortController | undefined, loadAbort: AbortController | undefined, receiptAbort: AbortController | undefined;
    function button(text: string, action: () => void, label?: string) { const b = el("button", label ? { "aria-label": label } : {}, text); b.addEventListener("click", action); return b; }
    function cancelReceipt() { receiptVersion++; receiptAbort?.abort(); verified = undefined; clear(evidence); }
    function clearFocus() { cancelReceipt(); focus = undefined; clear(selection); }
    function clearScope() { loadVersion++; loadAbort?.abort(); clearFocus(); route = undefined; loadedSource = ""; loadedSession = ""; routePage = 0; clear(routeList); clear(map); routeStatus.textContent = "Scope changed. Load captured route explicitly."; }
    function sameScope() { return !!editor && !!route && editor.source === loadedSource && editor.sessionId === loadedSession; }
    function drawMap() { clear(map); if (!route)
        return; const matching = sameScope(); if (editor && !matching)
        map.append(el("p", {}, "Branch reference belongs to a different source/session. Load branch route to compare; no anchor or alternative is paired here.")); map.append(renderReplayMap(route.events.filter(e => inWindow(e.time, win)), matching ? editor!.eventId : undefined, matching ? steps.value.split("\n").filter(s => s.trim()) : [], selectObservation, routeName())); }
    function pager(host: HTMLElement, page: number, total: number, size: number, name: string, change: (p: number) => void) { if (total <= size)
        return; const previous = button(`Previous ${name}`, () => change(page - 1)), next = button(`Next ${name}`, () => change(page + 1)); previous.disabled = page === 0; next.disabled = (page + 1) * size >= total; host.append(el("div", { class: "replay-controls" }, previous, el("span", {}, `${page * size + 1}–${Math.min((page + 1) * size, total)} of ${total}`), next)); }
    function drawRoute() { clear(routeList); drawMap(); if (!route)
        return; if (loadedSession)
        directory?.ensure({ id: loadedSession, source: loadedSource }); const needle = search.value.toLocaleLowerCase(); const scoped = route.events.filter(e => inWindow(e.time, win)); const filtered = scoped.filter(e => [e.id, e.summary, e.name, e.category].join(" ").toLocaleLowerCase().includes(needle)); routePage = Math.min(routePage, Math.max(0, Math.ceil(filtered.length / 40) - 1)); routeList.append(el("p", {}, `${filtered.length} filtered / ${route.events.length} captured observations. Invalid clocks are undated; no timing inference.${win ? ` ${scoped.length} of ${route.events.length} in window.` : ""}`)); const list = el("ol", { start: String(routePage * 40 + 1) }); for (const event of filtered.slice(routePage * 40, routePage * 40 + 40))
        list.append(el("li", { class: "replay-observation" }, el("span", {}, `${replayTimeLabel(event.time)} · ${event.summary || event.name || event.id}`), button("Select observation", () => selectObservation(event), `Select observation ${event.source} / ${routeName()} / ${event.id}`))); routeList.append(list); pager(routeList, routePage, filtered.length, 40, "observations", page => { clearFocus(); routePage = page; drawRoute(); }); }
    function selectObservation(event: FirehoseEvent) { clearFocus(); focus = event; selection.append(el("h3", {}, `Captured observation ${event.id}`), (selectionLine = el("p", {}, `${loadedSource} / ${routeName()} · ${replayTimeLabel(event.time)} · ${event.summary || event.name || ""}`)), el("p", { class: "dim" }, "Timeline metadata only. Inspect the captured receipt before creating a hypothetical branch."), button("Inspect captured receipt", () => void inspect(event))); selection.focus(); }
    async function inspect(event: FirehoseEvent) { cancelReceipt(); const current = receiptVersion, scope = loadVersion, ctl = new AbortController(); receiptAbort = ctl; evidence.append(el("p", { role: "status" }, "Loading captured receipt…")); try {
        const full = await capturedEvent(event.id, ctl.signal);
        if (ctl.signal.aborted || current !== receiptVersion || scope !== loadVersion || focus?.id !== event.id)
            return;
        if (full.id !== event.id || full.source !== loadedSource || full.session_id !== loadedSession)
            throw Error("Receipt identity mismatch");
        verified = full;
        clear(evidence);
        evidence.append(el("h3", {}, "Verified receipt identity — no outcome claim"), el("pre", {}, JSON.stringify(full, null, 2)), button("Open Score", () => { cancelReceipt(); openScore(loadedSession, loadedSource); }), button("New hypothetical branch", newBranch));
    }
    catch (error) {
        if (ctl.signal.aborted || current !== receiptVersion || scope !== loadVersion)
            return;
        evidence.replaceChildren(el("p", { role: "alert" }, `Receipt unavailable or conflicting: ${error instanceof Error ? error.message : String(error)}. Anchor not verified.`));
    } }
    function syncLoadBranch() {
        const other = !!editor && !!ctxRef && (editor.sessionId !== ctxRef.id || (!!ctxRef.source && editor.source !== ctxRef.source));
        loadBranchButton.disabled = !editor || other;
        loadBranchButton.title = other ? "This branch belongs to a different session than the one in scope. Change the session in scope to load its route." : "";
    }
    function form() { editorRegion.hidden = !editor; title.disabled = !editor; steps.disabled = !editor; saveButton.disabled = !editor || !writable; syncLoadBranch(); reference.textContent = editor ? `Immutable anchor reference: ${editor.source} / ${editor.sessionId} / ${editor.eventId}. Stored references are not current receipt verification.` : ""; }
    function fill(branch: ReplayBranch | undefined) { editor = branch ? { ...branch, steps: [...branch.steps] } : undefined; title.value = branch?.title ?? ""; steps.value = branch?.steps.join("\n") ?? ""; dirty = false; clear(confirmation); form(); drawMap(); }
    function newBranch() { if (!writable) { bookStatus.textContent = "Cannot create a branch while the notebook is read-only. Recover the stored notebook first."; return; } if (dirty) {
        bookStatus.textContent = "Unsaved edits. Save or explicitly Discard edits before starting another branch.";
        return;
    } if (!verified || !verified.session_id) {
        bookStatus.textContent = "Inspect a captured receipt first.";
        return;
    } let id: string; try {
        id = crypto.randomUUID();
    }
    catch (error) {
        bookStatus.textContent = `Could not create branch ID: ${error instanceof Error ? error.message : String(error)}.`;
        return;
    } fill({ id, source: verified.source, sessionId: verified.session_id, eventId: verified.id, title: "", steps: [] }); dirty = true; bookStatus.textContent = "Unsaved hypothetical branch. Enter a title and 1–12 steps; no outcome or timing predicted."; editorRegion.focus(); }
    function openBranch(branch: ReplayBranch) { if (dirty) {
        bookStatus.textContent = "Unsaved edits. Save or explicitly Discard edits before opening another branch.";
        return;
    } cancelReceipt(); fill(branch); bookStatus.textContent = "Stored branch opened; no captured receipt fetched or verified."; editorRegion.focus(); }
    function save() { if (!editor || !writable)
        return;
        const lines = steps.value.split("\n").map(s => s.trim());
        while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const candidate = { ...editor, title: title.value.trim(), steps: lines }; const next = { version: 1 as const, branches: book.branches.some(b => b.id === candidate.id) ? book.branches.map(b => b.id === candidate.id ? candidate : b) : [...book.branches, candidate] }; const result = saveReplayBook(storage, token, next); if (!result.ok) {
        bookStatus.textContent = `Save failed: ${result.error}. Edits retained. On conflict, copy edits or Discard edits, then Refresh notebook.`;
        return;
    } book = next; token = result.token ?? null; fill(candidate); bookStatus.textContent = "Saved hypothetical branch locally. Outcome and timing remain unknown."; drawBranches(); }
    function discard() { const prior = editor && book.branches.find(b => b.id === editor!.id); fill(prior); bookStatus.textContent = "Unsaved edits discarded explicitly."; }
    function drawBranches() { clear(branchList); branchPage = Math.min(branchPage, Math.max(0, Math.ceil(book.branches.length / 20) - 1)); branchList.append(el("p", {}, `${book.branches.length} saved hypothetical branches`)); const list = el("ul", { class: "replay-branches" }); for (const branch of book.branches.slice(branchPage * 20, branchPage * 20 + 20))
        list.append(el("li", {}, el("h4", {}, branch.title), el("p", {}, `${branch.source} / ${branch.sessionId} / ${branch.eventId}`), button("Open branch", () => openBranch(branch), `Open branch ${branch.title} / ${branch.id}`), button("Delete branch", () => confirmDelete(branch)))); branchList.append(list); pager(branchList, branchPage, book.branches.length, 20, "branches", page => { cancelReceipt(); clear(confirmation); branchPage = page; drawBranches(); }); }
    function confirmDelete(branch: ReplayBranch) { clear(confirmation); confirmation.append(el("p", {}, `Delete hypothetical branch “${branch.title}” anchored at ${branch.source} / ${branch.sessionId} / ${branch.eventId}? Its saved text will be removed.${dirty && editor?.id === branch.id ? " Unsaved edits to this branch will also be lost." : ""}`), button("Confirm delete branch", () => { if (!writable)
        return; const next = { version: 1 as const, branches: book.branches.filter(b => b.id !== branch.id) }; const result = saveReplayBook(storage, token, next); if (!result.ok) {
        bookStatus.textContent = `Delete failed: ${result.error}. Saved branch and edits retained.`;
        return;
    } book = next; token = result.token ?? null; if (editor?.id === branch.id)
        fill(undefined); clear(confirmation); cancelReceipt(); drawBranches(); bookStatus.textContent = "Selected branch deleted."; }), button("Cancel deletion", () => clear(confirmation))); }
    function refreshNotebook() { if (dirty) {
        bookStatus.textContent = "Unsaved edits retained. Copy or Save them, or explicitly Discard edits before Refresh notebook.";
        return;
    } const result = readReplayBook(storage); book = result.book; token = result.token; writable = result.writable; clear(recovery); bookStatus.textContent = result.error ? `Notebook read-only: ${result.error}` : "Notebook loaded. Stored anchor references are not current verification."; if (!writable) {
        if (result.token !== null) {
            const raw = result.token;
            const copy = el("textarea", {readonly:"", "aria-label":"Notebook recovery copy", rows:"8"});
            copy.value = raw.slice(0,65536);
            recovery.append(el("h3", {}, "Read-only notebook recovery copy"), el("p", {}, `Showing ${Math.min(65536,raw.length)} of ${raw.length} stored characters${raw.length>65536?"; truncated prefix only":""}. No data was changed or reset.`), copy);
        } else recovery.append(el("p", {}, "Storage unavailable for recovery copy; this is not an empty writable notebook."));
    } cancelReceipt(); const id = editor?.id; fill(id ? book.branches.find(b => b.id === id) : undefined); drawBranches(); }
    async function loadRoute() { clearScope(); const s = source.value, id = session.value; if (!s.trim() || !id.trim()) {
        routeStatus.textContent = "Enter exact source/session.";
        return;
    } const current = loadVersion, ctl = new AbortController(); loadAbort = ctl; routeStatus.textContent = `Loading captured route ${s} / ${id}…`; try {
        const events = await sessionEvents(id, "timeline", ctl.signal);
        if (ctl.signal.aborted || current !== loadVersion || source.value !== s || session.value !== id)
            return;
        clearFocus();
        route = buildReplayRoute(events, s, id);
        loadedSource = s;
        loadedSession = id;
        routeStatus.textContent = `Snapshot ${s} / ${id}; loaded ${new Date().toISOString()}. ${route.missingIds} missing IDs omitted; ${route.duplicates} duplicate records; ${route.conflicts} conflicting IDs excluded; ${route.invalidTimes} undated observations. Reduced timeline transfer still uses an unbounded existing server scan.`;
        drawRoute();
    }
    catch (error) {
        if (ctl.signal.aborted || current !== loadVersion)
            return;
        routeStatus.textContent = `Route unavailable: ${error instanceof Error ? error.message : String(error)}. No prior route shown as new scope.`;
    } }
    async function refresh() { follow(); cancelReceipt(); refreshNotebook(); const current = ++choiceVersion; choiceAbort?.abort(); const ctl = new AbortController(); choiceAbort = ctl; choicesStatus.textContent = "Loading session choices…"; try {
        const result = await attention(ctl.signal);
        if (ctl.signal.aborted || current !== choiceVersion)
            return;
        clear(choices);
        choices.append(el("option", { value: "" }, "Choose source/session"));
        for (const row of result.sessions)
            choices.append(el("option", { value: JSON.stringify([row.source, row.id]) }, `${row.source} / ${row.id}`));
        choicesStatus.textContent = `${result.sessions.length} choices. Choosing only fills fields; captured route load is explicit.`;
    }
    catch (error) {
        if (ctl.signal.aborted || current !== choiceVersion)
            return;
        choicesStatus.textContent = `Choices unavailable: ${error instanceof Error ? error.message : String(error)}. Manual scope remains available.`;
    } }
    for (const field of [title, steps])
        field.addEventListener("input", () => { dirty = true; clear(confirmation); bookStatus.textContent = "Unsaved edits. Hypothetical only; outcome and timing unknown."; drawMap(); });
    source.addEventListener("input", clearScope);
    session.addEventListener("input", clearScope);
    choices.addEventListener("change", () => { if (!choices.value)
        return; clearScope(); const [s, id] = JSON.parse(choices.value) as [
        string,
        string
    ]; source.value = s; session.value = id; });
    search.addEventListener("input", () => { clearFocus(); routePage = 0; drawRoute(); });
    /** A name that arrives late relabels the route in place; page, selection and receipt stay. */
    function relabel() { if (!route)
        return; const restore = keepControlFocus(root); drawRoute(); if (focus && selectionLine && selection.contains(selectionLine))
        selectionLine.textContent = `${loadedSource} / ${routeName()} · ${replayTimeLabel(focus.time)} · ${focus.summary || focus.name || ""}`; restore(); }
    function follow() { if (!unsubscribe && directory) { unsubscribe = directory.subscribe(relabel); relabel(); } }
    function deactivate() { unsubscribe?.(); unsubscribe = undefined; lastRef = null; choicesStatus.textContent = "Session choices paused. Refresh on return."; choiceVersion++; choiceAbort?.abort(); loadVersion++; loadAbort?.abort(); cancelReceipt(); if (!route)
        routeStatus.textContent = "No captured route loaded. Load explicitly."; }
    choices.append(el("option", { value: "" }, "Choose source/session"));
    refreshNotebook();
    form();
    /** Session-tab context: the scope session is loaded once per key; window changes filter without refetching. Never touches the notebook. */
    function setContext(ctx: SessionTabContext) {
        follow();
        const next = activeRange(ctx.window);
        const changed = (next?.from ?? null) !== (win?.from ?? null) || (next?.to ?? null) !== (win?.to ?? null);
        win = next; ctxRef = ctx.session;
        const ref = ctx.session;
        session.disabled = !!ref; choices.disabled = !!ref; source.disabled = !!ref?.source;
        syncLoadBranch();
        if (!ref) { lastRef = null; if (changed) windowChanged(); return; }
        const key = sessionKey(ref);
        if (key !== lastRef) {
            lastRef = key;
            const keepSource = !ref.source && session.value === ref.id ? source.value : "";
            clearScope();
            session.value = ref.id; source.value = ref.source ?? keepSource;
            if (ref.source) void loadRoute(); else routeStatus.textContent = "Choose the source for this session";
            return;
        }
        if (changed) windowChanged();
    }
    function windowChanged() {
        if (!route) return;
        if (focus && !inWindow(focus.time, win)) clearFocus();
        routePage = 0;
        drawRoute();
    }
    return { root, refresh, deactivate, setContext };
}
