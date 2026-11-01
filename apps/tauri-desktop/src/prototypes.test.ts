// @vitest-environment happy-dom
import {afterEach, expect, test, vi} from "vitest";
import fixture from "./ui/score/fixture.session.json";
import {renderDetail} from "./ui/detail";
import type {FirehoseEvent} from "./api";
const event = fixture[0] as FirehoseEvent;
const click = (label:string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === label);
  expect(button, label).toBeTruthy(); button!.click();
};
const nav = (panel:string) => document.querySelector<HTMLButtonElement>(`.nav-btn[data-panel=${panel}]`)!.click();
const tab = (name:string) => document.querySelector<HTMLElement>(`#session-tab-${name}`)!.click();
const input = (label:string, value:string) => {
  const field = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  expect(field, label).toBeTruthy(); field.value=value; field.dispatchEvent(new Event("input"));
};
afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules();});
async function setup() {
  document.body.innerHTML = '<div id="app"></div>';
  const data = new Map<string,string>();
  vi.stubGlobal("localStorage", {getItem:(key:string)=>key.includes("onboard") ? "1" : data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});
  vi.stubGlobal("setInterval", ()=>0);
  vi.stubGlobal("EventSource", class {close() {}});
  let receiptSignal:AbortSignal|undefined;
  vi.stubGlobal("fetch",vi.fn(async (url:string, init?:RequestInit)=> {
    if (url.includes(`/attention/event?id=${event.id}`)) {receiptSignal=init?.signal as AbortSignal; return new Promise<Response>(()=>{});}
    return new Response(JSON.stringify(url.endsWith("/health")?{status:"ok",version:"test",schema_version:1}:url.includes("/attention")?{sessions:[],warnings:[]}:[]));
  }));
  await import("./main");
  return ()=>receiptSignal;
}
test("all prototypes coexist and close a shared receipt on entry",async()=>{
  await setup();
  for(const name of ["court","handoffs","loom","ecosystem","replay","fleet"]) {
    renderDetail(document.querySelector<HTMLElement>("aside.detail")!,event,()=>{});
    expect(document.querySelector("aside.detail pre")).not.toBeNull();
    const tab = ["court","handoffs","loom","replay"].includes(name);
    if (tab) {nav("session");document.querySelector<HTMLElement>(`#session-tab-${name}`)!.click();}
    else nav(name);
    expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe(tab?"session":name);
    expect(document.querySelector("aside.detail")?.textContent).not.toContain(event.id);
    expect(document.querySelector(".attention-strip")).not.toBeNull();
  }
});
test("leaving Court cancels its pending receipt and preserves unsaved text across other prototypes",async()=>{
  const signal=await setup(); nav("session");tab("court");
  input("New claim","Tests pass");click("Create claim");input("New requirement","Captured result");click("Add requirement");
  input("Event ID",event.id);click("Look up event");
  expect(signal()).toBeDefined();
  input("New claim","Unsubmitted idea");tab("replay");
  expect(signal()!.aborted).toBe(true);
  nav("ecosystem");nav("session");
  expect(document.querySelector("#session-tab-replay")?.getAttribute("aria-selected")).toBe("true");
  tab("court");
  expect(document.querySelector<HTMLInputElement>('[aria-label="New claim"]')?.value).toBe("Unsubmitted idea");
});
test("Escape neither aborts a pending Court receipt nor leaves the tab; it is not prevented in the claim input",async()=>{
  const signal=await setup(); nav("session");tab("court");
  input("New claim","Tests pass");click("Create claim");input("New requirement","Captured result");click("Add requirement");
  input("Event ID",event.id);click("Look up event");
  expect(signal()).toBeDefined();
  const field=document.querySelector<HTMLElement>('[aria-label="New claim"]')!;
  const inField=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
  field.dispatchEvent(inField);
  const onTab=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
  document.querySelector("#session-tab-court")!.dispatchEvent(onTab);
  expect(inField.defaultPrevented).toBe(false);
  expect(onTab.defaultPrevented).toBe(false);
  expect(signal()!.aborted).toBe(false);
  expect(document.querySelector("#session-tab-court")?.getAttribute("aria-selected")).toBe("true");
  expect(document.querySelector(".nav-btn.active")?.getAttribute("data-panel")).toBe("session");
});
