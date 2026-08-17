// Pure feed state: bounded buffer, pause/unread, filters, and burst
// coalescing. Semantics mirror the Go viewer (internal/store) so both
// clients agree on what the timeline shows.

import type { FirehoseEvent } from "./api";

export interface Row {
  event: FirehoseEvent;
  count: number;
}

export interface Filter {
  category?: string;
  source?: string;
  text?: string;
}

const CORRELATION_WINDOW_MS = 5000;

function metadataKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { sha256?: unknown }).sha256 === "string") {
    return `sha256:${(value as { sha256: string }).sha256}`;
  }
  return null;
}

function correlationKey(ev: FirehoseEvent): string | null {
  const phase = metadataKey(ev.payload?.phase);
  const tool = metadataKey(ev.payload?.tool_name);
  if (!ev.session_id || !ev.turn_id || !ev.call_id ||
      !phase || !tool) {
    return null;
  }
  return `${ev.session_id}\0${ev.turn_id}\0${ev.call_id}\0${phase}\0${tool}`;
}

/**
 * Coalesces replayed ids and dual hook/rollout observations with the same
 * native correlation fields. Distinct activity is never burst-grouped.
 */
export function coalesce(evs: FirehoseEvent[], windowMs = CORRELATION_WINDOW_MS): Row[] {
  const rows: Row[] = [];
  const seenIds = new Set<string>();
  const correlated = new Map<string, number>();
  for (const ev of evs) {
    if (ev.id && seenIds.has(ev.id)) continue;
    if (ev.id) seenIds.add(ev.id);

    const correlatedKey = correlationKey(ev);
    if (correlatedKey) {
      const index = correlated.get(correlatedKey);
      if (index !== undefined) {
        const row = rows[index];
        const gap = Math.abs(Date.parse(ev.time) - Date.parse(row.event.time));
        if (!Number.isNaN(gap) && gap <= windowMs) {
          row.event = ev;
          row.count++;
          continue;
        }
      }
    }

    rows.push({ event: ev, count: 1 });
    if (correlatedKey) correlated.set(correlatedKey, rows.length - 1);
  }
  return rows;
}

function matches(ev: FirehoseEvent, f: Filter): boolean {
  if (f.category && ev.category !== f.category) return false;
  if (f.source && ev.source !== f.source) return false;
  if (f.text && !(ev.summary ?? "").toLowerCase().includes(f.text.toLowerCase())) return false;
  return true;
}

export class FeedState {
  private buf: FirehoseEvent[] = [];
  private seenIds = new Set<string>();
  private frozen: FirehoseEvent[] | null = null;
  private filter: Filter = {};
  private seenSources: string[] = [];
  paused = false;
  unread = 0;

  constructor(private cap = 5000) {}

  push(ev: FirehoseEvent): void {
    if (ev.id && this.seenIds.has(ev.id)) return;
    if (ev.id) this.seenIds.add(ev.id);
    this.buf.push(ev);
    if (this.buf.length > this.cap) {
      const removed = this.buf.splice(0, this.buf.length - this.cap);
      for (const old of removed) {
        if (old.id) this.seenIds.delete(old.id);
      }
    }
    if (ev.source && !this.seenSources.includes(ev.source)) {
      this.seenSources.push(ev.source);
    }
    if (this.paused) {
      this.unread++;
    }
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.unread = 0;
    this.frozen = [...this.buf];
  }

  resume(): void {
    this.paused = false;
    this.unread = 0;
    this.frozen = null;
  }

  setFilter(f: Filter): void {
    this.filter = f;
  }

  getFilter(): Filter {
    return { ...this.filter };
  }

  sources(): string[] {
    return [...this.seenSources];
  }

  /** Visible rows: filtered then coalesced, oldest first. */
  rows(): Row[] {
    const source = this.frozen ?? this.buf;
    return coalesce(source.filter((ev) => matches(ev, this.filter)));
  }
}
