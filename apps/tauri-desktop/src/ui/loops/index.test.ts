// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
const api = vi.hoisted(() => ({ sessionEvents: vi.fn(), errorSignatures: vi.fn(), capturedEvent: vi.fn(), sessions: vi.fn() }));
vi.mock("../../api", () => api);
import { createLoops } from "./index";
import { createScope } from "../../scope";
const sid = "019fd182-8513-7461-a816-e786f1fe439e";
const events = (fixture as FirehoseEvent[]).filter(e => e.session_id === sid);
const settle = async () => { for(let i=0;i<8;i++) await Promise.resolve(); };
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent?.includes(text)); expect(b).toBeTruthy(); b!.click(); };
beforeEach(() => { vi.resetAllMocks(); api.sessionEvents.mockResolvedValue(events); api.errorSignatures.mockResolvedValue([]); api.sessions.mockResolvedValue([]); api.capturedEvent.mockRejectedValue(new Error("not available")); });
afterEach(() => document.body.replaceChildren());

test("opens local recurrence evidence and fetches detail only on explicit selection", async () => {
  const panel = createLoops(); document.body.append(panel.root);
  await panel.open(sid, "codex");
  expect(api.sessionEvents).toHaveBeenCalledWith(sid, "timeline", expect.any(AbortSignal));
  expect(panel.root.textContent).toContain("2 occurrences");
  expect(panel.root.querySelector(".loops-signatures button")?.getAttribute("aria-pressed")).toBe("true");
  expect(panel.root.textContent).toContain("local fallback");
  expect(api.capturedEvent).not.toHaveBeenCalled();
  click(panel.root, "Compare interval 1");
  expect(panel.root.textContent).toContain("shell: 1");
  click(panel.root, "View occurrence 2"); await settle();
  expect(api.capturedEvent).toHaveBeenCalledWith(events[1].id, expect.any(AbortSignal));
  expect(panel.root.textContent).toContain("Full detail unavailable");
});

test("session switches and a newer selection reject stale detail and history responses", async () => {
  const panel = createLoops(); document.body.append(panel.root);
  await panel.open(sid);
  let resolve!: (v: FirehoseEvent) => void;
  api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r));
  click(panel.root, "View occurrence 1");
  api.sessionEvents.mockResolvedValueOnce([]);
  await panel.open("empty");
  resolve({...events[0], summary: "STALE DETAIL"}); await settle();
  expect(panel.root.textContent).not.toContain("STALE DETAIL");
  expect(panel.root.textContent).toContain("No captured events");
  let history!: (v: FirehoseEvent[]) => void;
  api.sessionEvents.mockReturnValueOnce(new Promise(r => history = r));
  const old = panel.open(sid);
  await panel.open("empty"); history(events); await old;
  expect(panel.root.textContent).toContain("No captured events");
});

test("history failures have a retry and old-daemon full envelopes remain viewable", async () => {
  const panel = createLoops(); document.body.append(panel.root);
  api.sessionEvents.mockRejectedValueOnce(new Error("offline"));
  await panel.open(sid);
  expect(panel.root.textContent).toContain("offline");
  click(panel.root, "Retry"); await settle();
  expect(panel.root.textContent).toContain("2 occurrences");
  click(panel.root, "View occurrence 1"); await settle();
  expect(panel.root.querySelector("pre")?.textContent).toContain(events[0].id);
});

test("large recurrences are paginated with exact counts", async () => {
  api.sessionEvents.mockResolvedValue(Array.from({length: 120}, (_, i) => ({...events[0], id: `large-${i.toString().padStart(3,"0")}`, time: new Date(Date.parse(events[0].time) + i * 1000).toISOString()})));
  const panel = createLoops(); await panel.open(sid);
  expect(panel.root.textContent).toContain("120 occurrences");
  expect(panel.root.querySelectorAll(".loop-occurrence")).toHaveLength(40);
  click(panel.root, "Next occurrences");
  expect(panel.root.textContent).toContain("41–80 of 120");
});

