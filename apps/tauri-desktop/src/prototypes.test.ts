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
  for(const name of ["court","handoffs","airspace","loom","ecosystem","replay"]) {
    renderDetail(document.querySelector<HTMLElement>("aside.detail")!,event,()=>{});
    expect(document.querySelector("aside.detail pre")).not.toBeNull();
    click(name);
    expect(document.querySelector(".nav-btn.active")?.textContent).toBe(name);
    expect(document.querySelector("aside.detail")?.textContent).not.toContain(event.id);
    expect(document.querySelector(".attention-strip")).not.toBeNull();
  }
});
test("leaving Court cancels its pending receipt and preserves unsaved text across other prototypes",async()=>{
  const signal=await setup(); click("court");
  input("New claim","Tests pass");click("Create claim");input("New requirement","Captured result");click("Add requirement");
  input("Event ID",event.id);click("Look up event");
  expect(signal()).toBeDefined();
  input("New claim","Unsubmitted idea");click("replay");
  expect(signal()!.aborted).toBe(true);
  click("ecosystem");click("court");
  expect(document.querySelector<HTMLInputElement>('[aria-label="New claim"]')?.value).toBe("Unsubmitted idea");
});
