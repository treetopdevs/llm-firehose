import { describe, expect, test } from "vitest";
import type { FirehoseEvent } from "../../api";
import { MAX_OPEN_SPAN_MS, buildLanes } from "../lanes/model";
import {
  BUCKET_PX,
  CATEGORY_ORDER,
  MIN_VIEW_MS,
  SPEEDS,
  advance,
  buildScore,
  clampView,
  coalesce,
  coalesceTrack,
  columnOf,
  digestLabel,
  eventAt,
  eventLabel,
  nextEventAfter,
  prevEventBefore,
  scoreAxisTicks,
  stripControl,
  tickKind,
  zoomView,
} from "./model";
import type { Track } from "./model";
import fixture from "./fixture.session.json";

// A real claude-code session captured in balanced mode on 2026-10-15 (101
// events, 13 minutes, five categories). Spool order, as GET /sessions/{id}
// returns it.
const session = fixture as FirehoseEvent[];
const SID = session[0].session_id!;
const t = (iso: string) => Date.parse(iso);

function ev(ageMs: number, over: Partial<FirehoseEvent> = {}): FirehoseEvent {
  return {
    id: `e-${ageMs}-${Math.random()}`,
    time: new Date(1_800_000_000_000 - ageMs).toISOString(),
    source: "claude-code",
    agent: "claude",
    category: "tool",
    session_id: "s",
    ...over,
  } as FirehoseEvent;
}

describe("buildScore on a real session", () => {
  const score = buildScore(session);

  test("spans the session from its first to its last captured event", () => {
    expect(score.start).toBe(t("2026-10-15T19:32:30.960878Z"));
    expect(score.end).toBe(t("2026-10-15T19:45:08.942576Z"));
    expect(score.events).toHaveLength(101);
    expect(score.events.map((e) => e.at)).toEqual([...score.events.map((e) => e.at)].sort((a, b) => a - b));
  });

  test("draws one track per category present, in envelope order, and none for absent categories", () => {
    expect(score.tracks.map((tr) => tr.category)).toEqual(["session", "prompt", "tool", "file", "shell"]);
    expect(CATEGORY_ORDER).toEqual(["session", "prompt", "message", "tool", "file", "permission", "shell", "error", "meta"]);
  });

  test("every event is a tick on its category track", () => {
    const counts = Object.fromEntries(score.tracks.map((tr) => [tr.category, tr.ticks.length]));
    expect(counts).toEqual({ session: 4, prompt: 3, tool: 24, file: 20, shell: 50 });
  });

  test("pairs call_id start and end into closed spans", () => {
    const shell = score.tracks.find((tr) => tr.category === "shell")!;
    // 25 Bash calls, each with a PreToolUse and a PostToolUse.
    expect(shell.spans).toHaveLength(25);
    expect(shell.spans.every((sp) => !sp.open && sp.to >= sp.from)).toBe(true);
    const first = shell.spans[0];
    expect(first).toMatchObject({ from: t("2026-10-15T19:32:37.642793Z"), to: t("2026-10-15T19:32:39.777452Z") });
  });

  test("an end captured before its start leaves a visibly open span to the session's last report (real quirk)", () => {
    // The first mcp__ccd_turn__wrap_up call was captured with its end at
    // 19:32:52.490 and its start at 19:32:52.546. Lanes treats to < from as
    // unmatched, so the score does too rather than inventing a negative span.
    const tool = score.tracks.find((tr) => tr.category === "tool")!;
    const open = tool.spans.filter((sp) => sp.open);
    expect(open).toHaveLength(1);
    expect(open[0].from).toBe(t("2026-10-15T19:32:52.546675Z"));
    expect(open[0].to).toBe(Math.min(score.end, open[0].from + MAX_OPEN_SPAN_MS));
    expect(open[0].to).toBe(score.end);
  });

  test("span pairing agrees with Lanes over the same events", () => {
    const summary = {
      id: SID,
      source: "claude-code",
      agent: "claude",
      first_time: new Date(score.start).toISOString(),
      last_time: new Date(score.end).toISOString(),
      events: session.length,
      state: "working",
    };
    const [lane] = buildLanes(session, [summary], score.end, score.end - score.start + 1);
    const laneSpans = lane.spans.map((sp) => [sp.from, sp.to, sp.open]).sort();
    const scoreSpans = score.tracks
      .flatMap((tr) => tr.spans)
      .map((sp) => [sp.from, sp.to, sp.open])
      .sort();
    expect(scoreSpans).toEqual(laneSpans);
    expect(scoreSpans).toHaveLength(47);
  });

  test("ticks carry their event id so the view can highlight the event under the playhead", () => {
    const ids = new Set(score.tracks.flatMap((tr) => tr.ticks.map((tk) => tk.id)));
    expect(ids.size).toBe(101);
    expect(ids.has(session[0].id)).toBe(true);
  });
});

