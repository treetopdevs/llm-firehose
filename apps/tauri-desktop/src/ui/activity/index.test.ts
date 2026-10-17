// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActivityResponse } from "../graph/api";
import { MINIMAL_NOTICE, axisTicks, createActivityMap } from "./index";
import fixture from "./fixture.activity.json";

const activity = vi.hoisted(() => vi.fn());
vi.mock("../graph/api", () => ({ graphAPI: { activity } }));

const real = fixture as ActivityResponse;
const WORKSPACES = [
  { id: "w1", name: "main" },
  { id: "w2", name: "feature" },
];

type Held = { params: Record<string, string>; signal: AbortSignal; resolve(r: ActivityResponse): void; reject(e: unknown): void };
let held: Held[] = [];

function respond(r: ActivityResponse = real) {
  vi.mocked(activity).mockImplementation(async () => structuredClone(r));
}
function hold() {
  vi.mocked(activity).mockImplementation(
    (params: Record<string, string>, signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        held.push({ params, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
async function open(r: ActivityResponse = real, privacy = "balanced") {
  respond(r);
  const map = createActivityMap();
  document.body.append(map.root);
  map.update("repo-1", WORKSPACES, privacy);
  await flush();
  return map;
}
const notices = (root: HTMLElement) => [...root.querySelectorAll(".map-notice")].map((n) => n.textContent);
const tileRects = (root: HTMLElement) =>
  [...root.querySelectorAll(".map-tile > rect")].map((r) => ["x", "y", "width", "height"].map((a) => r.getAttribute(a)).join(","));
const tileFills = (root: HTMLElement) => [...root.querySelectorAll(".map-tile > rect")].map((r) => r.getAttribute("fill"));
const strip = (root: HTMLElement) => root.querySelector<SVGSVGElement>(".map-strip")!;
const key = (target: Element, k: string, shiftKey = false) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
const button = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

beforeEach(() => {
  held = [];
  activity.mockReset();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("activity map view", () => {
  test("asks for the repository's last 24h and draws one tile per path, the strip and the hottest list", async () => {
    const map = await open();
    expect(activity).toHaveBeenCalledTimes(1);
    const params = vi.mocked(activity).mock.calls[0][0] as Record<string, string>;
    expect(params.repo_id).toBe("repo-1");
    expect(params.workspace_id).toBeUndefined();
    expect(Date.parse(params.to) - Date.parse(params.from)).toBe(24 * 3600_000);
    expect(map.root.querySelectorAll(".map-tile")).toHaveLength(real.paths.length);
    expect(map.root.querySelectorAll(".map-bar").length).toBeGreaterThan(0);
    expect(map.root.querySelectorAll(".map-hot li")).toHaveLength(20);
    expect(map.root.querySelector(".map-summary")!.textContent).toBe(`${real.file_events} file events · ${real.paths.length} paths`);
    const title = map.root.querySelector(".map-tile title")!.textContent!;
    expect(title).toMatch(/^.+\nHeat in range: \d+\nWindow total: \d+$/);
    // The unresolved groups sit under one labelled node.
    expect([...map.root.querySelectorAll(".map-dir text")].some((t) => t.textContent!.startsWith("Outside known worktrees"))).toBe(true);
  });

  test("minimal mode shows the unavailable notice and asks for nothing", async () => {
    const map = await open(real, "minimal");
    expect(activity).not.toHaveBeenCalled();
    expect(notices(map.root)).toEqual([MINIMAL_NOTICE]);
    expect(map.root.querySelector(".map-tile")).toBeNull();
  });

  test("a minimal response from the daemon is the same notice", async () => {
    const map = await open({ ...real, available: false, unavailable_reason: "minimal", paths: [], groups: [] });
    expect(notices(map.root)).toEqual([MINIMAL_NOTICE]);
  });

  test("each flag has its notice", async () => {
    const map = await open({ ...real, capture_gap: true, truncated: true, truncated_total: 1234, unreadable_file_events: 3 });
    expect(notices(map.root)).toEqual([
      "Capture gaps reported; this map may be incomplete.",
      "Showing the 2,000 hottest paths; 1,234 Heat on other paths is not drawn.",
      "3 file events carried no readable path and add no Heat.",
    ]);
    const empty = await open({ ...real, paths: [], groups: [], file_events: 0, unreadable_file_events: 0 });
    expect(notices(empty.root)).toEqual(["No file activity captured in this window."]);
    expect(empty.root.querySelector(".map-hot")!.textContent).toBe("No Heat in this range.");
  });

  test("brush keyboard: arrows move one bucket, shift+arrows resize, Home/End jump; tiles never move", async () => {
    const small: ActivityResponse = {
      ...real,
      buckets: 6,
      paths: [
        { path: "a/early.go", group: "", total: 4, heat: [[0, 3], [1, 1]] },
        { path: "a/late.go", group: "", total: 5, heat: [[5, 5]] },
        { path: "b.go", group: "", total: 2, heat: [[2, 1], [5, 1]] },
      ],
      groups: [],
    };
    const map = await open(small);
    const rects = tileRects(map.root);
    const fills = tileFills(map.root);
    const s = () => strip(map.root);
    s().focus();
    expect(s().getAttribute("aria-valuenow")).toBe("0");
    for (let i = 0; i < 5; i++) key(s(), "ArrowLeft", true); // shrink to bucket 0
    expect(Number(s().querySelector(".map-brush")!.getAttribute("width"))).toBeCloseTo(Number(s().getAttribute("width")) / 6);
    const early = tileFills(map.root);
    expect(early[1]).toBe("var(--map-zero)"); // late.go has no Heat in bucket 0
    key(s(), "End");
    expect(s().getAttribute("aria-valuenow")).toBe("5");
    expect(tileFills(map.root)[0]).toBe("var(--map-zero)");
    key(s(), "ArrowLeft");
    expect(s().getAttribute("aria-valuenow")).toBe("4");
    key(s(), "ArrowRight", true); // [4, 6)
    expect(Number(s().querySelector(".map-brush")!.getAttribute("width"))).toBeCloseTo((2 * Number(s().getAttribute("width"))) / 6);
    key(s(), "ArrowRight"); // already at the end: stays
    expect(s().getAttribute("aria-valuenow")).toBe("4");
    key(s(), "Home");
    expect(s().getAttribute("aria-valuenow")).toBe("0");
    expect(document.activeElement).toBe(s());
    // Size is window total: identical rects at every brush position. Colour follows the range.
    expect(tileRects(map.root)).toEqual(rects);
    expect(tileFills(map.root)).not.toEqual(fills);
    key(s(), "Escape");
    expect(tileFills(map.root)).toEqual(fills);
    expect(button(map.root, "Whole window").disabled).toBe(true);
  });

  test("dragging across the strip brushes every bucket it crosses, across redraws", async () => {
    const map = await open({ ...real, buckets: 10 });
    const width = Number(strip(map.root).getAttribute("width"));
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width, height: 72, right: width, bottom: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const at = (bucket: number) => ({ clientX: (bucket + 0.5) * (width / 10), clientY: 10, bubbles: true, pointerId: 1 });
    strip(map.root).dispatchEvent(new PointerEvent("pointerdown", at(2)));
    strip(map.root).dispatchEvent(new PointerEvent("pointermove", at(4)));
    // The strip was redrawn by the first move; the drag continues on the new one.
    strip(map.root).dispatchEvent(new PointerEvent("pointermove", at(6)));
    window.dispatchEvent(new PointerEvent("pointerup", at(6)));
    strip(map.root).dispatchEvent(new PointerEvent("pointermove", at(9)));
    rect.mockRestore();
    expect(strip(map.root).getAttribute("aria-valuenow")).toBe("2");
    expect(Number(strip(map.root).querySelector(".map-brush")!.getAttribute("width"))).toBeCloseTo((5 * width) / 10);
  });

  test("clicking a directory zooms into it; the breadcrumb leads back", async () => {
    const map = await open();
    const dir = map.root.querySelector<SVGGElement>(".map-dir")!;
    const name = dir.querySelector("text")!.textContent!.split(" · ")[0];
    dir.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(map.root.querySelector(".map-crumb.current")!.textContent).toBe(name);
    const inside = map.root.querySelectorAll(".map-tile").length;
    expect(inside).toBeLessThan(real.paths.length);
    button(map.root, "Repository").click();
    expect(map.root.querySelector(".map-crumb.current")!.textContent).toBe("Repository");
    expect(map.root.querySelectorAll(".map-tile")).toHaveLength(real.paths.length);
  });

  test("a parameter change aborts the request in flight", async () => {
    hold();
    const map = createActivityMap();
    map.update("repo-1", WORKSPACES, "balanced");
    expect(held).toHaveLength(1);
    button(map.root, "8h").click();
    expect(held[0].signal.aborted).toBe(true);
    expect(held).toHaveLength(2);
    expect(Date.parse(held[1].params.to) - Date.parse(held[1].params.from)).toBe(8 * 3600_000);
    const select = map.root.querySelector<HTMLSelectElement>('select[aria-label="Worktree"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(["All worktrees", "main", "feature"]);
    select.value = "w2";
    select.dispatchEvent(new Event("change"));
    expect(held[1].signal.aborted).toBe(true);
    expect(held[2].params.workspace_id).toBe("w2");
    held[2].resolve(structuredClone(real));
    await flush();
    expect(map.root.querySelectorAll(".map-tile")).toHaveLength(real.paths.length);
  });

  test("switching repository resets worktree, brush and zoom and cancels the old request", async () => {
    const map = await open();
    const select = map.root.querySelector<HTMLSelectElement>('select[aria-label="Worktree"]')!;
    select.value = "w1";
    select.dispatchEvent(new Event("change"));
    await flush();
    key(strip(map.root), "ArrowLeft", true);
    map.root.querySelector<SVGGElement>(".map-dir")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    hold();
    map.update("repo-2", [{ id: "x", name: "other" }], "balanced");
    const last = held[held.length - 1];
    expect(last.params.repo_id).toBe("repo-2");
    expect(last.params.workspace_id).toBeUndefined();
    expect(map.root.querySelector(".map-tile")).toBeNull();
    last.resolve(structuredClone(real));
    await flush();
    expect(map.root.querySelector(".map-crumb.current")!.textContent).toBe("Repository");
    expect(strip(map.root).getAttribute("aria-valuenow")).toBe("0");
    expect(button(map.root, "Whole window").disabled).toBe(true);
    expect(map.root.querySelector<HTMLSelectElement>('select[aria-label="Worktree"]')!.value).toBe("");
  });

  test("Live refetches on the poll once stale; a frozen window does not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const map = await open();
    map.update("repo-1", WORKSPACES, "balanced");
    await flush();
    expect(activity).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-16T12:00:15Z"));
    map.update("repo-1", WORKSPACES, "balanced");
    await flush();
    expect(activity).toHaveBeenCalledTimes(2);
    expect((vi.mocked(activity).mock.calls[1][0] as Record<string, string>).to).toBe("2026-10-16T12:00:15.000Z");
    button(map.root, "Live").click();
    await flush();
    const frozen = (vi.mocked(activity).mock.calls[2][0] as Record<string, string>).to;
    vi.setSystemTime(new Date("2026-10-16T12:05:00Z"));
    map.update("repo-1", WORKSPACES, "balanced");
    await flush();
    expect(activity).toHaveBeenCalledTimes(3);
    expect(frozen).toBe(real.to.replace("Z", ".000Z"));
  });

  test("captured paths are drawn without control characters", async () => {
    const map = await open({ ...real, paths: [{ path: "evil‮/x\u0007.go", group: "", total: 1, heat: [[0, 1]] }], groups: [] });
    const text = map.root.querySelector(".map-chart")!.textContent!;
    expect(text).not.toMatch(/[‮\u0007]/);
    expect(map.root.querySelector(".map-hot-path")!.textContent).toBe("evil/x.go");
  });
});

test("axis ticks are local-time aligned and at least ~90px apart", () => {
  const from = Date.parse("2026-10-15T20:00:00Z");
  const ticks = axisTicks(from, from + 24 * 3600_000, 900);
  expect(ticks.length).toBeGreaterThan(2);
  expect(ticks.length).toBeLessThanOrEqual(10);
  for (const t of ticks) expect(new Date(t.at).getMinutes()).toBe(0);
  expect(axisTicks(from, from + 7 * 24 * 3600_000, 900).length).toBeLessThanOrEqual(10);
});
