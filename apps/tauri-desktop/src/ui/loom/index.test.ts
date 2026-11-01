// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
const api = vi.hoisted(() => ({ attention: vi.fn(), sessionEvents: vi.fn(), capturedEvent: vi.fn() }));
vi.mock("../../api", () => api);
import { createLoom } from "./index";
import { createScope } from "../../scope";
const event = (fixture as FirehoseEvent[]).find(e => e.session_id)!;
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent === text); expect(b).toBeTruthy(); b!.click(); };
const input = (root: HTMLElement, label: string, value: string) => { const field = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; field.value = value; field.dispatchEvent(new Event("input")); };
const settle = async () => { for (let i = 0; i < 10; i++)
    await Promise.resolve(); };
async function load(panel: ReturnType<typeof createLoom>) { input(panel.root, "Source", event.source); input(panel.root, "Session ID", event.session_id!); click(panel.root, "Load relationships"); await settle(); }
beforeEach(() => { vi.resetAllMocks(); api.attention.mockResolvedValue({ sessions: [{ id: event.session_id, source: event.source }], warnings: [] }); api.sessionEvents.mockResolvedValue([event]); api.capturedEvent.mockResolvedValue(event); });
test("choice refresh fetches no history; explicit load and inspect validate exact source/session", async () => {
    const score = vi.fn(), panel = createLoom(score);
    await panel.refresh();
    expect(api.attention).toHaveBeenCalledOnce();
    expect(api.sessionEvents).not.toHaveBeenCalled();
    await load(panel);
    expect(api.sessionEvents).toHaveBeenCalledExactlyOnceWith(event.session_id, "correlation", expect.any(AbortSignal));
    expect(api.capturedEvent).not.toHaveBeenCalled();
    click(panel.root, "Focus observation");
    click(panel.root, "Inspect captured receipt");
    await settle();
    expect(api.capturedEvent).toHaveBeenCalledExactlyOnceWith(event.id, expect.any(AbortSignal));
    click(panel.root, "Open Score");
    expect(score).toHaveBeenCalledWith(event.session_id, event.source);
});
test("editing scope cancels old metadata and never labels it as a new session", async () => {
    const panel = createLoom();
    await load(panel);
    input(panel.root, "Session ID", "other");
    expect(panel.root.querySelectorAll(".loom-observation")).toHaveLength(0);
    let resolve!: (v: FirehoseEvent[]) => void;
    api.sessionEvents.mockReturnValueOnce(new Promise(r => resolve = r));
    click(panel.root, "Load relationships");
    const signal = api.sessionEvents.mock.calls.at(-1)![2] as AbortSignal;
    input(panel.root, "Source", "other-source");
    resolve([event]);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(panel.root.querySelectorAll(".loom-observation")).toHaveLength(0);
});
test("search and errors filter bounded observations locally and clear receipt", async () => {
    api.sessionEvents.mockResolvedValue(Array.from({ length: 85 }, (_, i) => ({ ...event, id: `e-${String(i).padStart(3, "0")}`, category: i === 84 ? "error" : "file", severity: i === 84 ? "error" : "info", summary: `observation ${i}` })));
    const panel = createLoom();
    await load(panel);
    expect(panel.root.querySelectorAll(".loom-observation")).toHaveLength(40);
    click(panel.root, "Next observations");
    expect(panel.root.textContent).toContain("41–80 of 85");
    const check = panel.root.querySelector<HTMLInputElement>('[aria-label="Errors only"]')!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    expect(panel.root.querySelectorAll(".loom-observation")).toHaveLength(1);
    expect(api.sessionEvents).toHaveBeenCalledOnce();
});
test("old daemon rejection is visible without full-payload fallback", async () => {
    api.sessionEvents.mockRejectedValueOnce(new Error("400 invalid view"));
    const panel = createLoom();
    await load(panel);
    expect(panel.root.textContent).toContain("older daemon");
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
    expect(panel.root.querySelectorAll(".loom-observation")).toHaveLength(0);
});
test("deactivation aborts evidence and rejects mismatched returned receipts", async () => {
    const panel = createLoom();
    await load(panel);
    click(panel.root, "Focus observation");
    api.capturedEvent.mockResolvedValueOnce({ ...event, source: "wrong" });
    click(panel.root, "Inspect captured receipt");
    await settle();
    expect(panel.root.textContent).toContain("identity mismatch");
    expect(panel.root.querySelector(".loom-evidence pre")).toBeNull();
    let resolve!: (v: FirehoseEvent) => void;
    api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r));
    click(panel.root, "Inspect captured receipt");
    const signal = api.capturedEvent.mock.calls.at(-1)![1] as AbortSignal;
    panel.deactivate();
    resolve(event);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(panel.root.querySelector(".loom-evidence pre")).toBeNull();
});
test("real OpenCode native message reference and member selection never fetch full receipts",async()=>{
 const native=(await import("./fixture.opencode.json")).default as FirehoseEvent[];api.sessionEvents.mockResolvedValue(native);const panel=createLoom();input(panel.root,"Source","opencode");input(panel.root,"Session ID",native[0].session_id!);click(panel.root,"Load relationships");await settle();click(panel.root,"Focus observation");expect(panel.root.textContent).toContain("Native parent message reference");const group=panel.root.querySelector<HTMLButtonElement>(".loom-groups button")!;group.click();expect(panel.root.querySelectorAll(".loom-members li").length).toBeGreaterThan(0);panel.root.querySelector<HTMLButtonElement>(".loom-members button")!.click();expect(api.capturedEvent).not.toHaveBeenCalled();
});
test("group members remain reachable across bounded pages",async()=>{
 const captured=(await import("../score/fixture.session.json")).default as FirehoseEvent[];const call=captured.find(e=>e.call_id)!;api.sessionEvents.mockResolvedValue(Array.from({length:85},(_,i)=>({...call,id:`member-${String(i).padStart(3,"0")}`})));const panel=createLoom();input(panel.root,"Source",call.source);input(panel.root,"Session ID",call.session_id!);click(panel.root,"Load relationships");await settle();click(panel.root,"Focus observation");panel.root.querySelector<HTMLButtonElement>(".loom-groups button")!.click();expect(panel.root.querySelectorAll(".loom-members li")).toHaveLength(40);click(panel.root,"Next members");expect(panel.root.querySelectorAll(".loom-members li")).toHaveLength(40);click(panel.root,"Next members");expect(panel.root.querySelectorAll(".loom-members li")).toHaveLength(5);expect(api.capturedEvent).not.toHaveBeenCalled();
});
test("focus reveals safe metadata and search clears pending receipt",async()=>{
 api.sessionEvents.mockResolvedValue([{...event,summary:"<img src=x>"}]);const panel=createLoom();document.body.append(panel.root);try{await load(panel);click(panel.root,"Focus observation");expect(document.activeElement).toBe(panel.root.querySelector('[aria-label="Focused observation"]'));expect(panel.root.querySelector("img")).toBeNull();let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));click(panel.root,"Inspect captured receipt");const signal=api.capturedEvent.mock.calls[0][1] as AbortSignal;input(panel.root,"Search observations","unmatched");resolve(event);await settle();expect(signal.aborted).toBe(true);expect(panel.root.querySelector(".loom-evidence pre")).toBeNull();}finally{panel.root.remove();}
});
test("manual scope stays available when choices fail and newer choices beat stale results",async()=>{
 const panel=createLoom();api.attention.mockRejectedValueOnce(new Error("offline"));await panel.refresh();expect(panel.root.textContent).toContain("Manual exact scope remains available");await load(panel);expect(panel.root.querySelectorAll(".loom-observation")).toHaveLength(1);let resolve!:(v:unknown)=>void;api.attention.mockReturnValueOnce(new Promise(r=>resolve=r));const old=panel.refresh();await panel.refresh();resolve({sessions:[{source:"stale",id:"stale"}]});await old;expect(panel.root.querySelector('select')?.textContent).not.toContain("stale");
});
test("large one-hop neighborhoods paginate all groups and native references",async()=>{
 const native=(await import("./fixture.opencode.json")).default as FirehoseEvent[];const parent=native[0],child=native.find(e=>e.parent_id)!;api.sessionEvents.mockResolvedValue([parent,...Array.from({length:45},(_,i)=>({...child,id:`child-${i}`,message_id:`msg-child-${i}`,parent_id:parent.message_id}))]);const panel=createLoom();input(panel.root,"Source",parent.source);input(panel.root,"Session ID",parent.session_id!);click(panel.root,"Load relationships");await settle();click(panel.root,"Focus observation");expect(panel.root.querySelectorAll(".loom-groups li")).toHaveLength(20);expect(panel.root.querySelectorAll(".loom-parents li")).toHaveLength(20);click(panel.root,"Next groups");click(panel.root,"Next groups");expect(panel.root.querySelectorAll(".loom-groups li")).toHaveLength(6);click(panel.root,"Next references");click(panel.root,"Next references");expect(panel.root.querySelectorAll(".loom-parents li")).toHaveLength(5);
});

