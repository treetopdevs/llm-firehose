import type { AttentionEvidence, AttentionSession } from "./api";
import { stateFresh } from "./spark";

// Who needs you, decided once from /attention so every view agrees with the
// strip: only a captured request or failure the engine still holds pending.

/** The source's own clock when captured, else the envelope time. */
export function evidenceTime(ev: AttentionEvidence | undefined): number {
  return ev ? Date.parse(ev.source_time ?? ev.time) : NaN;
}

/** A pending episode that is still plausible; days-old requests do not lead. */
export function pendingNow(s: AttentionSession, nowMs: number): boolean {
  const since = evidenceTime(s.pending);
  if (!Number.isFinite(since)) return false;
  const last = evidenceTime(s.last);
  return stateFresh("needs_input", Number.isFinite(last) ? Math.max(since, last) : since, nowMs);
}

export function isFailure(s: AttentionSession): boolean {
  return s.pending?.kind === "failure" || s.state === "failed";
}

/** NEEDS YOU or FAILED for a live pending episode, else the reported state. */
export function needsLabel(s: AttentionSession, nowMs: number): string {
  if (!pendingNow(s, nowMs)) return s.state;
  return isFailure(s) ? "FAILED" : "NEEDS YOU";
}
