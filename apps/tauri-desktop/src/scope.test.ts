import { expect, test, vi } from 'vitest';
import { createScope, sameSession, selectSession, scope, type Scope, type ScopeResolver } from './scope';

const cell = { where: 'w', agent: 'a', label: 'l' };

test('starts empty at fleet altitude', () => {
  const s = createScope();
  expect(s.get()).toEqual({ window: 'live' });
  expect(s.altitude()).toBe('fleet');
});

test('narrow merges, undefined clears, absent untouched', () => {
  const s = createScope();
  s.narrow({ project: 'p', cell });
  s.narrow({ worktree: 'w' });
  expect(s.get()).toMatchObject({ project: 'p', worktree: 'w', cell });
  s.narrow({ cell: undefined });
  expect(s.get().cell).toBeUndefined();
  expect('cell' in s.get()).toBe(false);
  expect(s.get().project).toBe('p');
});

test('project change drops worktree+session unless supplied; worktree change drops session', () => {
  const s = createScope();
  s.narrow({ project: 'p', worktree: 'w', session: { id: 's' } });
  s.narrow({ project: 'p2' });
  expect(s.get()).toEqual({ project: 'p2', window: 'live' });
  s.narrow({ project: 'p3', worktree: 'w3', session: { id: 's3' } });
  expect(s.get()).toMatchObject({ project: 'p3', worktree: 'w3', session: { id: 's3' } });
  s.narrow({ worktree: 'w4' });
  expect(s.get().session).toBeUndefined();
  expect(s.get().worktree).toBe('w4');
  s.narrow({ session: { id: 'x' } });
  s.narrow({ worktree: 'w5', session: { id: 'y' } });
  expect(s.get().session).toEqual({ id: 'y' });
  // same project keeps children
  s.narrow({ project: 'p3' });
  expect(s.get().worktree).toBe('w5');
});

test('session id or source change resets window unless patch carries window', () => {
  const s = createScope({ session: { id: 'a', source: 'x' } });
  s.narrow({ window: { from: 1, to: 5 } });
  expect(s.get().window).toEqual({ from: 1, to: 5 });
  s.narrow({ session: { id: 'a', source: 'x' } });
  expect(s.get().window).toEqual({ from: 1, to: 5 });
  s.narrow({ session: { id: 'a', source: 'y' } });
  expect(s.get().window).toBe('live');
  s.narrow({ window: { from: 1, to: 5 } });
  s.narrow({ session: { id: 'b' } });
  expect(s.get().window).toBe('live');
  s.narrow({ window: { from: 1, to: 5 } });
  s.narrow({ session: { id: 'c' }, window: { from: 2, to: 3 } });
  expect(s.get().window).toEqual({ from: 2, to: 3 });
});

test('altitude is deepest rung', () => {
  const s = createScope();
  s.narrow({ project: 'p' });
  expect(s.altitude()).toBe('project');
  s.narrow({ worktree: 'w' });
  expect(s.altitude()).toBe('worktree');
  s.narrow({ session: { id: 's' } });
  expect(s.altitude()).toBe('session');
});

test('ascend order and null does not notify', () => {
  const s = createScope();
  s.narrow({ project: 'p', worktree: 'w', session: { id: 's' }, cell });
  s.narrow({ window: { from: 1, to: 2 } });
  expect(s.ascend()).toBe('worktree');
  expect(s.get().window).toBe('live');
  expect(s.get().cell).toEqual(cell);
  expect(s.ascend()).toBe('project');
  expect(s.get().project).toBe('p');
  expect(s.ascend()).toBe('fleet');
  expect(s.get().cell).toBeUndefined();
  const only = createScope({ cell });
  expect(only.ascend()).toBe('fleet');
  expect(only.get()).toEqual({ window: 'live' });
  const fn = vi.fn();
  only.subscribe(fn);
  expect(only.ascend()).toBeNull();
  expect(fn).not.toHaveBeenCalled();
});

test('window validation', () => {
  const s = createScope();
  s.narrow({ window: { from: 1 } });
  expect(s.get().window).toBe('live');
  s.narrow({ window: { from: 1, to: 10 } });
  expect(s.get().window).toEqual({ from: 1, to: 10 });
  s.narrow({ window: { to: 20 } });
  expect(s.get().window).toEqual({ from: 1, to: 20 });
  s.narrow({ window: { from: 30 } });
  expect(s.get().window).toEqual({ from: 1, to: 20 });
  s.narrow({ window: { from: NaN } });
  s.narrow({ window: { to: Infinity } });
  expect(s.get().window).toEqual({ from: 1, to: 20 });
  s.narrow({ window: 'live' });
  expect(s.get().window).toBe('live');
  s.narrow({ window: { from: 5, to: 4 } });
  expect(s.get().window).toBe('live');
});