test("an empty session selection clears history and cancels pending detail", async () => {
  const panel = createLoops(); document.body.append(panel.root);
  await panel.refresh(); await panel.open(sid);
  const select = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop session"]')!;
  select.value = ""; select.dispatchEvent(new Event("change"));
  expect(panel.root.textContent).not.toContain("2 occurrences");
  expect(panel.root.textContent).toContain("Choose a session to inspect");
});

test("newer detail selection wins even when the first response ignores abort", async () => {
  const panel = createLoops(); document.body.append(panel.root); await panel.open(sid);
  let resolve!: (v: FirehoseEvent) => void;
  api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r)).mockResolvedValueOnce({...events[1], summary: "CURRENT DETAIL"});
  click(panel.root, "View occurrence 1"); click(panel.root, "View occurrence 2"); await settle();
  resolve({...events[0], summary: "STALE DETAIL"}); await settle();
  expect(panel.root.querySelector("pre")?.textContent).toContain("CURRENT DETAIL");
  expect(panel.root.querySelector("pre")?.textContent).not.toContain("STALE DETAIL");
});

test("unavailable signatures do not block history or silently claim authoritative grouping", async () => {
  api.errorSignatures.mockRejectedValueOnce(new Error("old daemon"));
  const panel = createLoops(); await panel.open(sid); await settle();
  expect(panel.root.textContent).toContain("Signature lookup unavailable");
  expect(panel.root.textContent).toContain("local fallback");
});

test("a hung signature lookup times out without holding the recurrence view hostage", async () => {
  vi.useFakeTimers();
  try {
    api.errorSignatures.mockImplementationOnce(() => new Promise(() => {}));
    const panel = createLoops(); await panel.open(sid);
    expect(panel.root.textContent).toContain("2 occurrences");
    expect(panel.root.textContent).toContain("Signature lookup pending");
    await vi.advanceTimersByTimeAsync(4000);
    expect(panel.root.textContent).toContain("Signature lookup unavailable");
  } finally { vi.useRealTimers(); }
});

test("opening another session aborts the superseded history request", async () => {
  const panel = createLoops();
  await panel.open(sid);
  const first = api.sessionEvents.mock.calls[0][2] as AbortSignal;
  await panel.open("empty");
  expect(first).toBeDefined();
  expect(first.aborted).toBe(true);
});

test("source changes cannot erase loading or failure states", async () => {
  const panel = createLoops();
  let reject!: (v: Error) => void;
  api.sessionEvents.mockReturnValueOnce(new Promise((_, r) => reject = r));
  const loading = panel.open(sid);
  const source = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop source"]')!;
  expect(source.disabled).toBe(true);
  source.dispatchEvent(new Event("change"));
  expect(panel.root.textContent).toContain("Loading");
  reject(new Error("offline")); await loading;
  source.dispatchEvent(new Event("change"));
  expect(panel.root.textContent).toContain("History unavailable");
  expect(panel.root.textContent).toContain("Retry history");
});

test("late authoritative membership preserves the selected interval when ids survive", async () => {
  let resolve!: (v: unknown[]) => void;
  api.errorSignatures.mockReturnValueOnce(new Promise(r => resolve = r));
  const panel = createLoops(); await panel.open(sid);
  click(panel.root, "Compare interval 1");
  resolve([{key: "codex|shell|PostToolUse|failed: mix test", source: "codex", members: events.map(e => e.id)}]); await settle();
  expect(panel.root.textContent).toContain("Captured activity between recurrences");
  expect(panel.root.textContent).toContain("0 of 2 selected occurrences use local fallback");
});