test("reference depth and direction redraw locally, retain focus, and cancel late receipts", async () => {
 const native = (await import("./fixture.opencode.json")).default as FirehoseEvent[];
 const a = {...native[0],id:"a",message_id:"a"};
 const b = {...native[1],id:"b",message_id:"b",parent_id:"a"};
 const c = {...b,id:"c",message_id:"c",parent_id:"b"};
 api.sessionEvents.mockResolvedValue([a,b,c]);
 const panel = createLoom(); document.body.append(panel.root);
 input(panel.root,"Source","opencode"); input(panel.root,"Session ID","ses_fixture01");
 click(panel.root,"Load relationships"); await settle();
 panel.root.querySelector<HTMLButtonElement>('[aria-label="Focus observation opencode / ses_fixture01 / c"]')!.click();
 expect(panel.root.querySelector('[aria-label="Native group opencode / ses_fixture01 / message / a"]')).toBeNull();
 let resolve!: (v: FirehoseEvent)=>void;
 api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));
 click(panel.root,"Inspect captured receipt");
 const signal = api.capturedEvent.mock.calls.at(-1)![1] as AbortSignal;
 const depth = panel.root.querySelector<HTMLSelectElement>('[aria-label="Reference depth"]');
 expect(depth).not.toBeNull(); depth!.focus(); depth!.value="2"; depth!.dispatchEvent(new Event("change"));
 expect(document.activeElement).toBe(depth);
 expect(signal.aborted).toBe(true);
 expect(panel.root.querySelector('[aria-label="Native group opencode / ses_fixture01 / message / a"]')).not.toBeNull();
 resolve(c); await settle(); expect(panel.root.querySelector(".loom-evidence pre")).toBeNull();
 const direction=panel.root.querySelector<HTMLSelectElement>('[aria-label="Reference direction"]')!;
 direction.value="downstream"; direction.dispatchEvent(new Event("change"));
 expect(panel.root.querySelector('[aria-label="Native group opencode / ses_fixture01 / message / b"]')).toBeNull();
 expect(api.sessionEvents).toHaveBeenCalledOnce(); expect(api.capturedEvent).toHaveBeenCalledOnce();
 input(panel.root,"Source","another"); expect(depth!.value).toBe("1"); expect(direction.value).toBe("both");
 panel.root.remove();
});

