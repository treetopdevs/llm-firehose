import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_LIVE_SPAN_MS,
  PRESETS,
  formatRange,
  formatSpan,
  isLive,
  liveSpanOf,
  presetWindow,
  resolveRange,
  shiftWindow,
  spanOf,
  createScope, sameSession, selectSession, scope, type Scope, type ScopeResolver } from './scope';

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

describe('fallback resolver', () => {
  const mk = (over: Partial<ScopeResolver> = {}): ScopeResolver => ({ sessions: () => undefined, labels: () => ({}), ...over });

  test('no fallback: resolver() is the exact primary object', () => {
    const s = createScope();
    const p = mk();
    s.setResolver(p);
    expect(s.resolver()).toBe(p);
  });

  test('only a fallback: resolver() exposes it', () => {
    const s = createScope();
    const f = mk();
    s.setFallbackResolver(f);
    expect(s.resolver()).toBe(f);
  });

  test('both: primary answers win when defined, fallback fills undefined', async () => {
    const s = createScope();
    const sc = s.get();
    const pm = (ref: { id: string }) => ref.id === 'p';
    const fm = (ref: { id: string }) => ref.id === 'f';
    const pRefresh = vi.fn(() => Promise.resolve());
    const fRefresh = vi.fn(() => Promise.resolve());
    const primary = mk({ sessions: () => new Set(['p']), matcher: () => pm, labels: () => ({ project: 'P' }), refresh: pRefresh });
    const fallback = mk({ sessions: () => new Set(['f']), matcher: () => fm, labels: () => ({ project: 'F', worktree: 'W' }), refresh: fRefresh });
    s.setResolver(primary);
    s.setFallbackResolver(fallback);
    const r = s.resolver()!;
    expect([...r.sessions(sc)!]).toEqual(['p']);
    expect(r.matcher!(sc)).toBe(pm);
    expect(r.labels(sc)).toEqual({ project: 'P', worktree: 'W' });
    await r.refresh!();
    expect(pRefresh).toHaveBeenCalledTimes(1);
    expect(fRefresh).toHaveBeenCalledTimes(1);

    s.setResolver(mk());
    const r2 = s.resolver()!;
    expect([...r2.sessions(sc)!]).toEqual(['f']);
    expect(r2.matcher!(sc)).toBe(fm);
  });

  test('labels: undefined primary keys do not hide fallback', () => {
    const s = createScope();
    s.setResolver(mk({ labels: () => ({ project: undefined, worktree: 'pw' }) }));
    s.setFallbackResolver(mk({ labels: () => ({ project: 'F', worktree: 'fw' }) }));
    expect(s.resolver()!.labels(s.get())).toEqual({ project: 'F', worktree: 'pw' });
  });

  test('onResolver fires on setFallbackResolver; setResolver(null) keeps fallback; setFallbackResolver(null) removes', () => {
    const s = createScope();
    const fn = vi.fn();
    s.onResolver(fn);
    const f = mk();
    s.setFallbackResolver(f);
    expect(fn).toHaveBeenCalledTimes(1);
    s.setResolver(mk());
    s.setResolver(null);
    expect(s.resolver()).toBe(f);
    s.setFallbackResolver(null);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(s.resolver()).toBeNull();
  });
});

describe("composed resolvers: knowledge", () => {
  const sc = { project: "p", worktree: "w", window: "live" } as const;
  test("a primary that does not know the worktree defers to a fallback that does", () => {
    const store = createScope();
    store.setResolver({ sessions: () => new Set<string>(), knows: () => false, labels: () => ({}) });
    store.setFallbackResolver({ sessions: () => new Set(["x"]), knows: () => true, labels: () => ({}) });
    expect([...store.resolver()!.sessions(sc)!]).toEqual(["x"]);
    expect(store.resolver()!.matcher!(sc)!({ id: "x" })).toBe(true);
    expect(store.resolver()!.knows!(sc)).toBe(true);
  });
  test("a primary that knows keeps authority; neither knowing stays the primary's answer", () => {
    const store = createScope();
    store.setResolver({ sessions: () => new Set<string>(), knows: () => true, labels: () => ({}) });
    store.setFallbackResolver({ sessions: () => new Set(["x"]), knows: () => true, labels: () => ({}) });
    expect([...store.resolver()!.sessions(sc)!]).toEqual([]);
    store.setFallbackResolver({ sessions: () => new Set(["x"]), knows: () => false, labels: () => ({}) });
    store.setResolver({ sessions: () => new Set<string>(), knows: () => false, labels: () => ({}) });
    expect([...store.resolver()!.sessions(sc)!]).toEqual([]);
    expect(store.resolver()!.knows!(sc)).toBe(false);
  });
});

