import { describe, expect, test } from "vitest";
import type { FirehoseEvent } from "../../api";
import { MAX_OPEN_SPAN_MS, buildLanes } from "../lanes/model";
import {
  CATEGORY_ORDER,
  SPEEDS,
  advance,
  buildScore,
  clampView,
  digestLabel,
  eventAt,
  eventLabel,
  nextEventAfter,
  prevEventBefore,
  stripControl,
  zoomView,
} from "./model";
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
