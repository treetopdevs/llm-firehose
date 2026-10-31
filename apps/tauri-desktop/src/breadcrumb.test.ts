// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createBreadcrumb } from './breadcrumb';
import { createScope, type ScopeResolver } from './scope';

const resolver = (labels: { project?: string; worktree?: string }): ScopeResolver => ({
  sessions: () => undefined,
  labels: () => labels,
});

afterEach(() => vi.restoreAllMocks());

test('empty scope renders empty span, no children', () => {
  const b = createBreadcrumb(createScope());
  expect(b.root.tagName).toBe('SPAN');
  expect(b.root.childNodes.length).toBe(0);
});

test('labels from resolver, separator, titles carry full ids', () => {
  const s = createScope();
  s.setResolver(resolver({ project: 'firehose', worktree: 'feat-x' }));
  const b = createBreadcrumb(s);
  s.narrow({ project: 'repo-1234567890', worktree: 'wt-abcdefghij', session: { id: 'sess-0123456789' } });
  expect(b.root.textContent).toBe('firehose › feat-x › sess-012');
  const segs = [...b.root.querySelectorAll('[title]')];
  expect(segs.map((x) => x.getAttribute('title'))).toEqual(['repo-1234567890', 'wt-abcdefghij', 'sess-0123456789']);
});

test('unresolved vs resolved rendering', () => {
  const s = createScope();
  const b = createBreadcrumb(s);
  s.narrow({ project: 'repo-1234567890', session: { id: 'sess-0123456789' } });
  expect([...b.root.querySelectorAll('span.unresolved')].map((x) => x.textContent)).toEqual(['repo-123', 'sess-012']);
  s.setResolver(resolver({ project: 'firehose' }));
  expect([...b.root.querySelectorAll('span.unresolved')].map((x) => x.textContent)).toEqual(['sess-012']);
  expect(b.root.textContent).toBe('firehose › sess-012');
});

test('F8: resolver arriving with the same scope refreshes labels', () => {
  const s = createScope();
  const b = createBreadcrumb(s);
  s.narrow({ project: 'repo-1234567890', worktree: 'wt-abcdefghij' });
  expect(b.root.querySelectorAll('.unresolved').length).toBe(2);
  s.setResolver(resolver({ project: 'P', worktree: 'W' }));
  expect(b.root.textContent).toBe('P › W');
  expect(b.root.querySelectorAll('.unresolved').length).toBe(0);
  s.setResolver({ sessions: () => undefined, labels: () => ({ project: 'P2', worktree: 'W' }) });
  s.touchResolver();
  expect(b.root.textContent).toBe('P2 › W');
});

test('window-only and cell-only changes do not rebuild', () => {
  const s = createScope();
  const b = createBreadcrumb(s);
  s.narrow({ project: 'repo-1234567890', session: { id: 'sess-0123456789' } });
  const first = b.root.firstChild;
  s.narrow({ window: { from: 1, to: 2 } });
  s.narrow({ cell: { where: 'w', agent: 'a', label: 'l' } });
  expect(b.root.firstChild).toBe(first);
});

test('no network, no console noise, throwing resolver caught', () => {
  expect(readFileSync('src/breadcrumb.ts', 'utf8')).not.toMatch(/api['"]/);
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = createScope();
  s.setResolver({ sessions: () => undefined, labels: () => { throw new Error('boom'); } });
  const b = createBreadcrumb(s);
  s.narrow({ project: 'repo-1234567890' });
  expect(b.root.querySelector('.unresolved')?.textContent).toBe('repo-123');
  expect(err).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test('destroy unsubscribes both channels', () => {
  const s = createScope();
  const b = createBreadcrumb(s);
  s.narrow({ project: 'repo-1234567890' });
  b.destroy();
  s.narrow({ worktree: 'wt-abcdefghij' });
  s.setResolver(resolver({ project: 'Z' }));
  expect(b.root.textContent).toBe('repo-123');
});
