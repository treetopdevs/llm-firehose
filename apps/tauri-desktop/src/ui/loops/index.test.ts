// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
const api = vi.hoisted(() => ({ sessionEvents: vi.fn(), errorSignatures: vi.fn(), capturedEvent: vi.fn(), sessions: vi.fn() }));
vi.mock("../../api", () => api);
import { createLoops } from "./index";
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
