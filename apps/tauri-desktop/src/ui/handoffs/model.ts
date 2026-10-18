/** Local annotations only: this state is not captured history or causal evidence. */
export const STORAGE_KEY = 'firehose.handoff-subway.v1';
export interface Endpoint {
    id: string;
    source: string;
    session_id: string;
}
export interface Handoff {
    id: string;
    label: string;
    from: Endpoint;
    to: Endpoint;
}
export interface HandoffBook {
    version: 1;
    links: Handoff[];
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid handoff notebook: expected an object.');
    const record = value as Record<string, unknown>;
    if (keys.some(key => !Object.prototype.hasOwnProperty.call(record, key)) || Object.keys(record).some(key => !keys.includes(key)))
        throw new Error('Invalid handoff notebook: missing or unexpected fields.');
    return record;
}
function identity(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 512)
        throw new Error('Invalid handoff notebook: identities must contain 1–512 characters.');
    return value;
}
function endpoint(value: unknown): Endpoint {
    const item = object(value, ['id', 'source', 'session_id']);
    return { id: identity(item.id), source: identity(item.source), session_id: identity(item.session_id) };
}
function laneKey(value: Endpoint): string { return JSON.stringify([value.source, value.session_id]); }
function validate(value: unknown): HandoffBook {
    const book = object(value, ['version', 'links']);
    if (book.version !== 1)
        throw new Error('Unsupported handoff notebook version. Stored annotations were not changed.');
    if (!Array.isArray(book.links) || book.links.length > 50)
        throw new Error('Invalid handoff notebook: at most 50 links are allowed.');
    const ids = new Set<string>();
    const pairs = new Set<string>();
    const events = new Map<string, string>();
    const links = Array.from(book.links, value => {
        const item = object(value, ['id', 'label', 'from', 'to']);
        const id = identity(item.id);
        if (typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 500)
            throw new Error('Invalid handoff notebook: labels must contain 1–500 characters.');
        const from = endpoint(item.from);
        const to = endpoint(item.to);
        if (from.id === to.id || laneKey(from) === laneKey(to))
            throw new Error('A handoff must connect different events in different source/session pairs.');
        const pair = JSON.stringify([from.id, to.id]);
        if (ids.has(id) || pairs.has(pair))
            throw new Error('Invalid handoff notebook: duplicate link ID or directed endpoint pair.');
        ids.add(id);
        pairs.add(pair);
        for (const station of [from, to]) {
            const lane = laneKey(station);
            if (events.has(station.id) && events.get(station.id) !== lane)
                throw new Error('Invalid handoff notebook: event identity conflicts across links.');
            events.set(station.id, lane);
        }
        return { id, label: item.label.trim(), from, to };
    });
    return { version: 1, links };
}
function parse(raw: string | null): HandoffBook {
    if (raw === null)
        return { version: 1, links: [] };
    let value: unknown;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('Invalid handoff notebook data. Stored annotations were not changed.');
    }
    return validate(value);
}
/** Raw-value comparisons detect stale writers, but are not transactional locking. */
export function createHandoffBook(storage: Pick<Storage, 'getItem' | 'setItem'>) {
    function stored(): string | null {
        try {
            return storage.getItem(STORAGE_KEY);
        }
        catch {
            throw new Error('Local handoff storage is unavailable. Annotations were not changed.');
        }
    }
    let original = stored();
    let current = parse(original);
    return {
        read(): HandoffBook { return validate(current); },
        save(next: HandoffBook): void {
            const candidate = validate(next);
            if (stored() !== original)
                throw new Error('Handoff notebook changed in another window. Reload before saving.');
            const raw = JSON.stringify(candidate);
            try {
                storage.setItem(STORAGE_KEY, raw);
            }
            catch {
                throw new Error('Could not save handoff annotations. Storage may be full or unavailable.');
            }
            current = candidate;
            original = raw;
        },
        reload(): HandoffBook {
            const raw = stored();
            const candidate = parse(raw);
            original = raw;
            current = candidate;
            return validate(current);
        },
    };
}
/** Layout organizes the supplied page; it never implies chronology or causality. */
export function buildHandoffMap(input: Handoff[]) {
    const { links } = validate({ version: 1, links: input });
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    const laneByKey = new Map<string, {
        key: string;
        source: string;
        session_id: string;
    }>();
    const stationByKey = new Map<string, Endpoint>();
    for (const link of links)
        for (const endpoint of [link.from, link.to]) {
            const key = laneKey(endpoint);
            laneByKey.set(key, { key, source: endpoint.source, session_id: endpoint.session_id });
            stationByKey.set(endpoint.id, endpoint);
        }
    const lanes = [...laneByKey.values()].sort((a, b) => compare(a.source, b.source) || compare(a.session_id, b.session_id));
    const laneIndices = new Map(lanes.map((lane, i) => [lane.key, i]));
    const stations = [...stationByKey.values()].map(endpoint => ({ key: endpoint.id, endpoint, lane: laneIndices.get(laneKey(endpoint))! })).sort((a, b) => a.lane - b.lane || compare(a.key, b.key));
    const edges = links.map(link => ({ id: link.id, label: link.label, from: link.from.id, to: link.to.id })).sort((a, b) => compare(a.id, b.id));
    return { lanes, stations, edges };
}
