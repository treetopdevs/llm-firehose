// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.errsig.json";
const api = vi.hoisted(() => ({ capturedEvent: vi.fn() }));
vi.mock("../../api", () => api);
import { createHandoffs } from "./index";
const from = (fixture as FirehoseEvent[]).find(e => e.session_id)!;
const to = (fixture as FirehoseEvent[]).find(e => e.session_id && e.session_id !== from.session_id)!;
const click = (root: HTMLElement, label: string) => { const b = [...root.querySelectorAll("button")].find(b => b.textContent === label); expect(b).toBeTruthy(); b!.click(); };
const input = (root: HTMLElement, label: string, value: string) => { const e = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; e.value = value; e.dispatchEvent(new Event("input")); };
const settle = async () => { await vi.waitFor(() => expect([...document.querySelectorAll('[data-loading="true"]')]).toHaveLength(0)); for (let i = 0; i < 6; i++)
    await Promise.resolve(); };
function storage() { let raw: string | null = null; return { getItem: vi.fn(() => raw), setItem: vi.fn((_k: string, v: string) => { raw = v; }) }; }
beforeEach(() => { vi.resetAllMocks(); api.capturedEvent.mockImplementation(async (id: string) => id === from.id ? from : to); });
async function preview(panel: ReturnType<typeof createHandoffs>) { input(panel.root, "Link label", "Review continuation"); input(panel.root, "Departure event ID", from.id); input(panel.root, "Arrival event ID", to.id); click(panel.root, "Look up departure"); click(panel.root, "Look up arrival"); await settle(); }
test("requires explicit verified endpoints, saves identity only, inspects and confirms deletion", async () => {
    const store = storage(), score = vi.fn(), panel = createHandoffs(score, () => [], store);
    expect(api.capturedEvent).not.toHaveBeenCalled();
    await preview(panel);
    expect(api.capturedEvent).toHaveBeenCalledTimes(2);
    expect(panel.root.textContent).toContain(from.session_id!);
    expect(panel.root.textContent).toContain(to.session_id!);
    click(panel.root, "Save annotation");
    const saved = JSON.parse(store.getItem()!).links[0];
    expect(saved.from).toEqual({ id: from.id, source: from.source, session_id: from.session_id });
    expect(saved.to).toEqual({ id: to.id, source: to.source, session_id: to.session_id });
    expect(Object.keys(saved).sort()).toEqual(["from", "id", "label", "to"]);
    click(panel.root, "Inspect departure");
    await settle();
    expect(api.capturedEvent).toHaveBeenCalledTimes(3);
    click(panel.root, "Open Score");
    expect(score).toHaveBeenCalledWith(from.session_id, from.source);
    click(panel.root, "Remove annotation");
    click(panel.root, "Cancel removal");
    expect(JSON.parse(store.getItem()!).links).toHaveLength(1);
    click(panel.root, "Remove annotation");
    click(panel.root, "Confirm removal");
    expect(JSON.parse(store.getItem()!).links).toHaveLength(0);
});
test("recent picker is explicit bounded and only fills ids without lookup", () => {
    const recent = Array.from({ length: 150 }, (_, i) => ({ ...from, id: `id-${i}` }));
    const panel = createHandoffs(undefined, () => recent, storage());
    expect(panel.root.querySelectorAll(".handoff-recent-row")).toHaveLength(0);
    click(panel.root, "Browse recent observations");
    expect(panel.root.querySelectorAll(".handoff-recent-row")).toHaveLength(20);
    expect(panel.root.textContent).toContain("100");
    click(panel.root, "Use as departure");
    expect(api.capturedEvent).not.toHaveBeenCalled();
    expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Departure event ID"]')?.value).toBe("id-149");
});
test("failed save preserves previews and drafts; refresh preserves fields but cancels previews", async () => {
    const store = storage(), panel = createHandoffs(undefined, () => [], store);
    await preview(panel);
    store.setItem.mockImplementationOnce(() => { throw Error("quota"); });
    click(panel.root, "Save annotation");
    expect(panel.root.textContent).toContain("Save failed");
    expect(panel.root.querySelectorAll(".handoff-endpoint pre")).toHaveLength(2);
    click(panel.root, "Save annotation");
    expect(JSON.parse(store.getItem()!).links).toHaveLength(1);
    input(panel.root, "Link label", "draft");
    panel.refresh();
    expect(panel.root.querySelector<HTMLInputElement>('[aria-label="Link label"]')?.value).toBe("draft");
    expect(panel.root.querySelectorAll(".handoff-endpoint pre")).toHaveLength(0);
});
test("changed endpoint aborts pending lookup and rejects stale response", async () => {
    const panel = createHandoffs(undefined, () => [], storage());
    let resolve!: (e: FirehoseEvent) => void;
    api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r));
    input(panel.root, "Departure event ID", from.id);
    click(panel.root, "Look up departure");
    const signal = api.capturedEvent.mock.calls[0][1] as AbortSignal;
    input(panel.root, "Departure event ID", to.id);
    resolve(from);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(panel.root.querySelectorAll(".handoff-endpoint pre")).toHaveLength(0);
});
test("invalid storage has read-only recovery and reload never writes", () => { const store = storage(); store.getItem.mockReturnValue('{"version":99}'); const panel = createHandoffs(undefined, () => [], store); expect(panel.root.textContent).toContain("Annotations unavailable"); expect(panel.root.querySelector("pre")?.textContent).toBe('{"version":99}'); click(panel.root, "Reload annotations"); expect(store.setItem).not.toHaveBeenCalled(); });
test("same lane and sessionless endpoints cannot be saved; malformed event identity is visible", async () => {
    const panel = createHandoffs(undefined, () => [], storage());
    api.capturedEvent.mockResolvedValueOnce(from).mockResolvedValueOnce({ ...to, source: from.source, session_id: from.session_id });
    await preview(panel);
    expect([...panel.root.querySelectorAll("button")].find(b => b.textContent === "Save annotation")!.disabled).toBe(true);
    api.capturedEvent.mockResolvedValueOnce({ ...to, session_id: undefined });
    click(panel.root, "Look up arrival");
    await settle();
    expect(panel.root.textContent).toContain("missing session/source");
});
test("saved-station mismatch is a visible gap without losing annotation", async () => {
    const store = storage(), panel = createHandoffs(undefined, () => [], store);
    await preview(panel);
    click(panel.root, "Save annotation");
    api.capturedEvent.mockResolvedValueOnce({ ...from, source: "wrong" });
    click(panel.root, "Inspect departure");
    await settle();
    expect(panel.root.textContent).toContain("Saved identity conflicts");
    expect(panel.root.querySelector(".handoff-detail pre")).toBeNull();
    expect(JSON.parse(store.getItem()!).links).toHaveLength(1);
});
test("paging bounds saved links and escapes labels; changing page cancels inspected evidence", async () => {
    const store = storage();
    store.setItem("x", JSON.stringify({ version: 1, links: Array.from({ length: 21 }, (_, i) => ({ id: `link-${i}`, label: "<img src=x>", from: { id: `from-${i}`, source: from.source, session_id: `s-${i}` }, to: { id: `to-${i}`, source: to.source, session_id: `t-${i}` } })) }));
    const panel = createHandoffs(undefined, () => [], store);
    expect(panel.root.querySelectorAll(".handoff-links li")).toHaveLength(10);
    expect(panel.root.querySelector("img")).toBeNull();
    let resolve!: (v: FirehoseEvent) => void;
    api.capturedEvent.mockReturnValueOnce(new Promise(r => resolve = r));
    click(panel.root, "Inspect departure");
    const signal = api.capturedEvent.mock.calls[0][1] as AbortSignal;
    click(panel.root, "Next annotations");
    resolve(from);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(panel.root.querySelector(".handoff-detail pre")).toBeNull();
    click(panel.root, "Next annotations");
    expect(panel.root.querySelectorAll(".handoff-links li")).toHaveLength(1);
});
test("conflicting write and UUID failure preserve previews for retry", async () => {
    const store = storage(), panel = createHandoffs(undefined, () => [], store);
    await preview(panel);
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementationOnce(() => { throw Error("unsupported"); });
    click(panel.root, "Save annotation");
    expect(panel.root.textContent).toContain("Could not create annotation ID");
    uuid.mockRestore();
    expect(panel.root.querySelectorAll(".handoff-endpoint pre")).toHaveLength(2);
    store.setItem("x", JSON.stringify({ version: 1, links: [] }));
    click(panel.root, "Save annotation");
    expect(panel.root.textContent).toContain("another window");
    expect(panel.root.querySelectorAll(".handoff-endpoint pre")).toHaveLength(2);
});
test("recent picker excludes stream-only transitions before retaining the latest 100 receipts", () => {
    // Captured envelopes from the real fixture, mixed with the engine's synthetic
    // transition shape; transitions are live state, never durable receipts.
    const mixed = Array.from({length: 110}, (_, i) => [
        {...from, id: `receipt-${i}`, summary: `Captured receipt ${i}`},
        {...from, id: `transition-${i}`, source: "firehose", name: "state.transition", summary: "Synthetic transition"},
    ]).flat();
    const panel = createHandoffs(undefined, () => mixed, storage());
    click(panel.root, "Browse recent observations");
    const seen: string[] = [];
    for (let page = 0; page < 5; page++) {
        const rows = [...panel.root.querySelectorAll<HTMLElement>(".handoff-recent-row")];
        expect(rows).toHaveLength(20);
        expect(rows.every(row => !row.textContent?.includes("Synthetic transition"))).toBe(true);
        for (const row of rows) {
            click(row, "Use as departure");
            seen.push(panel.root.querySelector<HTMLInputElement>('[aria-label="Departure event ID"]')!.value);
        }
        if (page < 4) click(panel.root, "Next observations");
    }
    expect(seen).toEqual(Array.from({length: 100}, (_, i) => `receipt-${109-i}`));
    expect(api.capturedEvent).not.toHaveBeenCalled();
});
import { createSessionDirectory } from "../../session-directory";
test("names sessions late without a refetch, keeps event ids, and stops after deactivate", async () => {
    const store = storage(), dir = createSessionDirectory(), panel = createHandoffs(vi.fn(), () => [], store, dir);
    await preview(panel);
    click(panel.root, "Save annotation");
    panel.refresh();
    const item = () => panel.root.querySelector(".handoff-links li")!.textContent!;
    expect(item()).toContain(from.session_id!.slice(0, 8));
    const calls = api.capturedEvent.mock.calls.length;
    dir.remember([{ id: from.session_id!, source: from.source, title: "Fix login bug" }]);
    expect(item()).toContain(`${from.source} / Fix login bug / ${from.id}`);
    expect(item()).toContain(`/ ${to.id}`);
    expect(panel.root.querySelector(".handoff-map")!.textContent).toContain("Fix login bug");
    expect(api.capturedEvent.mock.calls.length).toBe(calls);
    panel.deactivate();
    dir.remember([{ id: from.session_id!, source: from.source, title: "Renamed later" }]);
    expect(item()).toContain("Fix login bug");
    expect(item()).not.toContain("Renamed later");
});
test("returning to the panel relabels at once", async () => {
    const store = storage(), dir = createSessionDirectory(), panel = createHandoffs(vi.fn(), () => [], store, dir);
    await preview(panel);
    click(panel.root, "Save annotation");
    panel.refresh();
    panel.deactivate();
    dir.remember([{ id: from.session_id!, source: from.source, title: "Learned while away" }]);
    expect(panel.root.querySelector(".handoff-links li")!.textContent).not.toContain("Learned while away");
    panel.refresh();
    expect(panel.root.querySelector(".handoff-links li")!.textContent).toContain(`${from.source} / Learned while away / ${from.id}`);
});
