import { attention, sessionEvents, capturedEvent } from "../../api";
import type { FirehoseEvent } from "../../api";
import { clear, el } from "../../dom";
import { buildLoom, loomTraversal } from "./model";
import type { LoomModel, LoomGroup, LoomDirection } from "./model";
import { renderLoomMap } from "./map";
export function createLoom(openScore: (id: string, source: string) => void = () => { }) {
    const choices = el("select", { "aria-label": "Known session" }), source = el("input", { "aria-label": "Source", placeholder: "Exact source" }), session = el("input", { "aria-label": "Session ID", placeholder: "Exact session ID" }), search = el("input", { "aria-label": "Search observations", type: "search" }), errors = el("input", { "aria-label": "Errors only", type: "checkbox" });
    const direction = el("select", {"aria-label": "Reference direction"}, ...["both", "upstream", "downstream"].map(value => el("option", {value}, value === "both" ? "Both directions" : value === "upstream" ? "Upstream (parents)" : "Downstream (children)")));
    const depth = el("select", {"aria-label": "Reference depth"}, ...[1, 2, 3, 4].map(value => el("option", {value: String(value)}, String(value))));
    const traversalControls = el("div", {class: "loom-controls"}, el("label", {}, "Reference direction ", direction), el("label", {}, "Reference depth ", depth));
    const choiceStatus = el("p", { role: "status" }), status = el("p", { role: "status", class: "loom-status" }), focusRegion = el("section", { "aria-label": "Focused observation", tabindex: "-1" }), evidence = el("section", { class: "loom-evidence", "aria-label": "Captured receipt" }), body = el("section"), groupsRegion = el("section"), membersRegion = el("section", { "aria-label": "Group members", tabindex: "-1" });
    const root = el("section", { class: "loom" }, el("h2", {}, "Causal Loom"), el("p", { class: "dim" }, "Inspect native identifiers within one exact source/session. Group membership is association, not a causal arrow. Native parent message references do not establish root cause or successful resolution."), el("div", { class: "loom-controls" }, el("label", {}, "Known session ", choices), button("Refresh session choices", () => void refresh())), choiceStatus, el("div", { class: "loom-controls" }, el("label", {}, "Source ", source), el("label", {}, "Session ID ", session), button("Load relationships", () => void load())), status, focusRegion, evidence, traversalControls, el("div", { class: "loom-controls" }, el("label", {}, "Search ", search), el("label", {}, errors, " Errors only")), body, groupsRegion, membersRegion);
    let model: LoomModel | undefined, loadedSource = "", loadedSession = "", loadedAt = "", focus: FirehoseEvent | undefined, selectedGroup: LoomGroup | undefined;
    let neighborhoodCache: {model: LoomModel; id: string; direction: string; depth: string; result: ReturnType<typeof loomTraversal>} | undefined;
    let observationPage = 0, groupPage = 0, parentPage = 0, memberPage = 0, choiceVersion = 0, loadVersion = 0, receiptVersion = 0;
    let choiceAbort: AbortController | undefined, loadAbort: AbortController | undefined, receiptAbort: AbortController | undefined;
    function button(text: string, action: () => void, accessible?: string) { const b = el("button", accessible ? { "aria-label": accessible } : {}, text); b.addEventListener("click", action); return b; }
    function cancelReceipt() { receiptVersion++; receiptAbort?.abort(); clear(evidence); }
    function clearFocus() { neighborhoodCache = undefined; cancelReceipt(); focus = undefined; selectedGroup = undefined; groupPage = 0; parentPage = 0; memberPage = 0; clear(focusRegion); clear(groupsRegion); clear(membersRegion); }
    function clearScope() { direction.value = "both"; depth.value = "1"; loadVersion++; loadAbort?.abort(); clearFocus(); model = undefined; loadedSource = ""; loadedSession = ""; loadedAt = ""; observationPage = 0; clear(body); status.textContent = "Scope changed. Load relationships explicitly."; }
    function pager(host: HTMLElement, page: number, total: number, size: number, name: string, change: (n: number) => void) { if (total <= size)
        return; const previous = button(`Previous ${name}`, () => change(page - 1)), next = button(`Next ${name}`, () => change(page + 1)); previous.disabled = page === 0; next.disabled = (page + 1) * size >= total; host.append(el("div", { class: "loom-controls" }, previous, el("span", {}, `${page * size + 1}–${Math.min((page + 1) * size, total)} of ${total}`), next)); }
    function drawObservations() {
        clear(body);
        if (!model)
            return;
        const needle = search.value.toLocaleLowerCase();
        const filtered = model.events.filter(e => (!errors.checked || e.category === "error" || e.severity === "error") && [e.id, e.name, e.summary, e.category, e.call_id, e.turn_id, e.message_id].join(" ").toLocaleLowerCase().includes(needle));
        observationPage = Math.min(observationPage, Math.max(0, Math.ceil(filtered.length / 40) - 1));
        body.append(el("p", {}, `${filtered.length} filtered / ${model.events.length} scoped observations; showing ${filtered.length ? observationPage * 40 + 1 : 0}–${Math.min((observationPage + 1) * 40, filtered.length)}`));
        if (!filtered.length)
            body.append(el("p", {}, "No observations match this snapshot and filters."));
        const list = el("ol", { start: String(observationPage * 40 + 1) });
        for (const event of filtered.slice(observationPage * 40, observationPage * 40 + 40))
            list.append(el("li", { class: "loom-observation" }, el("span", {}, `${event.time} · ${event.category} · ${event.summary || event.name || event.id}`), button("Focus observation", () => selectFocus(event), `Focus observation ${event.source} / ${event.session_id} / ${event.id}`)));
        body.append(list);
        pager(body, observationPage, filtered.length, 40, "observations", page => { clearFocus(); observationPage = page; drawObservations(); });
    }
    function selectFocus(event: FirehoseEvent) { clearFocus(); focus = event; focusRegion.append(el("h3", {}, `Observation ${event.id}`), el("p", {}, `${loadedSource} / ${loadedSession}`), el("p", { class: "dim" }, "Loaded correlation metadata, not the full captured envelope. Times do not establish direction or causality."), el("pre", {}, JSON.stringify(event, null, 2)), button("Inspect captured receipt", () => void inspect(event))); drawGroups(); focusRegion.focus(); }
    function drawGroups() {
        clear(groupsRegion);
        if (!model || !focus)
            return;
        if (!neighborhoodCache || neighborhoodCache.model !== model || neighborhoodCache.id !== focus.id || neighborhoodCache.direction !== direction.value || neighborhoodCache.depth !== depth.value)
            neighborhoodCache = {model, id: focus.id, direction: direction.value, depth: depth.value, result: loomTraversal(model, focus.id, direction.value as LoomDirection, Number(depth.value))};
        const neighborhood = neighborhoodCache.result;
        groupsRegion.append(el("h3", {}, "Native reference neighborhood"), el("p", { class: "dim" }, `Map shows up to 20 groups and 20 references from the selected pages. ${neighborhood.groups.length} groups; ${neighborhood.parents.length} native references total. Direction: ${direction.value}; maximum ${depth.value} reference ${depth.value === "1" ? "hop" : "hops"}. Missing/conflicting references are terminal; only resolved references expand the neighborhood. ${direction.value === "both" ? "Both directions may include siblings through a shared parent. " : ""} Resolved means a captured receipt carries the referenced message ID. References beyond the selected depth are not explored; this is not a complete ancestry claim. The map may omit arrows whose endpoints fall on other group pages; complete reference text remains in the paginated list. No inferred causality or chronological layout. Depth limits traversal, not loaded history or memory.`));
        groupsRegion.append(renderLoomMap(focus, neighborhood.groups.slice(groupPage * 20, groupPage * 20 + 20), neighborhood.parents.slice(parentPage * 20, parentPage * 20 + 20), selectGroup));
        if (!neighborhood.groups.length)
            groupsRegion.append(el("p", {}, "No supported identifiers for this observation. Its captured receipt is still inspectable."));
        const groups = el("ul", { class: "loom-groups" });
        for (const group of neighborhood.groups.slice(groupPage * 20, groupPage * 20 + 20))
            groups.append(el("li", {}, button(`${group.kind}: ${group.id} · ${group.members.length} members`, () => selectGroup(group), `Native group ${loadedSource} / ${loadedSession} / ${group.kind} / ${group.id}`)));
        groupsRegion.append(groups);
        pager(groupsRegion, groupPage, neighborhood.groups.length, 20, "groups", page => { cancelReceipt(); selectedGroup = undefined; clear(membersRegion); groupPage = page; drawGroups(); });
        const parents = el("ul", { class: "loom-parents" });
        for (const parent of neighborhood.parents.slice(parentPage * 20, parentPage * 20 + 20))
            parents.append(el("li", {}, `Native parent message reference: ${parent.parentKey} → ${parent.childKey} · ${parent.status} · ${parent.evidenceIds.length} supporting observations. ${parent.status !== "resolved" ? "Unavailable or conflicting native relationship, not proof of capture loss." : ""}`));
        groupsRegion.append(parents);
        pager(groupsRegion, parentPage, neighborhood.parents.length, 20, "references", page => { cancelReceipt(); parentPage = page; drawGroups(); });
    }
    function selectGroup(group: LoomGroup) { cancelReceipt(); selectedGroup = group; memberPage = 0; drawMembers(); membersRegion.focus(); }
    function drawMembers() { clear(membersRegion); if (!model || !selectedGroup)
        return; const group = selectedGroup; membersRegion.append(el("h3", {}, `${group.kind}: ${group.id}`), el("p", {}, `${group.members.length} captured members. Membership alone does not prove a start/end pair or causal relationship.`)); if (!group.members.length)
        membersRegion.append(el("p", {}, "No captured members available for this native reference.")); const list = el("ul", { class: "loom-members" }); const byID = new Map(model.events.map(e => [e.id, e])); for (const id of group.members.slice(memberPage * 40, memberPage * 40 + 40)) {
        const event = byID.get(id);
        if (event)
            list.append(el("li", {}, button(`Focus member ${id}`, () => selectFocus(event), `Focus member ${event.source} / ${event.session_id} / ${id}`)));
    } membersRegion.append(list); pager(membersRegion, memberPage, group.members.length, 40, "members", page => { cancelReceipt(); memberPage = page; drawMembers(); }); }
    async function inspect(event: FirehoseEvent) { cancelReceipt(); const token = receiptVersion, scopeVersion = loadVersion, ctl = new AbortController(); receiptAbort = ctl; evidence.append(el("p", { role: "status" }, "Loading captured receipt…")); try {
        const full = await capturedEvent(event.id, ctl.signal);
        if (ctl.signal.aborted || token !== receiptVersion || scopeVersion !== loadVersion || focus?.id !== event.id)
            return;
        if (full.id !== event.id || full.source !== loadedSource || full.session_id !== loadedSession)
            throw Error("Receipt identity mismatch");
        clear(evidence);
        evidence.append(el("h3", {}, "Full captured receipt — no resolution inferred"), el("pre", {}, JSON.stringify(full, null, 2)), button("Open Score", () => { cancelReceipt(); openScore(loadedSession, loadedSource); }));
    }
    catch (error) {
        if (ctl.signal.aborted || token !== receiptVersion || scopeVersion !== loadVersion)
            return;
        clear(evidence);
        evidence.append(el("p", { role: "alert" }, `Receipt unavailable or conflicting: ${error instanceof Error ? error.message : String(error)}. Loaded metadata retained; no verification claim.`));
    } }
    async function load() { clearScope(); const exactSource = source.value, exactSession = session.value; if (!exactSource.trim() || !exactSession.trim()) {
        status.textContent = "Enter an exact source and session ID.";
        return;
    } const token = loadVersion, ctl = new AbortController(); loadAbort = ctl; status.textContent = `Loading correlation metadata for ${exactSource} / ${exactSession}…`; try {
        const events = await sessionEvents(exactSession, "correlation", ctl.signal);
        if (ctl.signal.aborted || token !== loadVersion || source.value !== exactSource || session.value !== exactSession)
            return;
        clearFocus();
        model = buildLoom(events, exactSource, exactSession);
        loadedSource = exactSource;
        loadedSession = exactSession;
        loadedAt = new Date().toISOString();
        status.textContent = `Metadata snapshot ${loadedSource} / ${loadedSession}; loaded ${loadedAt}. ${model.omitted} observations omitted for missing captured IDs; ${model.duplicates} duplicate records collapsed; ${model.conflicts} conflicting captured IDs excluded; ${model.unsupportedParents} unsupported references not joined; ${model.invalidTimes} observations with invalid times. Native parent conflicts are labelled separately below; unsupported references remain metadata only. This reduced view does not bound the underlying session history scan.`;
        drawObservations();
    }
    catch (error) {
        if (ctl.signal.aborted || token !== loadVersion)
            return;
        status.textContent = `Relationships unavailable: ${error instanceof Error ? error.message : String(error)}. An older daemon may not support correlation view. Update/restart and retry; no full-payload fallback was requested.`;
    } }
    async function refresh() { cancelReceipt(); const token = ++choiceVersion; choiceAbort?.abort(); const ctl = new AbortController(); choiceAbort = ctl; choiceStatus.textContent = "Loading session choices…"; try {
        const snapshot = await attention(ctl.signal);
        if (ctl.signal.aborted || token !== choiceVersion)
            return;
        clear(choices);
        choices.append(el("option", { value: "" }, "Choose a source/session"));
        for (const row of snapshot.sessions)
            choices.append(el("option", { value: JSON.stringify([row.source, row.id]) }, `${row.source} / ${row.id}`));
        choiceStatus.textContent = `${snapshot.sessions.length} known source/session choices. Selecting one only fills scope; Load relationships is explicit.`;
    }
    catch (error) {
        if (ctl.signal.aborted || token !== choiceVersion)
            return;
        choiceStatus.textContent = `Session choices unavailable: ${error instanceof Error ? error.message : String(error)}. Manual exact scope remains available.`;
    } }
    const changeTraversal = () => { cancelReceipt(); selectedGroup = undefined; groupPage = 0; parentPage = 0; memberPage = 0; clear(membersRegion); drawGroups(); };
    direction.addEventListener("change", changeTraversal);
    depth.addEventListener("change", changeTraversal);
    source.addEventListener("input", clearScope);
    session.addEventListener("input", clearScope);
    choices.addEventListener("change", () => { if (!choices.value)
        return; const [s, id] = JSON.parse(choices.value) as [
        string,
        string
    ]; clearScope(); source.value = s; session.value = id; });
    const filter = () => { clearFocus(); observationPage = 0; drawObservations(); };
    search.addEventListener("input", filter);
    errors.addEventListener("change", filter);
    function deactivate() { choiceVersion++; choiceAbort?.abort(); loadVersion++; loadAbort?.abort(); cancelReceipt(); if (!model)
        status.textContent = "No loaded metadata snapshot. Load relationships explicitly."; }
    choices.append(el("option", { value: "" }, "Choose a source/session"));
    status.textContent = "Choose or enter exact source/session, then load relationships.";
    return { root, refresh, deactivate };
}
