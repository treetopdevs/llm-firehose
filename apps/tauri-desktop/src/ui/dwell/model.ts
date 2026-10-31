import type { AttentionSession } from "../../api";
import { sessionName, sessionWhere } from "../../format";
import { evidenceTime, isFailure, needsLabel } from "../../needs";
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
  /** Only with includeStalePending: a pending request the freshness rule no longer calls live. */
  stale?: boolean;
};

export type LiveSession = { s: AttentionSession; since: number; last: number; stale?: boolean };

export interface LiveOptions {
  /**
   * Also admit a pending request that is no longer fresh, flagged `stale`, so a days-old
   * request is drawn and labelled rather than dropped (Fleet counts it as the attention
   * strip does). Default false: Dwell's own panel keeps the strict freshness rule.
   */
  includeStalePending?: boolean;
}

/**
 * Sessions still worth showing: the freshness rule behind every live view. A
 * pending request or failure is measured from when it was captured and stays
 * plausible as long as a waiting session does; any other session needs recent
 * evidence for its reported state. Input order is preserved.
 */
export function liveSessions(sessions: readonly AttentionSession[], nowMs: number, opts: LiveOptions = {}): LiveSession[] {
  const live: LiveSession[] = [];
  for (const s of sessions) {
    if (!s.id) continue;
    const last = evidenceTime(s.last);
    const since = s.pending ? evidenceTime(s.pending) : last;
    if (!Number.isFinite(since)) continue;
    // A pending episode stays plausible as long as a waiting session does.
    const freshness = s.pending ? "needs_input" : s.state;
    const lastOrSince = Number.isFinite(last) ? last : since;
    if (!stateFresh(freshness, Math.max(since, lastOrSince), nowMs)) {
      if (opts.includeStalePending && s.pending) live.push({ s, since, last: lastOrSince, stale: true });
      continue;
    }
    live.push({ s, since, last: lastOrSince });
  }
  return live;
}

/**
 * One bar per live session, read from the same /attention snapshot as the
 * strip and inbox so every view agrees on who needs you. A pending request or
 * failure leads, measured from when it was captured; any other session is
 * measured from its last activity. Only captured evidence moves a bar.
 */
export function buildDwell(sessions: readonly AttentionSession[], nowMs: number, opts: LiveOptions = {}): { rows: DwellRow[]; more: number } {
  const live = liveSessions(sessions, nowMs, opts);
  live.sort((a, b) => {
    const an = !!a.s.pending;
    const bn = !!b.s.pending;
    if (an !== bn) return an ? -1 : 1;
    const d = an ? a.since - b.since : b.last - a.last;
    if (d !== 0) return d;
    const ak = sessionKey(a.s);
    const bk = sessionKey(b.s);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
  const rows = live.slice(0, DWELL_CAP).map(({ s, since, stale }): DwellRow => {
    const dwellMs = Math.max(0, nowMs - since);
    const failed = isFailure(s);
    return {
      key: sessionKey(s),
      id: s.id,
      source: s.source,
      label: sessionName(s),
      where: s.title ? [s.agent || s.source, sessionWhere(s).label].filter(Boolean).join(" · ") : sessionWhere(s).label,
      // Every pending row here passed the needs_input freshness rule above.
      status: needsLabel(s, nowMs),
      needs: !!s.pending,
      dwellMs,
      fraction: Math.min(1, dwellMs / DWELL_MAX_MS),
      text: s.pending?.summary || s.uncertainty || s.last.summary || "",
      hasError: failed,
      ...(stale ? { stale: true } : {}),
    };
  });
  return { rows, more: live.length - rows.length };
}

/** Sessions are scoped by source and native id, as /attention scopes them. */
export function sessionKey(s: AttentionSession): string {
  return JSON.stringify([s.source, s.id]);
}