describe('window helpers', () => {
  test('presets', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['2h', '8h', '24h', '7d']);
    expect(presetWindow('2h', 1e9)).toEqual({ from: 1e9 - 7.2e6, to: 1e9 });
    expect(presetWindow('8h', 1e9)).toEqual({ from: 1e9 - 8 * 3.6e6, to: 1e9 });
    expect(presetWindow('24h', 1e9)).toEqual({ from: 1e9 - 24 * 3.6e6, to: 1e9 });
    expect(presetWindow('7d', 1e9)).toEqual({ from: 1e9 - 7 * 864e5, to: 1e9 });
  });
  test('isLive/spanOf/resolveRange', () => {
    expect(isLive('live')).toBe(true);
    expect(isLive({ from: 1, to: 2 })).toBe(false);
    expect(spanOf('live', 5)).toBe(DEFAULT_LIVE_SPAN_MS);
    expect(DEFAULT_LIVE_SPAN_MS).toBe(7 * 864e5);
    expect(spanOf('live', 5, 7_200_000)).toBe(7_200_000);
    expect(spanOf({ from: 100, to: 400 }, 5)).toBe(300);
    expect(resolveRange('live', 10_000, 4000)).toEqual({ from: 6000, to: 10_000 });
  });
  test('shiftWindow', () => {
    expect(shiftWindow({ from: 1000, to: 2000 }, -500, 5000)).toEqual({ from: 500, to: 1500 });
    expect(shiftWindow({ from: 1000, to: 2000 }, 10_000, 1800)).toEqual({ from: 800, to: 1800 });
    expect(shiftWindow({ from: 1000, to: 2000 }, 10_000, 2000, 1000)).toBe('live');
    expect(shiftWindow({ from: 1000, to: 2000 }, 10_000, 2000, 5000)).toEqual({ from: 1000, to: 2000 });
    const now = 100_000_000;
    expect(shiftWindow('live', -3_600_000, now, 7_200_000)).toEqual({ from: now - 10_800_000, to: now - 3_600_000 });
    expect(shiftWindow('live', 0, now, 7_200_000)).toBe('live');
    const w = { from: 1, to: 2 };
    expect(shiftWindow(w, NaN, 5)).toBe(w);
    expect(shiftWindow(w, Infinity, 5)).toBe(w);
  });
  test('formatSpan', () => {
    expect(formatSpan(30_000)).toBe('30 s');
    expect(formatSpan(45 * 60_000)).toBe('45 min');
    expect(formatSpan(2 * 3.6e6)).toBe('2 h');
    expect(formatSpan(90 * 60_000)).toBe('1 h 30 min');
    expect(formatSpan(30 * 3.6e6)).toBe('1 d 6 h');
    expect(formatSpan(7 * 864e5)).toBe('7 d');
  });
  test('formatRange', () => {
    const now = new Date(2026, 10, 1, 12, 0).getTime();
    expect(formatRange('live', now).text).toBe('Live');
    expect(formatRange('live', now, 7_200_000).text).toBe('Live · last 2 h');
    expect(formatRange('live', now, undefined, { wholeSession: true }).text).toBe('Live · whole session');
    const w = { from: new Date(2026, 9, 31, 9, 0).getTime(), to: new Date(2026, 9, 31, 17, 0).getTime() };
    const r = formatRange(w, now);
    expect(r.text).toBe('Oct 31, 09:00 › Oct 31, 17:00 · 8 h');
    expect(r.title).toContain(r.text);
    expect(r.title).toContain('UTC');
    const short = formatRange({ from: w.from, to: w.from + 10 * 60_000 + 5000 }, now);
    expect(short.text).toContain('09:00:00');
    const yr = formatRange({ from: new Date(2025, 11, 31, 23, 0).getTime(), to: new Date(2026, 0, 1, 1, 0).getTime() }, now);
    expect(yr.text).toContain('2025');
    expect(yr.text).toContain('2026');
  });
  test('UTC part of the title is timezone independent', () => {
    const w = { from: Date.UTC(2026, 9, 31, 13, 0), to: Date.UTC(2026, 9, 31, 21, 0) };
    const orig = process.env.TZ;
    const utcPart = (tz: string) => {
      process.env.TZ = tz;
      const t = formatRange(w, w.to).title;
      return t.slice(t.indexOf('UTC'));
    };
    try {
      expect(utcPart('America/New_York')).toBe(utcPart('UTC'));
      expect(utcPart('UTC')).toBe('UTC Oct 31, 13:00 › Oct 31, 21:00');
    } finally {
      if (orig === undefined) delete process.env.TZ;
      else process.env.TZ = orig;
    }
  });
});

