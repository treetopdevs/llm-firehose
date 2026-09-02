import type { FirehoseEvent, SessionSummary } from "../../api";
import { workspaceLabel } from "../../format";
import { bySupervision, isTransition, lastReported, needsYouNow, stateFresh } from "../../spark";

/** The bar is full at ten minutes; past that the label carries the number. */
export const DWELL_MAX_MS = 10 * 60_000;
/** The hairline a waiting session should not cross. */
export const DWELL_HAIRLINE_MS = 5 * 60_000;
export const DWELL_CAP = 24;

export type DwellRow = {
  id: string;
  label: string;
  where: string;
  state: string;
  needs: boolean;
  dwellMs: number;
  /** Bar length as a fraction of DWELL_MAX_MS, clamped to 1. */
  fraction: number;
  text: string;
  hasError: boolean;
};

function sinceMs(s: SessionSummary): number {
  const since = Date.parse(s.state_since ?? "");
  return Number.isFinite(since) ? since : Date.parse(s.last_time);
}

/**
 * One bar per live session: time in its current state, needs-you first and
 * longest wait first. The same staleness rule as the band and lanes decides
 * what is live.
 */
export function buildDwell(summaries: readonly SessionSummary[], nowMs: number): { rows: DwellRow[]; more: number } {
  const live = summaries.filter(
    (s) => !!s.id && stateFresh(s.state, lastReported(Date.parse(s.last_time), Date.parse(s.state_since ?? "")), nowMs),
  );
  live.sort(bySupervision(nowMs));
  const rows = live.slice(0, DWELL_CAP).map((s): DwellRow => {
    const since = sinceMs(s);
    const dwellMs = Number.isFinite(since) ? Math.max(0, nowMs - since) : 0;
    const needs = needsYouNow(s, nowMs);
    return {
      id: s.id,
      label: s.agent || s.source,
      where: workspaceLabel(s.repo, s.cwd),
      state: s.state ?? "",
      needs,
      dwellMs,
      fraction: Math.min(1, dwellMs / DWELL_MAX_MS),
      text: needs && s.state_reason ? s.state_reason : (s.last_summary ?? ""),
      hasError: !!s.has_error,
    };
  });
  return { rows, more: live.length - rows.length };
}

/** Restarts a session's dwell from a live state.transition; unknown sessions wait for the next fetch. */
export function applyTransition(summaries: SessionSummary[], ev: FirehoseEvent): SessionSummary[] {
  if (!isTransition(ev) || !ev.session_id) return summaries;
  const state = ev.payload?.state;
  if (typeof state !== "string" || state === "") return summaries;
  const idx = summaries.findIndex((s) => s.id === ev.session_id);
  if (idx < 0) return summaries;
  const reason = typeof ev.payload?.reason === "string" ? ev.payload.reason : undefined;
  const next = [...summaries];
  next[idx] = { ...next[idx], state, state_since: ev.time, state_reason: reason };
  return next;
}
