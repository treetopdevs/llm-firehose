import type { AttentionEvidence, AttentionSession } from "../../api";
import { workspaceLabel } from "../../format";
import { stateFresh } from "../../spark";

/** The bar is full at ten minutes; past that the label carries the number. */
export const DWELL_MAX_MS = 10 * 60_000;
/** The hairline a waiting session should not cross. */
export const DWELL_HAIRLINE_MS = 5 * 60_000;
export const DWELL_CAP = 24;

export type DwellRow = {
  /** Sessions are scoped by source and native id, as /attention scopes them. */
  key: string;
  id: string;
  source: string;
  label: string;
  where: string;
  /** NEEDS YOU, FAILED, or the attention state as reported. */
  status: string;
  needs: boolean;
  dwellMs: number;
  /** Bar length as a fraction of DWELL_MAX_MS, clamped to 1. */
  fraction: number;
  text: string;
  hasError: boolean;
};

/** The source's own clock when captured, else the envelope time. */
export function evidenceTime(ev: AttentionEvidence | undefined): number {
  return ev ? Date.parse(ev.source_time ?? ev.time) : NaN;
}

type Live = { s: AttentionSession; since: number; last: number };

/**
 * One bar per live session, read from the same /attention snapshot as the
 * strip and inbox so every view agrees on who needs you. A pending request or
 * failure leads, measured from when it was captured; any other session is
 * measured from its last activity. Only captured evidence moves a bar.
 */
export function buildDwell(sessions: readonly AttentionSession[], nowMs: number): { rows: DwellRow[]; more: number } {
  const live: Live[] = [];
  for (const s of sessions) {
    if (!s.id) continue;
    const last = evidenceTime(s.last);
    const since = s.pending ? evidenceTime(s.pending) : last;
    if (!Number.isFinite(since)) continue;
    // A pending episode stays plausible as long as a waiting session does.
    const freshness = s.pending ? "needs_input" : s.state;
    if (!stateFresh(freshness, Math.max(since, Number.isFinite(last) ? last : since), nowMs)) continue;
    live.push({ s, since, last: Number.isFinite(last) ? last : since });
  }
  live.sort((a, b) => {
    const an = !!a.s.pending;
    const bn = !!b.s.pending;
    if (an !== bn) return an ? -1 : 1;
    const d = an ? a.since - b.since : b.last - a.last;
    if (d !== 0) return d;
    const ak = keyOf(a.s);
    const bk = keyOf(b.s);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const rows = live.slice(0, DWELL_CAP).map(({ s, since }): DwellRow => {
    const dwellMs = Math.max(0, nowMs - since);
    const failed = s.pending?.kind === "failure" || s.state === "failed";
    return {
      key: keyOf(s),
      id: s.id,
      source: s.source,
      label: s.agent || s.source,
      where: workspaceLabel(s.repo, s.cwd),
      status: s.pending ? (failed ? "FAILED" : "NEEDS YOU") : s.state,
      needs: !!s.pending,
      dwellMs,
      fraction: Math.min(1, dwellMs / DWELL_MAX_MS),
      text: s.pending?.summary || s.uncertainty || s.last.summary || "",
      hasError: failed,
    };
  });
  return { rows, more: live.length - rows.length };
}

function keyOf(s: AttentionSession): string {
  return JSON.stringify([s.source, s.id]);
}
