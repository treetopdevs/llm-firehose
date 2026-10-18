// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import type { AttentionSnapshot, AttentionSession, FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
const api = vi.hoisted(() => ({ attention: vi.fn(), capturedEvent: vi.fn() }));
vi.mock("../../api", () => api);
import { createAirspace } from "./index";
const event = (fixture as FirehoseEvent[]).find(e => e.session_id)!;
const row: AttentionSession = { id: event.session_id!, source: event.source, state: "working", events: 1, last: { event_id: event.id, source: event.source, kind: "activity", summary: event.summary!, time: event.time, observed_at: event.time } };
const snapshot: AttentionSnapshot = { sessions: [row], warnings: [], gaps: [] };
const now = () => Date.parse(event.time) + 60000;
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent === text); expect(b).toBeTruthy(); b!.click(); };
const settle = async () => { for (let i = 0; i < 10; i++)
    await Promise.resolve(); };
beforeEach(() => { vi.resetAllMocks(); api.attention.mockResolvedValue(snapshot); api.capturedEvent.mockResolvedValue(event); });
test("activation fetches once and receipt lookup is explicit with exact scoped Score", async () => {
    const score = vi.fn(), inbox = vi.fn(), panel = createAirspace(score, inbox, now);
    await panel.activate();
    expect(api.attention).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(api.capturedEvent).not.toHaveBeenCalled();
    expect(panel.root.textContent).toContain("No recorded capture gaps");
    click(panel.root, "Select session");
    click(panel.root, "Inspect latest observation");
    await settle();
    expect(api.capturedEvent).toHaveBeenCalledExactlyOnceWith(event.id, expect.any(AbortSignal));
    expect(panel.root.querySelector("pre")?.textContent).toContain(event.id);
    click(panel.root, "Open Score");
    expect(score).toHaveBeenCalledWith(row.id, row.source);
    click(panel.root, "Open Attention inbox");
    expect(inbox).toHaveBeenCalledOnce();
});
test("offline cancels requests and preserves stale snapshot; reconnect requires explicit refresh", async () => {
    const panel = createAirspace(undefined, undefined, now);
    await panel.activate();
    panel.setConnected(false);
    expect(panel.root.textContent).toContain("Disconnected");
    expect(panel.root.textContent).toContain(row.id);
    panel.setConnected(true);
    expect(panel.root.textContent).toContain("stale");
    expect(api.attention).toHaveBeenCalledTimes(1);
    await panel.refresh();
    expect(api.attention).toHaveBeenCalledTimes(2);
    api.attention.mockRejectedValueOnce(new Error("offline"));
    await panel.refresh();
    expect(panel.root.textContent).toContain("Snapshot stale");
    expect(panel.root.textContent).toContain(row.id);
});
test("newer snapshot wins and deactivation rejects pending evidence", async () => {
    const panel = createAirspace(undefined, undefined, now);
    let resolve!: (v: AttentionSnapshot) => void;
    api.attention.mockReturnValueOnce(new Promise(r => resolve = r));
    const old = panel.activate();
    await panel.refresh();
    resolve({ sessions: [], warnings: [] });
    await old;
    expect(panel.root.textContent).toContain(row.id);
    let receipt!: (v: FirehoseEvent) => void;
    api.capturedEvent.mockReturnValueOnce(new Promise(r => receipt = r));
    click(panel.root, "Select session");
    click(panel.root, "Inspect latest observation");
    const signal = api.capturedEvent.mock.calls[0][1] as AbortSignal;
    panel.deactivate();
    receipt(event);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(panel.root.querySelector("pre")).toBeNull();
});
test("filters locally before bounded paging and limits warning and gap lists", async () => {
    api.attention.mockResolvedValue({ sessions: Array.from({ length: 45 }, (_, i) => ({ ...row, id: `session-${i}`, source: i === 44 ? "codex" : "claude-code" })), warnings: Array.from({ length: 12 }, () => row.last), gaps: Array.from({ length: 12 }, () => ({ source: "codex", time: event.time, summary: "gap" })) });
    const panel = createAirspace(undefined, undefined, now);
    await panel.activate();
    expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(20);
    expect(panel.root.querySelectorAll(".airspace-warnings li")).toHaveLength(10);
    expect(panel.root.querySelectorAll(".airspace-gaps li")).toHaveLength(10);
    click(panel.root, "Next sessions");
    expect(panel.root.textContent).toContain("21–40");
    const source = panel.root.querySelector<HTMLSelectElement>('[aria-label="Airspace source"]')!;
    source.value = JSON.stringify("codex");
    source.dispatchEvent(new Event("change"));
    expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(1);
    expect(api.attention).toHaveBeenCalledTimes(1);
});
test("mismatched receipt never renders and local filter cancels evidence", async () => {
    const panel = createAirspace(undefined, undefined, now);
    await panel.activate();
    click(panel.root, "Select session");
    api.capturedEvent.mockResolvedValueOnce({ ...event, session_id: "wrong" });
    click(panel.root, "Inspect latest observation");
    await settle();
    expect(panel.root.textContent).toContain("identity mismatch");
    expect(panel.root.querySelector("pre")).toBeNull();
    click(panel.root, "Inspect latest observation");
    await settle();
    const input = panel.root.querySelector<HTMLInputElement>('[aria-label="Search Airspace"]')!;
    input.value = "missing";
    input.dispatchEvent(new Event("input"));
    expect(panel.root.querySelector("pre")).toBeNull();
    expect(panel.root.textContent).toContain("No sessions match");
});
test("pending receipt is explicit, scopes evidence, and distinguishes source event time from capture", async () => {
    api.attention.mockResolvedValue({...snapshot, sessions:[{...row, pending:{...row.last,event_id:event.id,kind:"permission",source_time:event.time,summary:"<img src=x>"},last_observed_at:"2026-10-18T00:00:00Z"}]});
    const panel=createAirspace(undefined,undefined,now);await panel.activate();click(panel.root,"Select session");expect(panel.root.textContent).toContain("Pending observation (age is not waiting duration)");expect(panel.root.textContent).toContain("Source event time:");expect(panel.root.textContent).toContain("2026-10-18T00:00:00Z");expect(panel.root.querySelector("img")).toBeNull();expect(api.capturedEvent).not.toHaveBeenCalled();click(panel.root,"Inspect pending receipt");await settle();expect(api.capturedEvent).toHaveBeenCalledExactlyOnceWith(event.id,expect.any(AbortSignal));
});
test("offline and deactivation abort pending snapshots and repeated connectivity preserves evidence",async()=>{
    const panel=createAirspace(undefined,undefined,now);let resolve!:(v:AttentionSnapshot)=>void;api.attention.mockReturnValueOnce(new Promise(r=>resolve=r));const pending=panel.activate();const signal=api.attention.mock.calls[0][0] as AbortSignal;panel.setConnected(false);expect(signal.aborted).toBe(true);resolve(snapshot);await pending;expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(0);
    panel.setConnected(true);await panel.activate();click(panel.root,"Select session");click(panel.root,"Inspect latest observation");await settle();panel.setConnected(true);expect(panel.root.querySelector("pre")).not.toBeNull();expect(api.attention).toHaveBeenCalledTimes(2);
    let late!:(v:AttentionSnapshot)=>void;api.attention.mockReturnValueOnce(new Promise(r=>late=r));const refresh=panel.refresh();const nextSignal=api.attention.mock.calls[2][0] as AbortSignal;panel.deactivate();expect(nextSignal.aborted).toBe(true);late({sessions:[],warnings:[]});await refresh;expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(1);
});
test("Unknown workspace and literal all filters are distinct and preserved on activation",async()=>{
    api.attention.mockResolvedValue({...snapshot,sessions:[row,{...row,id:"literal",source:"all",cwd:"all"}]});const panel=createAirspace(undefined,undefined,now);await panel.activate();const workspace=panel.root.querySelector<HTMLSelectElement>('[aria-label="Airspace workspace"]')!;workspace.value=JSON.stringify("");workspace.dispatchEvent(new Event("change"));expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(1);expect(panel.root.textContent).toContain(row.id);
    workspace.value=JSON.stringify("all");workspace.dispatchEvent(new Event("change"));expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(1);expect(panel.root.textContent).toContain("literal");panel.deactivate();await panel.activate();expect(workspace.value).toBe(JSON.stringify("all"));expect(panel.root.querySelectorAll(".airspace-row")).toHaveLength(1);
});
test("first-load failure differs from empty success and a failed refresh clears displayed receipt",async()=>{
    const panel=createAirspace(undefined,undefined,now);api.attention.mockRejectedValueOnce(new Error("offline"));await panel.activate();expect(panel.root.textContent).toContain("No snapshot available");expect(panel.root.textContent).not.toContain("No sessions match");
    await panel.refresh();click(panel.root,"Select session");click(panel.root,"Inspect latest observation");await settle();api.attention.mockRejectedValueOnce(new Error("temporary"));await panel.refresh();expect(panel.root.querySelector("pre")).toBeNull();expect(panel.root.textContent).toContain(row.id);api.attention.mockResolvedValueOnce({sessions:[],warnings:[]});await panel.refresh();expect(panel.root.textContent).toContain("No sessions match");
});
test.each(["success","failure"])("accepted refresh %s cancels evidence selected from retained old board while loading",async outcome=>{
    const panel=createAirspace(undefined,undefined,now);await panel.activate();let resolve!:(v:AttentionSnapshot)=>void,reject!:(e:Error)=>void;api.attention.mockReturnValueOnce(new Promise((a,b)=>{resolve=a;reject=b;}));const refreshing=panel.refresh();
    let receipt!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>receipt=r));click(panel.root,"Select session");click(panel.root,"Inspect latest observation");const signal=api.capturedEvent.mock.calls[0][1] as AbortSignal;
    if(outcome==="success")resolve(snapshot);else reject(new Error("offline"));await refreshing;expect(signal.aborted).toBe(true);receipt(event);await settle();expect(panel.root.querySelector("pre")).toBeNull();expect(panel.root.querySelector('[aria-label="Selected session"]')?.textContent).toBe("");
});
test("selecting a session reveals its detail with keyboard focus",async()=>{
 const panel=createAirspace(undefined,undefined,now);document.body.append(panel.root);try{await panel.activate();click(panel.root,"Select session");const selected=panel.root.querySelector<HTMLElement>('[aria-label="Selected session"]')!;expect(document.activeElement).toBe(selected);expect(selected.getAttribute("tabindex")).toBe("-1");}finally{panel.root.remove();}
});
test("paging retains the evaluated snapshot even when activity ages across the window",async()=>{
 let clock=Date.parse(event.time)+14*60000;
 const sessions=Array.from({length:21},(_,i)=>({...row,id:`working-${String(i).padStart(2,"0")}`,last:{...row.last,time:new Date(Date.parse(event.time)+i*1000).toISOString()}}));
 // A quiet row has a newer clock; re-evaluation would move it before aged
 // working rows and repeat the last row of the prior page.
 sessions.push({...row,id:"quiet",state:"unknown",last:{...row.last,time:new Date(clock).toISOString()}});
 api.attention.mockResolvedValue({sessions,warnings:[]});const panel=createAirspace(undefined,undefined,()=>clock);await panel.activate();
 const first=[...panel.root.querySelectorAll(".airspace-row h3")].map(n=>n.textContent);
 const stamp=panel.root.querySelector(".airspace-notice")!.textContent;
 clock+=2*60000;click(panel.root,"Next sessions");const second=[...panel.root.querySelectorAll(".airspace-row h3")].map(n=>n.textContent);
 expect(second).toEqual([`${row.source} / working-00`,`${row.source} / quiet`]);expect(second.every(id=>!first.includes(id))).toBe(true);expect(panel.root.querySelector(".airspace-notice")!.textContent).toBe(stamp);
 click(panel.root,"Previous sessions");expect([...panel.root.querySelectorAll(".airspace-row h3")].map(n=>n.textContent)).toEqual(first);
});
