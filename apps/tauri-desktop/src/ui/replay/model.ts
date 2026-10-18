import type { FirehoseEvent } from "../../api";

export type ReplayRoute = {events: FirehoseEvent[]; missingIds: number; duplicates: number; conflicts: number; invalidTimes: number};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}

/** Strict stored RFC3339 clock, retaining sub-millisecond ordering. */
export function replayClock(value: string): {seconds: number; fraction: string} | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return;
  const [,year,month,day,hour,minute,second,fraction = "",zone] = m;
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
  const milliseconds = Date.parse(base);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0,19) !== base.slice(0,19)) return;
  const zh = zone === "Z" ? 0 : Number(zone.slice(1,3)), zm = zone === "Z" ? 0 : Number(zone.slice(4,6));
  if (zh > 23 || zm > 59) return;
  const offset = (zh * 60 + zm) * (zone[0] === "-" ? -1 : 1);
  return {seconds: milliseconds / 1000 - offset * 60, fraction};
}

export const replayTimeLabel = (time: string): string => replayClock(time) ? time : "Undated";

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
    const at = replayClock(event.time);
    if (!at) route.invalidTimes++;
    return {event, at};
  });
  timed.sort((a, b) => (a.at && b.at ? a.at.seconds - b.at.seconds || compare(a.at.fraction.padEnd(Math.max(a.at.fraction.length,b.at.fraction.length),"0"),b.at.fraction.padEnd(Math.max(a.at.fraction.length,b.at.fraction.length),"0")) : a.at ? -1 : b.at ? 1 : 0) || compare(a.event.id, b.event.id));
  route.events = timed.map(item => item.event);
  return route;
}
