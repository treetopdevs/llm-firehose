import type { FirehoseEvent } from "../../api";

export type LoomGroup = {key: string; kind: "call" | "turn" | "prompt" | "message" | "trace" | "request"; id: string; members: string[]};
export type LoomParent = {key: string; parentKey: string; childKey: string; status: "resolved" | "missing" | "conflicting"; evidenceIds: string[]};
export type LoomModel = {events: FirehoseEvent[]; groups: LoomGroup[]; parents: LoomParent[]; omitted: number; duplicates: number; conflicts: number; unsupportedParents: number; invalidTimes: number};
const fields = ["call", "turn", "prompt", "message", "trace", "request"] as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const groupKey = (kind: LoomGroup["kind"], id: string) => JSON.stringify([kind, id]);
const present = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Canonical JSON comparison ignores property insertion order. Any disagreement
 * in a duplicate captured envelope is conservative grounds to exclude that ID. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}

/** Every identifier lives in a distinct namespace inside one exact source/session.
 * Times order receipts only; they never create a relationship or direction. */
export function buildLoom(input: readonly FirehoseEvent[], source: string, session: string): LoomModel {
  const result: LoomModel = {events: [], groups: [], parents: [], omitted: 0, duplicates: 0, conflicts: 0, unsupportedParents: 0, invalidTimes: 0};
  const unique = new Map<string, {event: FirehoseEvent; fingerprint: string; conflict: boolean}>();
  for (const event of input) {
    if (event.source !== source || event.session_id !== session) continue;
    if (!present(event.id)) { result.omitted++; continue; }
    const fingerprint = canonical(event);
    const prior = unique.get(event.id);
    if (!prior) unique.set(event.id, {event, fingerprint, conflict: false});
    else {
      result.duplicates++;
      if (prior.fingerprint !== fingerprint && !prior.conflict) { prior.conflict = true; result.conflicts++; }
    }
  }
  const timed = [...unique.values()].filter(item => !item.conflict).map(({event}) => {
    const time = Date.parse(event.time);
    if (!Number.isFinite(time)) result.invalidTimes++;
    return {event, time: Number.isFinite(time) ? time : Infinity};
  });
  timed.sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? -1 : 1) || compare(a.event.id, b.event.id));
  result.events = timed.map(item => item.event);
  const groups = new Map<string, LoomGroup>();
  const references = new Map<string, Map<string, string[]>>();
  for (const event of result.events) {
    for (const kind of fields) {
      const id = event[`${kind}_id`];
      if (!present(id)) continue;
      const key = groupKey(kind, id);
      let group = groups.get(key);
      if (!group) { group = {key, kind, id, members: []}; groups.set(key, group); }
      group.members.push(event.id);
    }
    if (present(event.parent_id)) {
      if (source === "opencode" && event.name === "message.updated" && present(event.message_id)) {
        const childKey = groupKey("message", event.message_id);
        let childReferences = references.get(childKey);
        if (!childReferences) { childReferences = new Map(); references.set(childKey, childReferences); }
        const evidence = childReferences.get(event.parent_id) ?? [];
        evidence.push(event.id);
        childReferences.set(event.parent_id, evidence);
      } else result.unsupportedParents++;
    }
    if (present(event.upstream_event_id)) result.unsupportedParents++;
  }
  for (const [childKey, childReferences] of references) {
    for (const [parentId, evidenceIds] of childReferences) {
      const parentKey = groupKey("message", parentId);
      if (!groups.has(parentKey)) groups.set(parentKey, {key: parentKey, kind: "message", id: parentId, members: []});
      const status = childReferences.size > 1 || parentKey === childKey ? "conflicting" : groups.get(parentKey)!.members.length ? "resolved" : "missing";
      result.parents.push({key: JSON.stringify(["parent", parentKey, childKey]), parentKey, childKey, status, evidenceIds});
    }
  }
  result.parents.sort((a, b) => compare(a.key, b.key));
  result.groups = [...groups.values()].sort((a, b) => compare(a.key, b.key));
  return result;
}

/** One hop from the focus observation's own groups; never a recursive crawl. */
export function loomNeighborhood(model: LoomModel, eventId: string): {groups: LoomGroup[]; parents: LoomParent[]} {
  const direct = new Set(model.groups.filter(g => g.members.includes(eventId)).map(g => g.key));
  const parents = model.parents.filter(p => direct.has(p.parentKey) || direct.has(p.childKey));
  const visible = new Set(direct);
  for (const parent of parents) { visible.add(parent.parentKey); visible.add(parent.childKey); }
  return {groups: model.groups.filter(g => visible.has(g.key)), parents};
}

export type LoomDirection = "upstream" | "downstream" | "both";
/** Follow native references only. Unresolved edges remain visible terminal
 * evidence; they never carry traversal into another group. */
export function loomTraversal(model: LoomModel, eventId: string, direction: LoomDirection, depth: number): {groups: LoomGroup[]; parents: LoomParent[]} {
  const limit = Number.isFinite(depth) ? Math.max(1, Math.min(4, Math.floor(depth))) : 1;
  const direct = model.groups.filter(g => g.members.includes(eventId)).map(g => g.key);
  const visible = new Set(direct), visited = new Set(direct), edges = new Set<string>();
  let frontier = new Set(direct);
  for (let hop = 0; hop < limit && frontier.size; hop++) {
    const next = new Set<string>();
    for (const reference of model.parents) {
      const targets: string[] = [];
      if (direction !== "downstream" && frontier.has(reference.childKey)) targets.push(reference.parentKey);
      if (direction !== "upstream" && frontier.has(reference.parentKey)) targets.push(reference.childKey);
      if (!targets.length) continue;
      edges.add(reference.key);
      for (const target of targets) {
        visible.add(target);
        if (reference.status === "resolved" && !visited.has(target)) next.add(target);
      }
    }
    for (const key of next) visited.add(key);
    frontier = next;
  }
  return {groups: model.groups.filter(g => visible.has(g.key)), parents: model.parents.filter(p => edges.has(p.key))};
}