describe("buildScore edge rules", () => {
  test("an unmatched start is capped at MAX_OPEN_SPAN_MS", () => {
    const events = [
      ev(2 * MAX_OPEN_SPAN_MS, { call_id: "c", payload: { phase: "start", tool_name: "Bash" } }),
      ev(0),
    ];
    const score = buildScore(events);
    const [sp] = score.tracks[0].spans;
    expect(sp).toEqual({ from: score.start, to: score.start + MAX_OPEN_SPAN_MS, open: true, startId: events[0].id, endId: undefined });
  });

  test("errors are error ticks; needs-you transitions are needs ticks on meta; other transitions are not drawn", () => {
    const events = [
      ev(30_000, { category: "shell", severity: "error" }),
      ev(20_000, { source: "firehose", category: "meta", name: "state.transition", payload: { state: "needs_input" } }),
      ev(10_000, { source: "firehose", category: "meta", name: "state.transition", payload: { state: "working" } }),
      ev(0, { category: "error" }),
    ];
    const score = buildScore(events);
    expect(score.tracks.map((tr) => tr.category)).toEqual(["shell", "error", "meta"]);
    expect(score.tracks[0].ticks[0].kind).toBe("error");
    expect(score.tracks[1].ticks[0].kind).toBe("error");
    expect(score.tracks[2].ticks.map((tk) => tk.kind)).toEqual(["needs"]);
    // The playhead index covers exactly what is drawn.
    expect(score.events.map((e) => e.event.id)).toEqual([events[0].id, events[1].id, events[3].id]);
  });

  test("events without a parseable time are dropped; an empty session has no extent", () => {
    expect(buildScore([ev(0, { time: "garbage" })]).tracks).toEqual([]);
    const empty = buildScore([]);
    expect(empty.tracks).toEqual([]);
    expect(empty.events).toEqual([]);
    expect(Number.isNaN(empty.start)).toBe(true);
  });
});

describe("playhead", () => {
  const score = buildScore(session);

  test("eventAt is the latest drawn event at or before the playhead", () => {
    expect(eventAt(score, score.start - 1)).toBeUndefined();
    expect(eventAt(score, score.start)?.event.id).toBe(session[0].id);
    const mid = t("2026-10-15T19:36:16.4Z"); // between the first Edit start (16.356) and end (16.468)
    expect(eventAt(score, mid)?.event.name).toBe("PreToolUse:Edit");
    expect(eventAt(score, score.end + 60_000)?.event.name).toBe("Stop");
  });

  test("nextEventAfter and prevEventBefore step strictly past the current instant", () => {
    const first = score.events[0];
    expect(nextEventAfter(score, score.start - 1)?.at).toBe(first.at);
    expect(nextEventAfter(score, first.at)?.at).toBe(score.events[1].at);
    expect(nextEventAfter(score, score.end)).toBeUndefined();
    expect(prevEventBefore(score, score.end)?.at).toBe(score.events[score.events.length - 2].at);
    expect(prevEventBefore(score, score.start)).toBeUndefined();
  });

  test("advance moves by elapsed wall time times speed, stops at the end, and keeps gaps as real time", () => {
    expect(SPEEDS).toContain(1);
    expect(advance(score, score.start, 1000, 1)).toEqual({ at: score.start + 1000, done: false });
    expect(advance(score, score.start, 1000, 10)).toEqual({ at: score.start + 10_000, done: false });
    expect(advance(score, score.end - 500, 1000, 1)).toEqual({ at: score.end, done: true });
    // The 2m28s gap between the first Stop and the next prompt is replayed, not skipped.
    const stop = t("2026-10-15T19:33:07.570517Z");
    expect(eventAt(score, advance(score, stop, 60_000, 1).at)?.event.name).toBe("Stop");
  });
});

