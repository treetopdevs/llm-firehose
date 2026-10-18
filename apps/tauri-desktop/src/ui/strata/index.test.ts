// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import type { ErrorSignature, ErrorSignatureSessions, FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
const api = vi.hoisted(() => ({ errorSignatures: vi.fn(), errorSignatureSessions: vi.fn(), capturedEvent: vi.fn(), sessions: vi.fn() }));
vi.mock("../../api", () => api);
import { createStrata } from "./index";
const event = (fixture as FirehoseEvent[]).find(e => e.session_id)!;
const sig: ErrorSignature = {key: "codex|error|observed", source: event.source, category: "error", sample: "Observed error", count: 750, sessions: 3, first_time: event.time, last_time: event.time};
const page: ErrorSignatureSessions = {key: sig.key, total: 3, offset: 0, limit: 50, sessions: [{session_id: event.session_id!, source: event.source, count: 2, first_time: event.time, last_time: event.time, sample_event_id: event.id}]};
const settle = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent?.includes(text)); expect(b).toBeTruthy(); b!.click(); };
beforeEach(() => { vi.resetAllMocks(); api.errorSignatures.mockResolvedValue([sig]); api.errorSignatureSessions.mockResolvedValue(page); api.capturedEvent.mockResolvedValue(event); api.sessions.mockResolvedValue([]); });
test("loads one selected signature page without history fanout and opens scoped evidence and navigation", async () => {
  const loops = vi.fn(), score = vi.fn(); const panel = createStrata(loops, score); await panel.refresh();
  expect(api.errorSignatureSessions).not.toHaveBeenCalled();
  click(panel.root, "Observed error"); await settle();
  expect(api.errorSignatureSessions).toHaveBeenCalledExactlyOnceWith(sig.key, 0, 50, expect.any(AbortSignal));
  expect(panel.root.textContent).toContain("750 global observations");
  expect(panel.root.textContent).toContain("2 matching observations");
  expect(panel.root.textContent).toContain("not session duration");
  expect(api.capturedEvent).not.toHaveBeenCalled();
  click(panel.root, "Open Loops"); click(panel.root, "Open Score");
  expect(loops).toHaveBeenCalledWith(event.session_id, event.source); expect(score).toHaveBeenCalledWith(event.session_id, event.source);
  click(panel.root, "View evidence"); await settle(); expect(panel.root.querySelector("pre")?.textContent).toContain(event.id);
});
test("filters sources and text, paginates signatures and session snapshots", async () => {
  api.errorSignatures.mockResolvedValue(Array.from({length: 52}, (_, i) => ({...sig, key: `key-${i}`, sample: `Error ${i}`, source: i === 51 ? "claude-code" : "codex"})));
  const panel = createStrata(); await panel.refresh();
  expect(panel.root.querySelectorAll(".strata-signatures button")).toHaveLength(50);
  click(panel.root, "Next signatures"); expect(panel.root.querySelectorAll(".strata-signatures button")).toHaveLength(2);
  const source = panel.root.querySelector<HTMLSelectElement>("select")!; source.value = "claude-code"; source.dispatchEvent(new Event("change"));
  expect(panel.root.querySelectorAll(".strata-signatures button")).toHaveLength(1);
  const search = panel.root.querySelector<HTMLInputElement>("input")!; search.value = "missing"; search.dispatchEvent(new Event("input"));
  expect(panel.root.textContent).toContain("No recurring signatures match");
  search.value = ""; search.dispatchEvent(new Event("input"));
  api.errorSignatureSessions.mockResolvedValue({...page, key: "key-51", total: 51}); click(panel.root, "Error 51"); await settle();
  api.errorSignatureSessions.mockResolvedValue({...page, key: "key-51", offset: 50, total: 51}); click(panel.root, "Next sessions"); await settle();
  expect(api.errorSignatureSessions.mock.calls[1].slice(0,3)).toEqual(["key-51",50,50]);
});
test("filtering cancels pending sessions and detail, ignores late results, and refresh cancels old lists", async () => {
  const panel = createStrata(); await panel.refresh();
  let resolve!: (v: ErrorSignatureSessions) => void;
  api.errorSignatureSessions.mockReturnValueOnce(new Promise(r => resolve=r)); click(panel.root, "Observed error");
  const signal = api.errorSignatureSessions.mock.calls[0][3] as AbortSignal;
  const search = panel.root.querySelector<HTMLInputElement>("input")!; search.value="missing"; search.dispatchEvent(new Event("input"));
  expect(signal.aborted).toBe(true); resolve(page); await settle(); expect(panel.root.querySelectorAll(".strata-row")).toHaveLength(0);
  search.value=""; search.dispatchEvent(new Event("input")); click(panel.root,"Observed error"); await settle();
  let detail!: (v: FirehoseEvent) => void; api.capturedEvent.mockReturnValueOnce(new Promise(r=>detail=r)); click(panel.root,"View evidence");
  const dsignal=api.capturedEvent.mock.calls[0][1] as AbortSignal;
  await panel.refresh(); expect(dsignal.aborted).toBe(true); detail({...event,summary:"STALE"}); await settle(); expect(panel.root.textContent).not.toContain("STALE");
  let list!: (v: ErrorSignature[]) => void; api.errorSignatures.mockReturnValueOnce(new Promise(r=>list=r)); const old=panel.refresh(); const lsignal=api.errorSignatures.mock.calls.at(-1)![1] as AbortSignal;
  api.errorSignatures.mockResolvedValueOnce([]); await panel.refresh(); list([sig]); await old; expect(lsignal.aborted).toBe(true); expect(panel.root.textContent).not.toContain("Observed error");
});
test("evidence mismatches and failures never render an unrelated envelope; endpoint failure explains compatibility", async () => {
  const panel=createStrata(); await panel.refresh(); click(panel.root,"Observed error"); await settle();
  api.capturedEvent.mockResolvedValueOnce({...event, session_id:"wrong", summary:"UNRELATED"}); click(panel.root,"View evidence"); await settle();
  expect(panel.root.textContent).toContain("Evidence unavailable"); expect(panel.root.textContent).not.toContain("UNRELATED");
  api.errorSignatureSessions.mockRejectedValueOnce(new Error("404 not found")); click(panel.root,"Refresh sessions"); await settle();
  expect(panel.root.textContent).toContain("older daemon"); expect(panel.root.querySelectorAll(".strata-row")).toHaveLength(0);
});
test("signature text is escaped and excludes signatures seen in fewer than two sessions", async () => {
  api.errorSignatures.mockResolvedValue([{...sig,sample:"<img src=x onerror=alert(1)>"},{...sig,key:"single",sample:"single only",sessions:1}]);
  const panel=createStrata(); await panel.refresh(); expect(panel.root.querySelector("img")).toBeNull(); expect(panel.root.textContent).toContain("<img"); expect(panel.root.textContent).not.toContain("single only");
});
test("new signature and newer evidence selections win when old requests ignore cancellation", async () => {
  api.errorSignatures.mockResolvedValue([sig,{...sig,key:"other",sample:"Other signature"}]);
  const panel=createStrata(); await panel.refresh();
  let old!: (v: ErrorSignatureSessions) => void; api.errorSignatureSessions.mockReturnValueOnce(new Promise(r=>old=r)); click(panel.root,"Observed error");
  api.errorSignatureSessions.mockResolvedValueOnce({...page,key:"other"}); click(panel.root,"Other signature"); await settle();
  old({...page,sessions:[{...page.sessions[0],session_id:"STALE SESSION"}]}); await settle(); expect(panel.root.textContent).not.toContain("STALE SESSION");
  let oldEvidence!: (v: FirehoseEvent) => void; api.capturedEvent.mockReturnValueOnce(new Promise(r=>oldEvidence=r)).mockResolvedValueOnce({...event,summary:"CURRENT EVIDENCE"});
  click(panel.root,"View evidence"); click(panel.root,"View evidence"); await settle(); oldEvidence({...event,summary:"STALE EVIDENCE"}); await settle();
  expect(panel.root.querySelector("pre")?.textContent).toContain("CURRENT EVIDENCE"); expect(panel.root.textContent).not.toContain("STALE EVIDENCE");
});
test("empty later snapshot pages remain navigable without an impossible range", async () => {
  api.errorSignatureSessions.mockResolvedValueOnce({...page,total:51}); const panel=createStrata(); await panel.refresh(); click(panel.root,"Observed error"); await settle();
  api.errorSignatureSessions.mockResolvedValueOnce({...page,total:3,offset:50,sessions:[]}); click(panel.root,"Next sessions"); await settle();
  expect(panel.root.textContent).toContain("No matching sessions on this page"); expect(panel.root.textContent).not.toContain("51–3");
  expect([...panel.root.querySelectorAll("button")].find(b=>b.textContent==="Previous sessions")?.disabled).toBe(false);
});
test("an unavailable signature list and empty history give visible recoverable states", async () => {
  api.errorSignatures.mockRejectedValueOnce(new Error("offline")); const panel=createStrata(); await panel.refresh(); expect(panel.root.textContent).toContain("Signatures unavailable");
  await panel.refresh(); api.errorSignatureSessions.mockResolvedValueOnce({...page,total:0,sessions:[]}); click(panel.root,"Observed error"); await settle(); expect(panel.root.textContent).toContain("No matching sessions");
});
test("real errors sharing summary text remain distinguishable by authoritative signature identity", async () => {
  const captured = (fixture as FirehoseEvent[]).filter(e => e.summary === "agent response failed");
  const representatives = [captured[0], captured.find(e => e.payload?.error_class === "authentication_failed")!];
  api.errorSignatures.mockResolvedValue(representatives.map(e => ({...sig, source: e.source, name: e.name, sample: e.summary, class: e.payload?.error_class, key: `${e.source}|${e.category}|${e.name}|${e.payload?.error_class}`})));
  const panel=createStrata(); await panel.refresh();
  const labels = [...panel.root.querySelectorAll(".strata-signatures button")].map(b=>b.textContent);
  expect(labels[0]).toContain("rate_limit"); expect(labels[1]).toContain("authentication_failed"); expect(labels[0]).not.toBe(labels[1]);
});
test("returning from another panel preserves the selected signature and session page until explicit refresh", async () => {
  const panel=createStrata(); await panel.activate();
  api.errorSignatureSessions.mockResolvedValueOnce({...page,total:51}); click(panel.root,"Observed error"); await settle();
  api.errorSignatureSessions.mockResolvedValueOnce({...page,total:51,offset:50}); click(panel.root,"Next sessions"); await settle();
  await panel.activate(); expect(api.errorSignatures).toHaveBeenCalledTimes(1); expect(api.errorSignatureSessions).toHaveBeenCalledTimes(2);
  expect(panel.root.textContent).toContain("51–51 of 51"); expect(panel.root.querySelector('[aria-pressed="true"]')).not.toBeNull();
  click(panel.root,"Refresh signatures"); await settle(); expect(api.errorSignatures).toHaveBeenCalledTimes(2); expect(panel.root.querySelectorAll(".strata-row")).toHaveLength(0);
});
test("404 explains both an older daemon and a signature missing from the current projection", async () => {
  const panel=createStrata(); await panel.refresh(); api.errorSignatureSessions.mockRejectedValueOnce(new Error("GET /errors/sessions: 404 not found"));
  click(panel.root,"Observed error"); await settle(); expect(panel.root.textContent).toContain("older daemon"); expect(panel.root.textContent).toContain("signature may no longer exist");
});

test("matching sessions are named from the sessions list; the id is a chip, not the heading", async () => {
  api.sessions.mockResolvedValue([{ id: event.session_id, source: event.source, agent: "codex", cwd: "/work/app", title: "Fix the flaky test", events: 3, first_time: event.time, last_time: event.time, state: "done" }]);
  const panel = createStrata(); await panel.refresh(); click(panel.root, "Observed error"); await settle();
  const heading = panel.root.querySelector(".strata-row-heading")!;
  expect(heading.querySelector("strong")?.textContent).toBe("Fix the flaky test");
  expect(heading.querySelector(".session-id")?.textContent).toBe(event.session_id);
});

test("a session missing from the list, or an unavailable list, is named by source and short id", async () => {
  api.sessions.mockRejectedValue(new Error("offline"));
  const panel = createStrata(); await panel.refresh(); click(panel.root, "Observed error"); await settle();
  const heading = panel.root.querySelector(".strata-row-heading")!;
  expect(heading.querySelector("strong")?.textContent).toBe(`${event.source} · ${event.session_id!.slice(0, 8)}`);
  expect(heading.querySelector(".session-id")?.textContent).toBe(event.session_id);
  expect(heading.textContent?.split(event.session_id!).length).toBe(2);
});
