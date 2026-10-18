// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.session.json";
const api = vi.hoisted(() => ({ attention: vi.fn(), sessionEvents: vi.fn(), capturedEvent: vi.fn() }));
vi.mock("../../api", () => api);
import { createEcosystem } from "./index";
const event = (fixture as FirehoseEvent[]).find(e => e.category === "file" && typeof e.payload?.file_path === "string")!;
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent === text); expect(b).toBeTruthy(); b!.click(); };
const input = (root: HTMLElement, label: string, value: string) => { const f = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; f.value = value; f.dispatchEvent(new Event("input")); };
const settle = async () => { for (let i = 0; i < 10; i++)
    await Promise.resolve(); };
async function load(panel: ReturnType<typeof createEcosystem>) { input(panel.root, "Source", event.source); input(panel.root, "Session ID", event.session_id!); click(panel.root, "Load file history"); await settle(); }
beforeEach(() => { vi.resetAllMocks(); api.attention.mockResolvedValue({ sessions: [{ source: event.source, id: event.session_id }], warnings: [] }); api.sessionEvents.mockResolvedValue([event]); api.capturedEvent.mockResolvedValue(event); });
afterEach(() => vi.useRealTimers());
test("choices never load history; explicit full load and exact receipt lookup scope Score", async () => {
    const score = vi.fn(), panel = createEcosystem(score);
    await panel.refresh();
    expect(api.sessionEvents).not.toHaveBeenCalled();
    await load(panel);
    expect(api.sessionEvents).toHaveBeenCalledExactlyOnceWith(event.session_id, undefined, expect.any(AbortSignal));
    expect(api.capturedEvent).not.toHaveBeenCalled();
    click(panel.root, "Select file bed");
    click(panel.root, "Inspect captured receipt");
    await settle();
    expect(api.capturedEvent).toHaveBeenCalledExactlyOnceWith(event.id, expect.any(AbortSignal));
    click(panel.root, "Open Score");
    expect(score).toHaveBeenCalledWith(event.session_id, event.source);
});
test("replay keeps beds stable, steps one observation, and pauses on deactivation", async () => {
    vi.useFakeTimers();
    api.sessionEvents.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ ...event, id: `e-${i}` })));
    const panel = createEcosystem();
    await load(panel);
    click(panel.root, "Beginning");
    expect(panel.root.querySelectorAll(".ecosystem-bed")).toHaveLength(1);
    expect(panel.root.textContent).toContain("0 of 3 dated file observations");
    click(panel.root, "Play");
    await vi.advanceTimersByTimeAsync(250);
    expect(panel.root.textContent).toContain("1 of 3 dated file observations");
    panel.deactivate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(panel.root.textContent).toContain("1 of 3 dated file observations");
});
test("scope changes abort metadata and cannot show old results under new labels", async () => {
    const panel = createEcosystem();
    let resolve!: (v: FirehoseEvent[]) => void;
    api.sessionEvents.mockReturnValueOnce(new Promise(r => resolve = r));
    input(panel.root, "Source", event.source);
    input(panel.root, "Session ID", event.session_id!);
    click(panel.root, "Load file history");
    const signal = api.sessionEvents.mock.calls[0][2] as AbortSignal;
    input(panel.root, "Session ID", "different");
    resolve([event]);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(panel.root.querySelectorAll(".ecosystem-bed")).toHaveLength(0);
});
test("unknown paths and undated records are accessible without timed growth", async () => {
    api.sessionEvents.mockResolvedValue([event, { ...event, id: "unknown-path", payload: {}, summary: "No path" }, { ...event, id: "undated", time: "invalid", summary: "Undated file" }]);
    const panel = createEcosystem();
    await load(panel);
    expect(panel.root.querySelectorAll(".ecosystem-unknown li")).toHaveLength(1);
    expect(panel.root.querySelectorAll(".ecosystem-undated li")).toHaveLength(1);
    expect(panel.root.textContent).toContain("2 of 2 dated file observations");
    click(panel.root, "Beginning");
    expect(panel.root.querySelectorAll(".ecosystem-unknown li")).toHaveLength(0);
    expect(panel.root.querySelectorAll(".ecosystem-undated li")).toHaveLength(1);
});
test("bed pages retain membership across replay and filters are local",async()=>{
 api.sessionEvents.mockResolvedValue(Array.from({length:45},(_,i)=>({...event,id:`file-${i}`,payload:{...event.payload,file_path:`/path/${String(i).padStart(2,"0")}`}})));const panel=createEcosystem();await load(panel);expect(panel.root.querySelectorAll(".ecosystem-bed")).toHaveLength(20);click(panel.root,"Next beds");const before=[...panel.root.querySelectorAll(".ecosystem-bed button")].map(b=>b.getAttribute("aria-label"));click(panel.root,"Beginning");expect([...panel.root.querySelectorAll(".ecosystem-bed button")].map(b=>b.getAttribute("aria-label"))).toEqual(before);input(panel.root,"Filter file beds","/path/44");expect(panel.root.querySelectorAll(".ecosystem-bed")).toHaveLength(1);expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});