test("changing traversal resets paged groups and references and clears selected members", async () => {
 const native=(await import("./fixture.opencode.json")).default as FirehoseEvent[];
 const root={...native[0],id:"root",message_id:"root"};
 const children=Array.from({length:45},(_,i)=>({...native[1],id:`child-${i}`,message_id:`child-${i}`,parent_id:"root"}));
 api.sessionEvents.mockResolvedValue([root,...children]);
 const panel=createLoom(); input(panel.root,"Source","opencode"); input(panel.root,"Session ID","ses_fixture01");
 click(panel.root,"Load relationships"); await settle();
 panel.root.querySelector<HTMLButtonElement>('[aria-label="Focus observation opencode / ses_fixture01 / root"]')!.click();
 click(panel.root,"Next groups"); click(panel.root,"Next references");
 panel.root.querySelector<HTMLButtonElement>('.loom-groups button')!.click();
 expect(panel.root.querySelector('[aria-label="Group members"]')!.textContent).not.toBe("");
 const depth=panel.root.querySelector<HTMLSelectElement>('[aria-label="Reference depth"]')!;
 depth.value="2"; depth.dispatchEvent(new Event("change"));
 expect(panel.root.querySelector('[aria-label="Group members"]')!.textContent).toBe("");
 for(const label of ["Previous groups","Previous references"]) expect([...panel.root.querySelectorAll("button")].find(b=>b.textContent===label)!.disabled).toBe(true);
 expect(panel.root.querySelectorAll('.loom-groups li')).toHaveLength(20);
 expect(panel.root.querySelectorAll('.loom-parents li')).toHaveLength(20);
 expect(api.sessionEvents).toHaveBeenCalledOnce(); expect(api.capturedEvent).not.toHaveBeenCalled();
});

test("exploration options survive focus and filters but explicit reload resets them", async () => {
 api.sessionEvents.mockResolvedValue(Array.from({length:45},(_,i)=>({...event,id:`e-${String(i).padStart(2,"0")}`})));
 const panel=createLoom(); await load(panel);
 const direction=panel.root.querySelector<HTMLSelectElement>('[aria-label="Reference direction"]')!;
 const depth=panel.root.querySelector<HTMLSelectElement>('[aria-label="Reference depth"]')!;
 direction.value="upstream"; direction.dispatchEvent(new Event("change")); depth.value="3"; depth.dispatchEvent(new Event("change"));
 click(panel.root,"Focus observation"); click(panel.root,"Next observations"); click(panel.root,"Focus observation");
 input(panel.root,"Search observations","e-40");
 const errors=panel.root.querySelector<HTMLInputElement>('[aria-label="Errors only"]')!; errors.checked=true; errors.dispatchEvent(new Event("change"));
 expect(direction.value).toBe("upstream"); expect(depth.value).toBe("3");
 click(panel.root,"Load relationships"); await settle(); expect(direction.value).toBe("both"); expect(depth.value).toBe("1");
});

