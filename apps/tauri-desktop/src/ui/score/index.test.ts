// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const sessionEvents = vi.fn();
const errorSignatures = vi.fn();
const capturedEvent = vi.fn();
vi.mock("../../api", () => ({
  sessionEvents: (id: string, view?: string) => sessionEvents(id, view),
  capturedEvent: (id: string, signal?: AbortSignal) => capturedEvent(id, signal),
  errorSignatures: (id: string, signal?: AbortSignal) => errorSignatures(id, signal),
}));

import type { ErrorSignature, FirehoseEvent } from "../../api";
import { SIGNATURES_TIMEOUT_MS, createScore } from "./index";
import { createScope } from "../../scope";
import { BUCKET_PX, buildScore, coalesce, timelineProjection } from "./model";
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
  // The lazy full-detail fetch is outside most tests' scope: it fails quietly unless a test opts in.
  capturedEvent.mockReset();
  capturedEvent.mockRejectedValue(new Error("GET /attention/event: 404"));
});

// A score is attached while it is the shown view, as main.ts does; detached tests remove it.
afterEach(() => document.body.replaceChildren());

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
    expect(sessionEvents).toHaveBeenCalledWith(SID, "timeline");

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
    document.body.append(panel.root); // the shown view renders the detail pane
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
    document.body.append(panel.root); // the shown view renders the detail pane
    await panel.open(SID);
    const play = button(panel.root, "play");
    expect(play.getAttribute("aria-pressed")).toBe("false");
    play.click();
    expect(play.getAttribute("aria-pressed")).toBe("true");
    // These are full envelopes (an older daemon's response): pressing play re-renders the first event projected.
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls[1][0]).toEqual(timelineProjection(session[0]));

    panel.tick(1000);
    expect(panel.playhead()).toBe(START + 1000);
    // Still inside the first event's reign: no new selection.
    expect(onSelect).toHaveBeenCalledTimes(2);
    panel.tick(1000);
    expect(panel.playhead()).toBe(START + 2000);
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect.mock.calls[2][0].id).toBe(session[1].id);

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
    document.body.append(panel.root); // only the shown score re-renders the pane
    await panel.open(MIX_SESSION);
    expect(errorSignatures).toHaveBeenCalledWith(MIX_SESSION, expect.any(AbortSignal));

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
    document.body.append(panel.root); // only the shown score re-renders the pane
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
    document.body.append(panel.root); // only the shown score re-renders the pane
    await panel.open(MIX_SESSION);
    expect(panel.root.querySelectorAll(".score-tick.error.motif")).toHaveLength(2);
    expect(panel.root.querySelector("p.error")).toBeNull();
    expect(sigs).toEqual([undefined]);
  });

  test("a hung GET /errors cannot keep the score loading: it is aborted after the timeout and the mirror takes over", async () => {
    vi.useFakeTimers();
    try {
      sessionEvents.mockResolvedValue(mixEvents);
      // Never resolves on its own; only the caller's abort can settle it.
      errorSignatures.mockImplementation(
        (_id: string, signal?: AbortSignal) =>
          new Promise<ErrorSignature[]>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      );
      const sigs: (ErrorSignature | undefined)[] = [];
      const panel = createScore((_ev, _sib, signature) => sigs.push(signature));
      document.body.append(panel.root); // the shown view renders the detail pane
      const opening = panel.open(MIX_SESSION);
      await vi.advanceTimersByTimeAsync(SIGNATURES_TIMEOUT_MS + 1);
      await opening;
      expect(panel.root.querySelectorAll(".score-tick.error.motif")).toHaveLength(2);
      expect(panel.root.querySelector("p.error")).toBeNull();
      expect(sigs).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a slow or hung GET /errors never blocks the score; signatures enrich the detail when they land", async () => {
    sessionEvents.mockResolvedValue(mixEvents);
    let finish!: (sigs: ErrorSignature[]) => void;
    errorSignatures.mockImplementation(() => new Promise<ErrorSignature[]>((resolve) => (finish = resolve)));
    const sigs: (ErrorSignature | undefined)[] = [];
    const panel = createScore((_ev, _sib, signature) => sigs.push(signature));
    document.body.append(panel.root); // only the shown score re-renders the pane
    await panel.open(MIX_SESSION);

    // The score is fully drawn and the first event selected while /errors is still pending.
    expect(panel.root.querySelectorAll(".score-chart .score-tick.error.motif")).toHaveLength(2);
    expect(sigs).toEqual([undefined]);

    finish([MIX_SIG]);
    await Promise.resolve();
    // The current event is an error, so its detail is refreshed with the signature.
    expect(sigs).toEqual([undefined, MIX_SIG]);
  });

  test("late signatures do not reopen a dismissed detail pane", async () => {
    sessionEvents.mockResolvedValue(mixEvents);
    let finish!: (sigs: ErrorSignature[]) => void;
    errorSignatures.mockImplementation(() => new Promise<ErrorSignature[]>((resolve) => (finish = resolve)));
    const sigs: (ErrorSignature | undefined)[] = [];
    let dismiss!: () => void;
    const panel = createScore((_ev, _sib, signature, d) => {
      sigs.push(signature);
      dismiss = d;
    });
    document.body.append(panel.root);
    await panel.open(MIX_SESSION);
    expect(sigs).toEqual([undefined]); // the current event is an error
    dismiss(); // the pane's close button
    finish([MIX_SIG]);
    await Promise.resolve();
    expect(sigs).toEqual([undefined]);
  });

  test("late-arriving member ids rebuild the grouping in place", async () => {
    sessionEvents.mockResolvedValue(mixEvents);
    let finish!: (sigs: ErrorSignature[]) => void;
    errorSignatures.mockImplementation(() => new Promise<ErrorSignature[]>((resolve) => (finish = resolve)));
    const sigs: (ErrorSignature | undefined)[] = [];
    const panel = createScore((_ev, _sib, signature) => sigs.push(signature));
    document.body.append(panel.root); // only the shown score re-renders the pane
    await panel.open(MIX_SESSION);
    // The mirror grouped the pair as a motif while /errors was pending.
    expect(panel.root.querySelectorAll(".score-tick.error.motif")).toHaveLength(2);

    // The daemon's member ids split the pair into two signatures: the score
    // is rebuilt on their authority, and the motif dissolves.
    const a: ErrorSignature = { ...MIX_SIG, key: "codex|shell|PostToolUse|a", members: [mixEvents[0].id] };
    const b: ErrorSignature = { ...MIX_SIG, key: "codex|shell|PostToolUse|b", members: [mixEvents[1].id] };
    finish([a, b]);
    await Promise.resolve();
    expect(panel.root.querySelectorAll(".score-tick.error.motif")).toHaveLength(0);
    expect(panel.root.querySelectorAll(".score-tick.error")).toHaveLength(2);
    // The current event is an error; its refreshed detail carries its own signature.
    expect(sigs[sigs.length - 1]).toEqual(a);
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
    document.body.append(panel.root); // the shown view renders the detail pane
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

// The Score opens sessions with ?view=timeline: projected events first, full
// envelopes fetched lazily for the detail pane.
describe("session score timeline view", () => {
  const projected = session.map(timelineProjection);
  const realCaptured = async (id: string) => {
    const full = session.find((e) => e.id === id);
    if (!full) throw new Error(`no event ${id}`);
    return full;
  };
  beforeEach(() => {
    capturedEvent.mockImplementation(realCaptured);
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  type Call = [FirehoseEvent, ReturnType<typeof siblingsOf>, ErrorSignature | undefined, () => void];
  const siblingsOf = (fn: (ev: FirehoseEvent) => readonly FirehoseEvent[]) => fn;
  /** A paired call in the fixture: the end event, whose start event is its call sibling. */
  const pair = session.find((e) => e.call_id && e.payload?.phase === "end")!;
  const pairStart = session.find((e) => e.call_id === pair.call_id && e.id !== pair.id)!;

  function recorder() {
    const calls: Call[] = [];
    let cur: string | undefined;
    const panel = createScore((ev, sib, sig, dismiss) => {
      cur = ev.id;
      calls.push([ev, sib, sig, dismiss]);
    });
    document.body.append(panel.root);
    return { panel, calls, last: () => calls[calls.length - 1], cur: () => cur };
  }
  /** Steps the cursor event by event until `id` is current; ticks are coalesced per pixel, so not every id is clickable. */
  function goTo(panel: ReturnType<typeof createScore>, id: string, current: () => string | undefined) {
    const back = button(panel.root, "jump to previous event");
    const fwd = button(panel.root, "jump to next event");
    const want = session.findIndex((e) => e.id === id);
    for (let i = 0; i < session.length + 2 && current() !== id; i++) {
      (want < session.findIndex((e) => e.id === current()) ? back : fwd).click();
    }
    if (current() !== id) throw new Error(`could not reach ${id}`);
  }

  /** Gets to the event before `target`, lets its fetches settle, then takes the single explicit step onto `target`. */
  async function arriveAt(panel: ReturnType<typeof createScore>, target: FirehoseEvent, cur: () => string | undefined, calls: unknown[], after: (id: string) => Promise<FirehoseEvent> = realCaptured) {
    // Fetches for the steps on the way hang, so the target's siblings are not cached when it is reached.
    capturedEvent.mockImplementation(() => new Promise<FirehoseEvent>(() => {}));
    goTo(panel, session[session.findIndex((e) => e.id === target.id) - 1].id, cur);
    capturedEvent.mockImplementation(after);
    await flush();
    calls.length = 0;
    capturedEvent.mockClear();
    button(panel.root, "jump to next event").click();
    if (cur() !== target.id) throw new Error("next step did not land on the target");
  }

  test("the projected fixture is a strict subset of the full one and keeps what the score reads", () => {
    expect(projected).toHaveLength(session.length);
    for (const [i, p] of projected.entries()) {
      const full = session[i] as Record<string, unknown>;
      for (const [k, v] of Object.entries(p)) if (k !== "payload") expect(v).toEqual(full[k]);
      expect(p.id).toBe(session[i].id);
    }
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(session).length);
  });

  test("buildScore over the projected fixture equals buildScore over the full one, motifs included", () => {
    // Everything but the embedded event objects, which differ by design.
    const shape = (s: ReturnType<typeof buildScore>) => ({ ...s, events: s.events.map((e) => ({ at: e.at, id: e.event.id })) });
    expect(shape(buildScore(projected))).toEqual(shape(buildScore(session)));
    const errs = errsigFixture as FirehoseEvent[];
    const a = buildScore(errs.map(timelineProjection));
    const b = buildScore(errs);
    expect(shape(a)).toEqual(shape(b));
    expect(b.motifs.size).toBeGreaterThan(0);
    expect(a.motifs).toEqual(b.motifs);
  });

  test("a full-envelope (old daemon) response through the timeline path draws the same score", async () => {
    sessionEvents.mockResolvedValue(projected);
    const a = createScore(() => {});
    await a.open(SID);
    sessionEvents.mockResolvedValue(session);
    const b = createScore(() => {});
    await b.open(SID);
    const marks = (p: ReturnType<typeof createScore>) => [...p.root.querySelectorAll(".score-tick, .score-span")].map((n) => n.outerHTML);
    expect(marks(a)).toEqual(marks(b));
    expect(a.root.querySelector(".score-head")?.textContent).toBe(b.root.querySelector(".score-head")?.textContent);
  });

  test("highlight renders at once from projected fields, then re-renders with the fetched full event and siblings", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    await arriveAt(panel, pair, cur, calls);
    // Synchronous: the pane is never empty, and shows only projected fields.
    expect(calls).toHaveLength(1);
    expect(last()[0]).toEqual(timelineProjection(pair));
    expect(last()[1](last()[0]).map((e) => e.id)).toContain(pairStart.id);
    expect(last()[1](last()[0]).every((e) => JSON.stringify(e) === JSON.stringify(timelineProjection(e as FirehoseEvent)))).toBe(true);
    await flush();
    expect(capturedEvent).toHaveBeenCalledWith(pair.id, expect.any(AbortSignal));
    expect(capturedEvent).toHaveBeenCalledWith(pairStart.id, expect.any(AbortSignal));
    expect(calls).toHaveLength(2);
    expect(last()[0]).toEqual(pair);
    const sibs = last()[1](last()[0]);
    expect(sibs).toContainEqual(pairStart);
    // Cached for the open session: highlighting it again fetches nothing.
    capturedEvent.mockClear();
    goTo(panel, pairStart.id, cur);
    goTo(panel, pair.id, cur);
    await flush();
    expect(capturedEvent).not.toHaveBeenCalled();
    expect(last()[0]).toEqual(pair);
  });

  test("a highlight change before the fetch lands discards the stale result", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    let release!: (e: FirehoseEvent) => void;
    capturedEvent.mockImplementationOnce(() => new Promise<FirehoseEvent>((r) => (release = r)));
    const other = session.find((e) => !e.call_id && e.id !== pair.id && e.category === "prompt")!;
    calls.length = 0;
    goTo(panel, pair.id, cur);
    goTo(panel, other.id, cur);
    await flush();
    const before = calls.length;
    release(pair);
    await flush();
    expect(calls).toHaveLength(before);
    expect(last()[0].id).toBe(other.id);
  });

  test("the previous in-flight group is aborted when another starts", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, cur } = recorder();
    await panel.open(SID);
    await flush();
    const signals: AbortSignal[] = [];
    capturedEvent.mockImplementation((_id: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<FirehoseEvent>(() => {});
    });
    goTo(panel, pair.id, cur);
    goTo(panel, session.find((e) => e.category === "prompt")!.id, cur);
    expect(signals[0].aborted).toBe(true);
    expect(signals[signals.length - 1].aborted).toBe(false);
  });

  test("no capturedEvent request is made during play; one is made when playback stops on the event", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    capturedEvent.mockClear();
    button(panel.root, "play").click();
    document.body.append(panel.root); // a detached score pauses itself on the next frame
    const started = cur();
    const speed = panel.root.querySelector<HTMLSelectElement>("select")!;
    speed.value = speed.options[speed.options.length - 1].value;
    speed.dispatchEvent(new Event("change"));
    for (let i = 0; i < 3; i++) panel.tick(100);
    await flush();
    expect(cur()).not.toBe(started); // the cursor really moved while playing
    expect(capturedEvent).not.toHaveBeenCalled();
    const n = calls.length;
    button(panel.root, "play").click(); // pauses
    await flush();
    expect(capturedEvent).toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(n);
    expect(capturedEvent.mock.calls[0][0]).toBe(last()[0].id);
    panel.root.remove();
  });

  test("a failed fetch leaves the projected rendering standing", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    await arriveAt(panel, pair, cur, calls, () => Promise.reject(new Error("500")));
    await flush();
    expect(capturedEvent).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(last()[0]).toEqual(timelineProjection(pair));
    expect(panel.root.querySelector(".score-tick.current")).not.toBeNull();
  });

  test("starting playback aborts the in-flight detail fetch and restarting from the end fetches nothing", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, cur } = recorder();
    await panel.open(SID);
    await flush();
    let pending: AbortSignal | undefined;
    capturedEvent.mockImplementation((_id: string, signal?: AbortSignal) => {
      pending = signal;
      return new Promise<FirehoseEvent>(() => {});
    });
    button(panel.root, "jump to next event").click(); // explicit step: a fetch group starts and hangs
    expect(pending?.aborted).toBe(false);
    document.body.append(panel.root);
    button(panel.root, "play").click();
    expect(pending?.aborted).toBe(true);
    // Run to the end, then press play again: the restart rewinds to the start without a fetch in flight.
    const speed = panel.root.querySelector<HTMLSelectElement>("select")!;
    speed.value = speed.options[speed.options.length - 1].value;
    speed.dispatchEvent(new Event("change"));
    for (let i = 0; i < 20000 && cur() !== session[session.length - 1].id; i++) panel.tick(1000);
    button(panel.root, "play").click(); // pauses at the end: fetches the event under the cursor
    await flush();
    capturedEvent.mockClear();
    button(panel.root, "play").click(); // restart from the end rewinds and plays
    await flush();
    expect(capturedEvent).not.toHaveBeenCalled();
    button(panel.root, "play").click();
    panel.root.remove();
  });

  test("a detached score pausing itself neither fetches nor writes the detail pane", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls } = recorder();
    await panel.open(SID);
    await flush();
    capturedEvent.mockClear();
    panel.root.remove();
    button(panel.root, "play").click(); // detached: the next frame pauses it
    const n = calls.length;
    panel.tick(100);
    await flush();
    expect(button(panel.root, "play").getAttribute("aria-pressed")).toBe("false");
    expect(capturedEvent).not.toHaveBeenCalled();
    expect(calls).toHaveLength(n);
  });

  test("open() while playing does not fetch the previous session's current event", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, cur } = recorder();
    await panel.open(SID);
    await flush();
    document.body.append(panel.root);
    button(panel.root, "play").click();
    const speed = panel.root.querySelector<HTMLSelectElement>("select")!;
    speed.value = speed.options[speed.options.length - 1].value;
    speed.dispatchEvent(new Event("change"));
    for (let i = 0; i < 3; i++) panel.tick(100);
    const old = cur()!;
    expect(old).not.toBe(session[0].id); // the cursor moved off the first event
    capturedEvent.mockClear();
    const reopened = panel.open(SID);
    expect(capturedEvent).not.toHaveBeenCalled(); // pausing for open() fetched nothing
    await reopened;
    await flush();
    // The reload's own highlight of the first event may fetch; the old session's current event never does.
    for (const [id] of capturedEvent.mock.calls) expect(id).not.toBe(old);
    panel.root.remove();
  });

  test("open() clears the full-event cache", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, cur } = recorder();
    await panel.open(SID);
    await flush();
    goTo(panel, pair.id, cur);
    await flush();
    capturedEvent.mockClear();
    await panel.open(SID);
    await flush();
    goTo(panel, pair.id, cur);
    await flush();
    expect(capturedEvent).toHaveBeenCalledWith(pair.id, expect.any(AbortSignal));
  });

  /** Arrives at `pair` while paused with its fetch held open; resolves it on demand. */
  async function heldAtPair() {
    sessionEvents.mockResolvedValue(projected);
    const rec = recorder();
    await rec.panel.open(SID);
    await flush();
    const releases: (() => void)[] = [];
    await arriveAt(rec.panel, pair, rec.cur, rec.calls, (id) => new Promise<FirehoseEvent>((r) => releases.push(() => r(session.find((e) => e.id === id)!))));
    expect(capturedEvent).toHaveBeenCalled();
    expect(rec.calls).toHaveLength(1);
    return { ...rec, release: async () => { releases.forEach((r) => r()); await flush(); } };
  }

  test("closing the detail pane drops a late full-detail result instead of reopening it", async () => {
    const { calls, last, release } = await heldAtPair();
    const signal = capturedEvent.mock.calls[0][1] as AbortSignal;
    last()[3](); // the pane's close button
    expect(signal.aborted).toBe(true);
    await release();
    expect(calls).toHaveLength(1);
  });

  test("leaving the score drops a late full-detail result, so another view's selection stands", async () => {
    const { panel, calls, release } = await heldAtPair();
    panel.root.remove(); // main.ts show("live"): the score root leaves the document
    await release();
    expect(calls).toHaveLength(1);
  });

  test("leaving and coming back before the result lands still drops it", async () => {
    const { panel, calls, release } = await heldAtPair();
    const signal = capturedEvent.mock.calls[0][1] as AbortSignal;
    panel.root.remove();
    document.body.append(panel.root); // show("score") again
    await panel.refresh();
    expect(signal.aborted).toBe(true);
    await release();
    expect(calls).toHaveLength(1);
  });

  test("an explicit step during playback renders projected fields and fetches nothing", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last } = recorder();
    await panel.open(SID);
    await flush();
    capturedEvent.mockClear();
    button(panel.root, "play").click();
    calls.length = 0;
    button(panel.root, "jump to next event").click();
    await flush();
    expect(button(panel.root, "play").getAttribute("aria-pressed")).toBe("true");
    expect(capturedEvent).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(last()[0]).toEqual(timelineProjection(last()[0]));
    button(panel.root, "play").click();
  });

  test("revisiting a cached event during playback renders projected fields; pausing on it renders the cached full event", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    goTo(panel, pair.id, cur);
    await flush();
    expect(last()[0]).toEqual(pair); // cached now
    goTo(panel, pairStart.id, cur);
    await flush();
    button(panel.root, "play").click();
    capturedEvent.mockClear();
    calls.length = 0;
    goTo(panel, pair.id, cur);
    expect(last()[0]).toEqual(timelineProjection(pair));
    expect(last()[1](last()[0]).every((e) => JSON.stringify(e) === JSON.stringify(timelineProjection(e as FirehoseEvent)))).toBe(true);
    calls.length = 0;
    button(panel.root, "play").click(); // pause on the cached event
    await flush();
    expect(capturedEvent).not.toHaveBeenCalled();
    expect(last()[0]).toEqual(pair);
    expect(last()[1](last()[0])).toContainEqual(pairStart);
  });

  test("pressing play on a fully detailed event re-renders it with projected fields", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    goTo(panel, pair.id, cur);
    await flush();
    expect(last()[0]).toEqual(pair);
    calls.length = 0;
    button(panel.root, "play").click();
    expect(calls).toHaveLength(1);
    expect(last()[0]).toEqual(timelineProjection(pair));
    expect(last()[1](last()[0]).every((e) => JSON.stringify(e) === JSON.stringify(timelineProjection(e as FirehoseEvent)))).toBe(true);
    button(panel.root, "play").click();
  });

  test("an older daemon's full envelopes are rendered projected during playback", async () => {
    sessionEvents.mockResolvedValue(session); // ignores view=timeline
    const { panel, calls, last } = recorder();
    await panel.open(SID);
    await flush();
    button(panel.root, "play").click();
    calls.length = 0;
    button(panel.root, "jump to next event").click();
    expect(calls).toHaveLength(1);
    expect(last()[0]).toEqual(timelineProjection(last()[0]));
    expect(last()[1](last()[0]).every((e) => JSON.stringify(e) === JSON.stringify(timelineProjection(e as FirehoseEvent)))).toBe(true);
    // Paused on it, it is full again; pressing play drops it back to projected.
    button(panel.root, "play").click();
    expect(last()[0]).not.toEqual(timelineProjection(last()[0]));
    calls.length = 0;
    button(panel.root, "play").click();
    expect(calls).toHaveLength(1);
    expect(last()[0]).toEqual(timelineProjection(last()[0]));
    button(panel.root, "play").click();
  });

  test("a session load that lands after leaving the score neither renders nor fetches", async () => {
    let land!: (evs: FirehoseEvent[]) => void;
    sessionEvents.mockImplementation(() => new Promise<FirehoseEvent[]>((r) => (land = r)));
    const { panel, calls } = recorder();
    const opening = panel.open(SID);
    panel.root.remove(); // show("live") while loading
    capturedEvent.mockClear();
    land(projected);
    await opening;
    await flush();
    expect(calls).toHaveLength(0);
    expect(capturedEvent).not.toHaveBeenCalled();
    expect(panel.root.querySelector(".score-tick")).not.toBeNull(); // still drawn for when it is shown again
  });

  test("after the pane is closed during playback, the frame loop's moves leave it closed; an explicit step reopens it", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last, cur } = recorder();
    await panel.open(SID);
    await flush();
    button(panel.root, "play").click();
    last()[3](); // close the pane
    calls.length = 0;
    const started = cur();
    const speed = panel.root.querySelector<HTMLSelectElement>("select")!;
    speed.value = speed.options[speed.options.length - 1].value;
    speed.dispatchEvent(new Event("change"));
    for (let i = 0; i < 3; i++) panel.tick(100);
    expect(panel.root.querySelector(".score-tick.current")?.getAttribute("data-id")).not.toBe(started); // the cursor moved
    expect(calls).toHaveLength(0);
    button(panel.root, "play").click(); // pausing on a closed pane stays closed
    await flush();
    expect(calls).toHaveLength(0);
    // Clicking the event playback marked, which is already current, reopens the pane.
    // A click on empty track space at the playhead lands on that same event.
    const markedAt = panel.playhead();
    const chart = panel.root.querySelector<SVGSVGElement>(".score-chart svg")!;
    chart.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: playheadX(panel.root) }));
    expect(panel.playhead()).toBeCloseTo(markedAt, -3);
    expect(calls).toHaveLength(1);
    expect(t(last()[0].time)).toBeLessThanOrEqual(panel.playhead());
    last()[3](); // close again
    calls.length = 0;
    button(panel.root, "jump to next event").click();
    expect(calls).toHaveLength(1);
  });

  test("closing the pane while a session loads keeps it closed when the load lands", async () => {
    sessionEvents.mockResolvedValue(projected);
    const { panel, calls, last } = recorder();
    await panel.open(SID);
    await flush();
    let land!: (evs: FirehoseEvent[]) => void;
    sessionEvents.mockImplementation(() => new Promise<FirehoseEvent[]>((r) => (land = r)));
    const opening = panel.open(SID);
    last()[3](); // close the pane while loading
    calls.length = 0;
    capturedEvent.mockClear();
    land(projected);
    await opening;
    await flush();
    expect(calls).toHaveLength(0);
    expect(capturedEvent).not.toHaveBeenCalled();
  });
});

