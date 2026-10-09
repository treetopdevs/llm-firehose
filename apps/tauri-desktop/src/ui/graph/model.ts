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
}
export function eventWorkspace<T extends { id: string }>(
  ev: FirehoseEvent,
  workspaces: T[],
): T | undefined {
  return workspaces.find(
    (w) => w.id === (ev.jj_workspace_id ?? ev.worktree_id),
  );
}
export class TimelineState {
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
  merge(
    events: readonly FirehoseEvent[],
    associations: Record<
      string,
      { repo_id: string; workspace_id: string }
    > = {},
  ) {
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
    return events.filter(
      (e) =>
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
  unreadFor(f: TimelineFilter) {
    return this.matching(
      this.all().filter((e) => this.arrivals.has(e.id)),
      f,
    ).length;
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
