// @vitest-environment happy-dom
// Select fills the inspector, open pushes history (MS-8); honest unknown and overflow states (MS-10).
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessions = vi.fn();
const sessionEvents = vi.fn();
const attention = vi.fn();
vi.mock("../api", () => ({
  sessions: (signal?: AbortSignal) => sessions(signal),
  sessionEvents: (id: string) => sessionEvents(id),
  attention: (signal?: AbortSignal) => attention(signal),
}));

import { createSessions, SESSION_PAGE } from "./sessions";
import { createScope } from "../scope";
import { isEscapeClaimed } from "../escape";
import type { AttentionEvidence, AttentionSession, SessionSummary } from "../api";
import type { Inspected } from "./inspector";

const now = Date.now();
const summary = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  source: "claude-code",
  agent: "claude",
  first_time: new Date(now - 600_000).toISOString(),
  last_time: new Date(now - 5_000).toISOString(),
  events: 3,
  state: "working",
  ...over,
});
const evidence = (ageMs: number, over: Partial<AttentionEvidence> = {}): AttentionEvidence => {
  const at = new Date(now - ageMs).toISOString();
  return { event_id: `e-${ageMs}`, source: "claude-code", kind: "activity", summary: "", time: at, observed_at: at, ...over };
};
const inbox = (over: Partial<AttentionSession> & { id: string }): AttentionSession => ({ source: "claude-code", events: 1, state: "working", last: evidence(5_000), ...over });
const attentionSays = (entries: AttentionSession[]) => attention.mockResolvedValue({ gaps: [], sessions: entries, warnings: [] });

function rig(over: { onSelectSession?: (r: { id: string; source?: string }) => void } = {}) {
  const inspect = vi.fn();
  const store = createScope();
  const picked: Array<{ id: string; source?: string }> = [];
  const panel = createSessions(() => {}, () => [], undefined, undefined, store, undefined, over.onSelectSession ?? ((r) => picked.push(r)), { inspect });
  document.body.replaceChildren(panel.root);
  const last = () => inspect.mock.calls.at(-1)?.[0] as Inspected | null | undefined;
  return { panel, inspect, store, picked, last };
}
const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".session-item")];
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  sessions.mockReset();
  sessionEvents.mockReset();
  attention.mockReset();
  attentionSays([]);
  sessionEvents.mockResolvedValue([]);
});

describe("session rows: select and open", () => {
  test("a click selects the row and fills the inspector; it opens nothing and writes no scope", async () => {
    sessions.mockResolvedValue([summary({ id: "s1", title: "Sample task" }), summary({ id: "s2" })]);
    attentionSays([inbox({ id: "s1" }), inbox({ id: "s2" })]);
    const { panel, last, picked } = rig();
    await panel.refresh();
    items(panel.root)[0]!.click();
    expect(last()).toMatchObject({ kind: "session", title: "Sample task", id: { value: "s1" } });
    expect(items(panel.root)[0]!.classList.contains("picked")).toBe(true);
    expect(picked).toEqual([]);
    expect(sessionEvents).not.toHaveBeenCalled();
    expect(panel.root.querySelector(".session-heading")).toBeNull();
  });

  test("the row no longer carries the session id; the inspector holds it", async () => {
    sessions.mockResolvedValue([summary({ id: "s1-long-native-id" })]);
    attentionSays([inbox({ id: "s1-long-native-id" })]);
    const { panel } = rig();
    await panel.refresh();
    expect(items(panel.root)[0]!.querySelector(".session-id")).toBeNull();
    expect(items(panel.root)[0]!.textContent).not.toContain("s1-long-native-id");
  });

  test("Enter and a double click open the history and record the session", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    attentionSays([inbox({ id: "s1" })]);
    const { panel, picked } = rig();
    await panel.refresh();
    items(panel.root)[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(picked).toEqual([{ id: "s1", source: "claude-code" }]);
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledWith("s1"));
    key(items(panel.root)[0]!, "Enter");
    expect(picked).toHaveLength(2);
  });

  test("the inspector's Open runs the same open", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    attentionSays([inbox({ id: "s1" })]);
    const { panel, last, picked } = rig();
    await panel.refresh();
    items(panel.root)[0]!.click();
    last()!.open.run();
    expect(picked).toEqual([{ id: "s1", source: "claude-code" }]);
  });

  test("arrows move the selection to the neighbour row", async () => {
    sessions.mockResolvedValue([summary({ id: "s1", last_time: new Date(now - 1000).toISOString() }), summary({ id: "s2", last_time: new Date(now - 9000).toISOString() })]);
    attentionSays([inbox({ id: "s1" }), inbox({ id: "s2" })]);
    const { panel, last } = rig();
    await panel.refresh();
    const [a, b] = items(panel.root);
    a!.focus();
    key(a!, "ArrowDown");
    expect(document.activeElement).toBe(b);
    expect(last()!.id!.value).toBe("s2");
  });

  test("the selection survives the periodic rebuild by key, and the inspector is only re-filled when its data changed", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" }), summary({ id: "s2" })]);
    attentionSays([inbox({ id: "s1" }), inbox({ id: "s2" })]);
    const { panel, inspect } = rig();
    await panel.refresh();
    items(panel.root).find((n) => n.getAttribute("data-id") === "s2")!.click();
    const n = inspect.mock.calls.length;
    await panel.refresh();
    expect(items(panel.root).filter((x) => x.classList.contains("picked")).map((x) => x.getAttribute("data-id"))).toEqual(["s2"]);
    expect(inspect.mock.calls.length).toBe(n);
  });

  test("a selected row that is no longer listed clears the inspector", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" }), summary({ id: "s2" })]);
    attentionSays([inbox({ id: "s1" }), inbox({ id: "s2" })]);
    const { panel, last } = rig();
    await panel.refresh();
    items(panel.root).find((n) => n.getAttribute("data-id") === "s2")!.click();
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    await panel.refresh();
    expect(last()).toBeNull();
    expect(panel.selectedKey()).toBeUndefined();
  });

  test("without an inspector sink a settled refresh still drops a key that is no longer listed", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" }), summary({ id: "s2" })]);
    attentionSays([inbox({ id: "s1" }), inbox({ id: "s2" })]);
    const panel = createSessions(() => {}, () => [], undefined, undefined, createScope(), undefined, () => {});
    document.body.replaceChildren(panel.root);
    await panel.refresh();
    items(panel.root).find((n) => n.getAttribute("data-id") === "s1")!.click();
    expect(panel.selectedKey()).toBe("claude-code\u0000s1");
    sessions.mockResolvedValue([summary({ id: "s2" })]);
    await panel.refresh();
    expect(panel.selectedKey()).toBeUndefined();
  });

  test("Escape clears the selection and the inspector, claims the key, and a second Escape is left to the shell", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    attentionSays([inbox({ id: "s1" })]);
    const { panel, last } = rig();
    await panel.refresh();
    items(panel.root)[0]!.click();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    items(panel.root)[0]!.dispatchEvent(e);
    expect(isEscapeClaimed(e)).toBe(true);
    expect(last()).toBeNull();
    const e2 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    items(panel.root)[0]!.dispatchEvent(e2);
    expect(isEscapeClaimed(e2)).toBe(false);
  });

  test("selectKey restores a selection by key once the rows are drawn", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" }), summary({ id: "s2" })]);
    attentionSays([inbox({ id: "s1" }), inbox({ id: "s2" })]);
    const { panel, last } = rig();
    panel.selectKey("claude-code\u0000s2");
    await panel.refresh();
    expect(last()!.id!.value).toBe("s2");
    expect(panel.selectedKey()).toBe("claude-code\u0000s2");
  });
});