test("all interval evidence is accessible by paging", async () => {
  const start = Date.parse(events[0].time);
  const activity = Array.from({length: 85}, (_, i) => ({...events[0], category: "file", severity: "info", id: `file-${i}`, time: new Date(start + i + 1).toISOString()}));
  api.sessionEvents.mockResolvedValueOnce([events[0], ...activity, events[1]]);
  const panel = createLoops(); await panel.open(sid);
  click(panel.root, "Compare interval 1");
  click(panel.root, "Next evidence");
  expect(panel.root.textContent).toContain("41–80 of 86");
  click(panel.root, "Next evidence");
  expect(panel.root.textContent).toContain("81–86 of 86");
  expect(panel.root.querySelectorAll(".loops-evidence li")).toHaveLength(6);
});
test("compares two intervals explicitly and rejects self or invalid selections",async()=>{
 // Normalized contract mutations of a captured error; no new raw adapter shape.
 const history=Array.from({length:5},(_,i)=>({...events[0],id:`sequence-${i}`,time:new Date(Date.UTC(2026,9,18,0,0,i)).toISOString(),severity:i%2?'info':'error',payload:{...events[0].payload,tool_name:i===1?'Read':'Edit'}}));
 api.sessionEvents.mockResolvedValue(history);const panel=createLoops();await panel.open(sid,'codex');click(panel.root,'Compare interval 1');
 let input=panel.root.querySelector<HTMLInputElement>('[aria-label="Reference interval B"]')!;expect(input).toBeTruthy();expect(input.value).toBe('2');expect(panel.root.querySelector('.loops-sequence')).toBeNull();
 input.value='1';click(panel.root,'Compare sequences');expect(panel.root.textContent).toContain('Choose a different interval');
 input=panel.root.querySelector<HTMLInputElement>('[aria-label="Reference interval B"]')!;input.value='99';click(panel.root,'Compare sequences');expect(panel.root.textContent).toContain('whole interval number');
 input=panel.root.querySelector<HTMLInputElement>('[aria-label="Reference interval B"]')!;input.value='2';click(panel.root,'Compare sequences');expect(panel.root.querySelector('.loops-sequence')?.textContent).toContain('Recorded runs or counts differ');expect(api.capturedEvent).not.toHaveBeenCalled();
 click(panel.root,'Browse A run');expect(panel.root.textContent).toContain('Run observations');
 const source=panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop source"]')!;source.value='';source.dispatchEvent(new Event('change'));expect(panel.root.querySelector('.loops-sequence')).toBeNull();
});
test("one-interval history explains why comparison needs another recurrence",async()=>{
 const panel=createLoops();await panel.open(sid,'codex');click(panel.root,'Compare interval 1');expect(panel.root.textContent).toContain('three occurrences');
});
test("late membership retains endpoint pairs and reannounces shifted interval numbers",async()=>{
 const history=Array.from({length:7},(_,i)=>({...events[0],id:`late-${i}`,time:new Date(Date.UTC(2026,9,18,0,0,i)).toISOString(),severity:i%2?'info':'error',summary:i===0?'different error':events[0].summary}));
 let finish!:(value:unknown)=>void;api.errorSignatures.mockReturnValue(new Promise(r=>finish=r));api.sessionEvents.mockResolvedValue(history);
 const panel=createLoops();await panel.open(sid,'codex');click(panel.root,'Compare interval 1');click(panel.root,'Compare sequences');expect(panel.root.textContent).toContain('Comparing interval 1 with interval 2.');
 finish([{key:'codex|shell|PostToolUse|failed: mix test',source:'codex',members:history.filter((_,i)=>i%2===0).map(e=>e.id)}]);await settle();
 expect(panel.root.textContent).toContain('Comparing interval 2 with interval 3.');expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Reference interval B"]')?.value).toBe('3');
});
test("late membership removing a boundary clears comparison and stale detail is ignored",async()=>{
 const history=Array.from({length:5},(_,i)=>({...events[0],id:`boundary-${i}`,time:new Date(Date.UTC(2026,9,18,0,0,i)).toISOString(),severity:i%2?'info':'error'}));
 let membership!:(value:unknown)=>void,receipt!:(value:FirehoseEvent)=>void;api.errorSignatures.mockReturnValue(new Promise(r=>membership=r));api.sessionEvents.mockResolvedValue(history);api.capturedEvent.mockReturnValue(new Promise(r=>receipt=r));
 const panel=createLoops();await panel.open(sid,'codex');click(panel.root,'Compare interval 1');click(panel.root,'Compare sequences');click(panel.root,'Browse A run');click(panel.root,'Inspect observation');const signal=api.capturedEvent.mock.calls[0][1] as AbortSignal;
 membership([{key:'different-signature',source:'codex',members:[history[2].id]}]);await settle();expect(panel.root.querySelector('.loops-sequence')).toBeNull();expect(panel.root.textContent).toContain('Comparison cleared');expect(signal.aborted).toBe(true);
 receipt(history[1]);await settle();expect(panel.root.querySelector('.loops-detail')?.textContent).toBe('');
});
test('unchanged membership retains comparison view and open observations',async()=>{
 const history=Array.from({length:5},(_,i)=>({...events[0],id:`stable-${i}`,time:new Date(Date.UTC(2026,9,18,0,0,i)).toISOString(),severity:i%2?'info':'error'}));
 let finish!:(value:unknown)=>void;api.errorSignatures.mockReturnValue(new Promise(r=>finish=r));api.sessionEvents.mockResolvedValue(history);
 const panel=createLoops();await panel.open(sid,'codex');click(panel.root,'Compare interval 1');click(panel.root,'Compare sequences');click(panel.root,'Browse A run');const view=panel.root.querySelector('.loops-sequence');
 finish([]);await settle();expect(panel.root.querySelector('.loops-sequence')).toBe(view);expect(panel.root.textContent).toContain('Run observations');
});
test('initial membership replacement never claims an unmade comparison was cleared',async()=>{
 let finish!:(value:unknown)=>void;api.errorSignatures.mockReturnValue(new Promise(r=>finish=r));const panel=createLoops();await panel.open(sid);
 finish([{key:'authoritative',source:'codex',members:events.map(e=>e.id)}]);await settle();expect(panel.root.textContent).not.toContain('Comparison cleared');
});
test('reselecting the active signature preserves sequence inspection and invalid feedback stays beside controls',async()=>{
 // Normalized mutations of captured events.
 const history=Array.from({length:5},(_,i)=>({...events[0],id:`repeat-${i}`,time:new Date(Date.UTC(2026,9,18,0,0,i)).toISOString(),severity:i%2?'info':'error'}));api.sessionEvents.mockResolvedValue(history);
 const panel=createLoops();await panel.open(sid,'codex');click(panel.root,'Compare interval 1');click(panel.root,'Compare sequences');click(panel.root,'Browse A run');const view=panel.root.querySelector('.loops-sequence');
 (panel.root.querySelector('.loops-signatures button') as HTMLButtonElement).click();expect(panel.root.querySelector('.loops-sequence')).toBe(view);expect(panel.root.textContent).toContain('Run observations');
 const input=panel.root.querySelector<HTMLInputElement>('[aria-label="Reference interval B"]')!;input.value='1';click(panel.root,'Compare sequences');const feedback=panel.root.querySelector('.loops-comparison-feedback');expect(feedback?.textContent).toContain('Choose a different interval');expect(feedback?.previousElementSibling?.textContent).toBe('Compare sequences');
});