test('no-op set/narrow never notifies; same ref when unchanged; frozen', () => {
  const s = createScope();
  s.narrow({ project: 'p', cell });
  const fn = vi.fn();
  s.subscribe(fn);
  const before = s.get();
  s.narrow({ project: 'p' });
  s.narrow({});
  s.narrow({ cell: { ...cell } });
  s.set({ project: 'p', cell: { ...cell }, window: 'live' });
  expect(fn).not.toHaveBeenCalled();
  expect(s.get()).toBe(before);
  expect(Object.isFrozen(before)).toBe(true);
  s.narrow({ session: { id: 'a' } });
  expect(Object.isFrozen(s.get())).toBe(true);
  expect(Object.isFrozen(s.get().session)).toBe(true);
  expect(s.get()).not.toBe(before);
});

test('subscribe is synchronous, ordered, receives (next, prev); unsubscribe works', () => {
  const s = createScope();
  const calls: string[] = [];
  const un = s.subscribe((n, p) => calls.push(`a:${n.project}:${p.project}`));
  s.subscribe((n) => calls.push(`b:${n.project}`));
  s.narrow({ project: 'p' });
  expect(calls).toEqual(['a:p:undefined', 'b:p']);
  un();
  s.narrow({ project: 'q' });
  expect(calls).toEqual(['a:p:undefined', 'b:p', 'b:q']);
});

test('re-entrant narrow is queued in order with committed pairs', () => {
  const s = createScope();
  const seen: string[] = [];
  s.subscribe((n, p) => {
    seen.push(`${p.project ?? '-'}>${n.project}`);
    if (n.project === 'a') {
      s.narrow({ project: 'b' });
      expect(s.get().project).toBe('b');
      expect(seen).toEqual(['->a']);
    }
  });
  s.narrow({ project: 'a' });
  expect(seen).toEqual(['->a', 'a>b']);
});

test('reset notifies once; instances independent; module scope exists', () => {
  const s = createScope();
  const other = createScope();
  s.narrow({ project: 'p', worktree: 'w', session: { id: 's' } });
  const fn = vi.fn();
  s.subscribe(fn);
  s.reset();
  expect(fn).toHaveBeenCalledTimes(1);
  expect(s.get()).toEqual({ window: 'live' });
  s.reset();
  expect(fn).toHaveBeenCalledTimes(1);
  expect(other.get()).toEqual({ window: 'live' });
  expect(scope.get()).toEqual({ window: 'live' });
});

test('replaceContext clears context then applies patch', () => {
  const s = createScope();
  s.narrow({ project: 'p', worktree: 'w', session: { id: 's' }, cell });
  const fn = vi.fn();
  s.subscribe(fn);
  s.replaceContext({ session: { id: 't' } });
  expect(s.get()).toEqual({ session: { id: 't' }, window: 'live' });
  expect(fn).toHaveBeenCalledTimes(1);
  s.replaceContext({});
  expect(s.get()).toEqual({ window: 'live' });
});

test('sameSession distinguishes absent from explicit source', () => {
  expect(sameSession(undefined, undefined)).toBe(true);
  expect(sameSession({ id: 'a' }, undefined)).toBe(false);
  expect(sameSession({ id: 'a' }, { id: 'a' })).toBe(true);
  expect(sameSession({ id: 'a' }, { id: 'a', source: 'x' })).toBe(false);
  expect(sameSession({ id: 'a', source: 'x' }, { id: 'a', source: 'x' })).toBe(true);
  expect(sameSession({ id: 'a', source: 'x' }, { id: 'b', source: 'x' })).toBe(false);
});

test('resolver channel notifies onResolver, not scope subscribers', () => {
  const s = createScope();
  const res: ScopeResolver = { sessions: () => undefined, labels: () => ({}) };
  const scopeFn = vi.fn();
  const resFn = vi.fn();
  s.subscribe(scopeFn);
  const un = s.onResolver(resFn);
  expect(s.resolver()).toBeNull();
  s.setResolver(res);
  expect(s.resolver()).toBe(res);
  expect(resFn).toHaveBeenCalledTimes(1);
  s.touchResolver();
  expect(resFn).toHaveBeenCalledTimes(2);
  un();
  s.touchResolver();
  s.setResolver(null);
  expect(resFn).toHaveBeenCalledTimes(2);
  expect(s.resolver()).toBeNull();
  expect(scopeFn).not.toHaveBeenCalled();
  const _t: Scope = s.get();
  void _t;
});

test('selectSession: same native id under another source is not contained', () => {
  const s = createScope();
  s.setResolver({
    sessions: () => new Set(['n1']),
    matcher: () => (ref) => ref.id === 'n1' && ref.source === 'codex',
    labels: () => ({}),
  });
  s.narrow({ project: 'p', worktree: 'w', session: { id: 'n1', source: 'codex' } });
  selectSession(s, { id: 'n1', source: 'claude-code' });
  expect(s.get()).toMatchObject({ session: { id: 'n1', source: 'claude-code' } });
  expect(s.get().project).toBeUndefined();
  expect(s.get().worktree).toBeUndefined();
});
