// Sparklines and the session band's small vocabulary. Pure functions; the Go
// viewer (internal/tui/derive.go) uses the same encodings so both clients draw
// the same picture of the same session.

import type { FirehoseEvent, SessionSummary } from "./api";

export const BAND_BUCKETS = 10;
export const BAND_BUCKET_MS = 30_000;
/** A session quiet for longer leaves the live views unless its engine state is still plausible. */
export const LIVE_WINDOW_MS = 10 * 60_000;
/** Engine state is trusted only while it is still plausible; past this the session is a ghost. */
export const NEEDS_STALE_MS = 24 * 3_600_000;
export const WORKING_STALE_MS = 30 * 60_000;

const GLYPHS = [..."▁▂▃▄▅▆▇█"];

export function isTransition(ev: FirehoseEvent): boolean {
  return ev.source === "firehose" && ev.name === "state.transition";
}

/** Whether a session still belongs on screen given its engine state and when it last reported. */
export function stateFresh(state: string | undefined, lastAtMs: number, nowMs: number): boolean {
  if (!Number.isFinite(lastAtMs)) return false;
  const age = nowMs - lastAtMs;
  switch (state) {
    case "needs_input":
      return age <= NEEDS_STALE_MS;
    case "working":
      return age <= WORKING_STALE_MS;
    default:
      return age <= LIVE_WINDOW_MS;
  }
}

/**
 * When a session last gave evidence of life, for freshness checks: its last
 * event, or its state change when the engine asserts it is working or waiting.
 * Idle and done are absences, not reports: a daemon restart stamps every
 * historical session idle, and that must not make hundreds of them live.
 */
export function lastReported(lastAtMs: number, sinceMs: number, state: string | undefined): number {
  const asserted = state === "needs_input" || state === "working";
  if (!Number.isFinite(lastAtMs)) return sinceMs;
  if (!Number.isFinite(sinceMs) || !asserted) return lastAtMs;
  return Math.max(lastAtMs, sinceMs);
}

function lastReportedOf(s: SessionSummary): number {
  return lastReported(Date.parse(s.last_time), Date.parse(s.state_since ?? ""), s.state);
}

/** A needs-you state is only worth leading with while it is still plausible. */
export function needsYouNow(s: SessionSummary, nowMs: number): boolean {
  return s.state === "needs_input" && stateFresh(s.state, lastReportedOf(s), nowMs);
}

/** Needs-you first (longest wait first), then most recent activity. */
export function bySupervision(nowMs: number) {
  return (a: SessionSummary, b: SessionSummary): number => {
    const an = needsYouNow(a, nowMs);
    const bn = needsYouNow(b, nowMs);
    if (an !== bn) return an ? -1 : 1;
    if (an) {
      const d = Date.parse(a.state_since ?? "") - Date.parse(b.state_since ?? "");
      if (Number.isFinite(d) && d !== 0) return d;
    }
    const d = Date.parse(b.last_time) - Date.parse(a.last_time);
    if (Number.isFinite(d) && d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** Events per bucket for every session, oldest bucket first. Transitions are not activity. */
export function bucketCountsBySession(
  events: readonly FirehoseEvent[],
  nowMs: number,
  buckets = BAND_BUCKETS,
  bucketMs = BAND_BUCKET_MS,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const ev of events) {
    if (!ev.session_id || isTransition(ev)) continue;
    const t = Date.parse(ev.time);
    if (Number.isNaN(t)) continue;
    const idx = buckets - 1 - Math.floor(Math.max(0, nowMs - t) / bucketMs);
    if (idx < 0 || idx >= buckets) continue;
    let counts = out.get(ev.session_id);
    if (!counts) {
      counts = new Array<number>(buckets).fill(0);
      out.set(ev.session_id, counts);
    }
    counts[idx]++;
  }
  return out;
}

export function bucketCounts(
  events: readonly FirehoseEvent[],
  sessionId: string,
  nowMs: number,
  buckets = BAND_BUCKETS,
  bucketMs = BAND_BUCKET_MS,
): number[] {
  return bucketCountsBySession(events, nowMs, buckets, bucketMs).get(sessionId) ?? new Array<number>(buckets).fill(0);
}

/** Draws counts on a shared scale so shapes compare across rows. Zero is blank: a gap is the signal. */
export function sparkline(counts: readonly number[], scale: number): string {
  let out = "";
  for (const n of counts) {
    if (n <= 0 || scale <= 0) {
      out += " ";
      continue;
    }
    const level = Math.min(GLYPHS.length, Math.max(1, Math.ceil((n * GLYPHS.length) / scale)));
    out += GLYPHS[level - 1];
  }
  return out;
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (!(s >= 1)) return "0s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable hue in [0, 360) so one session keeps one color across panels. */
export function sessionHue(id: string): number {
  return hashString(id) % 360;
}
