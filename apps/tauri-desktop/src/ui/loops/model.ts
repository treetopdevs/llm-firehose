import type { ErrorSignature, FirehoseEvent } from "../../api";
import { isTransition } from "../../spark";
import { errorSignatureKey, memberSignatureKeys } from "../score/model";

export type Interval = { from: FirehoseEvent; to: FirehoseEvent; elapsedMs: number; counts: Record<string, number>; fromIndex: number; toIndex: number };
export type LoopGroup = { key: string; occurrences: FirehoseEvent[]; intervals: Interval[]; fallbackOccurrences: number };
export type Loops = { events: FirehoseEvent[]; groups: LoopGroup[]; fallbackCount: number; excluded: {invalidTime: number; duplicate: number} };

/** Session-local observations, not attempts. Category prefix counts keep overlapping
 * intervals across different signatures linear in history × category count. */
export function buildLoops(input: readonly FirehoseEvent[], session: string, source?: string, signatures: readonly ErrorSignature[] = []): Loops {
  const seen = new Set<string>();
  const excluded = {invalidTime: 0, duplicate: 0};
  const timed: {event: FirehoseEvent; at: number}[] = [];
  for (const event of input) {
    if (event.session_id !== session || (source && event.source !== source) || isTransition(event)) continue;
    const at = Date.parse(event.time);
    if (!Number.isFinite(at)) { excluded.invalidTime++; continue; }
    if (seen.has(event.id)) { excluded.duplicate++; continue; }
    seen.add(event.id);
    timed.push({event, at});
  }
  timed.sort((a, b) => a.at - b.at || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));
  const events = timed.map(item => item.event);
  const members = memberSignatureKeys(signatures.filter(s => !source || s.source === source));
  const categories = [...new Set(events.map(e => e.category))];
  const prefix = new Map(categories.map(c => [c, new Uint32Array(events.length + 1)]));
  const groups = new Map<string, LoopGroup>();
  const lastIndex = new Map<string, number>();
  let fallbackCount = 0;
  events.forEach((event, i) => {
    for (const [category, counts] of prefix) counts[i + 1] = counts[i] + (event.category === category ? 1 : 0);
    if (event.severity !== "error" && event.category !== "error") return;
    const authoritative = members.get(event.id);
    if (authoritative === undefined) fallbackCount++;
    const key = authoritative ?? errorSignatureKey(event);
    let group = groups.get(key);
    if (!group) { group = {key, occurrences: [], intervals: [], fallbackOccurrences: 0}; groups.set(key, group); }
    if (authoritative === undefined) group.fallbackOccurrences++;
    const before = lastIndex.get(key);
    if (before !== undefined) {
      const from = events[before];
      const counts: Record<string, number> = {};
      for (const [category, values] of prefix) {
        const count = values[i + 1] - values[before + 1];
        if (count) Object.defineProperty(counts, category, { value: count, enumerable: true });
      }
      group.intervals.push({from, to: event, elapsedMs: timed[i].at - timed[before].at, counts, fromIndex: before, toIndex: i});
    }
    group.occurrences.push(event);
    lastIndex.set(key, i);
  });
  return {events, groups: [...groups.values()].filter(g => g.occurrences.length >= 2), fallbackCount, excluded};
}