test("receipt mismatch is visible and moving cursor aborts obsolete evidence",async()=>{
 const panel=createEcosystem();await load(panel);click(panel.root,"Select file bed");api.capturedEvent.mockResolvedValueOnce({...event,source:"wrong"});click(panel.root,"Inspect captured receipt");await settle();expect(panel.root.textContent).toContain("identity mismatch");expect(panel.root.querySelector(".ecosystem-evidence pre")).toBeNull();let resolve!:(v:FirehoseEvent)=>void;api.capturedEvent.mockReturnValueOnce(new Promise(r=>resolve=r));click(panel.root,"Inspect captured receipt");const signal=api.capturedEvent.mock.calls.at(-1)![1] as AbortSignal;click(panel.root,"Beginning");resolve(event);await settle();expect(signal.aborted).toBe(true);expect(panel.root.querySelector(".ecosystem-evidence pre")).toBeNull();
});
test("playback stops at end and selection pauses while keeping drafts on refresh",async()=>{
 vi.useFakeTimers();api.sessionEvents.mockResolvedValue(Array.from({length:3},(_,i)=>({...event,id:`play-${i}`})));const panel=createEcosystem();await load(panel);click(panel.root,"Beginning");click(panel.root,"Play");await vi.advanceTimersByTimeAsync(750);expect(panel.root.textContent).toContain("3 of 3 dated file observations");expect([...panel.root.querySelectorAll("button")].some(b=>b.textContent==="Pause")).toBe(false);click(panel.root,"Beginning");click(panel.root,"Play");click(panel.root,"Select file bed");await vi.advanceTimersByTimeAsync(500);expect(panel.root.textContent).toContain("0 of 3 dated file observations");await panel.refresh();expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Session ID"]')?.value).toBe(event.session_id);
});
test("bed members are bounded, reveal focused selection, and path labels are safe",async()=>{
 api.sessionEvents.mockResolvedValue(Array.from({length:85},(_,i)=>({...event,id:`member-${String(i).padStart(2,"0")}`,payload:{...event.payload,file_path:"<img src=x>"}})));const panel=createEcosystem();document.body.append(panel.root);try{await load(panel);click(panel.root,"Select file bed");expect(document.activeElement).toBe(panel.root.querySelector('[aria-label="Selected file bed"]'));expect(panel.root.querySelector("img")).toBeNull();expect(panel.root.querySelectorAll(".ecosystem-members li")).toHaveLength(40);click(panel.root,"Next members");click(panel.root,"Next members");expect(panel.root.querySelectorAll(".ecosystem-members li")).toHaveLength(5);}finally{panel.deactivate();panel.root.remove();}
});
test("failed reload clears prior snapshot and manual fields remain usable after choices fail",async()=>{
 const panel=createEcosystem();api.attention.mockRejectedValueOnce(new Error("offline"));await panel.refresh();expect(panel.root.textContent).toContain("Manual exact scope");await load(panel);api.sessionEvents.mockRejectedValueOnce(new Error("missing"));click(panel.root,"Load file history");await settle();expect(panel.root.textContent).toContain("File history unavailable");expect(panel.root.querySelectorAll(".ecosystem-bed")).toHaveLength(0);
});
