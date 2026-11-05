// Marey-style lanes: every live session on one wall-clock axis ending at now.
// Pure derivation from the live buffer plus /sessions summaries; the engine's
// attention state is read, never re-folded (internal/tui/derive.go mirrors this).

import { disambiguateSessionLabel, idLabel, sessionName } from "../../format";
import type { SessionLike } from "../../format";
import type { FirehoseEvent, SessionSummary } from "../../api";
import { isTransition, lastReported, stateFresh } from "../../spark";

export const LANE_WINDOWS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
/** Past this an unfinished tool call cannot honestly be drawn as still running. */
export const MAX_OPEN_SPAN_MS = 30 * 60_000;
export const LANE_CAP = 12;
/** Joins source and native id in a lane key, so two sources reusing an id never share a lane. */
export const SEP = "\u0000";

/** A composite lane id back to its source and native id; a bare id has no source. */
export function decodeLaneId(key: string): { id: string; source?: string } {
  const i = key.indexOf(SEP);
  return i < 0 ? { id: key } : { id: key.slice(i + 1), source: key.slice(0, i) || undefined };
}

export type LaneTick = { at: number; kind: "event" | "error" | "needs" };
export type LaneSpan = { from: number; to: number; open: boolean };
export type Lane = {
  id: string;
  label: string;
  state: string;
  reason?: string;
  lastAt: number;
  ticks: LaneTick[];
  spans: LaneSpan[];
};

type Acc = Lane & { since: number };

/** One tool call's observed phases: the first start and the first end captured for a session × call id. */
export type CallPhases = {
  session: string;
  start?: number;
  end?: number;
  startEvent?: FirehoseEvent;
  endEvent?: FirehoseEvent;
};

/**
 * Pairs start and end observations by session and call id, in the order the
 * calls were first seen. Only the first start and the first end count, so a
 * dual observation of one phase cannot stretch a span. Whether an unpaired or
 * inverted pair draws as open, and to where, is the caller's rule.
 */
export function collectCalls(events: readonly FirehoseEvent[]): CallPhases[] {
  const calls = new Map<string, CallPhases>();
  const order: CallPhases[] = [];
  for (const ev of events) {
    if (!ev.session_id || !ev.call_id || isTransition(ev)) continue;
    const t = Date.parse(ev.time);
    if (Number.isNaN(t)) continue;
    const phase = ev.payload?.phase;
    if (phase !== "start" && phase !== "end") continue;
    const key = `${ev.session_id}\0${ev.call_id}`;
    let sp = calls.get(key);
    if (!sp) {
      sp = { session: ev.session_id };
      calls.set(key, sp);
      order.push(sp);
    }
    if (phase === "start" && sp.start === undefined) {
      sp.start = t;
      sp.startEvent = ev;
    } else if (phase === "end" && sp.end === undefined) {
      sp.end = t;
      sp.endEvent = ev;
    }
  }
  return order;
}

function later(current: number, candidate: number): number {
  return Number.isNaN(current) || candidate > current ? candidate : current;
}