describe("session rows: unknown stays unknown (MS-10)", () => {
  test("a session the needs-you snapshot does not know is unknown with a reason, never idle or working", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    attentionSays([]);
    const { panel, last } = rig();
    await panel.refresh();
    const state = items(panel.root)[0]!.querySelector<HTMLElement>(".cell.state")!;
    expect(state.textContent).toBe("unknown");
    expect(state.classList.contains("unknown")).toBe(true);
    expect(state.getAttribute("data-mark")).toBe("◌");
    expect(state.getAttribute("title")).toContain("not in the needs-you snapshot");
    items(panel.root)[0]!.click();
    expect(last()!.status).toMatchObject({ word: "unknown", mark: "◌" });
    expect(last()!.status.reason).toContain("not in the needs-you snapshot");
  });

  test("an unreadable activity time is drawn as unknown, not a blank", async () => {
    sessions.mockResolvedValue([summary({ id: "s1", last_time: "not a time", first_time: "" })]);
    attentionSays([inbox({ id: "s1" })]);
    const { panel, last } = rig();
    await panel.refresh();
    const age = items(panel.root)[0]!.querySelector<HTMLElement>(".cell.age")!;
    expect(age.textContent).toBe("unknown");
    expect(age.classList.contains("unknown")).toBe(true);
    items(panel.root)[0]!.click();
    const facts = Object.fromEntries(last()!.facts.map((f) => [f.label, f.value]));
    expect(facts["started"]).toBeUndefined();
    expect(facts["last activity"]).toBeUndefined();
    expect(items(panel.root)[0]!.textContent).not.toContain("started");
  });

  test("a known state keeps its word and carries no unknown mark", async () => {
    sessions.mockResolvedValue([summary({ id: "s1" })]);
    attentionSays([inbox({ id: "s1" })]);
    const { panel } = rig();
    await panel.refresh();
    const state = items(panel.root)[0]!.querySelector<HTMLElement>(".cell.state")!;
    expect(state.textContent).toBe("working");
    expect(state.hasAttribute("data-mark")).toBe(false);
  });
});

describe("session rows: overflow", () => {
  test("a long list says how many are shown of how many, and Show more adds a page", async () => {
    const many = Array.from({ length: SESSION_PAGE + 30 }, (_, i) => summary({ id: `s${String(i).padStart(4, "0")}`, last_time: new Date(now - i * 1000).toISOString() }));
    sessions.mockResolvedValue(many);
    attentionSays(many.map((s) => inbox({ id: s.id })));
    const { panel } = rig();
    await panel.refresh();
    expect(items(panel.root)).toHaveLength(SESSION_PAGE);
    expect(panel.root.querySelector(".sessions-count")!.textContent).toBe(`Showing ${SESSION_PAGE} of ${SESSION_PAGE + 30} sessions`);
    const more = panel.root.querySelector<HTMLButtonElement>(".sessions-more")!;
    expect(more.textContent).toBe("Show 30 more");
    more.click();
    await vi.waitFor(() => expect(items(panel.root)).toHaveLength(SESSION_PAGE + 30));
    expect(panel.root.querySelector(".sessions-count")!.textContent).toBe(`${SESSION_PAGE + 30} sessions`);
    expect(panel.root.querySelector(".sessions-more")).toBeNull();
  });

  test("an empty scope says so instead of drawing nothing", async () => {
    sessions.mockResolvedValue([]);
    const { panel } = rig();
    await panel.refresh();
    expect(panel.root.querySelector(".sessions-list")!.textContent).toContain("no sessions captured yet");
  });
});
