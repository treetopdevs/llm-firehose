// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActivityResponse } from "../graph/api";
import { shiftWindow } from "../../scope";
import { createActivityMap, type ActivityHost, type ActivityView } from "./index";
import fixture from "./fixture.activity.json";

const activity = vi.hoisted(() => vi.fn());
vi.mock("../graph/api", () => ({ graphAPI: { activity } }));

const real = fixture as ActivityResponse;
const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;
const WORKSPACES = [
  { id: "w1", name: "main" },
  { id: "w2", name: "feature" },
];
const LIVE: ActivityView = { window: "live" };

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const strip = (root: HTMLElement) => root.querySelector<SVGSVGElement>(".map-strip")!;
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const notices = (root: HTMLElement) => [...root.querySelectorAll(".map-notice")].map((n) => n.textContent ?? "");
const calls = () => vi.mocked(activity).mock.calls.map((c) => c[0] as Record<string, string>);

let onWindow: ReturnType<typeof vi.fn>;
let onPickWorktree: ReturnType<typeof vi.fn>;
let clock: number;
let rect: ReturnType<typeof vi.spyOn> | undefined;
const WIDTH = 1000;

function respond(r: ActivityResponse = real) {
  vi.mocked(activity).mockImplementation(async () => structuredClone(r));
}
async function open(view: ActivityView = LIVE, r: ActivityResponse = real) {
  respond(r);
  const host: ActivityHost = { onWindow, onPickWorktree, now: () => clock };
  const map = createActivityMap(host);
  document.body.append(map.root);
  map.update("repo-1", WORKSPACES, "balanced", view);
  await flush();
  return map;
}
const at = (bucket: number, buckets = real.buckets) => ({ clientX: (bucket + 0.5) * (WIDTH / buckets), clientY: 10, bubbles: true, pointerId: 1 });
const down = (root: HTMLElement, bucket: number) => strip(root).dispatchEvent(new PointerEvent("pointerdown", at(bucket)));
const move = (bucket: number) => window.dispatchEvent(new PointerEvent("pointermove", at(bucket)));
const up = (bucket: number) => window.dispatchEvent(new PointerEvent("pointerup", at(bucket)));
const inBars = (root: HTMLElement) => root.querySelectorAll(".map-bar.in").length;

