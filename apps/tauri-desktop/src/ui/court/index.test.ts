// @vitest-environment happy-dom
import {beforeEach, expect, test, vi} from "vitest";
import type {FirehoseEvent} from "../../api";
import fixture from "../score/fixture.errsig.json";
const api=vi.hoisted(()=>({capturedEvent:vi.fn()})); vi.mock("../../api",()=>api);
import {createCourt} from "./index";
const event=(fixture as FirehoseEvent[]).find(e=>e.session_id)!;
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const click=(root:HTMLElement,label:string)=>{const b=[...root.querySelectorAll("button")].find(b=>b.textContent===label);expect(b).toBeTruthy();b!.click();};
const input=(root:HTMLElement,label:string,value:string)=>{const field=root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;expect(field).toBeTruthy();field.value=value;field.dispatchEvent(new Event("input"));};
function storage(){let value:string|null=null;return {getItem:vi.fn(()=>value),setItem:vi.fn((_k:string,v:string)=>{value=v;})};}
beforeEach(()=>{vi.resetAllMocks();api.capturedEvent.mockResolvedValue(event);});
function setup(){const store=storage();const score=vi.fn();const panel=createCourt(score,store);input(panel.root,"New claim","Tests pass");click(panel.root,"Create claim");input(panel.root,"New requirement","Captured test result");click(panel.root,"Add requirement");return {panel,store,score};}
test("creates gaps, explicitly looks up and attaches identity only, reopens evidence and removes receipt",async()=>{
 const {panel,store,score}=setup();expect(panel.root.textContent).toContain("Missing receipt");expect(api.capturedEvent).not.toHaveBeenCalled();
 panel.offerEvent(event.id);click(panel.root,"Captured test result");expect(api.capturedEvent).not.toHaveBeenCalled();click(panel.root,"Look up event");await settle();expect(panel.root.querySelector("pre")?.textContent).toContain(event.id);
 click(panel.root,"Attach receipt");expect(panel.root.textContent).toContain("Receipt attached — not verified");expect(store.getItem()).not.toContain(event.summary!);expect(store.getItem()).toContain(event.id);
 click(panel.root,"Open receipt");await settle();expect(panel.root.textContent).toContain("Attached to: Tests pass → Captured test result");click(panel.root,"Open Score");expect(score).toHaveBeenCalledWith(event.session_id,event.source);
 click(panel.root,"Remove receipt");click(panel.root,"Confirm removal");expect(panel.root.textContent).toContain("Missing receipt");
});
test("navigation keeps drafts but cancels previews; handoff never automatically attaches",async()=>{
 const {panel}=setup();input(panel.root,"Claim text","draft edit");panel.refresh();expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Claim text"]')?.value).toBe("draft edit");
 let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");const signal=api.capturedEvent.mock.calls[0][1] as AbortSignal;
 panel.offerEvent("other");expect(signal.aborted).toBe(true);resolve(event);await settle();expect(panel.root.querySelector("pre")).toBeNull();expect(panel.root.textContent).toContain("Missing receipt");
});
test("mismatch and failed save keep the missing gap; reload recovers storage failures",async()=>{
 const {panel,store}=setup();panel.offerEvent(event.id);click(panel.root,"Captured test result");api.capturedEvent.mockResolvedValueOnce({...event,id:"wrong"});click(panel.root,"Look up event");await settle();expect(panel.root.textContent).toContain("Evidence identity mismatch");expect(panel.root.textContent).toContain("Nothing attached.");expect(panel.root.textContent).not.toContain("inspect or remove");
 click(panel.root,"Look up event");await settle();store.setItem.mockImplementationOnce(()=>{throw Error("quota");});click(panel.root,"Attach receipt");expect(panel.root.textContent).toContain("Storage may be full or unavailable");expect(panel.root.textContent).toContain("Missing receipt");
 click(panel.root,"Reload notebook");expect(panel.root.querySelector("pre")).toBeNull();expect(panel.root.textContent).toContain("Missing receipt");
});
test("invalid notebook is visible and cannot be silently overwritten",()=>{const store=storage();store.getItem.mockReturnValue("bad json");const panel=createCourt(undefined,store);expect(panel.root.textContent).toContain("Notebook unavailable");expect(store.setItem).not.toHaveBeenCalled();});
test("editing selected text cancels pending preview and renders notes as text",async()=>{
 const {panel}=setup();let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");
 const signal=api.capturedEvent.mock.calls[0][1] as AbortSignal;input(panel.root,"Requirement text","<img src=x onerror=alert(1)>");expect(signal.aborted).toBe(true);resolve(event);await settle();expect(panel.root.querySelector("pre")).toBeNull();
 click(panel.root,"Save requirement");expect(panel.root.textContent).toContain("<img src=x");expect(panel.root.querySelector("img")).toBeNull();click(panel.root,"Remove requirement");click(panel.root,"Confirm removal");expect(panel.root.textContent).toContain("0 missing receipts");click(panel.root,"Remove claim");click(panel.root,"Confirm removal");expect(panel.root.textContent).toContain("Create or select a claim");
});
test("opening saved identity rejects wrong scope and keeps attachment when lookup fails",async()=>{
 const {panel}=setup();panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");await settle();click(panel.root,"Attach receipt");
 api.capturedEvent.mockResolvedValueOnce({...event,source:"wrong"});click(panel.root,"Open receipt");await settle();expect(panel.root.querySelector("pre")).toBeNull();expect(panel.root.textContent).toContain("Receipt identity mismatch");expect(panel.root.textContent).toContain("Receipt attached — not verified");
 api.capturedEvent.mockRejectedValueOnce(new Error("404"));click(panel.root,"Open receipt");await settle();expect(panel.root.textContent).toContain("The stored reference is retained");
});
test("newer lookup wins, and switching requirements cannot attach the old preview",async()=>{
 const {panel}=setup();let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");click(panel.root,"Look up event");await settle();resolve({...event,summary:"STALE"});await settle();expect(panel.root.textContent).not.toContain("STALE");
 input(panel.root,"New requirement","Second requirement");click(panel.root,"Add requirement");expect(panel.root.querySelector("pre")).toBeNull();expect(panel.root.textContent).toContain("2 missing receipts");
});
test("an event without session has no Score action and remains attachable",async()=>{
 const {panel}=setup();api.capturedEvent.mockResolvedValueOnce({...event,session_id:undefined});panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");await settle();expect([...panel.root.querySelectorAll("button")].some(b=>b.textContent==="Open Score")).toBe(false);click(panel.root,"Attach receipt");expect(panel.root.textContent).toContain("Receipt attached — not verified");
});
test("reload retries initial read failure and clears manual drafts without saving",()=>{
 const store=storage();store.getItem.mockImplementationOnce(()=>{throw Error("blocked");});const panel=createCourt(undefined,store);expect(panel.root.textContent).toContain("Notebook unavailable");
 click(panel.root,"Reload notebook");input(panel.root,"New claim","Unsaved");click(panel.root,"Reload notebook");expect(panel.root.querySelector<HTMLTextAreaElement>('[aria-label="New claim"]')?.value).toBe("");expect(store.setItem).not.toHaveBeenCalled();
});
test("handoff requires deliberate target selection, names saved target, and blocks receipt replacement",async()=>{
 const {panel,store}=setup();panel.offerEvent(event.id);expect(panel.root.querySelector<HTMLButtonElement>('button:last-child')?.disabled ?? false).toBeDefined();
 expect([...panel.root.querySelectorAll("button")].find(b=>b.textContent==="Look up event")!.disabled).toBe(true);click(panel.root,"Captured test result");click(panel.root,"Look up event");await settle();expect(panel.root.textContent).toContain("Attach to: Tests pass → Captured test result");
 click(panel.root,"Attach receipt");expect(JSON.parse(store.getItem()!).claims[0].requirements[0].receipt).toEqual({id:event.id,source:event.source,session_id:event.session_id});
 expect([...panel.root.querySelectorAll("button")].find(b=>b.textContent==="Look up event")!.disabled).toBe(true);
 click(panel.root,"Reload notebook");click(panel.root,"Captured test result");expect(panel.root.textContent).toContain("Receipt attached — not verified");
 click(panel.root,"Remove receipt");click(panel.root,"Cancel removal");expect(panel.root.textContent).toContain("Receipt attached — not verified");click(panel.root,"Remove receipt");click(panel.root,"Confirm removal");click(panel.root,"Reload notebook");expect(panel.root.textContent).toContain("Missing receipt");
});
test("failed attach and unrelated drafts preserve evidence, and in-panel selection preserves drafts",async()=>{
 const {panel,store}=setup();panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");await settle();input(panel.root,"New claim","draft new claim");expect(panel.root.querySelector("pre")).not.toBeNull();
 store.setItem.mockImplementationOnce(()=>{throw Error("quota");});click(panel.root,"Attach receipt");expect(panel.root.querySelector("pre")).not.toBeNull();expect(panel.root.textContent).toContain("Missing receipt");
 click(panel.root,"Attach receipt");expect(api.capturedEvent).toHaveBeenCalledTimes(1);input(panel.root,"Requirement text","draft requirement");click(panel.root,"Tests pass");click(panel.root,"Captured test result");expect(panel.root.querySelector<HTMLTextAreaElement>('[aria-label="Requirement text"]')?.value).toBe("draft requirement");expect(panel.root.querySelector<HTMLTextAreaElement>('[aria-label="New claim"]')?.value).toBe("draft new claim");
});
test("corrupt notebook offers raw recovery text and unavailable UUID creation is visible",()=>{
 const store=storage();store.getItem.mockReturnValue('{"version":99}');const panel=createCourt(undefined,store);expect(panel.root.querySelector("pre")?.textContent).toBe('{"version":99}');expect(store.setItem).not.toHaveBeenCalled();
 const good=createCourt(undefined,storage());const uuid=vi.spyOn(crypto,"randomUUID").mockImplementation(()=>{throw Error("UUID unavailable");});input(good.root,"New claim","claim");click(good.root,"Create claim");expect(good.root.textContent).toContain("Could not create an ID");uuid.mockRestore();
});
test("stale cross-window attach keeps preview and draft while rejecting write",async()=>{
 const {panel,store}=setup();panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");await settle();
 input(panel.root,"New claim","keep my draft");const external=JSON.parse(store.getItem()!);external.claims[0].text="Other window edit";store.setItem("firehose.evidence-court.v1",JSON.stringify(external));
 click(panel.root,"Attach receipt");expect(panel.root.textContent).toContain("Save failed");expect(panel.root.querySelector("pre")?.textContent).toContain(event.id);expect(panel.root.querySelector<HTMLTextAreaElement>('[aria-label="New claim"]')?.value).toBe("keep my draft");expect(JSON.parse(store.getItem()!).claims[0].requirements[0].receipt).toBeUndefined();expect(api.capturedEvent).toHaveBeenCalledTimes(1);
});
test("switching target rejects a pending old response and detached Attach action",async()=>{
 const {panel,store}=setup();input(panel.root,"New requirement","Second requirement");click(panel.root,"Add requirement");panel.offerEvent(event.id);click(panel.root,"Captured test result");click(panel.root,"Look up event");await settle();
 const oldButton=[...panel.root.querySelectorAll("button")].find(b=>b.textContent==="Attach receipt")!;click(panel.root,"Second requirement");oldButton.click();expect(JSON.parse(store.getItem()!).claims[0].requirements.every((r:{receipt?:unknown})=>!r.receipt)).toBe(true);
 let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));click(panel.root,"Look up event");const signal=api.capturedEvent.mock.calls.at(-1)![1] as AbortSignal;click(panel.root,"Captured test result");resolve(event);await settle();expect(signal.aborted).toBe(true);expect(panel.root.querySelector("pre")).toBeNull();
});
test("offered event retains unavailable notebook guidance",()=>{
 const store=storage();store.getItem.mockReturnValue('bad json');const panel=createCourt(undefined,store);panel.offerEvent(event.id);
 expect(panel.root.textContent).toContain('Notebook unavailable');expect(panel.root.textContent).not.toContain('Select a requirement, look up');expect(store.setItem).not.toHaveBeenCalled();
});
