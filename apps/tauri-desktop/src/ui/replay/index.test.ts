// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.session.json";
const api = vi.hoisted(() => ({ attention: vi.fn(), sessionEvents: vi.fn(), capturedEvent: vi.fn() }));
vi.mock("../../api", () => api);
import { createReplay } from "./index";
const event = (fixture as FirehoseEvent[])[0];
let raw: string | null = null;
const storage = { getItem: vi.fn(() => raw), setItem: vi.fn((_key: string, value: string) => { raw = value; }) };
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent === text); expect(b).toBeTruthy(); b!.click(); };
const input = (root: HTMLElement, label: string, value: string) => { const n = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; n.value = value; n.dispatchEvent(new Event("input")); };
const settle = async () => { for (let i = 0; i < 10; i++)
    await Promise.resolve(); };
async function route(panel: ReturnType<typeof createReplay>) { input(panel.root, "Source", event.source); input(panel.root, "Session ID", event.session_id!); click(panel.root, "Load captured route"); await settle(); }
async function draft(panel: ReturnType<typeof createReplay>) { await route(panel); click(panel.root, "Select observation"); click(panel.root, "Inspect captured receipt"); await settle(); click(panel.root, "New hypothetical branch"); input(panel.root, "Branch title", "Alternative"); input(panel.root, "Hypothetical steps", "Inspect locally\nAsk for review"); }
beforeEach(() => { vi.resetAllMocks(); raw = null; storage.getItem.mockImplementation(() => raw); storage.setItem.mockImplementation((_k, v) => { raw = v; }); vi.stubGlobal("localStorage", storage); api.attention.mockResolvedValue({ sessions: [{ source: event.source, id: event.session_id }], warnings: [] }); api.sessionEvents.mockResolvedValue([event]); api.capturedEvent.mockResolvedValue(event); });
afterEach(() => vi.unstubAllGlobals());
test("explicit route/receipt enables branch creation and saves only manual annotations with identity", async () => {
    const panel = createReplay();
    await panel.refresh();
    expect(api.sessionEvents).not.toHaveBeenCalled();
    await draft(panel);
    expect(api.sessionEvents).toHaveBeenCalledExactlyOnceWith(event.session_id, "timeline", expect.any(AbortSignal));
    expect(api.capturedEvent).toHaveBeenCalledTimes(1);
    click(panel.root, "Save branch");
    const saved = JSON.parse(raw!).branches[0];
    expect(saved).toMatchObject({ source: event.source, sessionId: event.session_id, eventId: event.id, title: "Alternative", steps: ["Inspect locally", "Ask for review"] });
    expect(Object.keys(saved).sort()).toEqual(["eventId", "id", "sessionId", "source", "steps", "title"]);
});
test("dirty drafts survive scope edits navigation refresh and conflict; refresh notebook never discards", async () => {
    const panel = createReplay();
    await draft(panel);
    input(panel.root, "Source", "different");
    panel.deactivate();
    await panel.refresh();
    expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Branch title"]')?.value).toBe("Alternative");
    expect(panel.root.textContent).toContain("Unsaved edits");
    raw = JSON.stringify({ version: 1, branches: [] });
    click(panel.root, "Save branch");
    expect(panel.root.textContent).toContain("another");
    expect(panel.root.querySelector<HTMLTextAreaElement>('[aria-label="Hypothetical steps"]')?.value).toContain("Inspect locally");
    click(panel.root, "Refresh notebook");
    expect(panel.root.textContent).toContain("Unsaved edits");
});
test("saved branch reopening never verifies or loads history; explicit branch route notices missing anchor", async () => {
    const panel = createReplay();
    await draft(panel);
    click(panel.root, "Save branch");
    panel.deactivate();
    const reopened = createReplay();
    await reopened.refresh();
    const before = api.capturedEvent.mock.calls.length;
    click(reopened.root, "Open branch");
    expect(api.capturedEvent).toHaveBeenCalledTimes(before);
    expect(reopened.root.querySelector(".replay-evidence pre")).toBeNull();
    api.sessionEvents.mockResolvedValueOnce([]);
    click(reopened.root, "Load branch route");
    await settle();
    expect(reopened.root.textContent).toContain("anchor not in loaded snapshot");
});
test("failed saves retain edits and delete requires explicit confirmation with persistence", async () => {
    const panel = createReplay();
    await draft(panel);
    storage.setItem.mockImplementationOnce(() => { throw Error("quota"); });
    click(panel.root, "Save branch");
    expect(panel.root.textContent).toContain("Save failed");
    expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Branch title"]')?.value).toBe("Alternative");
    click(panel.root, "Save branch");
    click(panel.root, "Delete branch");
    click(panel.root, "Cancel deletion");
    expect(JSON.parse(raw!).branches).toHaveLength(1);
    click(panel.root, "Delete branch");
    click(panel.root, "Confirm delete branch");
    expect(JSON.parse(raw!).branches).toHaveLength(0);
});
test("invalid stored notebook offers bounded read-only recovery without re-reading or replacing it",()=>{
 raw="x".repeat(70000);const panel=createReplay();const text=panel.root.querySelector<HTMLTextAreaElement>('[aria-label="Notebook recovery copy"]')!;expect(text).not.toBeNull();expect(text.readOnly).toBe(true);expect(text.value).toHaveLength(65536);expect(panel.root.textContent).toContain("65536 of 70000");expect(storage.setItem).not.toHaveBeenCalled();expect(storage.getItem).toHaveBeenCalledTimes(1);
});
test("dirty branch cannot be replaced and does not associate with same ID in another source",async()=>{
 const panel=createReplay();await draft(panel);click(panel.root,"New hypothetical branch");expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Branch title"]')?.value).toBe("Alternative");expect(panel.root.textContent).toContain("Unsaved edits");input(panel.root,"Source","other-source");api.sessionEvents.mockResolvedValueOnce([{...event,source:"other-source"}]);click(panel.root,"Load captured route");await settle();expect(panel.root.querySelectorAll('[data-alternative]')).toHaveLength(0);expect(panel.root.querySelector('[aria-current="true"]')).toBeNull();expect(panel.root.textContent).toContain("different source/session");click(panel.root,"Discard edits");expect(panel.root.querySelector<HTMLElement>('[aria-label="Hypothetical branch editor"]')?.hidden).toBe(true);
});
test("discard restores saved edits and failed deletion preserves all editor fields",async()=>{
 const panel=createReplay();await draft(panel);click(panel.root,"Save branch");input(panel.root,"Branch title","Unsaved changed title");click(panel.root,"Open branch");expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Branch title"]')?.value).toBe("Unsaved changed title");click(panel.root,"Discard edits");expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Branch title"]')?.value).toBe("Alternative");input(panel.root,"Branch title","Keep after failed delete");storage.setItem.mockImplementationOnce(()=>{throw Error("quota");});click(panel.root,"Delete branch");click(panel.root,"Confirm delete branch");expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Branch title"]')?.value).toBe("Keep after failed delete");expect(JSON.parse(raw!).branches).toHaveLength(1);
});
test("scope changes cancel receipts and wrong identities never permit new branches",async()=>{
 const panel=createReplay();await route(panel);click(panel.root,"Select observation");api.capturedEvent.mockResolvedValueOnce({...event,session_id:"wrong"});click(panel.root,"Inspect captured receipt");await settle();expect(panel.root.textContent).toContain("identity mismatch");expect([...panel.root.querySelectorAll("button")].some(b=>b.textContent==="New hypothetical branch")).toBe(false);let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));click(panel.root,"Inspect captured receipt");const signal=api.capturedEvent.mock.calls.at(-1)![1] as AbortSignal;input(panel.root,"Source","other");resolve(event);await settle();expect(signal.aborted).toBe(true);expect(panel.root.querySelector(".replay-evidence pre")).toBeNull();
});
test("route and branch lists are bounded, search local, and annotation text is escaped",async()=>{
 raw=JSON.stringify({version:1,branches:Array.from({length:25},(_,i)=>({id:`branch-${i}`,source:event.source,sessionId:event.session_id,eventId:event.id,title:"<img src=x>",steps:["Do not execute"]}))});api.sessionEvents.mockResolvedValue(Array.from({length:85},(_,i)=>({...event,id:`route-${i}`,summary:`row ${i}`})));const panel=createReplay();expect(panel.root.querySelectorAll(".replay-branches li")).toHaveLength(20);expect(panel.root.querySelector("img")).toBeNull();click(panel.root,"Next branches");expect(panel.root.querySelectorAll(".replay-branches li")).toHaveLength(5);await route(panel);expect(panel.root.querySelectorAll(".replay-observation")).toHaveLength(40);click(panel.root,"Next observations");expect(panel.root.textContent).toContain("41–80 of 85");input(panel.root,"Search captured route","row 84");expect(panel.root.querySelectorAll(".replay-observation")).toHaveLength(1);expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});
