// Marey-style lanes: every live session on one wall-clock axis ending at now.
// Pure derivation from the live buffer plus /sessions summaries; the engine's
// attention state is read, never re-folded (internal/tui/derive.go mirrors this).

import type { FirehoseEvent, SessionSummary } from "../../api";
import { isTransition, lastReported, stateFresh } from "../../spark";

export const LANE_WINDOWS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
/** Past this an unfinished tool call cannot honestly be drawn as still running. */
export const MAX_OPEN_SPAN_MS = 30 * 60_000;
export const LANE_CAP = 12;

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

function later(current: number, candidate: number): number {
  return Number.isNaN(current) || candidate > current ? candidate : current;
}

export function buildLanes(
  events: readonly FirehoseEvent[],
  summaries: readonly SessionSummary[],
  nowMs: number,
  windowMs: number,
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

  type Span = { session: string; start?: number; end?: number };
  const spans = new Map<string, Span>();
  const order: string[] = [];
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
    const phase = ev.payload?.phase;
    if (!ev.call_id || (phase !== "start" && phase !== "end")) continue;
    const key = `${ev.session_id}\0${ev.call_id}`;
    let sp = spans.get(key);
    if (!sp) {
      sp = { session: ev.session_id };
      spans.set(key, sp);
      order.push(key);
    }
    if (phase === "start" && sp.start === undefined) sp.start = t;
    else if (phase === "end" && sp.end === undefined) sp.end = t;
  }
  for (const s of summaries) {
    if (!s.id) continue;
    const l = laneFor(s.id, s.agent || s.source);
    if (typeof s.state === "string") l.state = s.state;
    l.reason = s.state_reason;
    l.since = Date.parse(s.state_since ?? "");
    const last = Date.parse(s.last_time);
    if (!Number.isNaN(last)) l.lastAt = later(l.lastAt, last);
  }

  for (const key of order) {
    const sp = spans.get(key)!;
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

  const lanes = [...acc.values()].filter((l) => stateFresh(l.state, lastReported(l.lastAt, l.since), nowMs));
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
  return lanes.slice(0, LANE_CAP).map(({ since: _since, ...lane }) => ({
    ...lane,
    label: lane.label || lane.id.slice(0, 12),
  }));
}

const STEPS_MS = [10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000];
const MIN_LABEL_PX = 80;

export type AxisTick = { at: number; label: string };

function clockLabel(at: number, withSeconds: boolean): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

/** Whole clock times inside the window, so labels slide left as time passes. */
export function axisTicks(nowMs: number, windowMs: number, widthPx: number): AxisTick[] {
  const pxPerMs = widthPx / windowMs;
  const step = STEPS_MS.find((s) => s * pxPerMs >= MIN_LABEL_PX) ?? STEPS_MS[STEPS_MS.length - 1];
  const withSeconds = step < 60_000;
  const out: AxisTick[] = [];
  for (let at = Math.ceil((nowMs - windowMs) / step) * step; at < nowMs; at += step) {
    out.push({ at, label: clockLabel(at, withSeconds) });
  }
  return out;
}
