// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessionEvents = vi.fn();
vi.mock("../../api", () => ({ sessionEvents: (id: string) => sessionEvents(id) }));

import type { FirehoseEvent } from "../../api";
import { createScore } from "./index";
import fixture from "./fixture.session.json";

const session = fixture as FirehoseEvent[];
const SID = session[0].session_id!;
const t = (iso: string) => Date.parse(iso);
const START = t("2026-10-15T19:32:30.960878Z");

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const b = [...root.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.getAttribute("aria-label") === label || x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  return b;
}

function playheadX(root: HTMLElement): number {
  return Number(root.querySelector(".score-playhead")!.getAttribute("x1"));
}

beforeEach(() => {
  sessionEvents.mockReset();
  sessionEvents.mockResolvedValue(session);
});

describe("session score view", () => {
  test("with no session open it says where to open one from", async () => {
    const panel = createScore(() => {});
    await panel.refresh();
    expect(panel.root.textContent).toContain("open a session");
    expect(panel.root.querySelector(".score-track")).toBeNull();
  });

  test("opening a session fetches it once and draws one keyboard-operable row per category present", async () => {
    const panel = createScore(() => {});
    await panel.open(SID);
    expect(sessionEvents).toHaveBeenCalledTimes(1);
    expect(sessionEvents).toHaveBeenCalledWith(SID);

    const svg = panel.root.querySelector<SVGSVGElement>(".score-chart svg")!;
    expect(svg.getAttribute("role")).toBe("group");
    const rows = [...svg.querySelectorAll<SVGGElement>(".score-track")];
    expect(rows.map((r) => r.querySelector(".score-label")?.textContent)).toEqual(["session", "prompt", "tool", "file", "shell"]);
    for (const r of rows) {
      expect(r.getAttribute("tabindex")).toBe("0");
      expect(r.getAttribute("role")).toBe("button");
    }
    expect(svg.querySelectorAll(".score-span")).toHaveLength(47);
    expect(svg.querySelectorAll(".score-span.open")).toHaveLength(1);
    expect(svg.querySelectorAll(".score-tick")).toHaveLength(101);
    expect(svg.querySelectorAll(".score-axis text").length).toBeGreaterThan(0);
    expect(panel.root.querySelector(".score-head")?.textContent).toContain(SID);
    expect(panel.root.querySelector(".score-head")?.textContent).toContain("101 events");
    // The whole session is on the overview strip with the viewport over all of it.
    const overview = panel.root.querySelector<SVGSVGElement>(".score-overview svg")!;
    expect(overview.querySelectorAll(".score-track-mini")).toHaveLength(5);
    expect(overview.querySelector(".score-view")).not.toBeNull();
  });

  test("a failed fetch is shown, not thrown", async () => {
    sessionEvents.mockRejectedValue(new Error("daemon away"));
    const panel = createScore(() => {});
    await panel.open(SID);
    expect(panel.root.querySelector(".error")?.textContent).toContain("daemon away");
  });

  test("jump-to-next moves the playhead event by event and drives the detail with session siblings", async () => {
    const selected: FirehoseEvent[] = [];
    let siblings: ((ev: FirehoseEvent) => readonly FirehoseEvent[]) | undefined;
    const panel = createScore((ev, sib) => {
      selected.push(ev);
      siblings = sib;
    });
    await panel.open(SID);
    expect(panel.playhead()).toBe(START);
    expect(selected.map((e) => e.id)).toEqual([session[0].id]);

    const x0 = playheadX(panel.root);
    button(panel.root, "jump to next event").click();
    expect(panel.playhead()).toBe(t(session[1].time));
    expect(selected.map((e) => e.id)).toEqual([session[0].id, session[1].id]);
    expect(playheadX(panel.root)).toBeGreaterThan(x0);
    expect(panel.root.querySelector(`.score-tick.current`)?.getAttribute("data-id")).toBe(session[1].id);

    // The pairing the detail sees is this session's history, not the live buffer.
    const start = session.find((e) => e.call_id && e.payload?.phase === "start")!;
    expect(siblings!(start).map((e) => e.id).sort()).toEqual(session.filter((e) => e.call_id === start.call_id).map((e) => e.id).sort());

    panel.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(panel.playhead()).toBe(t(session[2].time));
    panel.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(panel.playhead()).toBe(t(session[1].time));
  });

  test("play advances at the chosen speed through real gaps, selects only on change, and stops at the end", async () => {
    const onSelect = vi.fn();
    const panel = createScore(onSelect);
    await panel.open(SID);
    const play = button(panel.root, "play");
    expect(play.getAttribute("aria-pressed")).toBe("false");
    play.click();
    expect(play.getAttribute("aria-pressed")).toBe("true");

    panel.tick(1000);
    expect(panel.playhead()).toBe(START + 1000);
    // Still inside the first event's reign: no new selection.
    expect(onSelect).toHaveBeenCalledTimes(1);
    panel.tick(1000);
    expect(panel.playhead()).toBe(START + 2000);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[1][0].id).toBe(session[1].id);

    const speed = panel.root.querySelector<HTMLSelectElement>("select[aria-label='speed']")!;
    expect([...speed.options].map((o) => o.value)).toEqual(["1", "2", "5", "10", "30", "60"]);
    speed.value = "60";
    speed.dispatchEvent(new Event("change"));
    panel.tick(1000);
    expect(panel.playhead()).toBe(START + 62_000);

    // The 2m28s gap after the first Stop is replayed as time, never skipped.
    panel.tick(1000);
    expect(panel.playhead()).toBe(START + 122_000);
    const names = onSelect.mock.calls.map((c) => c[0].name);
    expect(names[names.length - 1]).toBe("Stop");

    panel.tick(60 * 60_000);
    expect(panel.playhead()).toBe(t(session[session.length - 1].time));
    expect(play.getAttribute("aria-pressed")).toBe("false");
    // Space toggles play from the keyboard.
    panel.root.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(play.getAttribute("aria-pressed")).toBe("true");
    expect(panel.playhead()).toBe(START);
  });

  test("Enter on a track row steps to that category's next event", async () => {
    const panel = createScore(() => {});
    await panel.open(SID);
    const file = panel.root.querySelector<SVGGElement>('.score-track[data-key="file"]')!;
    file.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(panel.playhead()).toBe(t(session.find((e) => e.category === "file")!.time));
  });

  test("clicking a tick puts the playhead on that event and names it", async () => {
    const onSelect = vi.fn();
    const panel = createScore(onSelect);
    await panel.open(SID);
    const edit = session.find((e) => e.name === "PreToolUse:Edit")!;
    const tick = panel.root.querySelector<SVGElement>(`.score-tick[data-id="${edit.id}"]`)!;
    expect(tick.querySelector("title")?.textContent).toContain("will run Edit on app.config.js");
    tick.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel.playhead()).toBe(t(edit.time));
    expect(onSelect.mock.calls[onSelect.mock.calls.length - 1][0].id).toBe(edit.id);
    expect(tick.classList.contains("current")).toBe(true);
  });

  test("zoom narrows the window around the playhead; the overview viewport shrinks and fit restores it", async () => {
    const panel = createScore(() => {});
    await panel.open(SID);
    const viewW = () => Number(panel.root.querySelector(".score-overview .score-view")!.getAttribute("width"));
    const whole = viewW();
    button(panel.root, "zoom in").click();
    expect(viewW()).toBeCloseTo(whole / 2, 3);
    button(panel.root, "zoom in").click();
    expect(viewW()).toBeCloseTo(whole / 4, 3);
    // The score stays fully drawn: every event is still in the DOM, zoomed or not.
    expect(panel.root.querySelectorAll(".score-chart .score-tick")).toHaveLength(101);
    button(panel.root, "zoom out").click();
    expect(viewW()).toBeCloseTo(whole / 2, 3);
    button(panel.root, "fit").click();
    expect(viewW()).toBe(whole);
  });

  test("when the playhead leaves a zoomed window the whole score follows it", async () => {
    const panel = createScore(() => {});
    await panel.open(SID);
    const viewRect = () => panel.root.querySelector(".score-overview .score-view")!;
    const chartW = Number(panel.root.querySelector<SVGSVGElement>(".score-chart svg")!.getAttribute("viewBox")!.split(" ")[2]);
    button(panel.root, "zoom in").click();
    button(panel.root, "zoom in").click();
    button(panel.root, "zoom in").click();
    const x0 = Number(viewRect().getAttribute("x"));
    const w0 = Number(viewRect().getAttribute("width"));
    // Jump past the window's right edge: the window pans, and the marks are
    // redrawn for it, so the current tick is inside the chart, not off-canvas.
    for (let i = 0; i < 60; i++) button(panel.root, "jump to next event").click();
    expect(Number(viewRect().getAttribute("x"))).toBeGreaterThan(x0);
    expect(Number(viewRect().getAttribute("width"))).toBeCloseTo(w0, 3);
    const cur = panel.root.querySelector<SVGRectElement>(".score-chart .score-tick.current")!;
    const cx = Number(cur.getAttribute("x"));
    expect(cx).toBeGreaterThanOrEqual(110);
    expect(cx).toBeLessThanOrEqual(chartW);
    expect(Math.abs(playheadX(panel.root) - cx)).toBeLessThan(2);
  });

  test("minimal privacy mode renders tracks with digested labels", async () => {
    const digest = { sha256: "ab12cd34".padEnd(64, "0"), len: 4 };
    sessionEvents.mockResolvedValue(
      session.slice(0, 8).map((e) => ({
        ...e,
        summary: e.summary,
        payload: e.payload ? Object.fromEntries(Object.keys(e.payload).map((k) => [k, k === "phase" ? e.payload![k] : digest])) : undefined,
      })),
    );
    const panel = createScore(() => {});
    await panel.open(SID);
    expect(panel.root.querySelectorAll(".score-track").length).toBeGreaterThan(0);
    const titles = [...panel.root.querySelectorAll(".score-span title")].map((n) => n.textContent);
    expect(titles.every((x) => x?.includes("#ab12cd34"))).toBe(true);
  });

  test("control characters in event text never reach the SVG", async () => {
    sessionEvents.mockResolvedValue([{ ...session[0], summary: "bad\u001b[2Jtext‮" }]);
    const panel = createScore(() => {});
    await panel.open(SID);
    const text = panel.root.querySelector(".score-chart svg")!.textContent ?? "";
    expect(text).toContain("bad[2Jtext");
    expect(text).not.toMatch(/[\u0000-\u001f\u202e]/);
  });

  test("opening another session while one loads keeps only the latest", async () => {
    let finish!: (events: FirehoseEvent[]) => void;
    sessionEvents.mockImplementationOnce(() => new Promise<FirehoseEvent[]>((resolve) => (finish = resolve)));
    sessionEvents.mockResolvedValueOnce(session.slice(0, 3));
    const panel = createScore(() => {});
    const stale = panel.open("old");
    await panel.open(SID);
    finish(session);
    await stale;
    expect(panel.root.querySelectorAll(".score-tick")).toHaveLength(3);
  });
});
