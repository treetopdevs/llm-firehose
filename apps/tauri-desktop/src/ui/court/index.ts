import { capturedEvent, sessions } from "../../api";
import type { FirehoseEvent } from "../../api";
import { clear, el } from "../../dom";
import { sessionName, shortId } from "../../format";
import { sessionIdChip } from "../session-chip";
import { createNotebook, STORAGE_KEY } from "./notebook";
import type { Claim, Notebook, Receipt, Requirement } from "./notebook";

type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export function createCourt(openScore: (session: string, source: string) => void = () => {}, storage?: StorageAccess) {
  const notice = el("p", {role: "status", class: "court-notice"});
  const body = el("div");
  const confirmation = el("section", {class: "court-confirmation", "aria-label": "Confirm removal"});
  const recovery = el("section", {"aria-label": "Notebook recovery"});
  const drafts = new Map<string, string>();
  const detail = el("section", {class: "court-evidence", "aria-label": "Evidence preview"});
  const eventID = el("input", {"aria-label": "Event ID", maxlength: "512", placeholder: "Exact captured event ID"});
  const lookupButton = button("Look up event", () => void lookup());
  const root = el("section", {class: "court"}, el("h2", {}, "Evidence Court"),
    el("p", {class: "dim"}, "A manual notebook of claims and requested evidence. Attachments are associations you choose, not verified claims or proof of success."),
    el("p", {class: "dim"}, "Notes and receipt identities stay in this app origin and profile’s local storage (development and release builds are separate), separate from captured history. They are not exported or synced; clearing app data loses notes. Multi-window writes use best-effort conflict detection."),
    button("Reload notebook", reload), el("p", {class:"dim"}, "Reload notebook discards all unsaved drafts and previews; copy edits first."), notice, recovery, body, confirmation,
    el("div", {class: "court-controls"}, el("label", {}, "Event ID ", eventID), lookupButton), detail);
  let notebook: ReturnType<typeof createNotebook> | undefined;
  let state: Notebook = {version: 1, claims: []};
  let claimID = "", requirementID = "";
  let version = 0;
  let controller: AbortController | undefined;
  let preview: Receipt | undefined;
  function button(text: string, action: () => void) { const b = el("button", {}, text); b.addEventListener("click", action); return b; }
  function field(label: string, value: string, max: number, key: string, scoped = false) {
    const input = el("textarea", {"aria-label": label, maxlength: String(max), rows: "2"}); input.value = drafts.get(key) ?? value;
    input.addEventListener("input", () => { drafts.set(key, input.value); if (scoped) cancelPreview(); }); return input;
  }
  function selected(): {claim?: Claim; requirement?: Requirement} {
    const claim = state.claims.find(c => c.id === claimID);
    return {claim, requirement: claim?.requirements.find(r => r.id === requirementID)};
  }
  function cancelPreview() { version++; controller?.abort(); controller = undefined; preview = undefined; clear(detail); }
  function mutation(change: (next: Notebook) => void, clearDraft?: string) {
    if (!notebook) { notice.textContent = "Notebook unavailable. Reload notebook to retry."; return; }
    try {
      const next = notebook.read(); change(next); notebook.save(next); state = notebook.read(); if (clearDraft) drafts.delete(clearDraft); cancelPreview(); clear(confirmation); notice.textContent = "Saved locally."; draw();
    } catch (error) { notice.textContent = `Save failed: ${(error instanceof Error ? error.message : String(error))}. Prior saved state is unchanged. Reload notebook if another window changed it.`; }
  }
  function newID() {
    try { return crypto.randomUUID(); }
    catch (error) { notice.textContent = `Could not create an ID: ${error instanceof Error ? error.message : String(error)}. Notes were not changed.`; return undefined; }
  }
  function confirmRemoval(target: string, remove: () => void) {
    cancelPreview(); clear(confirmation);
    confirmation.append(el("p", {}, `Remove ${target}? This removes saved notebook information.`), button("Confirm removal", remove), button("Cancel removal", () => clear(confirmation)));
  }
  function draw() {
    clear(body);
    if (!notebook) { lookupButton.disabled = true; return; }
    const createText = field("New claim", "", 1000, "new-claim");
    const create = button("Create claim", () => {
      const text = createText.value.trim(); if (!text) { notice.textContent = "Enter a claim."; return; }
      const id = newID(); if (!id) return;
      mutation(next => { next.claims.push({id, text, requirements: []}); }, "new-claim");
      if (state.claims.some(c => c.id === id)) { claimID = id; requirementID = ""; draw(); }
    }); create.disabled = state.claims.length >= 20;
    body.append(el("div", {class: "court-editor"}, el("label", {}, "New claim", createText), create));
    const claims = el("div", {class: "court-claims", "aria-label": "Claims"});
    for (const c of state.claims) {
      const b = button(c.text, () => { cancelPreview(); claimID = c.id; requirementID = ""; clear(confirmation); draw(); });
      b.setAttribute("aria-pressed", String(c.id === claimID)); claims.append(b);
    }
    body.append(claims);
    const {claim, requirement} = selected(); lookupButton.disabled = !requirement || !!requirement.receipt;
    if (!claim) { body.append(el("p", {}, "Create or select a claim, then select an evidence requirement.")); return; }
    const claimText = field("Claim text", claim.text, 1000, `claim:${claim.id}`, true);
    body.append(el("div", {class: "court-editor"}, el("label", {}, "Claim text", claimText),
      button("Save claim", () => mutation(next => { next.claims.find(c => c.id === claim.id)!.text = claimText.value.trim(); })),
      button("Remove claim", () => confirmRemoval(`claim “${claim.text}” and its requirements and receipts`, () => mutation(next => { next.claims = next.claims.filter(c => c.id !== claim.id); })))));
    const missing = claim.requirements.filter(r => !r.receipt).length;
    body.append(el("p", {}, `${missing} missing receipts · ${claim.requirements.length - missing} attached references. Attachment counts do not verify this claim.`));
    const list = el("ul", {class: "court-requirements"});
    for (const r of claim.requirements) {
      const b = button(r.text, () => { cancelPreview(); requirementID = r.id; clear(confirmation); draw(); });
      b.setAttribute("aria-pressed", String(r.id === requirementID));
      list.append(el("li", {}, b, el("span", {}, r.receipt ? "Receipt attached — not verified" : "Missing receipt")));
    }
    body.append(list);
    const addText = field("New requirement", "", 500, `new-req:${claim.id}`);
    const add = button("Add requirement", () => {
      const text = addText.value.trim(); if (!text) { notice.textContent = "Enter an evidence requirement."; return; }
      const id = newID(); if (!id) return; mutation(next => next.claims.find(c => c.id === claim.id)!.requirements.push({id,text}), `new-req:${claim.id}`);
      if (state.claims.find(c => c.id === claim.id)?.requirements.some(r => r.id === id)) { requirementID = id; draw(); }
    }); add.disabled = claim.requirements.length >= 20;
    body.append(el("div", {class: "court-editor"}, el("label", {}, "New requirement", addText), add));
    if (!requirement) return;
    const reqText = field("Requirement text", requirement.text, 500, `req:${claim.id}:${requirement.id}`, true);
    body.append(el("div", {class: "court-editor"}, el("label", {}, "Requirement text", reqText),
      button("Save requirement", () => mutation(next => { next.claims.find(c => c.id === claim.id)!.requirements.find(r => r.id === requirement.id)!.text = reqText.value.trim(); })),
      button("Remove requirement", () => confirmRemoval(`requirement “${requirement.text}” and its receipt`, () => mutation(next => { const c = next.claims.find(c => c.id === claim.id)!; c.requirements = c.requirements.filter(r => r.id !== requirement.id); })))));
    if (requirement.receipt) body.append(el("div", {class: "court-controls"},
      el("span", {}, `Receipt ID: ${requirement.receipt.id}`), button("Open receipt", () => void lookup(requirement.receipt)),
      button("Remove receipt", () => confirmRemoval(`receipt for “${requirement.text}”`, () => mutation(next => { delete next.claims.find(c => c.id === claim.id)!.requirements.find(r => r.id === requirement.id)!.receipt; })))));
  }
  async function lookup(saved?: Receipt) {
    cancelPreview(); const {claim, requirement} = selected(); if (!requirement) { notice.textContent = "Select an evidence requirement first."; return; }
    if (!saved && requirement.receipt) { notice.textContent = "Remove the existing receipt before attaching another."; return; }
    const id = saved?.id ?? eventID.value.trim(); if (!id || id.length > 512) { notice.textContent = "Enter a valid event ID (up to 512 characters)."; return; }
    const token = version, selectedClaim = claimID, selectedRequirement = requirementID;
    const ctl = new AbortController(); controller = ctl; detail.append(el("p", {role: "status"}, "Loading captured evidence…"));
    try {
      const event: FirehoseEvent = await capturedEvent(id, ctl.signal);
      if (ctl.signal.aborted || token !== version || claimID !== selectedClaim || requirementID !== selectedRequirement) return;
      if (event.id !== id || typeof event.source !== "string" || !event.source || event.source.length > 512 || (event.session_id !== undefined && typeof event.session_id !== "string") || (event.session_id?.length ?? 0) > 512) throw new Error("Evidence identity mismatch");
      const receipt: Receipt = {id: event.id, source: event.source, session_id: event.session_id ?? ""};
      if (saved && (receipt.source !== saved.source || receipt.session_id !== saved.session_id)) throw new Error("Receipt identity mismatch");
      preview = receipt; clear(detail); detail.append(el("h3", {}, saved ? "Attached evidence — not verified" : "Review evidence before attaching"), el("p", {}, `${saved ? "Attached to" : "Attach to"}: ${claim!.text} → ${requirement.text}`), el("pre", {}, JSON.stringify(event, null, 2)));
      if (!saved) detail.append(button("Attach receipt", () => {
        if (selected().requirement?.receipt || !preview || token !== version || claimID !== selectedClaim || requirementID !== selectedRequirement) return;
        const identity = {...preview}; mutation(next => { next.claims.find(c => c.id === selectedClaim)!.requirements.find(r => r.id === selectedRequirement)!.receipt = identity; });
      }));
      if (receipt.session_id) {
        // The session is named, not numbered: its summary is fetched after the
        // evidence lands, and an unlisted session reads as source and short id.
        const name = el("strong", {}, `${receipt.source} · ${shortId(receipt.session_id)}`);
        detail.append(el("p", {class: "court-session"}, "Session: ", name, " ", sessionIdChip(receipt.session_id)), button("Open Score", () => { cancelPreview(); openScore(receipt.session_id, receipt.source); }));
        void Promise.resolve().then(() => sessions()).then(list => {
          const s = list?.find(x => x.id === receipt.session_id);
          if (s && !ctl.signal.aborted && token === version && preview === receipt) name.textContent = sessionName(s);
        }).catch(() => {});
      }
    } catch (error) {
      if (ctl.signal.aborted || token !== version) return;
      clear(detail); detail.append(el("p", {role: "alert"}, error instanceof Error && /identity mismatch/.test(error.message) ? `${error.message}. ${saved ? "Returned evidence conflicts with the saved identity. This receipt must not be relied on; inspect or remove it." : "Returned evidence does not match the requested event. Nothing attached."}` : `Evidence unavailable: ${(error instanceof Error ? error.message : String(error))}. ${saved ? "The stored reference is retained for inspection, without evidence verification." : "Nothing attached."}`));
    }
  }
  function reload() {
    cancelPreview(); drafts.clear(); clear(confirmation); clear(recovery); eventID.value = "";
    try { notebook = createNotebook(storage ?? localStorage); state = notebook.read(); claimID = state.claims[0]?.id ?? ""; requirementID = ""; notice.textContent = "Notebook loaded. Saved references are not verified."; }
    catch (error) { notebook = undefined; state = {version: 1, claims: []}; notice.textContent = `Notebook unavailable: ${(error instanceof Error ? error.message : String(error))}. Reload notebook to retry; existing storage has not been replaced.`; }
    if (!notebook) {
      try { const raw = (storage ?? localStorage).getItem(STORAGE_KEY); if (raw !== null) recovery.append(el("h3", {}, "Stored notebook for manual recovery"), el("p", {}, "Copy this read-only text to preserve or inspect it. No reset or overwrite was performed."), el("pre", {}, raw)); }
      catch { recovery.append(el("p", {}, "Storage cannot be read for recovery. Restore storage access and reload.")); }
    }
    draw();
  }
  function refresh() { cancelPreview(); }
  function offerEvent(id: string) { cancelPreview(); requirementID = ""; clear(confirmation); eventID.value = id; draw(); if (notebook) notice.textContent = "Event ID carried here. Select a requirement, look up the event, then attach explicitly."; }
  eventID.addEventListener("input", cancelPreview);
  reload();
  return {root, refresh, offerEvent};
}
