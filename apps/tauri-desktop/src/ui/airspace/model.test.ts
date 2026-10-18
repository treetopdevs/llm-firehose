import { describe, expect, it } from 'vitest';
import type { AttentionEvidence, AttentionSession } from '../../api';
import { BANDS, deriveAirspace } from './model';
const now = Date.parse('2026-10-18T12:00:00Z');
const evidence = (ago: number, extra: Partial<AttentionEvidence> = {}): AttentionEvidence => ({ event_id: 'event', source: 'codex', kind: 'activity', summary: 'observation', time: new Date(now - ago).toISOString(), observed_at: new Date(now).toISOString(), ...extra });
const session = (id: string, state = 'working', ago = 1000, extra: Partial<AttentionSession> = {}): AttentionSession => ({ id, source: 'codex', events: 1, state, last: evidence(ago), ...extra });
const options = { now, windowMs: 15 * 60000 };
describe('Airspace derivation', () => {
    it('uses the five observation bands and preserves old pending requests/failures', () => {
        const rows = [session('request', 'working', 1000, { pending: evidence(7 * 86400000, { kind: 'request' }) }), session('failure', 'working', 1000, { pending: evidence(7 * 86400000, { kind: 'failure' }) }), session('recent'), session('quiet', 'working', options.windowMs + 1), session('completion', 'done'), session('unknown', 'future-state'), session('failed-state', 'failed')];
        const result = deriveAirspace(rows, options);
        expect(BANDS.map(b => b.id)).toEqual(['request', 'failure', 'recent', 'quiet', 'completion']);
        expect(result.rows.map(r => [r.session.id, r.band])).toEqual([['request', 'request'], ['failure', 'failure'], ['failed-state', 'failure'], ['recent', 'recent'], ['unknown', 'quiet'], ['quiet', 'quiet'], ['completion', 'completion']]);
        expect(result.counts).toEqual({ request: 1, failure: 2, recent: 1, quiet: 2, completion: 1 });
        expect(result.total).toBe(7);
    });
    it('does not treat recent import time as source activity; includes exact threshold', () => {
        const result = deriveAirspace([session('old', 'working', 0, { last: evidence(0, { source_time: new Date(now - options.windowMs - 1).toISOString() }), last_observed_at: new Date(now).toISOString() }), session('edge', 'working', options.windowMs), session('fresh')], options);
        expect(result.rows.find(r => r.session.id === 'old')?.band).toBe('quiet');
        expect(result.rows.find(r => r.session.id === 'edge')?.band).toBe('recent');
        expect(result.rows.find(r => r.session.id === 'old')?.clockNote).toMatch(/source/i);
        expect(result.rows.find(r => r.session.id === 'fresh')?.clockNote).toMatch(/event.*source|source.*unavailable/i);
    });
    it('invalid/future source clocks do not fall back to valid primary or import clocks', () => {
        const rows = [session('bad', 'working', 0, { last: evidence(0, { source_time: 'invalid' }) }), session('future', 'working', 0, { last: evidence(0, { source_time: new Date(now + 1).toISOString() }) }), session('bad-primary', 'working', 0, { last: evidence(0, { time: 'invalid' }) })];
        const result = deriveAirspace(rows, options);
        for (const row of result.rows) {
            expect(row.band).toBe('quiet');
            expect(row.eventTime).toBeNull();
            expect(row.eventAgeMs).toBeNull();
            expect(row.clockNote).toMatch(/unknown|future/i);
        }
    });
    it('orders pending oldest valid first with uncertain clocks last, independent of input order', () => {
        const rows = [session('new', 'working', 0, { pending: evidence(1000, { kind: 'request' }) }), session('bad', 'working', 0, { pending: evidence(0, { kind: 'request', time: 'invalid' }) }), session('future', 'working', 0, { pending: evidence(-1000, { kind: 'request' }) }), session('old', 'done', 0, { pending: evidence(90000, { kind: 'request' }) })];
        const expected = deriveAirspace(rows, options);
        expect(expected.rows.map(r => r.session.id)).toEqual(['old', 'new', 'bad', 'future']);
        expect(expected.rows[0].eventAgeMs).toBe(90000);
        expect(deriveAirspace([...rows].reverse(), options)).toEqual(expected);
    });
    it('scopes identical native session IDs by source and breaks timestamp ties deterministically', () => {
        const rows = [session('same', 'working', 0, { source: 'codex' }), session('same', 'working', 0, { source: 'claude-code' }), session('a', 'working', 0, { source: 'codex' })];
        const result = deriveAirspace(rows, options);
        expect(result.rows.map(r => r.key)).toEqual([JSON.stringify(['claude-code', 'same']), JSON.stringify(['codex', 'a']), JSON.stringify(['codex', 'same'])]);
    });
    it('filters exact source/workspace and searches case-insensitively before counting without pagination', () => {
        const rows = Array.from({ length: 25 }, (_, i) => session(String(i), 'working', i, { source: 'codex', worktree_id: 'git', jj_workspace_id: 'jj', cwd: 'cwd', repo: 'repo', pending: i === 0 ? evidence(5, { kind: 'request', summary: 'UNIQUE Request' }) : undefined }));
        rows.push(session('other', 'done', 0, { source: 'claude-code', worktree_id: 'git' }));
        expect(deriveAirspace(rows, options).rows).toHaveLength(26);
        const all = deriveAirspace(rows, { ...options, source: 'codex', workspace: 'git' });
        expect(all.total).toBe(26);
        expect(all.rows).toHaveLength(25);
        expect(all.counts).toEqual({ request: 1, failure: 0, recent: 24, quiet: 0, completion: 0 });
        expect(deriveAirspace(rows, { ...options, workspace: 'jj' }).rows).toEqual([]);
        expect(deriveAirspace(rows, { ...options, query: ' unique request ' }).rows.map(r => r.session.id)).toEqual(['0']);
    });
    it('uses defined workspace fallback and preserves unknown/uncertain information', () => {
        const rows = [session('jj', 'unknown', 1, { jj_workspace_id: 'jj', cwd: 'cwd', repo: 'repo', uncertainty: 'Needs classification' }), session('cwd', 'unknown', 2, { cwd: 'cwd', repo: 'repo' }), session('repo', 'unknown', 3, { repo: 'repo' }), session('empty', 'unknown', 4)];
        const result = deriveAirspace(rows, options);
        expect(result.rows.map(r => r.workspace)).toEqual(['jj', 'cwd', 'repo', '']);
        expect(deriveAirspace(rows, { ...options, workspace: '' }).rows.map(r => r.session.id)).toEqual(['empty']);
        expect(result.rows[0].session.uncertainty).toBe('Needs classification');
        expect(deriveAirspace(rows, { ...options, query: 'classification' }).rows).toHaveLength(1);
    });
    it('keeps unfamiliar pending kinds as requests and reports uncertain clocks explicitly', () => {
        const rows = [session('pending', 'failed', 0, { pending: evidence(0, { kind: 'unfamiliar', time: 'invalid' }) }), session('done', 'done', 0, { last: evidence(0, { time: 'invalid' }) })];
        const result = deriveAirspace(rows, options);
        expect(result.rows.map(r => r.band)).toEqual(['request', 'completion']);
        expect(result.rows.every(r => r.eventTime === null && r.eventAgeMs === null)).toBe(true);
        expect(result.rows.every(r => r.clockNote.includes('unknown'))).toBe(true);
    });
    it('does not mutate snapshot, and returns zero counts for an empty result', () => {
        const rows = [session('b'), session('a')];
        const before = JSON.stringify(rows);
        deriveAirspace(rows, options);
        expect(JSON.stringify(rows)).toBe(before);
        expect(deriveAirspace([], options)).toEqual({ rows: [], counts: { request: 0, failure: 0, recent: 0, quiet: 0, completion: 0 }, total: 0 });
    });
});