// --- Session tab context ---------------------------------------------------
import type { SessionTabContext } from "./../session/context";
import sessionFixture from "../score/fixture.session.json";
const call = (sessionFixture as FirehoseEvent[]).find(e => e.call_id)!;
const t0 = Date.parse(call.time);
// Five real-shaped copies of one real call event, 10s apart, all sharing the call id (one native group).
const timed = Array.from({ length: 5 }, (_, i) => ({ ...call, id: `w-${i}`, time: new Date(t0 + i * 10_000).toISOString() }));
const ref = { id: call.session_id!, source: call.source };
const ctx = (over: Partial<SessionTabContext> = {}): SessionTabContext => ({ session: ref, window: "live", ...over });
const range = (a: number, b: number) => ({ from: t0 + a * 10_000 - 1, to: t0 + b * 10_000 + 1 });
const field = (root: HTMLElement, label: string) => root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const obs = (root: HTMLElement) => root.querySelectorAll(".loom-observation");
const focusBtn = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`[aria-label="Focus observation ${ref.source} / ${ref.id} / ${id}"]`)!;
async function loaded(over: Partial<SessionTabContext> = {}) {
    api.sessionEvents.mockResolvedValue(timed);
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext(ctx(over));
    await vi.waitFor(() => expect(obs(panel.root).length).toBeGreaterThan(0));
    return panel;
}
test("setContext prefills source+session, locks them, and loads once", async () => {
    const panel = await loaded();
    expect(field(panel.root, "Source").value).toBe(ref.source);
    expect(field(panel.root, "Session ID").value).toBe(ref.id);
    expect(field(panel.root, "Source").disabled).toBe(true);
    expect(field(panel.root, "Session ID").disabled).toBe(true);
    expect(api.sessionEvents).toHaveBeenCalledExactlyOnceWith(ref.id, "correlation", expect.any(AbortSignal));
    panel.setContext(ctx());
    panel.setContext(ctx({ window: range(1, 3) }));
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
    panel.setContext(ctx({ session: null }));
    expect(field(panel.root, "Source").disabled).toBe(false);
    expect(field(panel.root, "Session ID").disabled).toBe(false);
    expect(panel.root.querySelector<HTMLSelectElement>('[aria-label="Known session"]')!.disabled).toBe(false);
    expect(obs(panel.root)).toHaveLength(5);
});
test("source-less ref fills and locks only Session ID, loads nothing, and a different source is a different key", async () => {
    api.sessionEvents.mockResolvedValue(timed);
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext(ctx({ session: { id: ref.id } }));
    expect(field(panel.root, "Session ID").value).toBe(ref.id);
    expect(field(panel.root, "Session ID").disabled).toBe(true);
    expect(field(panel.root, "Source").disabled).toBe(false);
    expect(panel.root.textContent).toContain("Choose the source for this session");
    expect(api.sessionEvents).not.toHaveBeenCalled();
    input(panel.root, "Source", ref.source); click(panel.root, "Load relationships");
    await vi.waitFor(() => expect(obs(panel.root)).toHaveLength(5));
    panel.setContext(ctx({ session: { id: ref.id, source: ref.source } }));
    await vi.waitFor(() => expect(api.sessionEvents).toHaveBeenCalledTimes(2));
    panel.setContext(ctx({ session: { id: ref.id, source: "elsewhere" } }));
    await vi.waitFor(() => expect(api.sessionEvents).toHaveBeenCalledTimes(3));
});
test("observations and groups filtered to the window; live restores everything including later events", async () => {
    const panel = await loaded();
    expect(panel.root.textContent).toContain("5 filtered / 5 scoped observations");
    panel.setContext(ctx({ window: range(1, 2) }));
    expect(panel.root.textContent).toContain("2 filtered / 2 scoped observations");
    expect(obs(panel.root)).toHaveLength(2);
    focusBtn(panel.root, "w-1").click();
    expect(panel.root.querySelector(".loom-groups li button")?.textContent).toContain("2 members");
    panel.root.querySelector<HTMLButtonElement>(".loom-groups li button")!.click();
    expect(panel.root.querySelectorAll(".loom-members li")).toHaveLength(2);
    panel.setContext(ctx({ window: range(3, 4) })); // focused w-1 leaves the window
    expect(panel.root.querySelector('[aria-label="Focused observation"]')!.textContent).toBe("");
    expect(panel.root.querySelectorAll(".loom-groups li")).toHaveLength(0);
    panel.setContext(ctx());
    expect(panel.root.textContent).toContain("5 filtered / 5 scoped observations");
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});
test("a group with no in-window member is hidden", async () => {
    const other = { ...timed[0], id: "o-0", call_id: "other-call", time: new Date(t0 + 40_000).toISOString() };
    api.sessionEvents.mockResolvedValue([...timed.slice(0, 2), other]);
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext(ctx());
    await vi.waitFor(() => expect(obs(panel.root)).toHaveLength(3));
    focusBtn(panel.root, "w-0").click();
    panel.setContext(ctx({ window: range(0, 1) }));
    expect(panel.root.querySelector(".loom-groups")!.textContent).not.toContain("other-call");
});
test("an event later than a former bounds.to appears once the window is live", async () => {
    const panel = await loaded({ window: range(0, 1) });
    expect(obs(panel.root)).toHaveLength(2);
    panel.setContext(ctx());
    expect(obs(panel.root)).toHaveLength(5);
});
test("window change clears focus and receipt when the focused event leaves the window; late receipt is dropped", async () => {
    const panel = await loaded();
    focusBtn(panel.root, "w-0").click();
    let resolve!: (v: FirehoseEvent) => void;
    api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r));
    click(panel.root, "Inspect captured receipt");
    panel.setContext(ctx({ window: range(0, 4) })); // still in window: kept
    expect(panel.root.querySelector('[aria-label="Focused observation"]')!.textContent).toContain("w-0");
    panel.setContext(ctx({ window: range(2, 4) }));
    expect(panel.root.querySelector('[aria-label="Focused observation"]')!.textContent).toBe("");
    resolve(timed[0]);
    await vi.waitFor(() => expect(api.capturedEvent).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(panel.root.querySelector(".loom-evidence pre")).toBeNull();
});
test("window change resets the observation page without refetch", async () => {
    api.sessionEvents.mockResolvedValue(Array.from({ length: 85 }, (_, i) => ({ ...call, id: `p-${String(i).padStart(2, "0")}`, time: new Date(t0 + i * 1000).toISOString() })));
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext(ctx());
    await vi.waitFor(() => expect(obs(panel.root)).toHaveLength(40));
    click(panel.root, "Next observations");
    expect(panel.root.textContent).toContain("41–80 of 85");
    panel.setContext(ctx({ window: { from: t0 - 1, to: t0 + 59_000 } }));
    expect(panel.root.textContent).toContain("1–40 of 60");
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});
test("leave-before-resolve then same-session re-entry reloads; stale response ignored", async () => {
    let first!: (v: FirehoseEvent[]) => void;
    api.sessionEvents.mockReturnValueOnce(new Promise(r => first = r));
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext(ctx());
    panel.deactivate();
    api.sessionEvents.mockResolvedValueOnce(timed);
    panel.setContext(ctx());
    await vi.waitFor(() => expect(api.sessionEvents).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(obs(panel.root)).toHaveLength(5));
    first([timed[0]]);
    await Promise.resolve(); await Promise.resolve();
    expect(obs(panel.root)).toHaveLength(5);
});
test("race: A in flight, setContext(B), A resolves renders only B", async () => {
    let a!: (v: FirehoseEvent[]) => void;
    api.sessionEvents.mockReturnValueOnce(new Promise(r => a = r));
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext(ctx());
    api.sessionEvents.mockResolvedValueOnce(timed.slice(0, 2).map(e => ({ ...e, session_id: "b-session" })));
    panel.setContext(ctx({ session: { id: "b-session", source: call.source } }));
    await vi.waitFor(() => expect(obs(panel.root)).toHaveLength(2));
    a(timed);
    await Promise.resolve(); await Promise.resolve();
    expect(obs(panel.root)).toHaveLength(2);
});
test("a manually loaded session survives window changes when no session is in scope; setContext never subscribes", async () => {
    const store = createScope(); const subscribe = vi.spyOn(store, "subscribe");
    api.sessionEvents.mockResolvedValue(timed);
    const panel = createLoom(); document.body.append(panel.root);
    panel.setContext({ session: null, window: "live" });
    await load(panel);
    panel.setContext({ session: null, window: range(0, 1) });
    expect(field(panel.root, "Session ID").value).toBe(event.session_id);
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
    expect(subscribe).not.toHaveBeenCalled();
});
