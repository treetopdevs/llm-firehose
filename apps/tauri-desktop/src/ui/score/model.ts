// Session Score: one finished session's Captured Events as time-aligned
// tracks, one per envelope category, with real gaps preserved
// (docs/plans/2026-10-16-session-score-and-activity-map.md). Pure derivation;
// span pairing is the Lanes model's, so both views agree on every call.

import type { ErrorSignature, FirehoseEvent } from "../../api";
import { isTransition } from "../../spark";
import { MAX_OPEN_SPAN_MS, collectCalls } from "../lanes/model";

/** Envelope categories in the order event.go declares them; tracks follow it. */
export const CATEGORY_ORDER = ["session", "prompt", "message", "tool", "file", "permission", "shell", "error", "meta"] as const;

/** Replay speeds: one second of wall time advances the playhead this many seconds. */
export const SPEEDS = [1, 2, 5, 10, 30, 60] as const;

/** A window narrower than this cannot be zoomed into further. */
export const MIN_VIEW_MS = 1000;

export type TickKind = "event" | "error" | "needs";
export type ScoreTick = { at: number; kind: TickKind; id: string; sig?: string };
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
  /** Error Signature keys seen more than once in this session, with their in-session counts. */
  motifs: Map<string, number>;
};
export type View = { from: number; to: number };

// --- error signatures ------------------------------------------------------------
//
// The Error Signature identity is defined once, in the capture projection
// (internal/capture/internal/projection/errsig.go), and served at GET /errors.
// With ?session= the endpoint carries each signature's member event ids
// (additive, 2026-10-16), and those are the authoritative grouping:
// memberSignatureKeys turns them into an id → key map that buildScore prefers.
// The mirrored keying below remains only as the fallback for older daemons
// without the field, failed fetches, and ids past the endpoint's 500-member
// cap; parity is pinned by model.test.ts over the projection's own 11-event
// fixture. Cross-session facts (count, sessions, sample) come only from the
// daemon, never from this mirror.

/** Event id → signature key, from the daemon's session-scoped member ids. */
export function memberSignatureKeys(sigs: readonly ErrorSignature[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sigs) for (const id of s.members ?? []) out.set(id, s.key);
  return out;
}

/** Mirrors errsig.go normalizeErrorSummary: lowercase, collapse whitespace, hex runs of 6+ then digit runs to '#', 160 code points. */
export function normalizeErrorSummary(s: string): string {
  s = s.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  s = s.replace(/[0-9a-f]{6,}/g, "#").replace(/[0-9]+/g, "#");
  const runes = [...s];
  return runes.length > 160 ? runes.slice(0, 160).join("") : s;
}

/** Mirrors errsig.go errorClass: a non-empty error_class string, else a privacy digest's first 16 characters, else the normalized summary. */
function errorClass(ev: FirehoseEvent): string {
  const v = ev.payload?.error_class;
  if (typeof v === "string" && v !== "") return v;
  if (v !== null && typeof v === "object") {
    const sum = (v as { sha256?: unknown }).sha256;
    if (typeof sum === "string" && sum !== "") return sum.slice(0, 16);
  }
  return normalizeErrorSummary(ev.summary ?? "");
}

/** The signature an error observation belongs to, as errsig.go keys it: source|category|name|class. */
export function errorSignatureKey(ev: FirehoseEvent): string {
  return `${ev.source}|${ev.category}|${ev.name ?? ""}|${errorClass(ev)}`;
}

/** How an event is marked on its track; what buildScore assigns and what the view keys highlights by. */
export function tickKind(ev: FirehoseEvent): TickKind {
  if (isTransition(ev)) return "needs";
  return ev.severity === "error" || ev.category === "error" ? "error" : "event";
}

