import type { FirehoseEvent } from "../../api";
import { isTransition } from "../../spark";
export interface GraphNode {
  key: string;
  parents: string[];
  commit_id: string;
  description: string;
  timestamp: string;
  change_id?: string;
  conflicted?: boolean;
}
export interface Anchor {
  id: string;
  revision_key?: string;
}
export interface Point {
  x: number;
  y: number;
}
export function relatives(
  nodes: GraphNode[],
  key: string,
  descendants = false,
) {
  const map = new Map(nodes.map((n) => [n.key, n.parents]));
  if (descendants) {
    map.clear();
    for (const n of nodes)
      for (const p of n.parents) map.set(p, [...(map.get(p) ?? []), n.key]);
  }
  const keys = new Set(nodes.map((n) => n.key));
  const result = new Set<string>();
  const pending = [key];
  while (pending.length) {
    const k = pending.pop()!;
    if (result.has(k)) continue;
    result.add(k);
    for (const p of map.get(k) ?? []) if (keys.has(p)) pending.push(p);
  }
  return result;
}
/**
 * |ancestors(a) ∩ ancestors(b)| over the loaded nodes only. Ancestors include
 * the revision itself (same convention as `relatives`), so a revision that is
 * an ancestor of the other counts itself. Absent revisions contribute nothing.
 */
