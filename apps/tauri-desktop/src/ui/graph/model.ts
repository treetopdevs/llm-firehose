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
/** Iterative Kahn ranking follows parenthood, never timestamps. Absent parents remain boundaries. */
export function layoutGraph(nodes: GraphNode[], workspaces: Anchor[]) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const incoming = new Map(nodes.map((n) => [n.key, 0]));
  const ranks = new Map<string, number>();
  for (const n of nodes)
    for (const p of n.parents)
      if (byKey.has(p)) incoming.set(p, incoming.get(p)! + 1);
  const queue = nodes
    .filter((n) => incoming.get(n.key) === 0)
    .map((n) => n.key);
  let i = 0;
  while (i < queue.length) {
    const k = queue[i++];
    for (const p of byKey.get(k)!.parents) {
      if (!byKey.has(p)) continue;
      ranks.set(p, Math.max(ranks.get(p) ?? 0, (ranks.get(k) ?? 0) + 1));
      incoming.set(p, incoming.get(p)! - 1);
      if (incoming.get(p) === 0) queue.push(p);
    }
  }
  const levels = new Map<number, string[]>();
  for (const n of nodes) {
    const r = ranks.get(n.key) ?? 0;
    levels.set(r, [...(levels.get(r) ?? []), n.key]);
  }
  const points = new Map<string, Point>();
  const labels = new Map<string, Point>();
  let y = 45;
  let width = 600;
  for (const [, keys] of [...levels].sort((a, b) => a[0] - b[0])) {
    let height = 22;
    let nextX = 45;
    keys.forEach((k) => {
      const x = nextX;
      points.set(k, { x, y });
      const attached = workspaces.filter((w) => w.revision_key === k);
      attached.forEach((w, j) =>
        labels.set(w.id, { x: x + 22, y: y + j * 35 - 15 }),
      );
      height = Math.max(
        height,
        attached.length ? attached.length * 35 + 20 : 22,
      );
      nextX += attached.length ? 320 : 38;
      width = Math.max(width, x + (attached.length ? 325 : 40));
    });
    y += height;
  }
  for (const w of workspaces)
    if (!labels.has(w.id)) {
      labels.set(w.id, { x: 45, y });
      y += 40;
    }
  const edges = nodes.flatMap((n) =>
    n.parents
      .filter((p) => byKey.has(p))
      .map((p) => ({ child: n.key, parent: p })),
  );
  return {
    points,
    labels,
    edges,
    boundaries: nodes
      .filter((n) => n.parents.some((p) => !byKey.has(p)))
      .map((n) => n.key),
    width,
    height: y + 30,
  };
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