describe("score scope integration", () => {
  const defer = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const win = (st: ReturnType<typeof createScope>) => st.get().window;

  test("a successful open leaves the window live; zoom and fit publish the drawn view", async () => {
    const store = createScope();
    store.narrow({ session: { id: SID, source: "claude-code" } });
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    await panel.open(SID, "claude-code");
    const all = buildScore(session);
    expect(win(store)).toBe("live"); // a load never publishes
    button(panel.root, "zoom in").click();
    const w = win(store) as { from: number; to: number };
    expect(w.to - w.from).toBeLessThan(all.end - all.start);
    button(panel.root, "fit").click();
    expect(win(store)).toBe("live"); // the whole session is published as 'live', not as bounds
  });

  test("F2: different source in flight is not deduped, the first result is discarded, only the second publishes", async () => {
    const a = defer<FirehoseEvent[]>(), b = defer<FirehoseEvent[]>();
    sessionEvents.mockReset();
    sessionEvents.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const store = createScope();
    store.narrow({ session: { id: SID, source: "opencode" } });
    const panel = createScore(() => {}, store);
    const p1 = panel.open(SID, "codex");
    const p2 = panel.open(SID, "opencode");
    expect(sessionEvents).toHaveBeenCalledTimes(2);
    a.resolve(session); await p1;
    expect(panel.loadedSession()).toBeNull();
    expect(win(store)).toBe("live");
    b.resolve(session.map((e) => ({ ...e, source: "opencode" }))); await p2;
    expect(panel.loadedSession()).toEqual({ id: SID, source: "opencode" });
    expect(win(store)).toBe("live"); // loads no longer publish
  });

  test("undefined source and explicit source are different keys; the same key in flight dedups; retry after failure refetches", async () => {
    const a = defer<FirehoseEvent[]>();
    sessionEvents.mockReset();
    sessionEvents.mockReturnValueOnce(a.promise).mockResolvedValue(session);
    const panel = createScore(() => {}, createScope());
    const p1 = panel.open(SID);
    const p1b = panel.open(SID);
    expect(sessionEvents).toHaveBeenCalledTimes(1);
    void panel.open(SID, "codex");
    expect(sessionEvents).toHaveBeenCalledTimes(2);
    a.resolve(session); await Promise.all([p1, p1b]);

    sessionEvents.mockReset();
    sessionEvents.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(session);
    const store = createScope();
    const panel2 = createScore(() => {}, store);
    store.narrow({ session: { id: SID } });
    await panel2.open(SID);
    expect(panel2.loadedSession()).toBeNull();
    expect(store.get().window).toBe("live");
    await panel2.open(SID);
    expect(sessionEvents).toHaveBeenCalledTimes(2);
    expect(panel2.loadedSession()).toEqual({ id: SID });
  });

  test("no publish when scope.session differs by (id, source) or is unset; late open after the scope moved publishes nothing", async () => {
    const store = createScope();
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    expect(panel.loadedSession()).toBeNull();
    await panel.open(SID, "claude-code");
    expect(store.get().window).toBe("live"); // scope.session unset
    store.narrow({ session: { id: SID } }); // differs by source
    button(panel.root, "zoom in").click();
    expect(store.get().window).toBe("live");

    const late = defer<FirehoseEvent[]>();
    sessionEvents.mockReset();
    sessionEvents.mockReturnValueOnce(late.promise);
    const p = panel.open(SID, "claude-code");
    store.narrow({ session: { id: "other" } });
    late.resolve(session); await p;
    expect(store.get().window).toBe("live");
  });

  test("DEFERRED RESPONSE: a load resolving after deactivate does not publish the window; activate or open re-enables it", async () => {
    const late = defer<FirehoseEvent[]>();
    sessionEvents.mockReset();
    sessionEvents.mockReturnValueOnce(late.promise).mockResolvedValue(session);
    const store = createScope();
    store.narrow({ session: { id: SID, source: "claude-code" } });
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    const p = panel.open(SID, "claude-code");
    panel.deactivate();
    late.resolve(session); await p;
    expect(store.get().window).toBe("live");
    panel.activate();
    await vi.waitFor(() => expect(panel.loadedSession()).toEqual({ id: SID, source: "claude-code" }));
    button(panel.root, "zoom in").click();
    expect(store.get().window).not.toBe("live"); // activate re-enables publishing
    store.narrow({ window: "live" });
    panel.deactivate();
    button(panel.root, "zoom in").click();
    expect(store.get().window).toBe("live"); // departed: no write
    await panel.open(SID, "claude-code");
    button(panel.root, "zoom in").click();
    expect(store.get().window).not.toBe("live"); // open re-enables it
  });

  test("activate opens scope.session when it differs, no-ops when equal, keeps the cache when unset", async () => {
    const store = createScope();
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    panel.activate();
    expect(sessionEvents).not.toHaveBeenCalled();
    await panel.open("A", "codex");
    expect(sessionEvents).toHaveBeenCalledTimes(1);
    panel.activate(); // scope.session unset: keep the cached chart
    expect(sessionEvents).toHaveBeenCalledTimes(1);
    expect(panel.loadedSession()).toEqual({ id: "A", source: "codex" });
    store.narrow({ session: { id: "A", source: "codex" } });
    panel.activate(); // explicit reopen of the loaded session refetches history
    expect(sessionEvents).toHaveBeenCalledTimes(2);
    panel.activate(); // a request already in flight is joined, not duplicated
    expect(sessionEvents).toHaveBeenCalledTimes(2);
    await panel.open("A", "codex");
    store.narrow({ session: { id: "B" } }); // loops chose B
    panel.activate();
    expect(sessionEvents).toHaveBeenCalledTimes(3);
    expect(sessionEvents).toHaveBeenLastCalledWith("B", "timeline");
    await panel.open("B"); // joins the in-flight load activate() started
    expect(panel.loadedSession()).toEqual({ id: "B" });
    expect(store.get().session).toEqual({ id: "B" });
  });

  test("Escape is not consumed by the score", async () => {
    const panel = createScore(() => {}, createScope());
    document.body.append(panel.root);
    await panel.open(SID);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    panel.root.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("score reads scope.window", () => {
  const view = (root: HTMLElement) => root.querySelector(".score-overview .score-view")!;
  const viewW = (root: HTMLElement) => Number(view(root).getAttribute("width"));
  const END = buildScore(session).end;
  const mount = async (win?: { from: number; to: number }) => {
    const store = createScope();
    store.narrow({ session: { id: SID, source: "claude-code" } });
    if (win) store.narrow({ window: win });
    const narrow = vi.spyOn(store, "narrow");
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    await panel.open(SID, "claude-code");
    return { store, panel, narrow };
  };
  const full = async () => { const m = await mount(); return viewW(m.panel.root); };

  test("an explicit scope.window for the same session is the view after load", async () => {
    const w = { from: START + 1000, to: START + 5000 };
    const { store, panel, narrow } = await mount(w);
    expect(viewW(panel.root)).toBeLessThan(await full());
    expect(store.get().window).toEqual(w);
    expect(narrow).not.toHaveBeenCalled();
  });

  test("window store changes move the view with no refetch", async () => {
    const { store, panel, narrow } = await mount();
    const whole = viewW(panel.root);
    sessionEvents.mockClear();
    const a = { from: START + 2000, to: START + 4000 };
    store.narrow({ window: a });
    expect(narrow).toHaveBeenCalledTimes(1); // only my call: Score wrote nothing
    const w1 = viewW(panel.root);
    expect(w1).toBeLessThan(whole);
    expect(sessionEvents).not.toHaveBeenCalled();
    const b = { from: START, to: START + 60000 };
    store.narrow({ window: b });
    expect(viewW(panel.root)).toBeGreaterThan(w1);
    expect(store.get().window).toEqual(b);
    expect(narrow).toHaveBeenCalledTimes(2);
    expect(sessionEvents).not.toHaveBeenCalled();
  });

  test("disjoint window is preserved; partial overlap draws the clamped viewport", async () => {
    const w = { from: END + 60_000, to: END + 120_000 };
    const { store, panel, narrow } = await mount(w);
    expect(panel.root.textContent).toContain("window outside this session's span");
    const vw = viewW(panel.root);
    expect(vw).toBeGreaterThan(0);
    expect(vw).toBeLessThanOrEqual(await full() + 0.001);
    expect(store.get().window).toEqual(w);
    expect(narrow).not.toHaveBeenCalled();

    const p = { from: END - 20_000, to: END + 60_000 };
    store.narrow({ window: p });
    expect(store.get().window).toEqual(p);
    expect(narrow).toHaveBeenCalledTimes(1); // only my call
    expect(panel.root.textContent).not.toContain("window outside this session's span");
  });

  test("full-bounds view publishes 'live'; a late event extends the whole-session view on refetch", async () => {
    const { store, panel } = await mount({ from: START + 1000, to: START + 5000 });
    button(panel.root, "fit").click();
    expect(store.get().window).toBe("live");
    const last = session[session.length - 1];
    const late = { ...last, id: "late-event", time: new Date(END + 120_000).toISOString() };
    const whole = viewW(panel.root);
    sessionEvents.mockResolvedValue([...session, late]);
    panel.activate();
    await vi.waitFor(() => expect(panel.root.textContent).toContain("102 events"));
    expect(viewW(panel.root)).toBeGreaterThanOrEqual(whole - 1);
    expect(store.get().window).toBe("live");
  });

  test("window returning to live resets the view to bounds with no fetch", async () => {
    const { store, panel } = await mount();
    const whole = viewW(panel.root);
    button(panel.root, "zoom in").click();
    expect(viewW(panel.root)).toBeLessThan(whole);
    sessionEvents.mockClear();
    store.narrow({ window: "live" });
    expect(viewW(panel.root)).toBeCloseTo(whole, 3);
    expect(sessionEvents).not.toHaveBeenCalled();
    expect(store.get().window).toBe("live");
  });

  test("a departed Score ignores window changes; followWindow() re-syncs", async () => {
    const { store, panel } = await mount();
    const whole = viewW(panel.root);
    panel.deactivate();
    store.narrow({ window: { from: START + 2000, to: START + 4000 } });
    expect(viewW(panel.root)).toBeCloseTo(whole, 3);
    panel.followWindow();
    expect(viewW(panel.root)).toBeLessThan(whole);
  });

  test("window/session change for another session is ignored", async () => {
    const { store, panel } = await mount();
    const whole = viewW(panel.root);
    store.narrow({ session: { id: "other" } });
    store.narrow({ window: { from: START + 2000, to: START + 4000 } });
    expect(viewW(panel.root)).toBeCloseTo(whole, 3);
  });

  test("activate() with the same session refetches and keeps the selected window", async () => {
    const w = { from: START + 1000, to: START + 5000 };
    const { store, panel } = await mount(w);
    const last = session[session.length - 1];
    sessionEvents.mockResolvedValue([...session, { ...last, id: "more-1", time: new Date(START + 3000).toISOString() }]);
    panel.activate();
    await vi.waitFor(() => expect(panel.root.textContent).toContain("102 events"));
    expect(store.get().window).toEqual(w);
    expect(viewW(panel.root)).toBeLessThan(await full());
  });
});

describe("score playback and hosted-empty (review findings 1 and 4)", () => {
  const wnd = { from: START + 20_000, to: START + 40_000 };
  const mountScoped = async () => {
    const store = createScope();
    store.narrow({ session: { id: SID, source: "claude-code" } });
    store.narrow({ window: wnd });
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    await panel.open(SID, "claude-code");
    return { store, panel };
  };

  test("F1: Play after load/reactivation starts inside the preserved window and never rewrites it", async () => {
    const { store, panel } = await mountScoped();
    expect(panel.playhead()).toBeGreaterThanOrEqual(wnd.from);
    expect(panel.playhead()).toBeLessThanOrEqual(wnd.to);
    button(panel.root, "play").click();
    panel.tick(100);
    expect(store.get().window).toEqual(wnd);
    panel.deactivate();
    panel.activate(); // switch-away-and-back: refetch keeps the window
    await vi.waitFor(() => expect(sessionEvents).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.playhead()).toBeGreaterThanOrEqual(wnd.from);
    expect(panel.playhead()).toBeLessThanOrEqual(wnd.to);
    button(panel.root, "play").click();
    panel.tick(100);
    expect(store.get().window).toEqual(wnd);
  });

  test("F4: a loaded Score shows the empty state once the hosted context is empty", async () => {
    const { store, panel } = await mountScoped();
    store.narrow({ session: undefined });
    panel.showEmpty();
    expect(panel.loadedSession()).toBeNull();
    expect(panel.root.textContent).toContain("open a session");
    expect(panel.root.querySelector(".score-playhead")).toBeNull();
    button(panel.root, "play").click();
    panel.tick(100);
    expect(panel.root.querySelector(".score-playhead")).toBeNull();
    expect(store.get().window).toBe("live");
  });

  test("F4: a load pending when the context empties cannot populate it", async () => {
    const store = createScope();
    store.narrow({ session: { id: SID, source: "claude-code" } });
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    let resolve!: (v: FirehoseEvent[]) => void;
    sessionEvents.mockReturnValueOnce(new Promise<FirehoseEvent[]>((r) => (resolve = r)));
    const p = panel.open(SID, "claude-code");
    store.narrow({ session: undefined });
    panel.showEmpty();
    resolve(session); await p;
    expect(panel.loadedSession()).toBeNull();
    expect(panel.root.textContent).toContain("open a session");
  });
});

describe("score activate without a session", () => {
  test("shows the empty state and does not fetch", () => {
    const store = createScope();
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    sessionEvents.mockClear();
    panel.followWindow();
    panel.activate();
    expect(panel.root.textContent).toContain("open a session");
    expect(sessionEvents).not.toHaveBeenCalled();
  });
});

describe("score reads scope.window: liveSpanMs", () => {
  test("liveSpanMs alone neither redraws nor writes", async () => {
    const store = createScope();
    store.narrow({ session: { id: SID, source: "claude-code" } });
    const narrow = vi.spyOn(store, "narrow");
    const panel = createScore(() => {}, store);
    document.body.append(panel.root);
    await panel.open(SID, "claude-code");
    const w = () => Number(panel.root.querySelector(".score-overview .score-view")!.getAttribute("width"));
    const before = w();
    store.narrow({ liveSpanMs: 3_600_000 });
    expect(w()).toBe(before);
    expect(narrow).toHaveBeenCalledTimes(1);
    expect(store.get().window).toBe("live");
  });
});
