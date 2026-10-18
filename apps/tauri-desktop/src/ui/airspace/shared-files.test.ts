// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from 'vitest';
import type { AttentionSession, FileSession, FirehoseEvent } from '../../api';
import fixture from '../score/fixture.session.json';
import { createSharedFiles } from './shared-files';
const api = vi.hoisted(() => ({ fileSessions: vi.fn(), capturedEvent: vi.fn() }));
vi.mock('../../api', () => api);
const original = fixture.find(e => e.category === 'file')!;
// Labelled normalized contract mutation of a real captured file receipt.
const event = { ...original, worktree_id: '/work', payload: { file_path: 'src/main.ts' } } as FirehoseEvent;
const row: FileSession = { workspace_kind: 'worktree_id', workspace: '/work', path: 'src/main.ts', source: event.source, session_id: event.session_id!, events: 1, first_time: event.time, last_time: event.time, last_event_id: event.id };
const session = (id: string): AttentionSession => ({ id, source: event.source, worktree_id: '/work', state: 'working', events: 1, last: { event_id: event.id, source: event.source, kind: 'activity', summary: 'Captured', time: event.time } });
const rows = [row, { ...row, session_id: 'second', last_event_id: 'second-event' }];
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const button = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll('button')].find(b => b.textContent === text); expect(b).toBeTruthy(); return b!; };
const mount = () => { const panel = createSharedFiles(() => Date.parse(event.time)); document.body.append(panel.root); panel.setSessions([session(row.session_id), session('second')], false); return panel; };
beforeEach(() => { vi.resetAllMocks(); document.body.replaceChildren(); api.fileSessions.mockResolvedValue(rows); api.capturedEvent.mockResolvedValue(event); });
test('loads only explicitly and shows complete paths, historical limits and verified receipt with close focus', async () => {
  const p = mount(); expect(api.fileSessions).not.toHaveBeenCalled();
  button(p.root, 'Load shared files').click(); await settle();
  expect(api.fileSessions).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  expect(p.root.textContent).toContain('1 shared file');
  expect(p.root.textContent).toContain('src/main.ts');
  expect(p.root.textContent).toContain('not simultaneous');
  const opener = button(p.root, `Inspect file observation: ${row.source} / ${row.session_id}`); opener.focus(); opener.click(); await settle();
  expect(p.root.querySelector('pre')?.textContent).toContain(event.id);
  button(p.root, 'Close file receipt').click(); expect(document.activeElement).toBe(opener);
});
test('keeps stale rows and Retry after errors and filter updates', async () => {
  const p = mount(); button(p.root, 'Load shared files').click(); await settle();
  api.fileSessions.mockRejectedValueOnce(Error('offline'));
  button(p.root, 'Refresh shared files').click(); await settle();
  p.setSessions([session(row.session_id), session('second')], false);
  expect(p.root.textContent).toContain('offline'); expect(p.root.textContent).toContain('stale');
  expect(p.root.textContent).toContain('src/main.ts'); button(p.root, 'Retry shared files').click(); await settle();
  expect(api.fileSessions).toHaveBeenCalledTimes(3);
});
test('filter changes cancel pending receipts and omit no-longer-shared lanes', async () => {
  const p = mount(); button(p.root, 'Load shared files').click(); await settle();
  let done!: (e: FirehoseEvent) => void; api.capturedEvent.mockReturnValue(new Promise(r => done = r));
  button(p.root, `Inspect file observation: ${row.source} / ${row.session_id}`).click();
  const signal = api.capturedEvent.mock.calls[0][1];
  p.setSessions([session(row.session_id)], false); done(event); await settle();
  expect(signal.aborted).toBe(true); expect(p.root.querySelector('pre')).toBeNull(); expect(p.root.textContent).toContain('No shared recorded files');
});
test('deactivation rejects late list responses; reconnect requires explicit reload', async () => {
  const p = mount(); let done!: (r: FileSession[]) => void; api.fileSessions.mockReturnValue(new Promise(r => done = r));
  button(p.root, 'Load shared files').click(); const signal = api.fileSessions.mock.calls[0][0];
  p.deactivate(); done(rows); await settle(); expect(signal.aborted).toBe(true); expect(p.root.textContent).not.toContain('src/main.ts');
  p.activate(); p.setConnected(false); p.setConnected(true); expect(api.fileSessions).toHaveBeenCalledTimes(1);
});
test.each([
  { id: 'wrong' }, { source: 'wrong' }, { session_id: 'wrong' }, { worktree_id: '/wrong' }, { payload: { file_path: 'other' } },
])('rejects mismatched receipt %j', async mutation => {
  const p = mount(); button(p.root, 'Load shared files').click(); await settle(); api.capturedEvent.mockResolvedValue({ ...event, ...mutation });
  button(p.root, `Inspect file observation: ${row.source} / ${row.session_id}`).click(); await settle();
  expect(p.root.querySelector('pre')).toBeNull(); expect(p.root.textContent).toContain('Receipt unavailable');
});
test('paginates all participants, disables missing receipts, and safely renders full paths', async () => {
  const p = mount(); const many = Array.from({ length: 85 }, (_, i) => ({ ...row, session_id: String(i).padStart(3, '0'), path: '<script>' + 'long/'.repeat(90), last_event_id: '' }));
  p.setSessions(many.map(r => session(r.session_id)), false); api.fileSessions.mockResolvedValue(many);
  button(p.root, 'Load shared files').click(); await settle();
  expect(p.root.querySelectorAll('[data-file-participant]')).toHaveLength(40); expect(p.root.querySelector('script')).toBeNull(); expect(p.root.textContent).toContain(many[0].path);
  expect(button(p.root, `Inspect file observation: ${row.source} / 000`).disabled).toBe(true);
  button(p.root, 'Next file participants').click(); expect(p.root.querySelectorAll('[data-file-participant]')).toHaveLength(40);
  button(p.root, 'Next file participants').click(); expect(p.root.querySelectorAll('[data-file-participant]')).toHaveLength(5);
  expect(document.activeElement?.textContent).toBe('Shared recorded files');
});
