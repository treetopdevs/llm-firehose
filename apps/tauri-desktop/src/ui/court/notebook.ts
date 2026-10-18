/** Host-private manual notes, separate from captured history and exports. */
export const STORAGE_KEY = 'firehose.evidence-court.v1';
export interface Receipt { id: string; source: string; session_id: string }
export interface Requirement { id: string; text: string; receipt?: Receipt }
export interface Claim { id: string; text: string; requirements: Requirement[] }
export interface Notebook { version: 1; claims: Claim[] }

type RecordValue = Record<string, unknown>;
function object(value: unknown, required: string[], optional: string[] = []): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid notebook: expected an object.');
  const record = value as RecordValue;
  if (required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error('Invalid notebook: unexpected or missing fields.');
  }
  return record;
}
function identity(value: unknown, empty = false): string {
  if (typeof value !== 'string' || value.length > 512 || (!empty && !value.trim())) throw new Error('Invalid notebook: identity must be a nonempty string of at most 512 characters.');
  return value;
}
function manualText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`Invalid notebook: text must contain 1–${max} characters.`);
  return value.trim();
}
function boundedList<T>(value: unknown, parse: (item: unknown) => T & { id: string }): T[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid notebook: at most 20 items are allowed.');
  const ids = new Set<string>();
  return Array.from(value, item => {
    const parsed = parse(item);
    if (ids.has(parsed.id)) throw new Error('Invalid notebook: duplicate item IDs.');
    ids.add(parsed.id);
    return parsed;
  });
}
function validate(value: unknown): Notebook {
  const notebook = object(value, ['version', 'claims']);
  if (notebook.version !== 1) throw new Error('Unsupported notebook version. Stored notes were not changed.');
  const claims = boundedList<Claim>(notebook.claims, item => {
    const claim = object(item, ['id', 'text', 'requirements']);
    return {
      id: identity(claim.id), text: manualText(claim.text, 1000),
      requirements: boundedList<Requirement>(claim.requirements, item => {
        const requirement = object(item, ['id', 'text'], ['receipt']);
        const result: Requirement = { id: identity(requirement.id), text: manualText(requirement.text, 500) };
        if (Object.prototype.hasOwnProperty.call(requirement, 'receipt')) {
          const receipt = object(requirement.receipt, ['id', 'source', 'session_id']);
          result.receipt = { id: identity(receipt.id), source: identity(receipt.source), session_id: identity(receipt.session_id, true) };
        }
        return result;
      }),
    };
  });
  return { version: 1, claims };
}
function parse(raw: string | null): Notebook {
  if (raw === null) return { version: 1, claims: [] };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid notebook data. Stored notes were not changed.'); }
  return validate(value);
}

/** Optimistic storage conflict checks are best effort, not transactional locking. */
export function createNotebook(storage: Pick<Storage, 'getItem' | 'setItem'>) {
  function stored(): string | null {
    try { return storage.getItem(STORAGE_KEY); } catch { throw new Error('Local notebook storage is unavailable. Notes were not changed.'); }
  }
  let original = stored();
  let current = parse(original);
  return {
    read(): Notebook { return validate(current); },
    save(next: Notebook): void {
      const candidate = validate(next);
      if (stored() !== original) throw new Error('Notebook changed in another window. Reload before saving.');
      const serialized = JSON.stringify(candidate);
      try { storage.setItem(STORAGE_KEY, serialized); } catch { throw new Error('Could not save local notebook. Storage may be full or unavailable. Notes were not changed.'); }
      current = candidate;
      original = serialized;
    },
    reload(): Notebook {
      const raw = stored();
      const candidate = parse(raw);
      original = raw;
      current = candidate;
      return validate(current);
    },
  };
}