test("choosing a session or source publishes the selection; preselects a pre-existing scope.session on first show; never subscribes", async () => {
  const store = createScope();
  const subscribe = vi.spyOn(store, "subscribe");
  api.sessions.mockResolvedValue([{id: sid, source: "codex", agent: "codex"}]);
  const panel = createLoops(store); document.body.append(panel.root);
  await panel.refresh(); await settle();
  const sel = panel.root.querySelector<HTMLSelectElement>("select[aria-label='Loop session']")!;
  sel.value = sid; sel.dispatchEvent(new Event("change")); await settle();
  expect(store.get().session).toEqual({id: sid});
  const src = panel.root.querySelector<HTMLSelectElement>("select[aria-label='Loop source']")!;
  src.value = "codex"; src.dispatchEvent(new Event("change"));
  expect(store.get().session).toEqual({id: sid, source: "codex"});
  expect(subscribe).not.toHaveBeenCalled();

  const pre = createScope(); pre.narrow({session: {id: sid, source: "codex"}});
  api.sessionEvents.mockClear();
  const second = createLoops(pre); document.body.append(second.root);
  await second.refresh(); await settle();
  expect(api.sessionEvents).toHaveBeenCalledWith(sid, "timeline", expect.any(AbortSignal));
  expect(second.root.querySelector<HTMLSelectElement>("select[aria-label='Loop session']")!.value).toBe(sid);
  expect(second.root.querySelector<HTMLSelectElement>("select[aria-label='Loop source']")!.value).toBe("codex");
  expect(pre.get().session).toEqual({id: sid, source: "codex"});
  const e = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
  second.root.dispatchEvent(e);
  expect(e.defaultPrevented).toBe(false);
});

