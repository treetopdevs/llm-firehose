import { describe, expect, it } from 'vitest';
import { createNotebook, STORAGE_KEY, type Notebook } from './notebook';

function storage(raw: string | null = null) {
  const state = { raw, reads: 0, writes: 0, failRead: false, failWrite: false };
  return { state, getItem(key: string) { expect(key).toBe(STORAGE_KEY); state.reads++; if (state.failRead) throw new Error('denied'); return state.raw; }, setItem(key: string, value: string) { expect(key).toBe(STORAGE_KEY); if (state.failWrite) throw new Error('quota'); state.writes++; state.raw = value; } };
}
const fixture = (): Notebook => ({ version: 1, claims: [{ id: 'claim', text: ' Tests pass ', requirements: [{ id: 'req', text: ' Test output ', receipt: { id: 'c5089b7d2673ba045c26b47175717f12', source: 'codex', session_id: '019faf77-c87d-7b22-a292-75e4f40f25bf' } }] }] });

describe('Evidence Court notebook', () => {
  it('does not write on load; saves trimmed manual text and exact receipt identity', () => {
    const store = storage(); const book = createNotebook(store);
    expect(book.read()).toEqual({ version: 1, claims: [] }); expect(store.state.writes).toBe(0);
    book.save(fixture());
    expect(book.read().claims[0].text).toBe('Tests pass'); expect(book.read().claims[0].requirements[0].text).toBe('Test output');
    expect(createNotebook(store).read()).toEqual(book.read()); expect(store.state.writes).toBe(1);
  });
  it('returns copies and retains no references to save input', () => {
    const book = createNotebook(storage()); const input = fixture(); book.save(input);
    input.claims[0].requirements[0].receipt!.id = 'changed';
    const read = book.read(); read.claims[0].requirements[0].receipt!.source = 'changed'; read.claims.push(read.claims[0]);
    expect(book.read().claims).toHaveLength(1); expect(book.read().claims[0].requirements[0].receipt).toEqual(fixture().claims[0].requirements[0].receipt);
  });
  it.each(['', 'null', '[]', '{', '{"version":2,"claims":[]}', '{"version":1}', '{"version":1,"claims":[],"payload":"private"}'])('rejects corrupt/future state without writing: %s', raw => {
    const store = storage(raw); expect(() => createNotebook(store)).toThrow(); expect(store.state.raw).toBe(raw); expect(store.state.writes).toBe(0);
  });
  it.each([
    (n: Notebook) => { n.claims = Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: 'x', requirements: [] })); },
    (n: Notebook) => { n.claims[0].requirements = Array.from({ length: 21 }, (_, i) => ({ id: String(i), text: 'x' })); },
    (n: Notebook) => { n.claims[0].text = 'x'.repeat(1001); },
    (n: Notebook) => { n.claims[0].requirements[0].text = 'x'.repeat(501); },
    (n: Notebook) => { n.claims[0].text = '  '; },
    (n: Notebook) => { n.claims = new Array(1); },
    (n: Notebook) => { n.claims[0].requirements = new Array(1); },
    (n: Notebook) => { Object.assign(n.claims[0].requirements[0], { receipt: null }); },
    (n: Notebook) => { Object.assign(n.claims[0].requirements[0].receipt!, { id: 42 }); },
    (n: Notebook) => { n.claims[0].id = ''; },
    (n: Notebook) => { n.claims[0].id = 'x'.repeat(513); },
    (n: Notebook) => { n.claims.push(n.claims[0]); },
    (n: Notebook) => { n.claims[0].requirements.push(n.claims[0].requirements[0]); },
    (n: Notebook) => { n.claims[0].requirements[0].receipt!.source = ''; },
    (n: Notebook) => { n.claims[0].requirements[0].receipt!.session_id = 'x'.repeat(513); },
    (n: Notebook) => { Object.assign(n.claims[0].requirements[0].receipt!, { payload: 'must not persist' }); },
  ])('rejects invalid mutations before storage write', mutate => {
    const store = storage(); const book = createNotebook(store); const next = fixture(); mutate(next);
    expect(() => book.save(next)).toThrow(); expect(book.read()).toEqual({ version: 1, claims: [] }); expect(store.state.writes).toBe(0);
  });
  it('accepts bounds, empty session identity and unattached requirements', () => {
    const next = fixture(); next.claims = Array.from({ length: 20 }, (_, i) => ({ id: String(i), text: 'x'.repeat(1000), requirements: Array.from({ length: 20 }, (_, j) => ({ id: String(j), text: 'x'.repeat(500) })) }));
    next.claims[0].requirements[0].receipt = { id: 'x'.repeat(512), source: 'codex', session_id: '' };
    const book = createNotebook(storage()); book.save(next); expect(book.read()).toEqual(next);
  });
  it('preserves state after quota/read failures and permits a later successful save', () => {
    const store = storage(); const book = createNotebook(store); book.save(fixture()); const previous = book.read(); const raw = store.state.raw;
    store.state.failWrite = true; expect(() => book.save({ version: 1, claims: [] })).toThrow(); expect(book.read()).toEqual(previous); expect(store.state.raw).toBe(raw);
    store.state.failWrite = false; store.state.failRead = true; expect(() => book.save({ version: 1, claims: [] })).toThrow(); expect(() => book.reload()).toThrow(); expect(() => createNotebook(store)).toThrow(); expect(book.read()).toEqual(previous);
    store.state.failRead = false; book.save({ version: 1, claims: [] }); expect(book.read().claims).toEqual([]);
  });
  it('rejects stale writes until explicit reload and never resets invalid reload data', () => {
    const store = storage(); const first = createNotebook(store); const stale = createNotebook(store); first.save(fixture());
    expect(() => stale.save({ version: 1, claims: [] })).toThrow(/reload/i); expect(stale.read().claims).toEqual([]);
    expect(stale.reload()).toEqual(first.read()); stale.save({ version: 1, claims: [] });
    store.state.raw = '{"version":7,"claims":[]}'; expect(() => stale.reload()).toThrow(); expect(stale.read().claims).toEqual([]); expect(() => stale.save(fixture())).toThrow(/reload/i);
  });
});