describe("viewport", () => {
  const bounds = { from: 0, to: 100_000 };

  test("zoom halves the window around the anchor and never leaves the session", () => {
    const view = zoomView(bounds, 2, 50_000, bounds);
    expect(view).toEqual({ from: 25_000, to: 75_000 });
    expect(zoomView(view, 0.5, 50_000, bounds)).toEqual(bounds);
    // Anchor at 10% of the window stays at 10% of the narrower window.
    expect(zoomView(view, 2, 30_000, bounds)).toEqual({ from: 27_500, to: 52_500 });
    expect(zoomView(view, 0.1, 50_000, bounds)).toEqual(bounds);
  });

  test("clampView keeps the window inside the session and at least one second wide", () => {
    expect(clampView({ from: -10, to: 20_000 }, bounds)).toEqual({ from: 0, to: 20_010 });
    expect(clampView({ from: 90_000, to: 120_000 }, bounds)).toEqual({ from: 70_000, to: 100_000 });
    expect(clampView({ from: 50_000, to: 50_000 }, bounds)).toEqual({ from: 49_500, to: 50_500 });
  });
});

describe("labels", () => {
  test("digested payload values and path digests print as a short hash; readable text stays readable", () => {
    expect(digestLabel("Bash")).toBe("Bash");
    expect(digestLabel({ sha256: "ab12cd34ef567890".padEnd(64, "0"), len: 4 })).toBe("#ab12cd34");
    expect(digestLabel("ab12cd34ef567890".padEnd(64, "0"))).toBe("#ab12cd34");
    expect(digestLabel(undefined)).toBe("");
  });

  test("eventLabel prefers the summary, then the tool name, then the name, and strips control characters", () => {
    expect(eventLabel(session[2])).toBe("will run tool mcp__ccd_turn__update_plan");
    expect(eventLabel(ev(0, { summary: "", payload: { tool_name: "Bash" } }))).toBe("Bash");
    expect(eventLabel(ev(0, { summary: "", payload: { tool_name: { sha256: "f".repeat(64), len: 4 } } }))).toBe("#ffffffff");
    expect(eventLabel(ev(0, { summary: "", name: "Stop" }))).toBe("Stop");
    expect(eventLabel(ev(0, { summary: "\u001b[31mred\u001b[0m ‮evil" }))).toBe("[31mred[0m evil");
  });

  test("stripControl removes C0, C1, and bidi override characters", () => {
    expect(stripControl("a\u0000b\u001fc\u007fd\u009fe‪f⁦g")).toBe("abcdefg");
    expect(stripControl("tab\tkeeps\nnewline")).toBe("tab\tkeeps\nnewline");
  });
});

// --- viewport coalescing -------------------------------------------------------

const HOUR = 3_600_000;
const CATS = ["session", "prompt", "tool", "file", "shell"];

/** A synthetic long session: `n` events over `spanMs`, every 50th an error, every other tool event a call pair. */
function bigSession(n: number, spanMs: number): FirehoseEvent[] {
  const base = 1_800_000_000_000;
  const out: FirehoseEvent[] = [];
  for (let i = 0; i < n; i++) {
    const category = CATS[i % CATS.length];
    const call = category === "tool" ? { call_id: `c${i >> 1}`, payload: { phase: i % 2 ? "end" : "start", tool_name: "Bash" } } : {};
    out.push({
      id: `e${i}`,
      time: new Date(base + Math.floor((i / n) * spanMs)).toISOString(),
      source: "codex",
      agent: "codex",
      category,
      session_id: "big",
      severity: i % 50 === 0 ? "error" : undefined,
      ...call,
    } as FirehoseEvent);
  }
  return out;
}

