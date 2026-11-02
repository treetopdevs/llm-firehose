// One event row model for Fleet Events, Project Events and the Worktree rung.
// Two adapters (the live feed ring and the durable timeline) map into the same
// EventRow so a single renderer can show either. Adapters are read views: the
// owner of each state keeps its network and mutation.

import type { FirehoseEvent } from "../../api";
import { coalesce, type FeedState } from "../../state";
import type { TimelineFilter, TimelineState } from "../graph/model";

export interface EventRow {
  /** Logical identity, stable across coalescing (the first event's id). */
  key: string;
  /** The latest event folded into the row; event.id is its exact id. */
  event: FirehoseEvent;
  time: string;
  source: string;
  /** `${source}\0${session_id}`, the same form the timeline session filter uses; "" when the event has no session. */
  sessionRef: string;
  category: string;
  summary: string;
  count: number;
}

export interface EventQuery {
  source?: string;
  session?: string;
  category?: string;
  text?: string;
}

export interface EventWindow {
  from?: number;
  to?: number;
}

export interface EventSource {
  rows(q: EventQuery, w?: EventWindow): EventRow[];
  sources(): string[];
  sessions(): string[];
  readonly paused: boolean;
  unread(q: EventQuery, w?: EventWindow): number;
  pause(): void;
  resume(): void;
  /** The owner resets pagination, aborts stale requests and refetches the head. */
  setQuery(q: EventQuery): void;
  readonly hasOlder: boolean;
  loadOlder?(): Promise<void>;
  reload?(): Promise<void>;
  notice(): string;
  readonly order: "oldest-first" | "newest-first";
  readonly pausable: boolean;
  readonly coalesce: boolean;
  readonly renderLimit?: number;
}

export interface EventScope {
  repo?: string;
  workspace?: string;
  window?: EventWindow;
  /** An explicit category filter; it selects that category and lifts the default meta exclusion. */
  category?: string;
}

/** Default policy: meta (capture bookkeeping) events are hidden unless the category filter is set explicitly. */
export function defaultEventPolicy(ev: FirehoseEvent, category?: string): boolean {
  return !!category || ev.category !== "meta";
}

function inWindow(ev: FirehoseEvent, w?: EventWindow): boolean {
  if (!w || (w.from === undefined && w.to === undefined)) return true;
  const t = Date.parse(ev.time);
  if (Number.isNaN(t)) return false;
  return (w.from === undefined || t >= w.from) && (w.to === undefined || t <= w.to);
}

/** Scope events to a repo/worktree association and a time window, then apply the default policy. */
export function scopeEvents(events: readonly FirehoseEvent[], scope: EventScope): FirehoseEvent[] {
  const { repo, workspace } = scope;
  return events.filter(
    (e) =>
      defaultEventPolicy(e, scope.category) &&
      (!scope.category || e.category === scope.category) &&
      (!repo || e.repo_id === repo || e.jj_repo_id === repo) &&
      (!workspace || e.worktree_id === workspace || e.jj_workspace_id === workspace) &&
      inWindow(e, scope.window),
  );
}

function sessionRef(e: FirehoseEvent): string {
  return e.session_id ? `${e.source}\0${e.session_id}` : "";
}

function toRow(event: FirehoseEvent, key: string, count: number): EventRow {
  return {
    key,
    event,
    time: event.time,
    source: event.source,
    sessionRef: sessionRef(event),
    category: event.category,
    summary: event.summary ?? "",
    count,
  };
}

function matchesQuery(e: FirehoseEvent, q: EventQuery): boolean {
  return (
    (!q.source || e.source === q.source) &&
    (!q.session || sessionRef(e) === q.session) &&
    (!q.category || e.category === q.category) &&
    (!q.text || (e.summary ?? "").toLowerCase().includes(q.text.toLowerCase()))
  );
}

function distinct(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))];
}

export interface LiveSourceOptions {
  /** Repo/worktree scope, read at call time. */
  scope?: () => { repo?: string; workspace?: string };
  renderLimit?: number;
}

