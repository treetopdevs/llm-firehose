import type { FirehoseEvent } from "../../api";

export type ReplayRoute = {events: FirehoseEvent[]; missingIds: number; duplicates: number; conflicts: number; invalidTimes: number};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}

/** Exact scope before identity normalization. Duplicates count extra records;
 * conflicts count captured IDs excluded entirely. Invalid clocks sort last
 * and remain inspectable, never supplying inferred timing or causality. */
export function buildReplayRoute(input: readonly FirehoseEvent[], source: string, session: string): ReplayRoute {
  const route: ReplayRoute = {events: [], missingIds: 0, duplicates: 0, conflicts: 0, invalidTimes: 0};
  const unique = new Map<string, {event: FirehoseEvent; fingerprint: string; conflict: boolean}>();
  for (const event of input) {
    if (event.source !== source || event.session_id !== session) continue;
    if (typeof event.id !== "string" || !event.id.trim()) { route.missingIds++; continue; }
    const fingerprint = canonical(event);
    const prior = unique.get(event.id);
    if (!prior) unique.set(event.id, {event, fingerprint, conflict: false});
    else {
      route.duplicates++;
      if (prior.fingerprint !== fingerprint && !prior.conflict) { prior.conflict = true; route.conflicts++; }
    }
  }
  const timed = [...unique.values()].filter(item => !item.conflict).map(({event}) => {
    const at = Date.parse(event.time);
    if (!Number.isFinite(at)) route.invalidTimes++;
    return {event, at: Number.isFinite(at) ? at : Infinity};
  });
  timed.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) || compare(a.event.id, b.event.id));
  route.events = timed.map(item => item.event);
  return route;
}