describe("coalesce: drawn nodes are bounded by the viewport, not the event count", () => {
  const W = 682; // what an 800px chart leaves for lanes
  const big = bigSession(100_000, 1364 * HOUR);

  test("a 100k-event session coalesces to at most one node per pixel column per kind on each track", () => {
    const score = buildScore(big);
    expect(score.events).toHaveLength(100_000);
    const drawn = coalesce(score, { from: score.start, to: score.end }, W);
    expect(drawn.map((tr) => tr.category)).toEqual(score.tracks.map((tr) => tr.category));
    const columns = Math.ceil(W / BUCKET_PX) + 1;
    for (const tr of drawn) {
      const kinds = new Set(tr.ticks.map((tk) => tk.kind)).size;
      expect(tr.ticks.length).toBeLessThanOrEqual(columns * kinds);
      expect(tr.spans.length).toBeLessThanOrEqual(columns * 2);
    }
    const ticks = drawn.reduce((n, tr) => n + tr.ticks.length, 0);
    expect(ticks).toBeLessThanOrEqual(columns * drawn.length * 2);
    // Every in-view event is counted exactly once.
    expect(drawn.reduce((n, tr) => n + tr.ticks.reduce((m, tk) => m + tk.count, 0), 0)).toBe(100_000);
    // The playhead index is untouched by coalescing.
    expect(nextEventAfter(score, score.start)?.event.id).toBe("e1");
  });

  test("zooming in culls to the window and keeps the bound; counts cover only what is in view", () => {
    const score = buildScore(big);
    const view = zoomView({ from: score.start, to: score.end }, 1000, score.start + 100 * HOUR, { from: score.start, to: score.end });
    const drawn = coalesce(score, view, W);
    const inView = score.events.filter((e) => e.at >= view.from && e.at <= view.to).length;
    expect(inView).toBeGreaterThan(0);
    expect(drawn.reduce((n, tr) => n + tr.ticks.reduce((m, tk) => m + tk.count, 0), 0)).toBe(inView);
    for (const tr of drawn) for (const tk of tr.ticks) expect(tk.at).toBeGreaterThanOrEqual(view.from);
  });

  test("builds and coalesces 100k events well under a second", () => {
    const t0 = performance.now();
    const score = buildScore(big);
    const view = { from: score.start, to: score.end };
    coalesce(score, view, W);
    const zoomed = zoomView(view, 4, score.start + 100 * HOUR, view);
    coalesce(score, zoomed, W);
    expect(scoreAxisTicks(view, W).length).toBeGreaterThanOrEqual(2);
    expect(scoreAxisTicks(zoomed, W).length).toBeGreaterThanOrEqual(2);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("coalesce: merge rules", () => {
  const view = { from: 0, to: 100_000 };
  const W = 100; // 1000 ms per pixel
  const tk = (at: number, kind: "event" | "error" | "needs", id: string) => ({ at, kind, id });
  const track = (ticks: Track["ticks"], spans: Track["spans"] = []): Track => ({ category: "tool", ticks, spans });

  test("ticks in the same pixel column merge into one tick carrying a count and the earliest id", () => {
    const tr = track([tk(5_300, "event", "b"), tk(5_100, "event", "a"), tk(5_900, "event", "c"), tk(7_000, "event", "d")]);
    const out = coalesceTrack(tr, view, W);
    expect(out.ticks).toEqual([
      { at: 5_100, kind: "event", id: "a", count: 3, column: 5 },
      { at: 7_000, kind: "event", id: "d", count: 1, column: 7 },
    ]);
    expect(columnOf(5_999, view, W)).toBe(5);
    expect(columnOf(6_000, view, W)).toBe(6);
  });

  test("an error tick never merges into plain ticks in its column; a needs tick keeps its own mark too", () => {
    const tr = track([tk(5_100, "event", "a"), tk(5_200, "error", "x"), tk(5_300, "event", "b"), tk(5_400, "needs", "n")]);
    const out = coalesceTrack(tr, view, W);
    expect(out.ticks.map((t) => [t.kind, t.id, t.count])).toEqual([
      ["event", "a", 2],
      ["error", "x", 1],
      ["needs", "n", 1],
    ]);
  });

  test("ticks outside the window are not drawn", () => {
    const tr = track([tk(-1, "event", "a"), tk(0, "event", "b"), tk(100_000, "event", "c"), tk(100_001, "event", "d")]);
    expect(coalesceTrack(tr, view, W).ticks.map((t) => t.id)).toEqual(["b", "c"]);
  });

  test("spans narrower than a pixel in the same column merge; a wide span and an open span stay separate", () => {
    const sp = (from: number, to: number, open = false, startId = `s${from}`) => ({ from, to, open, startId, endId: open ? undefined : `e${to}` });
    const tr = track([], [sp(5_100, 5_200), sp(5_300, 5_350, true), sp(5_400, 5_500), sp(5_450, 5_480, true), sp(5_600, 9_000), sp(200_000, 200_100)]);
    const out = coalesceTrack(tr, view, W);
    expect(out.spans).toEqual([
      { from: 5_100, to: 5_500, open: false, startId: "s5100", endId: "e5500", count: 2 },
      { from: 5_300, to: 5_480, open: true, startId: "s5300", endId: undefined, count: 2 },
      { from: 5_600, to: 9_000, open: false, startId: "s5600", endId: "e9000", count: 1 },
    ]);
  });

  test("a small session paints the same columns coalesced as it would tick by tick", () => {
    const score = buildScore(session);
    const view = { from: score.start, to: score.end };
    const W = 682;
    const drawn = coalesce(score, view, W);
    const raw = new Set(score.tracks.flatMap((tr) => tr.ticks.map((t) => `${tr.category}:${t.kind}:${columnOf(t.at, view, W)}`)));
    const merged = new Set(drawn.flatMap((tr) => tr.ticks.map((t) => `${tr.category}:${t.kind}:${t.column}`)));
    expect(merged).toEqual(raw);
    expect(drawn.reduce((n, tr) => n + tr.ticks.reduce((m, t) => m + t.count, 0), 0)).toBe(101);
    expect(drawn.reduce((n, tr) => n + tr.spans.reduce((m, s) => m + s.count, 0), 0)).toBe(47);
  });

  test("tickKind matches what buildScore assigns", () => {
    expect(tickKind(ev(0))).toBe("event");
    expect(tickKind(ev(0, { severity: "error" }))).toBe("error");
    expect(tickKind(ev(0, { category: "error" }))).toBe("error");
    expect(tickKind(ev(0, { source: "firehose", category: "meta", name: "state.transition", payload: { state: "needs_input" } }))).toBe("needs");
  });
});

describe("scoreAxisTicks", () => {
  const W = 682;
  const start = Date.parse("2026-09-01T00:00:00Z");

  test("a multi-week window, and the same window after one zoom, get at least two spaced labels with dates", () => {
    for (const hours of [1364, 682]) {
      const view = { from: start, to: start + hours * HOUR };
      const ticks = scoreAxisTicks(view, W);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(W / 80 + 1);
      const px = ticks.map((t) => ((t.at - view.from) / (view.to - view.from)) * W);
      for (let i = 1; i < px.length; i++) expect(px[i] - px[i - 1]).toBeGreaterThanOrEqual(80 - 1e-6);
      for (const t of ticks) {
        expect(t.at).toBeGreaterThanOrEqual(view.from);
        expect(t.at).toBeLessThanOrEqual(view.to);
        expect(t.label).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
      }
    }
  });

  test("a thirteen-minute session labels minutes like Lanes does", () => {
    const score = buildScore(session);
    const ticks = scoreAxisTicks({ from: score.start, to: score.end }, W);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0].label).toMatch(/^\d{2}:\d{2}$/);
  });

  test("the narrowest window still gets two labels, in tenths of a second", () => {
    const ticks = scoreAxisTicks({ from: start, to: start + MIN_VIEW_MS }, W);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks[0].label).toMatch(/^\d{2}:\d{2}:\d{2}\.\d$/);
    // Whole seconds once the step reaches a second.
    expect(scoreAxisTicks({ from: start, to: start + 10 * MIN_VIEW_MS }, W)[0].label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    // A session shorter than any step still gets its two ends labelled.
    expect(scoreAxisTicks({ from: start, to: start + 10 }, W)).toHaveLength(2);
  });
});