export function buildLanes(
  events: readonly FirehoseEvent[],
  summaries: readonly SessionSummary[],
  nowMs: number,
  windowMs: number,
  /** Names a session the summaries do not cover (the session directory). */
  lookup?: (ref: { id: string; source?: string }) => SessionLike | undefined,
): Lane[] {
  const start = nowMs - windowMs;
  const acc = new Map<string, Acc>();
  const laneFor = (id: string, label: string): Acc => {
    let l = acc.get(id);
    if (!l) {
      l = { id, label, state: "", lastAt: NaN, since: NaN, ticks: [], spans: [] };
      acc.set(id, l);
    }
    return l;
  };

  for (const ev of events) {
    if (!ev.session_id) continue;
    const t = Date.parse(ev.time);
    if (Number.isNaN(t)) continue;
    const l = laneFor(ev.session_id, ev.agent || ev.source);
    if (isTransition(ev)) {
      if (ev.payload?.state === "needs_input" && t >= start) l.ticks.push({ at: t, kind: "needs" });
      continue;
    }
    l.lastAt = later(l.lastAt, t);
    if (t >= start) {
      const failed = ev.severity === "error" || ev.category === "error";
      l.ticks.push({ at: t, kind: failed ? "error" : "event" });
    }
  }
  const calls = collectCalls(events);
  for (const s of summaries) {
    if (!s.id) continue;
    const ref = decodeLaneId(s.id);
    // The lane keeps its composite key; only the name is made from the native id.
    const named = sessionName({ ...s, id: ref.id, source: ref.source ?? s.source });
    const l = laneFor(s.id, named);
    l.label = named;
    if (typeof s.state === "string") l.state = s.state;
    l.reason = s.state_reason;
    l.since = Date.parse(s.state_since ?? "");
    const last = Date.parse(s.last_time);
    if (!Number.isNaN(last)) l.lastAt = later(l.lastAt, last);
  }

  for (const sp of calls) {
    if (sp.start === undefined) continue;
    const l = acc.get(sp.session)!;
    let to = sp.end;
    let open = false;
    if (to === undefined || to < sp.start) {
      // An unfinished call runs to now only while the engine still says the
      // session is working; otherwise it ends at the session's last report.
      open = l.state === "working" || l.state === "";
      to = open || Number.isNaN(l.lastAt) ? nowMs : l.lastAt;
      to = Math.min(to, sp.start + MAX_OPEN_SPAN_MS);
    }
    if (to < start) continue;
    l.spans.push({ from: Math.max(sp.start, start), to, open });
  }

  // A lane no summary covers is named by the directory when it knows the session.
  const covered = new Set(summaries.map((s) => s.id));
  for (const l of acc.values()) {
    if (covered.has(l.id)) continue;
    const ref = decodeLaneId(l.id);
    const known = ref.source ? lookup?.({ id: ref.id, source: ref.source }) : undefined;
    if (known) l.label = sessionName(known);
  }
  const lanes = [...acc.values()].filter((l) => stateFresh(l.state, lastReported(l.lastAt, l.since, l.state), nowMs));
  lanes.sort((a, b) => {
    const an = a.state === "needs_input";
    const bn = b.state === "needs_input";
    if (an !== bn) return an ? -1 : 1;
    if (an) {
      const d = (Number.isNaN(a.since) ? Infinity : a.since) - (Number.isNaN(b.since) ? Infinity : b.since);
      if (d !== 0 && Number.isFinite(d)) return d;
    }
    const d = (Number.isNaN(b.lastAt) ? -Infinity : b.lastAt) - (Number.isNaN(a.lastAt) ? -Infinity : a.lastAt);
    if (d !== 0 && Number.isFinite(d)) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const shown = lanes.slice(0, LANE_CAP);
  // Qualified lanes that share a name carry their source and short id.
  const keyed = shown.filter((l) => l.id.includes(SEP)).map((l) => [l.id, l.label] as const);
  return shown.map(({ since: _since, ...lane }) => {
    const ref = decodeLaneId(lane.id);
    const label = lane.label || (ref.source ? `${ref.source} · ${idLabel(ref.id)}` : idLabel(ref.id));
    return { ...lane, label: lane.id.includes(SEP) ? disambiguateSessionLabel(lane.id, label, keyed) : label };
  });
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const STEPS_MS = [10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS];
const MIN_LABEL_PX = 80;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type AxisTick = { at: number; label: string };

function clockLabel(at: number, withSeconds: boolean, withDate: boolean, clock: boolean): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (!clock) return date;
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const time = withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
  return withDate ? `${date} ${time}` : time;
}

/**
 * Whole clock times inside the window, so labels slide left as time passes. Windows of a day or
 * more get dated labels; steps of a day or more sit on local midnights.
 */
export function axisTicks(nowMs: number, windowMs: number, widthPx: number): AxisTick[] {
  const pxPerMs = widthPx / windowMs;
  const step = STEPS_MS.find((s) => s * pxPerMs >= MIN_LABEL_PX) ?? STEPS_MS[STEPS_MS.length - 1];
  const withSeconds = step < 60_000;
  const withDate = windowMs >= DAY_MS || step >= 12 * HOUR_MS;
  const out: AxisTick[] = [];
  const start = nowMs - windowMs;
  if (step >= DAY_MS) {
    const d = new Date(start);
    d.setHours(0, 0, 0, 0);
    for (; d.getTime() < nowMs; d.setDate(d.getDate() + 1)) {
      if (d.getTime() >= start) out.push({ at: d.getTime(), label: clockLabel(d.getTime(), false, true, false) });
    }
    return out;
  }
  for (let at = Math.ceil(start / step) * step; at < nowMs; at += step) {
    out.push({ at, label: clockLabel(at, withSeconds, withDate, true) });
  }
  return out;
}