test("unavailable UUID and invalid steps retain the unsaved draft without writes",async()=>{
 const panel=createReplay();await route(panel);click(panel.root,"Select observation");click(panel.root,"Inspect captured receipt");await settle();const uuid=vi.spyOn(crypto,"randomUUID").mockImplementationOnce(()=>{throw Error("unsupported");});click(panel.root,"New hypothetical branch");expect(panel.root.textContent).toContain("Could not create branch ID");uuid.mockRestore();click(panel.root,"New hypothetical branch");input(panel.root,"Branch title","valid title");input(panel.root,"Hypothetical steps","one\n\nthree");click(panel.root,"Save branch");expect(panel.root.textContent).toContain("Save failed");expect(storage.setItem).not.toHaveBeenCalled();expect(panel.root.querySelector<HTMLTextAreaElement>('[aria-label="Hypothetical steps"]')?.value).toBe("one\n\nthree");
});

test("read-only notebook refuses new drafts after receipt verification",async()=>{
 raw='broken';const panel=createReplay();await route(panel);click(panel.root,'Select observation');click(panel.root,'Inspect captured receipt');await settle();click(panel.root,'New hypothetical branch');
 expect(panel.root.textContent).toContain('Cannot create a branch while the notebook is read-only');
 expect(panel.root.querySelector<HTMLElement>('[aria-label="Hypothetical branch editor"]')?.hidden).toBe(true);
});
test("delete warns explicitly about current unsaved edits",async()=>{
 const panel=createReplay();await draft(panel);click(panel.root,'Save branch');input(panel.root,'Branch title','Changed');click(panel.root,'Delete branch');
 expect(panel.root.querySelector('.replay-confirmation')?.textContent).toContain('Unsaved edits to this branch will also be lost');
});
test("invalid captured clock is labelled undated in selection and map",async()=>{
 api.sessionEvents.mockResolvedValue([{...event,time:'1'}]);const panel=createReplay();await route(panel);click(panel.root,'Select observation');
 expect(panel.root.querySelector('[aria-label="Selected observation"]')?.textContent).toContain('Undated');
 expect(panel.root.querySelector('.replay-map button')?.textContent).toContain('Undated');
});
test.each(["one\ntwo\n", "one\ntwo\n\n", "one\ntwo\n  \n"])("trailing blank step lines save as two steps: %j", async value => {
 const panel = createReplay(); await draft(panel);
 input(panel.root, "Hypothetical steps", value); click(panel.root, "Save branch");
 expect(raw).not.toBeNull();
 expect(JSON.parse(raw!).branches[0].steps).toEqual(["one", "two"]);
 expect(panel.root.textContent).toContain("Saved hypothetical branch locally");
});