beforeEach(() => {
  activity.mockReset();
  onWindow = vi.fn();
  onPickWorktree = vi.fn();
  clock = NOW;
  rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: WIDTH, height: 72, right: WIDTH, bottom: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
});
afterEach(() => {
  rect?.mockRestore();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("hosted activity map", () => {
  test("has no presets, Live button, worktree select or window buttons", async () => {
    const map = await open();
    expect(map.root.querySelector(".map-presets")).toBeNull();
    expect(map.root.querySelector(".map-live")).toBeNull();
    expect(map.root.querySelector("select")).toBeNull();
    expect(button(map.root, "Back to live")).toBeUndefined();
    expect(button(map.root, "Whole window")).toBeUndefined();
    expect(map.root.querySelector(".map-summary")).not.toBeNull();
  });

  test("live view requests the last liveSpanMs ending at the injected now", async () => {
    await open({ window: "live", liveSpanMs: 2 * DAY });
    const p = calls()[0];
    expect(p.to).toBe(new Date(NOW).toISOString());
    expect(p.from).toBe(new Date(NOW - 2 * DAY).toISOString());
    expect(p.workspace_id).toBeUndefined();
  });

  test("an explicit window is requested exactly; worktree adds workspace_id", async () => {
    const w = { from: NOW - 5 * DAY, to: NOW - 3 * DAY };
    const map = await open({ window: w });
    expect(calls()[0]).toMatchObject({ from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString() });
    map.update("repo-1", WORKSPACES, "balanced", { window: w, worktree: "w2" });
    await flush();
    expect(calls()).toHaveLength(2);
    expect(calls()[1].workspace_id).toBe("w2");
    map.update("repo-1", WORKSPACES, "balanced", { window: w });
    await flush();
    expect(calls()).toHaveLength(3);
    expect(calls()[2].workspace_id).toBeUndefined();
  });

  test("the live cache key excludes the moving end", async () => {
    const map = await open();
    for (let i = 1; i <= 2; i++) {
      clock = NOW + i * 1000;
      map.update("repo-1", WORKSPACES, "balanced", LIVE);
      await flush();
    }
    expect(calls()).toHaveLength(1);
    map.update("repo-1", WORKSPACES, "balanced", { window: "live", liveSpanMs: DAY });
    await flush();
    expect(calls()).toHaveLength(2);
    map.update("repo-1", WORKSPACES, "balanced", { window: { from: NOW - DAY, to: NOW } });
    await flush();
    expect(calls()).toHaveLength(3);
    clock = NOW + 20_000;
    map.update("repo-1", WORKSPACES, "balanced", { window: { from: NOW - DAY, to: NOW } });
    await flush();
    expect(calls()).toHaveLength(3);
  });

  test("a live view refetches once when the injected now advances past the refresh age", async () => {
    const map = await open();
    clock = NOW + 10_000;
    map.update("repo-1", WORKSPACES, "balanced", LIVE);
    await flush();
    expect(calls()).toHaveLength(2);
    map.update("repo-1", WORKSPACES, "balanced", LIVE);
    await flush();
    expect(calls()).toHaveLength(2);
  });

  test("a window over 31 days is clamped with a notice", async () => {
    const map = await open({ window: { from: NOW - 40 * DAY, to: NOW } });
    const p = calls()[0];
    expect(Date.parse(p.to) - Date.parse(p.from)).toBe(31 * DAY);
    expect(notices(map.root).some((n) => n.includes("31 days"))).toBe(true);
  });

  test("a pointer brush commits one window on pointerup, not before", async () => {
    const map = await open();
    down(map.root, 20);
    move(40);
    expect(onWindow).not.toHaveBeenCalled();
    expect(inBars(map.root)).toBeGreaterThan(0);
    up(40);
    expect(onWindow).toHaveBeenCalledTimes(1);
    const w = onWindow.mock.calls[0][0] as { from: number; to: number };
    const from = Date.parse(real.from);
    expect(w.from).toBeLessThan(w.to);
    expect(w.from).toBeGreaterThanOrEqual(from);
    expect(w.to).toBeLessThanOrEqual(from + real.buckets * real.bucket_seconds * 1000);
  });

  test("a brush covering the whole window commits nothing", async () => {
    const map = await open();
    down(map.root, 0);
    move(real.buckets - 1);
    up(real.buckets - 1);
    expect(onWindow).not.toHaveBeenCalled();
  });

  test("a stale brush is dropped when the scope changes mid-drag", async () => {
    const map = await open();
    down(map.root, 20);
    move(30);
    map.update("other", WORKSPACES, "balanced", LIVE);
    await flush();
    up(30);
    expect(onWindow).not.toHaveBeenCalled();
    down(map.root, 20);
    map.update("other", WORKSPACES, "balanced", { window: { from: NOW - DAY, to: NOW } });
    await flush();
    up(30);
    expect(onWindow).not.toHaveBeenCalled();
  });

  test.each(["cancel", "setActive"] as const)("%s mid-drag drops the commit and releases every listener", async (how) => {
    const map = await open();
    const removed = vi.spyOn(window, "removeEventListener");
    const docRemoved = vi.spyOn(document, "removeEventListener");
    down(map.root, 20);
    move(30);
    expect(inBars(map.root)).toBeGreaterThan(0);
    if (how === "cancel") map.cancel();
    else map.setActive(false);
    expect(removed.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));
    expect(docRemoved.mock.calls.some((c) => c[0] === "keydown")).toBe(true);
    expect(inBars(map.root)).toBe(0);
    up(30);
    expect(onWindow).not.toHaveBeenCalled();
    // The same scope key is unchanged, yet the late commit is still rejected.
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    if (how === "setActive") {
      down(map.root, 20);
      move(30);
      up(30);
      expect(onWindow).not.toHaveBeenCalled();
      map.setActive(true);
    }
    down(map.root, 20);
    move(30);
    up(30);
    expect(onWindow).toHaveBeenCalledTimes(1);
  });

  test("Escape mid-drag cancels the brush and is claimed; with no drag it is not", async () => {
    const map = await open();
    const idle = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    strip(map.root).dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    down(map.root, 20);
    move(30);
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stop = vi.spyOn(esc, "stopPropagation");
    document.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(inBars(map.root)).toBe(0);
    up(30);
    expect(onWindow).not.toHaveBeenCalled();
  });

  test("Arrow keys scrub the window by a quarter span; ArrowRight on live does nothing", async () => {
    const w = { from: NOW - 4 * DAY, to: NOW - 2 * DAY };
    const map = await open({ window: w, liveSpanMs: 7 * DAY });
    const key = (k: string) => strip(map.root).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    key("ArrowLeft");
    expect(onWindow).toHaveBeenLastCalledWith(shiftWindow(w, -(2 * DAY) / 4, NOW, 7 * DAY));
    key("ArrowRight");
    expect(onWindow).toHaveBeenLastCalledWith(shiftWindow(w, (2 * DAY) / 4, NOW, 7 * DAY));
    onWindow.mockClear();
    map.update("repo-1", WORKSPACES, "balanced", LIVE);
    await flush();
    strip(map.root).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onWindow).not.toHaveBeenCalled();
  });

  test("worktree note names the worktree and Clear unpicks it", async () => {
    const map = await open({ window: "live", worktree: "w2" });
    expect(map.root.querySelector(".map-scope")!.textContent).toContain("Worktree: feature");
    button(map.root.querySelector<HTMLElement>(".map-scope")!, "Clear")!.click();
    expect(onPickWorktree).toHaveBeenCalledWith(undefined);
    map.update("repo-1", WORKSPACES, "balanced", LIVE);
    await flush();
    expect(map.root.querySelector(".map-scope")!.textContent).toBe("");
  });

  test("a filtered-empty response with a worktree says so and offers Clear", async () => {
    const map = await open({ window: "live", worktree: "w2" }, { ...real, paths: [], groups: [], file_events: 0 });
    const n = notices(map.root).find((t) => t.includes("No activity for this worktree in this window"));
    expect(n).toBeDefined();
    const clear = [...map.root.querySelectorAll<HTMLButtonElement>(".map-notice button")].find((b) => b.textContent === "Clear")!;
    clear.click();
    expect(onPickWorktree).toHaveBeenCalledWith(undefined);
  });

  test("a group tile equal to a workspace id picks the worktree; any other group zooms", async () => {
    const withGroup = (id: string): ActivityResponse => {
      const paths = real.paths.slice(0, 3).map((p) => ({ ...p, group: id }));
      return { ...real, paths, groups: [{ id, label: id, resolved: true }] };
    };
    const map = await open(LIVE, withGroup("w2"));
    const group = (id: string) => map.root.querySelector<SVGGElement>(`.map-dir[data-key="${id}\0"]`);
    const click = (g: Element) => g.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // Groups sit under the "Outside known worktrees" node; zoom into it first.
    if (!group("w2")) click(map.root.querySelector(".map-dir")!);
    click(group("w2")!);
    expect(onPickWorktree).toHaveBeenCalledWith("w2");
    expect(onPickWorktree).toHaveBeenCalledTimes(1);

    onPickWorktree.mockClear();
    respond(withGroup("not-a-workspace"));
    map.update("repo-2", WORKSPACES, "balanced", LIVE);
    await flush();
    const before = map.root.querySelector(".map-crumb.current")!.textContent;
    if (!group("not-a-workspace")) click(map.root.querySelector(".map-dir")!);
    click(group("not-a-workspace")!);
    expect(onPickWorktree).not.toHaveBeenCalled();
    expect(map.root.querySelector(".map-crumb.current")!.textContent).not.toBe(before);
  });

  test("a failed frozen request is retried by the next update and by the Retry control", async () => {
    const frozen: ActivityView = { window: { from: NOW - 3 * DAY, to: NOW - DAY } };
    vi.mocked(activity).mockRejectedValue(new Error("down"));
    const map = createActivityMap({ onWindow, onPickWorktree, now: () => clock });
    document.body.append(map.root);
    map.update("repo-1", WORKSPACES, "balanced", frozen);
    await flush();
    expect(calls()).toHaveLength(1);
    expect(notices(map.root).some((n) => n.includes("Activity unavailable"))).toBe(true);
    // Polling / re-entering Map calls update() with the same explicit window: it asks again.
    respond();
    map.update("repo-1", WORKSPACES, "balanced", frozen);
    await flush();
    expect(calls()).toHaveLength(2);
    expect(notices(map.root).some((n) => n.includes("Activity unavailable"))).toBe(false);
    // A failure offers Retry, which forces a request.
    vi.mocked(activity).mockRejectedValue(new Error("down"));
    map.update("repo-1", WORKSPACES, "balanced", { window: { from: NOW - 5 * DAY, to: NOW - 4 * DAY } });
    await flush();
    respond();
    button(map.root, "Retry")!.click();
    await flush();
    expect(calls()).toHaveLength(4);
    expect(button(map.root, "Retry")).toBeUndefined();
  });
});