export function sharedAncestorCount(
  nodes: GraphNode[],
  a: string,
  b: string,
): number {
  const loaded = new Set(nodes.map((n) => n.key));
  if (!loaded.has(a) || !loaded.has(b)) return 0;
  const left = relatives(nodes, a);
  const right = relatives(nodes, b);
  let shared = 0;
  for (const k of left) if (right.has(k) && loaded.has(k)) shared++;
  return shared;
}
export interface TimelineFilter {
  repo?: string;
  workspace?: string;
  source?: string;
  session?: string;
  category?: string;
  search?: string;
  from?: number;
  to?: number;
}
export function orderBy<T>(
  order: readonly string[] | undefined,
  items: readonly T[],
  id: (t: T) => string,
): T[] {
  if (!order || order.length === 0) return [...items];
  const rank = new Map<string, number>();
  order.forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i);
  });
  const rest = order.length;
  return items
    .map((t, i) => ({ t, i, r: rank.get(id(t)) ?? rest }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
}
export function eventWorkspace<T extends { id: string }>(
  ev: FirehoseEvent,
  workspaces: T[],
): T | undefined {
  return workspaces.find(
    (w) => w.id === (ev.jj_workspace_id ?? ev.worktree_id),
  );
}
/**
 * D110: the most events the Events timeline holds, the live feed's ring size
 * (`FeedState(5000)` in main.ts). Past it the far edge is evicted; see merge().
 */
export const TIMELINE_CAP = 5000;
/** How many events one merge evicted from each edge of the time range. */
export interface Eviction {
  older: number;
  newer: number;
}
export class TimelineState {
  constructor(readonly cap = TIMELINE_CAP) {}
  /**
   * The oldest events were evicted at some point, so durable history older than
   * what is held exists and must be paged in again ("Load older" stays offered).
   */
  olderEvicted = false;
  private associations = new Map<
    string,
    { repo_id: string; workspace_id: string }
  >();
  private events = new Map<string, FirehoseEvent>();
  private frozen: FirehoseEvent[] | null = null;
  selected: FirehoseEvent | undefined;
  unread = 0;
  private arrivals = new Set<string>();
  get paused() {
    return this.frozen !== null;
  }
  event(id: string) {
    return this.events.get(id);
  }
  association(e: FirehoseEvent, repo?: string) {
    return (
      this.associations.get(e.id) ?? {
        repo_id:
          repo && repo === e.repo_id ? e.repo_id : (e.jj_repo_id ?? e.repo_id),
        workspace_id:
          repo && repo === e.repo_id
            ? e.worktree_id
            : (e.jj_workspace_id ?? e.worktree_id),
      }
    );
  }
  /**
   * Merge by exact ID. Past the cap, live and head merges evict the oldest
   * events; an `older` page evicts the newest instead, so paging back is not
   * undone by its own merge (a later head refresh restores the newest).
   */
  merge(
    events: readonly FirehoseEvent[],
    associations: Record<
      string,
      { repo_id: string; workspace_id: string }
    > = {},
    opts: { older?: boolean } = {},
  ): Eviction {
    for (const [id, a] of Object.entries(associations))
      this.associations.set(id, a);
    for (const e of events) {
      if (isTransition(e)) continue;
      if (!this.events.has(e.id) && this.paused) {
        this.unread++;
        this.arrivals.add(e.id);
      }
      this.events.set(e.id, e);
    }
    return this.evict(!!opts.older);
  }
  private evict(older: boolean): Eviction {
    const over = this.events.size - this.cap;
    if (over <= 0) return { older: 0, newer: 0 };
    // Oldest first, the reverse of rows(); an unparsable time counts as oldest.
    const keyed = [...this.events.values()].map((e) => {
      const t = Date.parse(e.time);
      return { e, t: Number.isNaN(t) ? -Infinity : t, sub: submillisecond(e.time) };
    });
    keyed.sort((a, b) => a.t - b.t || a.sub - b.sub || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    const gone = older ? keyed.slice(keyed.length - over) : keyed.slice(0, over);
    for (const { e } of gone) {
      this.events.delete(e.id);
      this.associations.delete(e.id);
      if (this.arrivals.delete(e.id)) this.unread = Math.max(0, this.unread - 1);
    }
    if (!older) this.olderEvicted = true;
    return older ? { older: 0, newer: over } : { older: over, newer: 0 };
  }
  select(id: string) {
    this.selected = this.events.get(id);
  }
  pause() {
    if (!this.paused) {
      this.frozen = [...this.events.values()];
      this.unread = 0;
      this.arrivals.clear();
    }
  }
  resume() {
    this.frozen = null;
    this.unread = 0;
    this.arrivals.clear();
  }
  all() {
    return [...this.events.values()];
  }
  private matching(events: FirehoseEvent[], f: TimelineFilter) {
    const ranged = f.from !== undefined || f.to !== undefined;
    return events.filter(
      (e) =>
        (!ranged || this.inRange(e, f)) &&
        (!f.repo || this.association(e, f.repo).repo_id === f.repo) &&
        (!f.workspace ||
          this.association(e, f.repo).workspace_id === f.workspace) &&
        (!f.source || e.source === f.source) &&
        (!f.session || `${e.source}\0${e.session_id}` === f.session) &&
        (!f.category || e.category === f.category) &&
        (!f.search ||
          [e.name, e.summary, e.agent, e.source, e.session_id]
            .join(" ")
            .toLowerCase()
            .includes(f.search.toLowerCase())),
    );
  }
  private inRange(e: FirehoseEvent, f: TimelineFilter) {
    const t = Date.parse(e.time);
    if (Number.isNaN(t)) return false;
    return (
      (f.from === undefined || t >= f.from) && (f.to === undefined || t <= f.to)
    );
  }
  unreadFor(f: TimelineFilter) {
    return this.unreadEvents(f).length;
  }
  /** Arrivals since pause() that match the filter. */
  unreadEvents(f: TimelineFilter) {
    return this.matching(
      this.all().filter((e) => this.arrivals.has(e.id)),
      f,
    );
  }
  rows(f: TimelineFilter) {
    return this.matching(this.frozen ?? this.all(), f).sort(
      (a, b) =>
        Date.parse(b.time) - Date.parse(a.time) ||
        submillisecond(b.time) - submillisecond(a.time) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  }
}

function submillisecond(time: string): number {
  return Number((time.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(3, 9));
}
