import { describe, expect, it } from 'vitest';
import type { AttentionSession, FileSession } from '../../api';
import { sharedFileLanes } from './shared-files-model';

// Normalized public projection rows, not adapter capture fixtures.
const session = (id: string, extra: Partial<AttentionSession> = {}): AttentionSession => ({
  id, source: 'codex', state: 'working', events: 1, worktree_id: '/work',
  last: { event_id: 'e', source: 'codex', kind: 'activity', summary: 'Observed', time: '2026-10-18T12:00:00Z' }, ...extra,
});
const file = (id: string, extra: Partial<FileSession> = {}): FileSession => ({
  workspace_kind: 'worktree_id', workspace: '/work', path: 'src/main.ts', source: 'codex', session_id: id,
  events: 1, first_time: '2026-10-18T11:00:00Z', last_time: '2026-10-18T12:00:00Z', last_event_id: `file-${id}`, ...extra,
});

describe('shared recorded file lanes', () => {
  it('joins exact source/session identity and preserves same native IDs across sources', () => {
    const sessions = [session('same'), session('same', { source: 'claude-code' })];
    const files = [file('same'), file('same', { source: 'claude-code' }), file('unrelated')];
    const lanes = sharedFileLanes(files, sessions);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].members.map(r => [r.source, r.session_id])).toEqual([['claude-code', 'same'], ['codex', 'same']]);
    expect(lanes[0].path).toBe('src/main.ts');
    expect(lanes[0].workspace_kind).toBe('worktree_id');
  });
  it('groups by historical row scope even after sessions move and never combines scope kinds', () => {
    const sessions = [session('a', { worktree_id: '/new' }), session('b', { worktree_id: '', repo: '/repo' })];
    const files = [file('a'), file('b'), file('a', { workspace_kind: 'cwd', workspace: '/old' }), file('b', { workspace_kind: 'cwd', workspace: '/old' })];
    expect(sharedFileLanes(files, sessions).map(g => [g.workspace_kind, g.workspace])).toEqual([['cwd', '/old'], ['worktree_id', '/work']]);
    expect(sharedFileLanes([file('a'), file('b', { workspace_kind: 'cwd' })], sessions)).toEqual([]);
    expect(sharedFileLanes([file('a'), file('b', { workspace: 'a'.repeat(64) })], sessions)).toEqual([]);
  });
  it('excludes unknown/empty scopes and truncated paths without normalizing relative paths', () => {
    const sessions = [session('a'), session('b')];
    for (const extra of [{ workspace_kind: 'unknown' }, { workspace_kind: '' }, { workspace: '' }, { path: 'src/main.ts…' }])
      expect(sharedFileLanes([file('a', extra), file('b', extra)], sessions)).toEqual([]);
    expect(sharedFileLanes([file('a'), file('b', { path: '/work/src/main.ts' })], sessions)).toEqual([]);
    expect(sharedFileLanes([file('a'), file('b')], sessions)).toHaveLength(1);
  });
  it('merges defensive duplicate participants deterministically without double counting', () => {
    const files = [file('a'), file('a', { events: 3, first_time: '2026-10-17T11:00:00Z', last_event_id: 'z' }), file('b')];
    const result = sharedFileLanes(files, [session('a'), session('b')]);
    expect(result[0].members[0]).toMatchObject({ events: 3, first_time: '2026-10-17T11:00:00Z', last_event_id: 'z' });
    expect(sharedFileLanes([...files].reverse(), [session('b'), session('a')])).toEqual(result);
  });
  it('requires two distinct eligible participants after filtering, not duplicate rows', () => {
    expect(sharedFileLanes([file('a'), file('a')], [session('a')])).toEqual([]);
    expect(sharedFileLanes([file('a'), file('b')], [session('a')])).toEqual([]);
    expect(sharedFileLanes([file(''), file('b')], [session(''), session('b')])).toEqual([]);
    expect(sharedFileLanes([file('a', { source: '' }), file('b')], [session('a', { source: '' }), session('b')])).toEqual([]);
  });
  it('keeps all participants and groups in stable order without mutating inputs', () => {
    const sessions = Array.from({ length: 85 }, (_, i) => session(String(i).padStart(3, '0')));
    const files = sessions.flatMap(s => [file(s.id, { path: 'z' }), file(s.id, { path: 'a' })]);
    const before = JSON.stringify(files);
    const result = sharedFileLanes(files, sessions);
    expect(result.map(g => g.path)).toEqual(['a', 'z']);
    expect(result.flatMap(g => g.members)).toHaveLength(170);
    expect(sharedFileLanes([...files].reverse(), [...sessions].reverse())).toEqual(result);
    expect(JSON.stringify(files)).toBe(before);
  });
});
it('keeps an unfamiliar nonempty row kind distinct without interpreting it', () => {
  const sessions = [session('a'), session('b')];
  expect(sharedFileLanes([file('a', { workspace_kind: 'future-kind' }), file('b', { workspace_kind: 'future-kind' })], sessions)).toHaveLength(1);
  expect(sharedFileLanes([file('a', { workspace_kind: 'future-kind' }), file('b')], sessions)).toEqual([]);
});