test("loops reconciles with scope.session on every show, and clearing the select clears scope.session", async () => {
  const store = createScope();
  api.sessions.mockResolvedValue([{id: sid, source: "codex", agent: "codex"}]);
  const panel = createLoops(store); document.body.append(panel.root);
  await panel.refresh(); await settle();
  expect(api.sessionEvents).not.toHaveBeenCalledWith(sid, "timeline", expect.any(AbortSignal));
  api.sessionEvents.mockClear();
  store.narrow({session: {id: sid}});
  await panel.refresh(); await settle();
  expect(api.sessionEvents).toHaveBeenCalledWith(sid, "timeline", expect.any(AbortSignal));
  const sel = panel.root.querySelector<HTMLSelectElement>("select[aria-label='Loop session']")!;
  expect(sel.value).toBe(sid);
  sel.value = ""; sel.dispatchEvent(new Event("change"));
  expect(store.get().session).toBeUndefined();
});

test("choosing a session outside the scoped project/worktree clears them", async () => {
  const store = createScope();
  store.narrow({project: "A", worktree: "w1"});
  api.sessions.mockResolvedValue([{id: sid, source: "codex", agent: "codex"}]);
  const panel = createLoops(store); document.body.append(panel.root);
  await panel.refresh(); await settle();
  const sel = panel.root.querySelector<HTMLSelectElement>("select[aria-label='Loop session']")!;
  sel.value = sid; sel.dispatchEvent(new Event("change")); await settle();
  expect(store.get().session).toEqual({id: sid});
  expect(store.get().project).toBeUndefined();
  expect(store.get().worktree).toBeUndefined();
});

// --- Session tab context ---------------------------------------------------
import type { SessionTabContext } from "../session/context";
const T = (e: FirehoseEvent) => Date.parse(e.time);
const three: FirehoseEvent[] = [...events, {...events[1], id: "late-3", time: new Date(T(events[1]) + 60_000).toISOString()}];
const ref = {id: sid, source: "codex"};
const ctx = (over: Partial<SessionTabContext> = {}): SessionTabContext => ({session: ref, window: "live", ...over});
const win = (from: number, to: number) => ({from, to});
const items = (root: HTMLElement) => [...root.querySelectorAll(".loop-occurrence")];

test("setContext opens the named session once; window-only change never loads; null session unlocks", async () => {
  const panel = createLoops(createScope()); document.body.append(panel.root);
  const select = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop session"]')!;
  panel.setContext(ctx());
  await vi.waitFor(() => expect(panel.root.textContent).toContain("2 occurrences"));
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  expect(api.sessionEvents).toHaveBeenCalledWith(sid, "timeline", expect.any(AbortSignal));
  expect(select.disabled).toBe(true);
  panel.setContext(ctx());
  panel.setContext(ctx({window: win(T(events[0]) - 1, T(events[1]) + 1)}));
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  panel.setContext(ctx({session: null}));
  expect(select.disabled).toBe(false);
  expect(panel.root.textContent).toContain("2 occurrences");
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});