describe('liveSpanMs', () => {
  test('absent by default; narrow stores; invalid ignored', () => {
    const s = createScope();
    expect(s.get()).toEqual({ window: 'live' });
    expect(liveSpanOf(s.get())).toBe(DEFAULT_LIVE_SPAN_MS);
    s.narrow({ liveSpanMs: 7_200_000 });
    expect(s.get()).toEqual({ window: 'live', liveSpanMs: 7_200_000 });
    expect(liveSpanOf(s.get())).toBe(7_200_000);
    for (const bad of [0, -1, NaN, Infinity]) s.narrow({ liveSpanMs: bad });
    expect(s.get().liveSpanMs).toBe(7_200_000);
    const fresh = createScope();
    const fn = vi.fn();
    fresh.subscribe(fn);
    fresh.narrow({ liveSpanMs: undefined });
    expect(fresh.get()).toEqual({ window: 'live' });
    expect('liveSpanMs' in fresh.get()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
  test('window and span notify once; identical does not; span-only notifies', () => {
    const s = createScope();
    const fn = vi.fn();
    s.subscribe(fn);
    s.narrow({ window: { from: 1, to: 2 }, liveSpanMs: 3_600_000 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.get()).toEqual({ window: { from: 1, to: 2 }, liveSpanMs: 3_600_000 });
    s.narrow({ liveSpanMs: 3_600_000 });
    expect(fn).toHaveBeenCalledTimes(1);
    s.narrow({ liveSpanMs: 7_200_000 });
    expect(fn).toHaveBeenCalledTimes(2);
  });
  test('kept by narrow, replaceContext, ascend; cleared by reset/set', () => {
    const s = createScope();
    s.narrow({ liveSpanMs: 7_200_000, window: { from: 1, to: 2 } });
    s.narrow({ project: 'p' });
    expect(s.get().liveSpanMs).toBe(7_200_000);
    s.replaceContext({ project: 'q' });
    expect(s.get()).toEqual({ project: 'q', window: { from: 1, to: 2 }, liveSpanMs: 7_200_000 });
    s.ascend();
    expect(s.get().liveSpanMs).toBe(7_200_000);
    s.reset();
    expect(s.get()).toEqual({ window: 'live' });
    expect('liveSpanMs' in s.get()).toBe(false);
    s.narrow({ liveSpanMs: 7_200_000 });
    s.set({ window: 'live' });
    expect('liveSpanMs' in s.get()).toBe(false);
  });
  test('session change resets window, keeps span; explicit window carries', () => {
    const s = createScope();
    s.narrow({ liveSpanMs: 7_200_000, window: { from: 1, to: 2 } });
    s.narrow({ session: { id: 'a' } });
    expect(s.get()).toMatchObject({ window: 'live', liveSpanMs: 7_200_000 });
    s.narrow({ session: { id: 'b' }, window: { from: 5, to: 9 } });
    expect(s.get().window).toEqual({ from: 5, to: 9 });
    expect(s.get().liveSpanMs).toBe(7_200_000);
  });
});
