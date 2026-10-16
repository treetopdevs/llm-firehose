// Session Score: one finished session's Captured Events as time-aligned
// tracks, one per envelope category, with real gaps preserved
// (docs/plans/2026-10-16-session-score-and-activity-map.md). Pure derivation;
// span pairing is the Lanes model's, so both views agree on every call.

import type { FirehoseEvent } from "../../api";
import { isTransition } from "../../spark";
import { MAX_OPEN_SPAN_MS, collectCalls } from "../lanes/model";

/** Envelope categories in the order event.go declares them; tracks follow it. */
export const CATEGORY_ORDER = ["session", "prompt", "message", "tool", "file", "permission", "shell", "error", "meta"] as const;

/** Replay speeds: one second of wall time advances the playhead this many seconds. */
export const SPEEDS = [1, 2, 5, 10, 30, 60] as const;

/** A window narrower than this cannot be zoomed into further. */
export const MIN_VIEW_MS = 1000;

export type TickKind = "event" | "error" | "needs";
export type ScoreTick = { at: number; kind: TickKind; id: string };
export type ScoreSpan = { from: number; to: number; open: boolean; startId: string; endId: string | undefined };
export type Track = { category: string; ticks: ScoreTick[]; spans: ScoreSpan[] };
/** One drawn event in playhead order. */
export type ScoreEvent = { at: number; event: FirehoseEvent };
export type Score = {
  /** First and last drawn event; NaN for an empty session. */
  start: number;
  end: number;
  tracks: Track[];
  /** Every drawn event sorted by time; the playhead steps through these. */
  events: ScoreEvent[];
};
export type View = { from: number; to: number };

function rank(category: string): number {
  const i = (CATEGORY_ORDER as readonly string[]).indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

export function buildScore(events: readonly FirehoseEvent[]): Score {
  const tracks = new Map<string, Track>();
  const trackFor = (category: string): Track => {
    let tr = tracks.get(category);
    if (!tr) {
      tr = { category, ticks: [], spans: [] };
      tracks.set(category, tr);
    }
    return tr;
  };
  const drawn: ScoreEvent[] = [];
  let lastReport = NaN;
  for (const ev of events) {
    const t = Date.parse(ev.time);
    if (Number.isNaN(t)) continue;
    if (isTransition(ev)) {
      // Engine transitions are not activity; only a needs-you mark is drawn.
      if (ev.payload?.state !== "needs_input") continue;
      trackFor(ev.category).ticks.push({ at: t, kind: "needs", id: ev.id });
      drawn.push({ at: t, event: ev });
      continue;
    }
    if (Number.isNaN(lastReport) || t > lastReport) lastReport = t;
    const failed = ev.severity === "error" || ev.category === "error";
    trackFor(ev.category).ticks.push({ at: t, kind: failed ? "error" : "event", id: ev.id });
    drawn.push({ at: t, event: ev });
  }
  for (const call of collectCalls(events)) {
    if (call.start === undefined || !call.startEvent) continue;
    let to = call.end;
    let open = false;
    if (to === undefined || to < call.start) {
      // The session is finished, so an unfinished call can only have run to
      // the session's last report; past the cap it cannot honestly be drawn.
      open = true;
      to = Math.min(Number.isNaN(lastReport) ? call.start : lastReport, call.start + MAX_OPEN_SPAN_MS);
    }
    trackFor(call.startEvent.category).spans.push({
      from: call.start,
      to,
      open,
      startId: call.startEvent.id,
      endId: open ? undefined : call.endEvent?.id,
    });
  }
  drawn.sort((a, b) => a.at - b.at);
  const ordered = [...tracks.values()].sort((a, b) => rank(a.category) - rank(b.category) || (a.category < b.category ? -1 : 1));
  return {
    start: drawn.length ? drawn[0].at : NaN,
    end: drawn.length ? drawn[drawn.length - 1].at : NaN,
    tracks: ordered,
    events: drawn,
  };
}

/** Index of the last drawn event at or before `at`, or -1. */
function indexAt(score: Score, at: number): number {
  let lo = 0;
  let hi = score.events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (score.events[mid].at <= at) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The event under the playhead: the latest drawn event at or before it. */
export function eventAt(score: Score, at: number): ScoreEvent | undefined {
  const i = indexAt(score, at);
  return i === -1 ? undefined : score.events[i];
}

export function nextEventAfter(score: Score, at: number): ScoreEvent | undefined {
  const i = indexAt(score, at);
  return score.events[i + 1];
}

export function prevEventBefore(score: Score, at: number): ScoreEvent | undefined {
  // Several events may share an instant; step to the last one strictly earlier.
  let i = indexAt(score, at);
  while (i >= 0 && score.events[i].at >= at) i--;
  return i < 0 ? undefined : score.events[i];
}

/** Moves the playhead by elapsed wall time at the given speed. Gaps are real time. */
export function advance(score: Score, at: number, elapsedMs: number, speed: number): { at: number; done: boolean } {
  const next = at + elapsedMs * speed;
  if (Number.isNaN(score.end) || next >= score.end) return { at: score.end, done: true };
  return { at: next, done: false };
}

export function clampView(view: View, bounds: View): View {
  const total = bounds.to - bounds.from;
  let width = Math.min(Math.max(view.to - view.from, MIN_VIEW_MS), total);
  if (!Number.isFinite(width) || width <= 0) width = total;
  let from = view.to - view.from < MIN_VIEW_MS ? (view.from + view.to) / 2 - width / 2 : view.from;
  if (from < bounds.from) from = bounds.from;
  if (from + width > bounds.to) from = bounds.to - width;
  return { from, to: from + width };
}

/** Narrows (factor > 1) or widens the window around an anchor instant, inside the session. */
export function zoomView(view: View, factor: number, anchor: number, bounds: View): View {
  const width = (view.to - view.from) / factor;
  const ratio = (anchor - view.from) / (view.to - view.from);
  const from = anchor - width * ratio;
  return clampView({ from, to: from + width }, bounds);
}

/** Slides the window so `center` sits in its middle, inside the session. */
export function panView(view: View, center: number, bounds: View): View {
  const width = view.to - view.from;
  return clampView({ from: center - width / 2, to: center + width / 2 }, bounds);
}

const DIGEST = /^[0-9a-f]{64}$/;

/** Control characters that would garble or reorder SVG text: C0, DEL, C1, and bidi controls. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function stripControl(s: string): string {
  return s.replace(CONTROL, "");
}

/**
 * A payload value as a label. Minimal mode digests values to {sha256, len}
 * and every mode digests path identities to 64 hex characters; both print
 * as eight characters of hash. Readable text is returned as is.
 */
export function digestLabel(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return DIGEST.test(v) ? `#${v.slice(0, 8)}` : v;
  if (typeof v === "object" && typeof (v as { sha256?: unknown }).sha256 === "string") {
    return `#${(v as { sha256: string }).sha256.slice(0, 8)}`;
  }
  return "";
}

/** What an event is called on the score: its summary, else its tool, else its name. */
export function eventLabel(ev: FirehoseEvent): string {
  const text = ev.summary || digestLabel(ev.payload?.tool_name) || ev.name || ev.category;
  return stripControl(digestLabel(text) || text);
}
