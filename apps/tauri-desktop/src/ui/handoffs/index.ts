import { capturedEvent } from "../../api";
import type { FirehoseEvent } from "../../api";
import { clear, el } from "../../dom";
import { createHandoffBook, STORAGE_KEY } from "./model";
import type { Endpoint, Handoff, HandoffBook } from "./model";
import { renderHandoffMap } from "./map";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export function createHandoffs(openScore: (session: string, source: string) => void = () => { }, getRecent: () => readonly FirehoseEvent[] = () => [], storage?: StorageAccess) {
    const status = el("p", { role: "status" }), recovery = el("section"), saved = el("section"), detail = el("section", { class: "handoff-detail", "aria-label": "Inspected receipt" }), confirmation = el("section", { class: "handoff-confirm" });
    const label = el("input", { "aria-label": "Link label", maxlength: "500" });
    const sides = ["departure", "arrival"] as const;
    type Side = typeof sides[number];
    const fields = { departure: el("input", { "aria-label": "Departure event ID", maxlength: "512" }), arrival: el("input", { "aria-label": "Arrival event ID", maxlength: "512" }) };
    const previews = { departure: el("section", { class: "handoff-endpoint", "aria-label": "Departure preview" }), arrival: el("section", { class: "handoff-endpoint", "aria-label": "Arrival preview" }) };
    const verified: Partial<Record<Side, Endpoint>> = {};
    const tokens = { departure: 0, arrival: 0 };
    const aborts: Partial<Record<Side, AbortController>> = {};
    let inspectToken = 0, inspectAbort: AbortController | undefined;
    let book: ReturnType<typeof createHandoffBook> | undefined, state: HandoffBook = { version: 1, links: [] }, page = 0, recentPage = 0, recentEvents: FirehoseEvent[] = [];
    const target = el("p", { class: "dim" });
    const save = button("Save annotation", saveLink);
    const recent = el("section", { "aria-label": "Recent observations" });
    const root = el("section", { class: "handoffs" }, el("h2", {}, "Handoff Subway"), el("p", { class: "dim" }, "User annotation — not source-confirmed. Direction is your annotation, not proof of a transfer, temporal order, or causality. Missing annotations do not prove no transfer occurred."), el("p", { class: "dim" }, "Labels and identities stay in this app origin/profile’s local storage. Development and release builds are separate. No sync or export; clearing app data loses annotations. Cross-window writes use best-effort conflict detection."), button("Reload annotations", reload), el("p", { class: "dim" }, "Reload discards unsaved fields and previews; copy drafts first."), status, recovery, el("label", {}, "Link label ", label));
    for (const side of sides)
        root.append(el("div", { class: "handoff-controls" }, el("label", {}, `${side} event ID `, fields[side]), button(`Look up ${side}`, () => void lookup(side))), previews[side]);
    root.append(target, save, button("Browse recent observations", browse), recent, saved, confirmation, detail);
    function button(text: string, action: () => void) { const b = el("button", {}, text); b.addEventListener("click", action); return b; }
    function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
    function cancelSide(side: Side) { tokens[side]++; aborts[side]?.abort(); delete verified[side]; clear(previews[side]); updateSave(); }
    function cancelInspect() { inspectToken++; inspectAbort?.abort(); clear(detail); }
    function invalidate() { for (const side of sides)
        cancelSide(side); cancelInspect(); clear(confirmation); }
    function updateSave() {
        const a = verified.departure, b = verified.arrival;
        const valid = !!a && !!b && a.id !== b.id && (a.source !== b.source || a.session_id !== b.session_id);
        save.disabled = !book || !valid || !label.value.trim() || state.links.length >= 50;
        target.textContent = a && b ? `Save direction: ${a.source} / ${a.session_id} / ${a.id} → ${b.source} / ${b.session_id} / ${b.id}.${valid ? "" : " Endpoints must be different events in different session/source lanes."}` : "Look up both endpoints to review evidence before saving.";
    }
    function identity(event: FirehoseEvent, id: string): Endpoint {
        if (event.id !== id || typeof event.source !== "string" || !event.source.trim() || event.source.length > 512 || typeof event.session_id !== "string" || !event.session_id.trim() || event.session_id.length > 512)
            throw Error("Evidence identity mismatch or missing session/source");
        return { id: event.id, source: event.source, session_id: event.session_id };
    }
    async function lookup(side: Side) {
        cancelSide(side);
        cancelInspect();
        const id = fields[side].value.trim();
        if (!id || id.length > 512) {
            status.textContent = "Enter a captured event ID of 1–512 characters.";
            return;
        }
        const token = tokens[side], ctl = new AbortController();
        aborts[side] = ctl;
        previews[side].append(el("p", { role: "status" }, "Loading evidence…"));
        try {
            const event = await capturedEvent(id, ctl.signal);
            if (ctl.signal.aborted || token !== tokens[side] || fields[side].value.trim() !== id)
                return;
            verified[side] = identity(event, id);
            clear(previews[side]);
            previews[side].append(el("h3", {}, `${side} evidence`), el("pre", {}, JSON.stringify(event, null, 2)));
            updateSave();
        }
        catch (error) {
            if (ctl.signal.aborted || token !== tokens[side])
                return;
            clear(previews[side]);
            previews[side].append(el("p", { role: "alert" }, `${/identity mismatch/.test(message(error)) ? "Conflicting evidence" : "Evidence unavailable"}: ${message(error)}. Endpoint not verified.`));
        }
    }
    function mutate(change: (next: HandoffBook) => void): boolean {
        if (!book) {
            status.textContent = "Annotations unavailable. Reload to retry.";
            return false;
        }
        try {
            const next = book.read();
            change(next);
            book.save(next);
            state = book.read();
            status.textContent = "Saved locally. User annotation — not source-confirmed.";
            return true;
        }
        catch (error) {
            status.textContent = `Save failed: ${message(error)}. Saved annotations are unchanged. Copy drafts before reloading after a conflict.`;
            return false;
        }
    }
    function saveLink() {
        const from = verified.departure, to = verified.arrival;
        if (save.disabled || !from || !to)
            return;
        let id: string;
        try {
            id = crypto.randomUUID();
        }
        catch (error) {
            status.textContent = `Could not create annotation ID: ${message(error)}. Nothing saved.`;
            return;
        }
        if (mutate(next => next.links.push({ id, label: label.value.trim(), from: { ...from }, to: { ...to } }))) {
            invalidate();
            label.value = "";
            fields.departure.value = "";
            fields.arrival.value = "";
            page = Math.floor((state.links.length - 1) / 10);
            drawSaved();
            updateSave();
        }
    }
    async function inspect(endpoint: Endpoint) {
        invalidate();
        const token = inspectToken, ctl = new AbortController();
        inspectAbort = ctl;
        detail.append(el("p", { role: "status" }, "Loading saved station receipt…"));
        try {
            const event = await capturedEvent(endpoint.id, ctl.signal);
            if (ctl.signal.aborted || token !== inspectToken)
                return;
            const actual = identity(event, endpoint.id);
            if (actual.source !== endpoint.source || actual.session_id !== endpoint.session_id)
                throw Error("Saved identity conflicts with returned evidence");
            clear(detail);
            detail.append(el("h3", {}, "Saved station receipt — annotation not verified"), el("pre", {}, JSON.stringify(event, null, 2)), button("Open Score", () => { invalidate(); openScore(actual.session_id, actual.source); }));
        }
        catch (error) {
            if (ctl.signal.aborted || token !== inspectToken)
                return;
            clear(detail);
            detail.append(el("p", { role: "alert" }, `${/identity|conflicts/.test(message(error)) ? "Conflicting receipt identity" : "Receipt unavailable"}: ${message(error)}. The annotation is retained for inspection, without verified evidence.`));
        }
    }
    function drawSaved() {
        clear(saved);
        page = Math.min(page, Math.max(0, Math.ceil(state.links.length / 10) - 1));
        const links = state.links.slice(page * 10, page * 10 + 10);
        saved.append(el("h3", {}, `${state.links.length} saved annotations`), el("p", { class: "dim" }, "Map shows this page only. Positions organize references, not time, duration, or effort."));
        if (!links.length) {
            saved.append(el("p", {}, "No saved annotations."));
            return;
        }
        saved.append(renderHandoffMap(links, endpoint => void inspect(endpoint)));
        const list = el("ol", { class: "handoff-links", start: String(page * 10 + 1) });
        for (const link of links)
            list.append(el("li", {}, el("h4", {}, link.label), el("p", {}, "User annotation — not source-confirmed"), el("p", {}, `${link.from.source} / ${link.from.session_id} / ${link.from.id} → ${link.to.source} / ${link.to.session_id} / ${link.to.id}`), button("Inspect departure", () => void inspect(link.from)), button("Inspect arrival", () => void inspect(link.to)), button("Remove annotation", () => remove(link))));
        saved.append(list);
        if (state.links.length > 10)
            pager(saved, page, state.links.length, 10, "annotations", next => { invalidate(); page = next; drawSaved(); });
    }
    function remove(link: Handoff) { invalidate(); confirmation.append(el("p", {}, `Remove annotation “${link.label}”: ${link.from.id} → ${link.to.id}?`), button("Confirm removal", () => { if (mutate(next => { next.links = next.links.filter(l => l.id !== link.id); })) {
        invalidate();
        drawSaved();
        updateSave();
    } }), button("Cancel removal", () => clear(confirmation))); }
    function pager(host: HTMLElement, current: number, total: number, size: number, name: string, change: (page: number) => void) { const previous = button(`Previous ${name}`, () => change(current - 1)), next = button(`Next ${name}`, () => change(current + 1)); previous.disabled = current === 0; next.disabled = (current + 1) * size >= total; host.append(el("div", { class: "handoff-controls" }, previous, el("span", {}, `${current * size + 1}–${Math.min((current + 1) * size, total)} of ${total}`), next)); }
    function browse() {
        try {
            recentEvents = getRecent().filter(e => e.session_id && e.source).slice(-100).reverse();
            recentPage = 0;
            drawRecent();
        }
        catch (error) {
            clear(recent);
            recent.append(el("p", { role: "alert" }, `Recent observations unavailable: ${message(error)}`));
        }
    }
    function drawRecent() {
        clear(recent);
        recent.append(el("p", { class: "dim" }, `${recentEvents.length} recent session-bearing observations from the bounded live buffer. Older events require manual IDs.`));
        for (const event of recentEvents.slice(recentPage * 20, recentPage * 20 + 20)) {
            const row = el("div", { class: "handoff-recent-row" }, el("p", {}, `${event.source} / ${event.session_id} / ${event.time} · ${event.summary || event.name || event.id}`));
            for (const side of sides)
                row.append(button(`Use as ${side}`, () => { cancelSide(side); cancelInspect(); fields[side].value = event.id; status.textContent = `${side} ID filled. Look up evidence explicitly before saving.`; }));
            recent.append(row);
        }
        if (recentEvents.length > 20)
            pager(recent, recentPage, recentEvents.length, 20, "observations", next => { invalidate(); recentPage = next; drawRecent(); });
    }
    function reload() {
        invalidate();
        clear(recovery);
        clear(recent);
        label.value = "";
        fields.departure.value = "";
        fields.arrival.value = "";
        page = 0;
        try {
            book = createHandoffBook(storage ?? localStorage);
            state = book.read();
            status.textContent = "Annotations loaded. Receipts are fetched only on explicit lookup.";
        }
        catch (error) {
            book = undefined;
            state = { version: 1, links: [] };
            status.textContent = `Annotations unavailable: ${message(error)}. Existing storage has not been replaced.`;
            try {
                const raw = (storage ?? localStorage).getItem(STORAGE_KEY);
                if (raw !== null)
                    recovery.append(el("h3", {}, "Read-only recovery copy"), el("p", {}, "Copy this text before manual recovery. No reset was performed."), el("pre", {}, raw));
            }
            catch {
                recovery.append(el("p", {}, "Storage is unreadable. Restore access and reload."));
            }
        }
        drawSaved();
        updateSave();
    }
    for (const side of sides)
        fields[side].addEventListener("input", () => { cancelSide(side); cancelInspect(); });
    label.addEventListener("input", updateSave);
    function refresh() { invalidate(); }
    reload();
    return { root, refresh };
}
