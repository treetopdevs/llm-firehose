import { attention, capturedEvent } from "../../api";
import type { AttentionSnapshot, AttentionEvidence } from "../../api";
import { clear, el } from "../../dom";
import { BANDS, deriveAirspace } from "./model";
import type { AirspaceRow } from "./model";
import { renderAirspaceMap } from "./map";
export function createAirspace(openScore: (id: string, source: string) => void = () => { }, openInbox: () => void = () => { }, now: () => number = Date.now) {
    const windowSelect = el("select", { "aria-label": "Activity window" });
    for (const minutes of [5, 15, 60])
        windowSelect.append(el("option", { value: String(minutes) }, `${minutes} minutes`));
    windowSelect.value = "15";
    const sourceSelect = el("select", { "aria-label": "Airspace source" }), workspaceSelect = el("select", { "aria-label": "Airspace workspace" }), query = el("input", { type: "search", "aria-label": "Search Airspace", placeholder: "Search sessions" });
    const notice = el("p", { role: "status", class: "airspace-notice" }), board = el("section"), diagnostics = el("section"), selection = el("section", { "aria-label": "Selected session", tabindex: "-1" }), evidence = el("section", { "aria-label": "Captured receipt", class: "airspace-evidence", tabindex: "-1" });
    const root = el("section", { class: "airspace" }, el("h2", {}, "Attention Airspace"), el("p", { class: "dim" }, "Captured observations, not process monitoring. Completion may mean a turn completed, not that a session ended. No observation in a window is not proof of idleness."), el("div", { class: "airspace-controls" }, el("label", {}, "Recent window ", windowSelect), el("label", {}, "Source ", sourceSelect), el("label", {}, "Workspace ", workspaceSelect), query, button("Refresh snapshot", () => void refresh()), button("Open Attention inbox", openInbox)), notice, selection, evidence, board, diagnostics);
    let snapshot: AttentionSnapshot | undefined, fetchedAt: number | undefined, evaluatedAt = now(), page = 0, connected = true, active = true, loading = false, stale = true, error = "";
    let snapshotToken = 0, receiptToken = 0, snapshotAbort: AbortController | undefined, receiptAbort: AbortController | undefined;
    function button(text: string, action: () => void) { const b = el("button", {}, text); b.addEventListener("click", action); return b; }
    function value(select: HTMLSelectElement): string | undefined { return select.value === "all" ? undefined : JSON.parse(select.value) as string; }
    function options(select: HTMLSelectElement, values: string[]) { const previous = select.value || "all"; clear(select); select.append(el("option", { value: "all" }, "All")); for (const item of [...new Set(values)].sort())
        select.append(el("option", { value: JSON.stringify(item) }, item || "Unknown")); if ([...select.options].some(o => o.value === previous))
        select.value = previous; }
    function workspace(row: AttentionSnapshot["sessions"][number]) { return row.worktree_id || row.jj_workspace_id || row.cwd || row.repo || ""; }
    function cancelReceipt() { receiptToken++; receiptAbort?.abort(); clear(selection); clear(evidence); }
    function time(ms: number | undefined) { return ms === undefined ? "not fetched" : new Date(ms).toISOString(); }
    function drawNotice() { notice.textContent = `${!connected ? "Disconnected — snapshot stale. " : loading ? "Loading snapshot… " : stale ? "Snapshot stale. " : "Snapshot checked. "}${error ? `${error} ` : ""}Fetched at ${time(fetchedAt)}; ages evaluated at ${time(evaluatedAt)}. This is a fixed snapshot, not a live status.`; notice.classList.toggle("stale", stale || !connected); }
    function draw() {
        drawNotice();
        clear(board);
        clear(diagnostics);
        if (!snapshot) {
            board.append(el("p", {}, loading ? "Waiting for first snapshot…" : "No snapshot available. Refresh to retry."));
            return;
        }
        const derived = deriveAirspace(snapshot.sessions, { now: evaluatedAt, windowMs: Number(windowSelect.value) * 60000, source: value(sourceSelect), workspace: value(workspaceSelect), query: query.value });
        page = Math.min(page, Math.max(0, Math.ceil(derived.rows.length / 20) - 1));
        const rows = derived.rows.slice(page * 20, page * 20 + 20);
        board.append(el("p", {}, `${derived.rows.length} filtered / ${snapshot.sessions.length} total sessions`), el("p", { class: "airspace-counts" }, BANDS.map(b => `${b.label}: ${derived.counts[b.id]}`).join(" · ")));
        if (!rows.length)
            board.append(el("p", {}, "No sessions match this snapshot and filters."));
        else {
            board.append(renderAirspaceMap(rows, derived.counts, selectRow));
            const list = el("ol", { class: "airspace-list", start: String(page * 20 + 1) });
            for (const row of rows) {
                const session = row.session;
                list.append(el("li", { class: "airspace-row" }, el("h3", {}, `${session.source} / ${session.id}`), el("p", {}, `${BANDS.find(b => b.id === row.band)?.label} · workspace: ${row.workspace || "Unknown"}`), el("p", {}, `${session.pending ? "Pending observation" : "Latest observation"} age: ${row.eventAgeMs === null ? "unknown" : `${Math.floor(row.eventAgeMs / 1000)} seconds`} · ${row.clockNote}`), el("p", {}, `State reported: ${session.state}${session.uncertainty ? ` · ${session.uncertainty}` : ""}`), button("Select session", () => selectRow(row))));
            }
            board.append(list);
            if (derived.rows.length > 20) {
                const previous = button("Previous sessions", () => { cancelReceipt(); page--; draw(); }), next = button("Next sessions", () => { cancelReceipt(); page++; draw(); });
                previous.disabled = page === 0;
                next.disabled = (page + 1) * 20 >= derived.rows.length;
                board.append(el("div", { class: "airspace-controls" }, previous, el("span", {}, `${page * 20 + 1}–${Math.min((page + 1) * 20, derived.rows.length)} of ${derived.rows.length}`), next));
            }
        }
        diagnostics.append(el("h3", {}, `Capture warnings: ${snapshot.warnings.length} total; showing ${Math.min(10, snapshot.warnings.length)}`));
        const warnings = el("ul", { class: "airspace-warnings" });
        for (const warning of snapshot.warnings.slice(0, 10))
            warnings.append(el("li", {}, `${warning.source} / ${warning.time} · ${warning.summary}`));
        diagnostics.append(warnings);
        const gaps = snapshot.gaps ?? [];
        diagnostics.append(el("h3", {}, `Capture gaps: ${gaps.length} total; showing ${Math.min(10, gaps.length)}`));
        if (!gaps.length)
            diagnostics.append(el("p", {}, "No recorded capture gaps; this does not establish complete coverage."));
        const gapList = el("ul", { class: "airspace-gaps" });
        for (const gap of gaps.slice(0, 10))
            gapList.append(el("li", {}, `${gap.source} / ${gap.time} · ${gap.summary}`));
        diagnostics.append(gapList);
    }
    function selectRow(row: AirspaceRow) {
        cancelReceipt();
        const session = row.session;
        selection.append(el("h3", {}, `${session.source} / ${session.id}`), el("p", {}, `Workspace: ${row.workspace || "Unknown"}`), el("p", {class:"dim"}, stale ? "Selected from a stale snapshot. Receipt lookup checks the saved event identity; it does not refresh session state." : "Selected from the checked snapshot."));
        function summary(label: string, item: AttentionEvidence) { selection.append(el("h4", {}, label), el("p", {}, item.summary), el("p", {}, `${item.source_time !== undefined ? "Source event time" : "Event time"}: ${item.source_time ?? item.time}; event envelope time: ${item.time}; capture observed at: ${item.observed_at || "Unknown"}`)); }
        summary("Latest observation", session.last);
        selection.append(el("p", {class:"dim"}, "The latest receipt may differ from the observation that set the reported state. Inspecting it does not verify the band."));
        selection.append(el("p", {}, `Latest session capture observed at: ${session.last_observed_at || "Unknown"}`), button("Inspect latest observation", () => void inspect(row, session.last)));
        if (session.pending) {
            summary("Pending observation (age is not waiting duration)", session.pending);
            selection.append(button("Inspect pending receipt", () => void inspect(row, session.pending!)));
        }
        selection.focus();
    }
    async function inspect(row: AirspaceRow, item: AttentionEvidence) {
        receiptToken++;
        receiptAbort?.abort();
        clear(evidence);
        const token = receiptToken, ctl = new AbortController();
        receiptAbort = ctl;
        if (!connected || !active) {
            evidence.append(el("p", { role: "alert" }, "Disconnected or inactive. Connect and return to this view before inspecting."));
            return;
        }
        evidence.append(el("p", { role: "status" }, "Loading captured receipt…"));
        try {
            const event = await capturedEvent(item.event_id, ctl.signal);
            if (ctl.signal.aborted || token !== receiptToken || !active || !connected)
                return;
            if (event.id !== item.event_id || event.source !== row.session.source || event.session_id !== row.session.id)
                throw Error("Receipt identity mismatch");
            clear(evidence);
            evidence.append(el("h3", {}, "Captured receipt — not proof of resolution"), el("pre", {}, JSON.stringify(event, null, 2)), button("Open Score", () => { cancelReceipt(); openScore(row.session.id, row.session.source); }));
        }
        catch (cause) {
            if (ctl.signal.aborted || token !== receiptToken)
                return;
            clear(evidence);
            evidence.append(el("p", { role: "alert" }, `Receipt unavailable or conflicting: ${cause instanceof Error ? cause.message : String(cause)}. No resolution inferred.`));
        }
    }
    async function refresh() {
        const token = ++snapshotToken;
        snapshotAbort?.abort();
        cancelReceipt();
        error = "";
        stale = true;
        if (!connected || !active) {
            loading = false;
            draw();
            return;
        }
        const ctl = new AbortController();
        snapshotAbort = ctl;
        loading = true;
        draw();
        try {
            const result = await attention(ctl.signal);
            if (ctl.signal.aborted || token !== snapshotToken || !connected || !active)
                return;
            cancelReceipt();
            snapshot = result;
            fetchedAt = now();
            evaluatedAt = fetchedAt;
            stale = false;
            options(sourceSelect, snapshot.sessions.map(s => s.source));
            options(workspaceSelect, snapshot.sessions.map(workspace));
        }
        catch (cause) {
            if (ctl.signal.aborted || token !== snapshotToken)
                return;
            cancelReceipt();
            error = `Refresh failed: ${cause instanceof Error ? cause.message : String(cause)}.`;
            stale = true;
        }
        finally {
            if (token === snapshotToken) {
                loading = false;
                draw();
            }
        }
    }
    function localChange() { cancelReceipt(); page = 0; evaluatedAt = now(); draw(); }
    for (const select of [windowSelect, sourceSelect, workspaceSelect])
        select.addEventListener("change", localChange);
    query.addEventListener("input", localChange);
    function deactivate() { active = false; snapshotToken++; snapshotAbort?.abort(); loading = false; cancelReceipt(); }
    async function activate() { active = true; await refresh(); }
    function setConnected(value: boolean) { if (connected === value)
        return; connected = value; stale = true; error = ""; snapshotToken++; snapshotAbort?.abort(); loading = false; cancelReceipt(); draw(); }
    options(sourceSelect, []);
    options(workspaceSelect, []);
    draw();
    return { root, activate, refresh, deactivate, setConnected };
}
