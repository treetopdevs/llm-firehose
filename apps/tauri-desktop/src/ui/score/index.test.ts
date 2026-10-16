// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

const sessionEvents = vi.fn();
const errorSignatures = vi.fn();
vi.mock("../../api", () => ({
  sessionEvents: (id: string) => sessionEvents(id),
  errorSignatures: (id: string) => errorSignatures(id),
}));

import type { ErrorSignature, FirehoseEvent } from "../../api";
import { createScore } from "./index";
import { BUCKET_PX, buildScore, coalesce } from "./model";
import fixture from "./fixture.session.json";
import errsigFixture from "./fixture.errsig.json";

const HOUR = 3_600_000;

/** `n` events over `spanMs` on five tracks, every 50th an error; see model.test.ts. */
function bigSession(n: number, spanMs: number): FirehoseEvent[] {
  const cats = ["session", "prompt", "tool", "file", "shell"];
  const base = 1_800_000_000_000;
  return Array.from({ length: n }, (_, i) => {
    const category = cats[i % cats.length];
    const call = category === "tool" ? { call_id: `c${i >> 1}`, payload: { phase: i % 2 ? "end" : "start", tool_name: "Bash" } } : {};
    return {
      id: `e${i}`,
      time: new Date(base + Math.floor((i / n) * spanMs)).toISOString(),
      source: "codex",
      agent: "codex",
      category,
      session_id: "big",
      summary: `event ${i}`,
      severity: i % 50 === 0 ? "error" : undefined,
      ...call,
    } as FirehoseEvent;
  });
}

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

// A real codex session (fixture.errsig.json) in which the same `mix test`
// failure was captured twice, and what GET /errors?session= returns for it:
// counts are global, so the daemon has seen this signature three times across
// two sessions while this session holds two of them.
const MIX_SESSION = "019fd182-8513-7461-a816-e786f1fe439e";
const mixEvents = (errsigFixture as FirehoseEvent[]).filter((e) => e.session_id === MIX_SESSION);
const MIX_SIG: ErrorSignature = {
  key: "codex|shell|PostToolUse|failed: mix test",
  source: "codex",
  category: "shell",
  name: "PostToolUse",
  class: "failed: mix test",
  sample: "failed: mix test",
  count: 3,
  sessions: 2,
  first_time: "2026-07-30T06:32:13.793447Z",
  last_time: "2026-08-05T13:56:47.146775Z",
};

