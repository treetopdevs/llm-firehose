export type ReplayBranch = {id: string; source: string; sessionId: string; eventId: string; title: string; steps: string[]};
export type ReplayBook = {version: 1; branches: ReplayBranch[]};
export type ReplayStorage = Pick<Storage, "getItem" | "setItem">;
export const REPLAY_STORAGE_KEY = "agentfirehose.replay.v1";
export const MAX_REPLAY_BYTES = 512 * 1024;
const empty = (): ReplayBook => ({version: 1, branches: []});
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function reference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}
function userText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value;
}

/** Validate the entire notebook. Unknown fields are rejected so captured
 * envelopes and future schemas cannot be accidentally copied or pruned. */
function validate(value: unknown): asserts value is ReplayBook {
  if (!record(value) || !exactKeys(value, ["version", "branches"])) throw new Error("Invalid notebook fields; stored data is retained.");
  if (value.version !== 1) throw new Error("Unsupported notebook version; stored data is retained.");
  if (!Array.isArray(value.branches) || value.branches.length > 50) throw new Error("Notebook requires at most 50 branches.");
  const ids = new Set<string>();
  for (const branch of value.branches) {
    if (!record(branch) || !exactKeys(branch, ["id", "source", "sessionId", "eventId", "title", "steps"])) throw new Error("Invalid branch fields; only annotations and exact references may be stored.");
    if (![branch.id, branch.source, branch.sessionId, branch.eventId].every(reference)) throw new Error("Branch and reference IDs must be nonempty strings of at most 1024 characters.");
    if (!userText(branch.title, 120)) throw new Error("Title must be trimmed, nonempty text of at most 120 characters.");
    if (!Array.isArray(branch.steps) || branch.steps.length < 1 || branch.steps.length > 12 || !branch.steps.every(step => userText(step, 500))) throw new Error("Provide 1–12 hypothetical steps, each trimmed, nonempty and at most 500 characters.");
    const id = branch.id as string;
    if (ids.has(id)) throw new Error("Duplicate branch IDs are not allowed.");
    ids.add(id);
  }
}
function decode(raw: string): ReplayBook {
  if (bytes(raw) > MAX_REPLAY_BYTES) throw new Error("Notebook exceeds the 512 KiB limit; stored data is retained.");
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error("Notebook is corrupt; stored data is retained."); }
  validate(decoded);
  return decoded;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function readReplayBook(storage: ReplayStorage): {book: ReplayBook; token: string | null; writable: boolean; error?: string} {
  let token: string | null = null;
  try {
    token = storage.getItem(REPLAY_STORAGE_KEY);
    return {book: token === null ? empty() : decode(token), token, writable: true};
  } catch (error) {
    return {book: empty(), token, writable: false, error: `Notebook unavailable for editing: ${message(error)}`};
  }
}

/** Optimistic cross-window check, not an atomic transaction. No writes occur
 * on invalid data, stale tokens or unreadable existing state. Storage.setItem
 * supplies its normal all-or-nothing failure semantics; no unsafe rollback. */
export function saveReplayBook(storage: ReplayStorage, expectedToken: string | null, book: ReplayBook): {ok: boolean; token?: string; error?: string} {
  try {
    validate(book);
    const serialized = JSON.stringify(book);
    decode(serialized); // Validate the stored representation too (e.g. sparse arrays serialize as null).
    const current = storage.getItem(REPLAY_STORAGE_KEY);
    if (current !== expectedToken) return {ok: false, error: "Notebook changed in another window. Keep your edits, then Refresh notebook and reapply them."};
    if (current !== null) decode(current); // Corrupt/future storage is never overwritten even with its token.
    storage.setItem(REPLAY_STORAGE_KEY, serialized);
    return {ok: true, token: serialized};
  } catch (error) {
    return {ok: false, error: `Notebook was not saved: ${message(error)}`};
  }
}
