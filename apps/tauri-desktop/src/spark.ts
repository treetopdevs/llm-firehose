// Sparklines and the session band's small vocabulary. Pure functions; the Go
// viewer (internal/tui/derive.go) uses the same encodings so both clients draw
// the same picture of the same session.

import type { FirehoseEvent } from "./api";

export const BAND_BUCKETS = 10;
export const BAND_BUCKET_MS = 30_000;

const GLYPHS = [..."▁▂▃▄▅▆▇█"];

export function isTransition(ev: FirehoseEvent): boolean {
  return ev.source === "firehose" && ev.name === "state.transition";
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