beforeEach(() => {
  sessionEvents.mockReset();
  sessionEvents.mockResolvedValue(session);
  errorSignatures.mockReset();
  errorSignatures.mockResolvedValue([]);
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
    // Marks sharing a pixel column are drawn once with a count; together they cover every event and call.
    const drawnTicks = coalesce(buildScore(session), { from: START, to: t(session[session.length - 1].time) }, 682);
    const tickCount = drawnTicks.reduce((n, tr) => n + tr.ticks.length, 0);
    const spanCount = drawnTicks.reduce((n, tr) => n + tr.spans.length, 0);
    expect(tickCount).toBeLessThan(101);
    expect(svg.querySelectorAll(".score-tick")).toHaveLength(tickCount);
    expect(svg.querySelectorAll(".score-span")).toHaveLength(spanCount);
    expect(svg.querySelectorAll(".score-span.open")).toHaveLength(1);
    expect([...svg.querySelectorAll(".score-tick title")].filter((n) => n.textContent?.startsWith("×")).length).toBeGreaterThan(0);
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
    // Only the window is drawn, but everything in it is: the overview still covers the whole session.
    expect(panel.root.querySelectorAll(".score-chart .score-tick").length).toBeLessThan(101);
    expect(panel.root.querySelectorAll(".score-overview .score-tick-mini").length).toBeGreaterThan(0);
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

  test("repeating errors are marked as a motif, highlighted as a group, and carry the daemon's signature", async () => {
    sessionEvents.mockResolvedValue(mixEvents);
    errorSignatures.mockResolvedValue([MIX_SIG]);
    const sigs: (ErrorSignature | undefined)[] = [];
    const panel = createScore((_ev, _sib, signature) => sigs.push(signature));
    await panel.open(MIX_SESSION);
    expect(errorSignatures).toHaveBeenCalledWith(MIX_SESSION);

    // Both ticks of the repeating signature share the motif marker, and the
    // in-session count reads apart from the coalescing ×N prefix.
    const motifs = [...panel.root.querySelectorAll(".score-chart .score-tick.error.motif")];
    expect(motifs).toHaveLength(2);
    for (const m of motifs) expect(m.querySelector("title")?.textContent).toContain("same error ×2 in this session");

    // Opening selected the first event: an error, so its daemon signature
    // (global count and sample) went to the detail, and its motif kin lit up.
    expect(sigs).toEqual([MIX_SIG]);
    expect(panel.root.querySelectorAll(".score-chart .score-tick.kin")).toHaveLength(2);

    // The group highlight survives a redraw, as .current does.
    button(panel.root, "zoom out").click();
    expect(panel.root.querySelectorAll(".score-chart .score-tick.kin").length).toBeGreaterThan(0);
  });

  test("the daemon's member ids drive grouping and detail lookup even when the mirror would key differently", async () => {
    const daemonSig: ErrorSignature = { ...MIX_SIG, key: "codex|shell|PostToolUse|rekeyed by the daemon", members: mixEvents.map((e) => e.id) };
    sessionEvents.mockResolvedValue(mixEvents);
    errorSignatures.mockResolvedValue([daemonSig]);
    const sigs: (ErrorSignature | undefined)[] = [];
    const panel = createScore((_ev, _sib, signature) => sigs.push(signature));
    await panel.open(MIX_SESSION);
    expect(panel.root.querySelectorAll(".score-tick.error.motif")).toHaveLength(2);
    expect(sigs).toEqual([daemonSig]);
    expect(panel.root.querySelectorAll(".score-chart .score-tick.kin")).toHaveLength(2);
  });

  test("an older daemon without GET /errors still groups motifs locally and costs the score nothing", async () => {
    sessionEvents.mockResolvedValue(mixEvents);
    errorSignatures.mockRejectedValue(new Error("GET /errors: 404"));
    const sigs: (ErrorSignature | undefined)[] = [];
    const panel = createScore((_ev, _sib, signature) => sigs.push(signature));
    await panel.open(MIX_SESSION);
    expect(panel.root.querySelectorAll(".score-tick.error.motif")).toHaveLength(2);
    expect(panel.root.querySelector("p.error")).toBeNull();
    expect(sigs).toEqual([undefined]);
  });

  test("a session without repeating errors draws no motif marks", async () => {
    const panel = createScore(() => {});
    await panel.open(SID);
    expect(panel.root.querySelectorAll(".score-tick.motif")).toHaveLength(0);
    expect(panel.root.querySelectorAll(".score-tick.kin")).toHaveLength(0);
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

  test("a 100k-event multi-week session draws a bounded number of nodes, keeps dated axis labels after zoom, and steps event by event", async () => {
    const big = bigSession(100_000, 1364 * HOUR);
    sessionEvents.mockResolvedValue(big);
    const selected: FirehoseEvent[] = [];
    const panel = createScore((ev) => selected.push(ev));
    const t0 = performance.now();
    await panel.open("big");
    const openMs = performance.now() - t0;
    const chart = panel.root.querySelector<SVGSVGElement>(".score-chart svg")!;
    const laneW = Number(chart.getAttribute("viewBox")!.split(" ")[2]) - 110 - 8;
    const columns = Math.ceil(laneW / BUCKET_PX) + 1;
    const tracks = chart.querySelectorAll(".score-track").length;
    expect(tracks).toBe(5);
    // Ticks: at most one per column per kind present (event, error); spans likewise bounded by columns.
    expect(chart.querySelectorAll(".score-tick").length).toBeLessThanOrEqual(columns * tracks * 2);
    expect(chart.querySelectorAll(".score-span").length).toBeLessThanOrEqual(columns * 2);
    expect(chart.querySelectorAll(".score-tick.error").length).toBeGreaterThan(0);
    expect(panel.root.querySelectorAll(".score-overview .score-tick-mini").length).toBeLessThanOrEqual(columns * tracks * 2);
    expect(panel.root.querySelector(".score-head")?.textContent).toContain("100000 events");

    const labels = () => [...panel.root.querySelectorAll(".score-axis text")].map((n) => n.textContent ?? "");
    expect(labels().length).toBeGreaterThanOrEqual(2);
    expect(labels().every((l) => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(l))).toBe(true);
    button(panel.root, "zoom in").click();
    expect(labels().length).toBeGreaterThanOrEqual(2);
    expect(new Set(labels()).size).toBe(labels().length);

    // Jumping steps through the full event list, one event at a time, even
    // though thousands share a pixel column; the merged tick is highlighted.
    button(panel.root, "jump to next event").click();
    button(panel.root, "jump to next event").click();
    expect(selected.map((e) => e.id)).toEqual(["e0", "e1", "e2"]);
    expect(panel.playhead()).toBe(t(big[2].time));
    const cur = panel.root.querySelector<SVGRectElement>(".score-chart .score-tick.current")!;
    expect(cur).not.toBeNull();
    expect(Math.abs(Number(cur.getAttribute("x")) - playheadX(panel.root))).toBeLessThan(3);
    expect(cur.querySelector("title")?.textContent).toMatch(/^×\d+ · /);
    // Clicking a merged tick selects its earliest event.
    cur.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selected[selected.length - 1].id).toBe("e2");

    // v1 took 27 s to first render on a session this size; happy-dom builds
    // nodes slowly and shares the CPU with other suites, so this is a loose
    // guard (model.test.ts holds the tight bound on the pure part).
    expect(openMs).toBeLessThan(2000);
  });
});