function rank(category: string): number {
  const i = (CATEGORY_ORDER as readonly string[]).indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

export function buildScore(events: readonly FirehoseEvent[], members?: ReadonlyMap<string, string>): Score {
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
  const sigCounts = new Map<string, number>();
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
    const kind = tickKind(ev);
    const tick: ScoreTick = { at: t, kind, id: ev.id };
    if (kind === "error") {
      tick.sig = members?.get(ev.id) ?? errorSignatureKey(ev);
      sigCounts.set(tick.sig, (sigCounts.get(tick.sig) ?? 0) + 1);
    }
    trackFor(ev.category).ticks.push(tick);
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
  // Spool order is only roughly chronological; the coalescer walks ticks and
  // spans in time order so one pass finds every column's earliest member.
  for (const tr of ordered) {
    tr.ticks.sort((a, b) => a.at - b.at);
    tr.spans.sort((a, b) => a.from - b.from);
  }
  const motifs = new Map<string, number>();
  for (const [sig, n] of sigCounts) if (n >= 2) motifs.set(sig, n);
  return {
    start: drawn.length ? drawn[0].at : NaN,
    end: drawn.length ? drawn[drawn.length - 1].at : NaN,
    tracks: ordered,
    events: drawn,
    motifs,
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

// --- viewport coalescing ---------------------------------------------------------
//
// The score is drawn for a window of the session at a pixel width. Marks that
// would land in the same pixel column on one track are drawn once, carrying a
// count, so the number of nodes is bounded by tracks × columns rather than by
// the event count. Zoom, jump, and the playhead keep using Score.events.

/** Width of one coalescing bucket in pixels. */
export const BUCKET_PX = 1;

/** `sig` follows `id`: a merged tick carries its earliest member's signature; other members' motifs show once zoomed in. */
export type DrawnTick = { at: number; kind: TickKind; id: string; sig?: string; count: number; column: number };
export type DrawnSpan = { from: number; to: number; open: boolean; startId: string; endId: string | undefined; count: number };
export type DrawnTrack = { category: string; ticks: DrawnTick[]; spans: DrawnSpan[] };

/** The bucket an instant falls in for a window drawn `widthPx` wide. */
export function columnOf(at: number, view: View, widthPx: number): number {
  return Math.floor((((at - view.from) / (view.to - view.from)) * widthPx) / BUCKET_PX);
}

export function coalesceTrack(track: Track, view: View, widthPx: number): DrawnTrack {
  const ticks: DrawnTick[] = [];
  // One open bucket per kind: an error or needs-you mark never disappears into
  // the plain ticks around it.
  const current: Partial<Record<TickKind, DrawnTick>> = {};
  for (const tk of track.ticks) {
    if (tk.at < view.from || tk.at > view.to) continue;
    const column = columnOf(tk.at, view, widthPx);
    const open = current[tk.kind];
    if (open && open.column === column) {
      open.count++;
      if (tk.at < open.at) {
        open.at = tk.at;
        open.id = tk.id;
        open.sig = tk.sig;
      }
      continue;
    }
    const next = { at: tk.at, kind: tk.kind, id: tk.id, sig: tk.sig, count: 1, column };
    current[tk.kind] = next;
    ticks.push(next);
  }
  ticks.sort((a, b) => a.at - b.at || a.column - b.column);

  type Bucketed = DrawnSpan & { c1: number; c2: number };
  const spans: Bucketed[] = [];
  // Sub-pixel spans sharing a column merge; so do spans that would paint the
  // very same pixels. Open spans are drawn differently and never merge with
  // closed ones, so each state keeps its own open bucket.
  const lastBy: { open?: Bucketed; closed?: Bucketed } = {};
  for (const sp of track.spans) {
    if (sp.to < view.from || sp.from > view.to) continue;
    const c1 = columnOf(sp.from, view, widthPx);
    const c2 = columnOf(sp.to, view, widthPx);
    const last = sp.open ? lastBy.open : lastBy.closed;
    if (last && last.c1 === c1 && last.c2 === c2) {
      last.count++;
      last.to = Math.max(last.to, sp.to);
      if (!sp.open && sp.to >= last.to) last.endId = sp.endId;
      if (sp.from < last.from) {
        last.from = sp.from;
        last.startId = sp.startId;
      }
      continue;
    }
    const next = { from: sp.from, to: sp.to, open: sp.open, startId: sp.startId, endId: sp.endId, count: 1, c1, c2 };
    if (sp.open) lastBy.open = next;
    else lastBy.closed = next;
    spans.push(next);
  }
  spans.sort((a, b) => a.from - b.from);
  return {
    category: track.category,
    ticks,
    spans: spans.map(({ c1: _c1, c2: _c2, ...sp }) => sp),
  };
}

/** Every track of the score coalesced for one window and width; the overview strip uses the whole session as its window. */
export function coalesce(score: Score, view: View, widthPx: number): DrawnTrack[] {
  return score.tracks.map((tr) => coalesceTrack(tr, view, widthPx));
}

// --- axis ------------------------------------------------------------------------------

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Candidate label steps from a tenth of a second to four weeks; Lanes stops at an hour, a session does not. */
const AXIS_STEPS_MS = [100, 250, 500, SEC, 2 * SEC, 5 * SEC, 10 * SEC, 30 * SEC, MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];
const AXIS_MIN_LABEL_PX = 80;

export type ScoreAxisTick = { at: number; label: string };

function axisLabel(at: number, step: number, withDate: boolean): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  let s = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (step < MIN) s += `:${pad(d.getSeconds())}`;
  if (step < SEC) s += `.${Math.floor(d.getMilliseconds() / 100)}`;
  return withDate ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${s}` : s;
}

/** How many whole multiples of `step` fall inside the window; no ticks are built to count them. */
function stepCount(view: View, step: number): number {
  return Math.floor(view.to / step) - Math.ceil(view.from / step) + 1;
}

function stepTicks(view: View, step: number): number[] {
  const out: number[] = [];
  for (let at = Math.ceil(view.from / step) * step; at <= view.to; at += step) out.push(at);
  return out;
}

/**
 * Whole clock times inside the window at the coarsest step that keeps labels
 * readable, and always at least two of them: a window too narrow for any
 * step is labelled at its ends. Dates appear once a window is longer than a day.
 */
export function scoreAxisTicks(view: View, widthPx: number): ScoreAxisTick[] {
  const windowMs = view.to - view.from;
  const withDate = windowMs > DAY;
  if (!(windowMs > 0) || !(widthPx > 0)) return [];
  const pxPerMs = widthPx / windowMs;
  // Finest to coarsest, as Lanes does: the first step with room for its
  // labels wins if two of its ticks fall in the window; otherwise the
  // coarsest step that still puts two ticks in the window, labels crowding or not.
  let chosen: number | undefined;
  for (const step of AXIS_STEPS_MS) {
    if (stepCount(view, step) >= 2) chosen = step;
    if (step * pxPerMs >= AXIS_MIN_LABEL_PX) break;
  }
  if (chosen === undefined) {
    const step = AXIS_STEPS_MS[0];
    return [view.from, view.to].map((at) => ({ at, label: axisLabel(at, step, withDate) }));
  }
  const step = chosen;
  return stepTicks(view, step).map((at) => ({ at, label: axisLabel(at, step, withDate) }));
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

/** Envelope fields the daemon's `?view=timeline` keeps (docs/plans/2026-10-17-session-timeline-view.md). */
export const TIMELINE_FIELDS = ["schema_version", "id", "time", "source", "agent", "session_id", "turn_id", "call_id", "category", "name", "severity", "summary"] as const;
/** Payload keys the timeline view keeps, values copied as-is. */
export const TIMELINE_PAYLOAD_KEYS = ["phase", "state", "tool_name", "error_class", "duration_ms", "status", "item_type"] as const;

/**
 * What the daemon's timeline view would send for one event: the allowlisted
 * envelope fields and payload keys, nothing else, an empty payload omitted.
 * The daemon is the real projector; this mirror lets tests derive the
 * projected fixture from the real full one instead of hand-writing it.
 */
export function timelineProjection(ev: FirehoseEvent): FirehoseEvent {
  const out: Record<string, unknown> = {};
  const src = ev as unknown as Record<string, unknown>;
  for (const k of TIMELINE_FIELDS) if (src[k] !== undefined) out[k] = src[k];
  const payload: Record<string, unknown> = {};
  for (const k of TIMELINE_PAYLOAD_KEYS) if (ev.payload?.[k] !== undefined) payload[k] = ev.payload[k];
  if (Object.keys(payload).length > 0) out.payload = payload;
  return out as unknown as FirehoseEvent;
}