test("occurrence list filtered to the window, original numbering kept", async () => {
  api.sessionEvents.mockResolvedValue(three);
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  await vi.waitFor(() => expect(items(panel.root)).toHaveLength(3));
  expect(panel.root.textContent).not.toContain("occurrences in window");
  panel.setContext(ctx({window: win(T(three[1]) - 1, T(three[2]) + 1)}));
  expect(items(panel.root)).toHaveLength(2);
  expect(items(panel.root)[0].textContent).toContain("View occurrence 2");
  expect(panel.root.textContent).toContain("2 of 3 occurrences in window");
  expect(panel.root.textContent).not.toContain("Baseline observation");
  panel.setContext(ctx({window: win(T(three[0]) - 1, T(three[1]) + 1)}));
  expect(items(panel.root)).toHaveLength(2);
  expect(panel.root.textContent).toContain("Baseline observation");
  panel.setContext(ctx());
  expect(items(panel.root)).toHaveLength(3);
  expect(panel.root.textContent).not.toContain("in window");
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});

test("window change clears an excluded selection and drops its deferred receipt; an in-window selection is kept", async () => {
  api.sessionEvents.mockResolvedValue(three);
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  await vi.waitFor(() => expect(items(panel.root)).toHaveLength(3));
  click(panel.root, "Compare interval 1");
  expect(panel.root.textContent).toContain("Captured activity between recurrences");
  let resolve!: (v: FirehoseEvent) => void;
  api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r));
  click(panel.root, "View occurrence 1");
  // the whole interval stays in window: selection kept
  panel.setContext(ctx({window: win(T(three[0]) - 1, T(three[2]) + 1)}));
  expect(panel.root.textContent).toContain("Captured activity between recurrences");
  expect(panel.root.querySelector(".loops-detail pre")).toBeTruthy();
  // now exclude the interval's first boundary
  panel.setContext(ctx({window: win(T(three[1]) - 1, T(three[2]) + 1)}));
  expect(panel.root.textContent).not.toContain("Captured activity between recurrences");
  expect(panel.root.querySelector(".loops-detail pre")).toBeNull();
  resolve({...three[0], summary: "STALE RECEIPT"});
  await vi.waitFor(() => expect(api.capturedEvent).toHaveBeenCalled());
  await Promise.resolve();
  expect(panel.root.textContent).not.toContain("STALE RECEIPT");
});

test("window change clears an excluded comparison", async () => {
  api.sessionEvents.mockResolvedValue(three);
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  await vi.waitFor(() => expect(items(panel.root)).toHaveLength(3));
  click(panel.root, "Compare interval 2");
  click(panel.root, "Compare sequences");
  expect(panel.root.querySelector(".loops-sequence-caption")).toBeTruthy();
  panel.setContext(ctx({window: win(T(three[1]) - 1, T(three[2]) + 1)}));
  expect(panel.root.querySelector(".loops-sequence-caption")).toBeNull();
});

test("leave-before-resolve then same-session re-entry reloads; a stale response is dropped", async () => {
  let first!: (v: FirehoseEvent[]) => void;
  api.sessionEvents.mockReturnValueOnce(new Promise(r => first = r));
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  panel.deactivate();
  panel.setContext(ctx());
  await vi.waitFor(() => expect(api.sessionEvents).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(panel.root.textContent).toContain("2 occurrences"));
  first([]);
  await Promise.resolve(); await Promise.resolve();
  expect(panel.root.textContent).toContain("2 occurrences");
  expect(panel.root.textContent).not.toContain("No captured events");
});

test("race: A in flight, setContext(B), A resolves renders only B", async () => {
  let a!: (v: FirehoseEvent[]) => void;
  api.sessionEvents.mockReturnValueOnce(new Promise(r => a = r));
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  api.sessionEvents.mockResolvedValueOnce([]);
  panel.setContext(ctx({session: {id: "other", source: "codex"}}));
  await vi.waitFor(() => expect(panel.root.textContent).toContain("No captured events"));
  a(events);
  await Promise.resolve(); await Promise.resolve();
  expect(panel.root.textContent).toContain("No captured events");
  expect(panel.root.textContent).not.toContain("2 occurrences");
});

