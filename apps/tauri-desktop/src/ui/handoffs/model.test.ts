import { describe, expect, it } from 'vitest';
import { buildHandoffMap, createHandoffBook, STORAGE_KEY, type HandoffBook } from './model';
const book = (): HandoffBook => ({ version: 1, links: [{ id: 'link', label: ' Review handoff ', from: { id: 'c5089b7d2673ba045c26b47175717f12', source: 'codex', session_id: '019faf77-c87d-7b22-a292-75e4f40f25bf' }, to: { id: 'f8dba170217e34a1a442ee787b2efd68', source: 'claude-code', session_id: 'same' } }] });
function storage(raw: string | null = null) {
    const state = { raw, writes: 0, failRead: false, failWrite: false };
    return { state, getItem(key: string) { expect(key).toBe(STORAGE_KEY); if (state.failRead)
            throw Error('denied'); return state.raw; }, setItem(key: string, value: string) { expect(key).toBe(STORAGE_KEY); if (state.failWrite)
            throw Error('quota'); state.raw = value; state.writes++; } };
}
describe('Handoff persistence', () => {
    it('loads without writing, trims labels, roundtrips and returns copies', () => {
        const store = storage();
        const model = createHandoffBook(store);
        expect(model.read()).toEqual({ version: 1, links: [] });
        expect(store.state.writes).toBe(0);
        const input = book();
        model.save(input);
        input.links[0].from.id = 'changed';
        const read = model.read();
        read.links[0].to.source = 'changed';
        expect(model.read().links[0].label).toBe('Review handoff');
        expect(model.read().links[0].from).toEqual(book().links[0].from);
        expect(model.read().links[0].to).toEqual(book().links[0].to);
        expect(createHandoffBook(store).read()).toEqual(model.read());
    });
    it.each(['', 'null', '[]', '{', '{"version":2,"links":[]}', '{"version":1}', '{"version":1,"links":[],"payload":"private"}'])('blocks invalid persisted data without writes %s', raw => { const store = storage(raw); expect(() => createHandoffBook(store)).toThrow(); expect(store.state.raw).toBe(raw); expect(store.state.writes).toBe(0); });
    it.each([
        (b: HandoffBook) => { b.links = Array.from({ length: 51 }, (_, i) => ({ ...b.links[0], id: String(i) })); },
        (b: HandoffBook) => { b.links = new Array(1); },
        (b: HandoffBook) => { b.links[0].label = ' '; },
        (b: HandoffBook) => { b.links[0].label = 'x'.repeat(501); },
        (b: HandoffBook) => { b.links[0].id = 'x'.repeat(513); },
        (b: HandoffBook) => { b.links[0].from.source = ''; },
        (b: HandoffBook) => { b.links[0].to.session_id = ' '; },
        (b: HandoffBook) => { b.links[0].to.id = b.links[0].from.id; },
        (b: HandoffBook) => { b.links[0].to = { ...b.links[0].from, id: 'other' }; },
        (b: HandoffBook) => { b.links.push({ ...b.links[0] }); },
        (b: HandoffBook) => { b.links.push({ ...b.links[0], id: 'different' }); },
        (b: HandoffBook) => { b.links.push({ ...b.links[0], id: 'different', from: { ...b.links[0].from, source: 'conflict' }, to: { ...b.links[0].to, id: 'third' } }); },
        (b: HandoffBook) => { Object.assign(b.links[0].from, { payload: 'private' }); },
        (b: HandoffBook) => { Object.assign(b.links[0], { label: 42 }); },
    ])('rejects invalid mutations and preserves state', mutate => { const store = storage(); const model = createHandoffBook(store); const next = book(); mutate(next); expect(() => model.save(next)).toThrow(); expect(model.read().links).toEqual([]); expect(store.state.writes).toBe(0); });
    it('accepts exact bounds and distinct source with same native session ID', () => { const next = book(); next.links = Array.from({ length: 50 }, (_, i) => ({ id: String(i), label: 'x'.repeat(500), from: { id: `${i}`.padEnd(512, 'x'), source: 'a', session_id: 'same' }, to: { id: `${i}`.padEnd(512, 'y'), source: 'b', session_id: 'same' } })); const model = createHandoffBook(storage()); model.save(next); expect(model.read()).toEqual(next); });
    it('preserves memory and storage on failed reads/writes, and retries successfully', () => { const store = storage(); const model = createHandoffBook(store); model.save(book()); const prior = model.read(); const raw = store.state.raw; store.state.failWrite = true; expect(() => model.save({ version: 1, links: [] })).toThrow(); expect(model.read()).toEqual(prior); expect(store.state.raw).toBe(raw); store.state.failWrite = false; store.state.failRead = true; expect(() => model.reload()).toThrow(); expect(() => model.save(book())).toThrow(); expect(() => createHandoffBook(store)).toThrow(); expect(model.read()).toEqual(prior); store.state.failRead = false; model.save({ version: 1, links: [] }); expect(model.read().links).toEqual([]); });
    it('requires explicit reload on conflict and preserves previous snapshot on invalid reload', () => { const store = storage(); const a = createHandoffBook(store); const b = createHandoffBook(store); a.save(book()); expect(() => b.save({ version: 1, links: [] })).toThrow(/reload/i); expect(b.read().links).toEqual([]); expect(b.reload()).toEqual(a.read()); store.state.raw = '{"version":9,"links":[]}'; expect(() => b.reload()).toThrow(); expect(b.read()).toEqual(a.read()); expect(() => b.save(book())).toThrow(/reload/i); });
});
describe('deterministic handoff map', () => {
    it('uses exact lanes, shared stations and directed edges independent of input order', () => {
        const a = { id: 'a', source: 'codex', session_id: 'same' };
        const b = { id: 'b', source: 'claude-code', session_id: 'same' };
        const c = { id: 'c', source: 'codex', session_id: 'third' };
        const links = [{ id: 'z', label: 'out', from: a, to: b }, { id: 'a', label: 'next', from: b, to: c }, { id: 'back', label: 'reverse', from: b, to: a }];
        const map = buildHandoffMap(links);
        expect(buildHandoffMap([...links].reverse())).toEqual(map);
        expect(map.lanes).toEqual([{ key: JSON.stringify(['claude-code', 'same']), source: 'claude-code', session_id: 'same' }, { key: JSON.stringify(['codex', 'same']), source: 'codex', session_id: 'same' }, { key: JSON.stringify(['codex', 'third']), source: 'codex', session_id: 'third' }]);
        expect(map.stations.map(s => [s.key, s.lane])).toEqual([['b', 0], ['a', 1], ['c', 2]]);
        expect(map.edges).toEqual([{ id: 'a', label: 'next', from: 'b', to: 'c' }, { id: 'back', label: 'reverse', from: 'b', to: 'a' }, { id: 'z', label: 'out', from: 'a', to: 'b' }]);
        map.stations[0].endpoint.source = 'changed';
        expect(b.source).toBe('claude-code');
    });
    it('does not collide delimiter-bearing identities and keeps one-page graph bounded', () => {
        const links = Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: 'link', from: { id: `f${i}`, source: 'a|b', session_id: 'c' }, to: { id: `t${i}`, source: 'a', session_id: 'b|c' } }));
        const map = buildHandoffMap(links);
        expect(map.lanes).toHaveLength(2);
        expect(map.stations).toHaveLength(20);
        expect(map.edges).toHaveLength(10);
        expect(buildHandoffMap([])).toEqual({ lanes: [], stations: [], edges: [] });
    });
    it('rejects inconsistent identity rather than producing ambiguous graph', () => { const links = book().links; links.push({ ...links[0], id: 'other', from: { ...links[0].from, source: 'other' }, to: { ...links[0].to, id: 'other' } }); expect(() => buildHandoffMap(links)).toThrow(); });
});
