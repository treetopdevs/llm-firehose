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

const COALESCE_WINDOW_MS = 2000;

function groupKey(ev: FirehoseEvent): string {
  return `${ev.source}\0${ev.session_id ?? ""}\0${ev.category}\0${ev.name ?? ""}`;
}

/**
 * Groups consecutive events with the same source, session, category, and
 * name when each arrives within windowMs of the previous one. The latest
 * event represents the group.
 */
export function coalesce(evs: FirehoseEvent[], windowMs = COALESCE_WINDOW_MS): Row[] {
  const rows: Row[] = [];
  for (const ev of evs) {
    const last = rows[rows.length - 1];
    if (last && groupKey(last.event) === groupKey(ev)) {
      const gap = Date.parse(ev.time) - Date.parse(last.event.time);
      if (!Number.isNaN(gap) && gap <= windowMs) {
        last.event = ev;
        last.count++;
        continue;
      }
    }
    rows.push({ event: ev, count: 1 });
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
  private frozen: FirehoseEvent[] | null = null;
  private filter: Filter = {};
  private seenSources: string[] = [];
  paused = false;
  unread = 0;

  constructor(private cap = 5000) {}

  push(ev: FirehoseEvent): void {
    this.buf.push(ev);
    if (this.buf.length > this.cap) {
      this.buf.splice(0, this.buf.length - this.cap);
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