test("window-only change redraws without refetch and resets the occurrence page", async () => {
  api.sessionEvents.mockResolvedValue(Array.from({length: 120}, (_, i) => ({...events[0], id: `large-${String(i).padStart(3, "0")}`, time: new Date(T(events[0]) + i * 1000).toISOString()})));
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  await vi.waitFor(() => expect(items(panel.root)).toHaveLength(40));
  click(panel.root, "Next occurrences");
  expect(panel.root.textContent).toContain("41–80 of 120");
  panel.setContext(ctx({window: win(T(events[0]) - 1, T(events[0]) + 99_000)}));
  expect(panel.root.textContent).toContain("1–40 of 100");
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
});

test("null session re-enables the picker; a manually opened session survives window changes; never subscribes", async () => {
  const store = createScope(); const subscribe = vi.spyOn(store, "subscribe");
  const panel = createLoops(store); document.body.append(panel.root);
  panel.setContext({session: null, window: "live"});
  await panel.open(sid, "codex");
  const select = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop session"]')!;
  expect(select.disabled).toBe(false);
  panel.setContext({session: null, window: win(T(events[0]) - 1, T(events[1]) + 1)});
  expect(panel.root.textContent).toContain("2 occurrences");
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  expect(subscribe).not.toHaveBeenCalled();
});

test("empty scope: a picker choice keeps both pickers usable and loads the history once", async () => {
  const store = createScope(); const panel = createLoops(store); document.body.append(panel.root);
  panel.setContext({session: null, window: "live"});
  await panel.refresh();
  const select = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop session"]')!;
  select.append(Object.assign(document.createElement("option"), {value: sid, textContent: sid}));
  select.value = sid; select.dispatchEvent(new Event("change"));
  expect(store.get().session).toEqual({id: sid});
  panel.setContext({session: store.get().session ?? null, window: store.get().window});
  await vi.waitFor(() => expect(panel.root.textContent).toContain("2 occurrences"));
  expect(select.disabled).toBe(false);
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  // Navigation from outside still locks the picker.
  panel.setContext({session: {id: "other", source: "codex"}, window: "live"});
  expect(select.disabled).toBe(true);
});

test("choosing a source for a source-less scope session keeps the window and does not reload", async () => {
  const store = createScope({session: {id: sid}}); const panel = createLoops(store); document.body.append(panel.root);
  const w = win(T(events[0]) - 1, T(events[1]) + 1);
  store.narrow({window: w});
  panel.setContext({session: store.get().session ?? null, window: w});
  await vi.waitFor(() => expect(panel.root.textContent).toContain("2 occurrences"));
  const source = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop source"]')!;
  source.value = "codex"; source.dispatchEvent(new Event("change"));
  expect(store.get().session).toEqual({id: sid, source: "codex"});
  expect(store.get().window).toEqual(w);
  panel.setContext({session: store.get().session ?? null, window: store.get().window});
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  expect(source.disabled).toBe(false);
});

test("F2: refining the source of a scoped session honours containment and keeps the window", async () => {
  const w = win(T(events[0]) - 1, T(events[1]) + 1);
  const mk = () => createScope({project: "A", worktree: "w1", session: {id: sid}});
  const run = async (store: ReturnType<typeof createScope>) => {
    store.narrow({window: w});
    const panel = createLoops(store); document.body.append(panel.root);
    panel.setContext({session: store.get().session ?? null, window: w});
    await vi.waitFor(() => expect(panel.root.textContent).toContain("2 occurrences"));
    const source = panel.root.querySelector<HTMLSelectElement>('[aria-label="Loop source"]')!;
    source.value = "codex"; source.dispatchEvent(new Event("change"));
    panel.root.remove();
  };
  // Resolver rejects exactly this (source, session): parents are dropped, the window survives.
  const rejecting = mk();
  rejecting.setResolver({sessions: () => undefined, matcher: () => (r) => r.source !== "codex", labels: () => ({})});
  await run(rejecting);
  expect(rejecting.get().session).toEqual({id: sid, source: "codex"});
  expect(rejecting.get().project).toBeUndefined();
  expect(rejecting.get().worktree).toBeUndefined();
  expect(rejecting.get().window).toEqual(w);
  // Resolver confirms membership (or is unrestricted): parents stay.
  const confirming = mk();
  confirming.setResolver({sessions: () => undefined, matcher: () => () => true, labels: () => ({})});
  await run(confirming);
  expect(confirming.get().project).toBe("A");
  expect(confirming.get().session).toEqual({id: sid, source: "codex"});
  expect(confirming.get().window).toEqual(w);
});