/** The live feed ring as an EventSource: oldest first, burst-coalesced. */
export function liveSource(feed: FeedState, o: LiveSourceOptions = {}): EventSource {
  const scoped = (events: readonly FirehoseEvent[], q: EventQuery, w?: EventWindow) =>
    scopeEvents(events, { ...o.scope?.(), window: w, category: q.category }).filter((e) => matchesQuery(e, q));
  return {
    rows(q, w) {
      const rows = coalesce(scoped(feed.snapshot(), q, w)).map((r) => toRow(r.event, r.key, r.count));
      return o.renderLimit !== undefined && rows.length > o.renderLimit ? rows.slice(rows.length - o.renderLimit) : rows;
    },
    sources: () => feed.sources(),
    sessions: () => distinct(feed.events().map(sessionRef)),
    get paused() {
      return feed.paused;
    },
    unread: (q, w) => scoped(feed.arrivals(), q, w).length,
    pause: () => feed.pause(),
    resume: () => feed.resume(),
    setQuery() {},
    hasOlder: false,
    notice: () => "",
    order: "oldest-first",
    pausable: true,
    coalesce: true,
    renderLimit: o.renderLimit,
  };
}

type Lazy<T> = T | (() => T);
const read = <T>(v: Lazy<T>): T => (typeof v === "function" ? (v as () => T)() : v);

export interface TimelineViewOptions {
  repo?: Lazy<string | undefined>;
  workspace?: Lazy<string | undefined>;
  hasMore?: Lazy<boolean>;
  loadOlder?: () => Promise<void>;
  reload?: () => Promise<void>;
  notice?: () => string;
  setQuery?: (q: EventQuery) => void;
  pausable?: boolean;
  renderLimit?: number;
  /** Owner-supplied filter options (e.g. known sessions not yet loaded); default is what the state holds. */
  sources?: () => string[];
  sessions?: () => string[];
  /** The owner's own time bound, used when the caller passes none (the graph shows its window in its own state line). */
  window?: () => EventWindow | undefined;
}

/** The durable timeline as a read-only EventSource: newest first, one row per exact id. The graph keeps ownership and network. */
export function timelineView(state: TimelineState, o: TimelineViewOptions = {}): EventSource {
  const filter = (q: EventQuery, w?: EventWindow): TimelineFilter => ({
    repo: read(o.repo),
    workspace: read(o.workspace),
    source: q.source,
    session: q.session,
    category: q.category,
    search: q.text,
    from: (w ?? o.window?.())?.from,
    to: (w ?? o.window?.())?.to,
  });
  let last = "{}";
  return {
    rows(q, w) {
      const rows = state
        .rows(filter(q, w))
        .filter((e) => defaultEventPolicy(e, q.category))
        .map((e) => toRow(e, e.id, 1));
      return o.renderLimit !== undefined ? rows.slice(0, o.renderLimit) : rows;
    },
    sources: () => o.sources?.() ?? distinct(state.all().map((e) => e.source)),
    sessions: () => o.sessions?.() ?? distinct(state.all().map(sessionRef)),
    get paused() {
      return state.paused;
    },
    unread: (q, w) => state.unreadEvents(filter(q, w)).filter((e) => defaultEventPolicy(e, q.category)).length,
    pause: () => state.pause(),
    resume() {
      state.resume();
      void o.reload?.();
    },
    setQuery(q) {
      const next = JSON.stringify([q.source ?? "", q.session ?? "", q.category ?? "", q.text ?? ""]);
      if (next === last) return;
      last = next;
      o.setQuery?.(q);
    },
    get hasOlder() {
      return read(o.hasMore) ?? false;
    },
    loadOlder: o.loadOlder,
    reload: o.reload,
    notice: () => o.notice?.() ?? "",
    order: "newest-first",
    pausable: o.pausable ?? true,
    coalesce: false,
    renderLimit: o.renderLimit,
  };
}
