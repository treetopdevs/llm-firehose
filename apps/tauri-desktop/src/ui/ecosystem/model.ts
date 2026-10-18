import type { FirehoseEvent } from "../../api";

export type PatchBed = {key: string; path: string; workspace: string; eventIds: string[]};
export type Ecosystem = {
  events: FirehoseEvent[];
  undated: FirehoseEvent[];
  beds: PatchBed[];
  missingPaths: number;
  missingIds: number;
  duplicates: number;
  conflicts: number;
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const present = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Source-reported stages only. Failed wins; a start remains an attempt even
 * when a transport also labels that observation completed. No pairing inferred. */
export function patchPhase(event: FirehoseEvent): "attempt" | "complete" | "failed" | "unknown" {
  const status = event.payload?.status;
  if (event.severity === "error" || status === "error" || status === "failed" || status === "interrupted") return "failed";
  if (event.payload?.phase === "start" || status === "started") return "attempt";
  if (status === "success" || status === "completed") return "complete";
  return "unknown";
}

/** Mirrors projection.EventFilePaths. Never parse patch text or stringify digests. */
function paths(event: FirehoseEvent): string[] {
  for (const field of ["file_path", "path", "file"]) {
    const value = event.payload?.[field];
    if (present(value)) return [value];
  }
  const changes = event.payload?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const object = changes as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 2 && typeof object.sha256 === "string" && Object.hasOwn(object, "len")) return [];
  return keys.sort(compare);
}

function workspace(event: FirehoseEvent): string {
  for (const field of ["worktree_id", "cwd", "repo_id", "repo"] as const) {
    if (present(event[field])) return `${field}:${event[field]}`;
  }
  return "unknown";
}

/** Compare complete stored envelopes independent of object insertion order.
 * Disagreeing copies are excluded, never arbitrarily selected as evidence. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(k => object[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(",")}}`;
}

/** Counts apply only to exact-scope file observations: duplicates are extra
 * copies; conflicts are unique IDs excluded entirely; missingPaths counts
 * surviving unique receipts (dated or undated) with no observed path. */
export function buildEcosystem(input: readonly FirehoseEvent[], source: string, session: string): Ecosystem {
  const model: Ecosystem = {events: [], undated: [], beds: [], missingPaths: 0, missingIds: 0, duplicates: 0, conflicts: 0};
  const unique = new Map<string, {event: FirehoseEvent; fingerprint: string; conflict: boolean}>();
  for (const event of input) {
    if (event.source !== source || event.session_id !== session || event.category !== "file") continue;
    if (!present(event.id)) { model.missingIds++; continue; }
    const fingerprint = canonical(event);
    const prior = unique.get(event.id);
    if (!prior) unique.set(event.id, {event, fingerprint, conflict: false});
    else {
      model.duplicates++;
      if (prior.fingerprint !== fingerprint && !prior.conflict) { prior.conflict = true; model.conflicts++; }
    }
  }
  const dated: {event: FirehoseEvent; time: number; paths: string[]}[] = [];
  for (const item of unique.values()) {
    if (item.conflict) continue;
    const observed = paths(item.event);
    if (!observed.length) model.missingPaths++;
    const time = Date.parse(item.event.time);
    if (!Number.isFinite(time)) model.undated.push(item.event);
    else dated.push({event: item.event, time, paths: observed});
  }
  dated.sort((a, b) => a.time - b.time || compare(a.event.id, b.event.id));
  model.undated.sort((a, b) => compare(a.id, b.id));
  const beds = new Map<string, PatchBed>();
  for (const item of dated) {
    model.events.push(item.event);
    const where = workspace(item.event);
    for (const path of item.paths) {
      const key = JSON.stringify([where, path]);
      let bed = beds.get(key);
      if (!bed) { bed = {key, path, workspace: where, eventIds: []}; beds.set(key, bed); }
      bed.eventIds.push(item.event.id);
    }
  }
  model.beds = [...beds.values()].sort((a, b) => compare(a.key, b.key));
  return model;
}

/** Cursor is an observation count, not wall time. Stable beds survive empty prefixes. */
export function replayBeds(model: Ecosystem, cursor: number): PatchBed[] {
  const end = Number.isNaN(cursor) ? 0 : Math.max(0, Math.min(Math.floor(cursor), model.events.length));
  const visible = new Set(model.events.slice(0, end).map(event => event.id));
  return model.beds.map(bed => ({...bed, eventIds: bed.eventIds.filter(id => visible.has(id))}));
}