test("F3: intervals reaching outside the window are neither offered nor accepted as reference B", async () => {
  api.sessionEvents.mockResolvedValue(three);
  const panel = createLoops(createScope()); document.body.append(panel.root);
  panel.setContext(ctx());
  await vi.waitFor(() => expect(items(panel.root)).toHaveLength(3));
  panel.setContext(ctx({window: win(T(three[1]) - 1, T(three[2]) + 1)}));
  const labels = () => [...panel.root.querySelectorAll("button")].map(b => b.textContent ?? "");
  expect(labels().some(l => l.startsWith("Compare interval 1"))).toBe(false);
  expect(labels().some(l => l.startsWith("Compare interval 2"))).toBe(true);
  click(panel.root, "Compare interval 2");
  expect(panel.root.querySelector(`[data-key="event:${three[0].id}"]`)).toBeNull(); // no evidence from the excluded occurrence
  const ref = panel.root.querySelector<HTMLInputElement>('[aria-label="Reference interval B"]')!;
  ref.value = "1"; ref.dispatchEvent(new Event("input"));
  click(panel.root, "Compare sequences");
  expect(panel.root.querySelector(".loops-sequence-caption")).toBeNull();
  expect(panel.root.textContent).toContain("outside the current window");
});
import { createSessionDirectory } from "../../session-directory";
test("names the opened session, relabels late keeping page state, and stops after deactivate", async () => {
  const dir = createSessionDirectory(); const panel = createLoops(createScope(), dir); document.body.append(panel.root);
  await panel.refresh(); await panel.open(sid, "codex"); await settle();
  const option = () => [...panel.root.querySelectorAll("option")].find(o => o.value === sid)!;
  expect(option().textContent).toBe(sid.slice(0, 8));
  expect(panel.root.textContent).toContain(`Session ${sid.slice(0, 8)} ·`);
  click(panel.root, "Compare interval 1"); const compared = panel.root.textContent;
  dir.remember([{id: sid, source: "codex", agent: "codex", title: "Fix login bug"}]);
  expect(option().textContent).toBe("codex · Fix login bug");
  expect(panel.root.textContent).toContain("Session Fix login bug ·");
  expect(panel.root.textContent).toContain("shell: 1"); expect(compared).toContain("shell: 1");
  expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  panel.deactivate();
  dir.remember([{id: sid, source: "codex", agent: "codex", title: "Renamed later"}]);
  expect(option().textContent).toBe("codex · Fix login bug");
});
test("a listed session is named from the list and remembered", async () => {
  const dir = createSessionDirectory(); api.sessions.mockResolvedValue([{id: sid, source: "codex", agent: "codex", title: "Fix login bug"}]);
  const panel = createLoops(createScope(), dir); await panel.refresh(); await settle();
  expect([...panel.root.querySelectorAll("option")].map(o => o.textContent)).toContain("codex · Fix login bug");
  expect(dir.lookup({id: sid, source: "codex"})?.title).toBe("Fix login bug");
});
test("the open option is named by its exact source, and later renames beat the cached list", async () => {
  const dir = createSessionDirectory();
  api.sessions.mockResolvedValue([{id: sid, source: "codex", agent: "codex", title: "Codex task"}, {id: sid, source: "claude-code", agent: "claude", title: "Claude task"}]);
  const panel = createLoops(createScope(), dir); document.body.append(panel.root);
  await panel.refresh(); await panel.open(sid, "claude-code"); await settle();
  const option = () => [...panel.root.querySelectorAll("option")].find(o => o.value === sid)!;
  expect(option().textContent).toBe("claude · Claude task");
  dir.remember([{id: sid, source: "claude-code", agent: "claude", title: "Claude renamed"}]);
  expect(option().textContent).toBe("claude · Claude renamed");
});
