// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isEscapeClaimed } from './escape';
import { PRESETS, createScope, formatRange, liveSpanOf, presetWindow, type ScopeStore } from './scope';
import { createTransport, type Transport } from './transport';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const H = 3_600_000;
const D = 86_400_000;

let rafQ: Array<[number, FrameRequestCallback]> = [];
let rafId = 0;
const flushRaf = (): void => {
  const q = rafQ;
  rafQ = [];
  for (const [, cb] of q) cb(0);
};

let made: Transport[] = [];
function setup(opts: { span?: () => number; store?: ScopeStore } = {}) {
  const store = opts.store ?? createScope();
  const t = createTransport({ store, now: () => NOW, effectiveLiveSpan: opts.span ?? (() => liveSpanOf(store.get())) });
  made.push(t);
  document.body.append(t.root);
  const track = t.root.querySelector<HTMLElement>('.transport-track')!;
  track.getBoundingClientRect = () => ({ width: 1000, height: 14, left: 0, top: 0, right: 1000, bottom: 14, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return { store, t, track };
}
const q = (t: Transport, sel: string) => t.root.querySelector<HTMLElement>(sel)!;
const preset = (t: Transport, id: string) => q(t, `[data-preset="${id}"]`);
const key = (target: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const ptr = (target: Element | Window, type: string, x = 0, init: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, button: 0, ...init }));

beforeEach(() => {
  rafQ = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQ.push([++rafId, cb]);
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQ = rafQ.filter(([i]) => i !== id);
  });
});
afterEach(() => {
  for (const t of made) t.destroy();
  made = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('structure', () => {
  const { t, track } = setup();
  expect(t.root.getAttribute('role')).toBe('group');
  expect(t.root.getAttribute('aria-label')).toBe('Time window');
  expect([...t.root.querySelectorAll('.transport-preset')].map((b) => b.getAttribute('data-preset'))).toEqual(['2h', '8h', '24h', '7d']);
  for (const b of t.root.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button');
  expect(track.getAttribute('role')).toBe('slider');
  expect(track.getAttribute('tabindex')).toBe('0');
  expect(track.getAttribute('aria-label')).toBe('Window position');
  expect(track.getAttribute('aria-valuemin')).toBe('0');
  expect(track.getAttribute('aria-valuemax')).toBe('100');
  expect(q(t, '.transport-live')).toBeTruthy();
  expect(q(t, '.transport-hold')).toBeTruthy();
});

test('preset click writes window and span in one commit', () => {
  for (const p of PRESETS) {
    const { store, t } = setup();
    const fn = vi.fn();
    store.subscribe(fn);
    preset(t, p.id).click();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.get().window).toEqual(presetWindow(p.id, NOW));
    expect(store.get().liveSpanMs).toBe(p.ms);
  }
});

test('Live follows the remembered span', () => {
  const { store, t } = setup();
  preset(t, '2h').click();
  q(t, '.transport-live').click();
  expect(store.get().window).toBe('live');
  expect(store.get().liveSpanMs).toBe(2 * H);
  expect(q(t, '.transport-range').textContent).toBe('Live · last 2 h');
  expect(q(t, '.transport-live').getAttribute('aria-pressed')).toBe('true');
  expect(preset(t, '2h').getAttribute('aria-pressed')).toBe('true');
  expect(preset(t, '8h').getAttribute('aria-pressed')).toBe('false');
});

test('default state', () => {
  const { t } = setup();
  expect(q(t, '.transport-live').getAttribute('aria-pressed')).toBe('true');
  for (const p of PRESETS) expect(preset(t, p.id).getAttribute('aria-pressed')).toBe('false');
  expect(q(t, '.transport-range').textContent).toBe('Live');
  expect(q(t, '.transport-hold').hasAttribute('aria-pressed')).toBe(false);
});

describe('hold', () => {
  test('freezes the remembered span', () => {
    const { store, t } = setup();
    preset(t, '2h').click();
    q(t, '.transport-live').click();
    q(t, '.transport-hold').click();
    expect(store.get().window).toEqual({ from: NOW - 2 * H, to: NOW });
    expect(store.get().liveSpanMs).toBe(2 * H);
  });
  test('unset span freezes the effective span (default Fleet lanes)', () => {
    const { store, t } = setup({ span: () => 300_000 });
    q(t, '.transport-hold').click();
    expect(store.get().window).toEqual({ from: NOW - 300_000, to: NOW });
    expect(store.get().liveSpanMs).toBeUndefined();
  });
  test('unset span with default effective is 7d', () => {
    const { store, t } = setup();
    q(t, '.transport-hold').click();
    expect(store.get().window).toEqual({ from: NOW - 7 * D, to: NOW });
  });
  test('on explicit returns to live', () => {
    const { store, t } = setup();
    store.narrow({ window: { from: NOW - H, to: NOW - 1000 } });
    expect(q(t, '.transport-hold').getAttribute('aria-label')).toBe('Return to live');
    q(t, '.transport-hold').click();
    expect(store.get().window).toBe('live');
  });
  test('round trip keeps the 5 min Fleet span', () => {
    const { store, t, track } = setup({ span: () => 300_000 });
    q(t, '.transport-hold').click();
    const w = store.get().window as { from: number; to: number };
    expect(w.to - w.from).toBe(300_000);
    q(t, '.transport-live').click();
    expect(store.get().window).toBe('live');
    key(track, 'ArrowLeft');
    const w2 = store.get().window as { from: number; to: number };
    expect(w2.to - w2.from).toBe(300_000);
  });
  test('brush then Live keeps the previous span', () => {
    const { store, t } = setup();
    preset(t, '8h').click();
    store.narrow({ window: { from: NOW - 1000, to: NOW } });
    q(t, '.transport-live').click();
    expect(store.get().window).toBe('live');
    expect(store.get().liveSpanMs).toBe(8 * H);
  });
});

test('explicit window readout', () => {
  const { store, t } = setup();
  const w = { from: NOW - 3 * H - 777, to: NOW - 1000 };
  store.narrow({ window: w });
  const r = q(t, '.transport-range');
  expect(r.textContent).toBe(formatRange(w, NOW).text);
  expect(r.textContent).toContain(' › ');
  expect(r.title).not.toBe('');
  for (const p of PRESETS) expect(preset(t, p.id).getAttribute('aria-pressed')).toBe('false');
  store.narrow({ window: { from: NOW - 8 * H - 5, to: NOW - 5 } });
  expect(preset(t, '8h').getAttribute('aria-pressed')).toBe('true');
  expect(preset(t, '2h').getAttribute('aria-pressed')).toBe('false');
});

describe('altitude from the displayed panel', () => {
  test('session panel disables window controls, Live still acts', () => {
    const { store, t, track } = setup();
    store.narrow({ session: { id: 's' } });
    t.setPanel('session');
    expect(q(t, '.transport-range').textContent).toBe('Live · whole session');
    for (const s of ['[data-preset="2h"]', '.transport-hold', '.transport-track']) expect(q(t, s).getAttribute('aria-disabled')).toBe('true');
    expect(track.getAttribute('tabindex')).toBe('-1');
    expect(q(t, '.transport-hint').textContent).toBe('Zoom with the Score');
    const before = store.get();
    preset(t, '2h').click();
    q(t, '.transport-hold').click();
    key(track, 'ArrowLeft');
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 400);
    flushRaf();
    expect(store.get()).toBe(before);
    expect(q(t, '.transport-live').getAttribute('aria-disabled')).not.toBe('true');
    store.narrow({ liveSpanMs: 7 * D });
    const fn = vi.fn();
    store.subscribe(fn);
    q(t, '.transport-live').click();
    expect(store.get().window).toBe('live');
  });
  test('navigating away re-enables controls even though session is retained', () => {
    for (const panel of ['project', 'fleet']) {
      const { store, t } = setup();
      store.narrow({ session: { id: 's' }, liveSpanMs: 2 * H });
      t.setPanel('session');
      t.setPanel(panel);
      expect(store.get().session).toBeTruthy();
      expect(preset(t, '2h').getAttribute('aria-disabled')).toBe('false');
      expect(q(t, '.transport-range').textContent).not.toContain('whole session');
      expect(preset(t, '2h').getAttribute('aria-pressed')).toBe('true');
    }
  });
  test('scope.session alone does not change altitude', () => {
    const { store, t } = setup();
    store.narrow({ session: { id: 's' } });
    t.setPanel('project');
    expect(preset(t, '2h').getAttribute('aria-disabled')).toBe('false');
    expect(q(t, '.transport-range').textContent).not.toContain('whole session');
  });
});

describe('keyboard', () => {
  const start = { from: NOW - 2 * H, to: NOW - 1000 };
  test('arrows shift by 10% / 50%', () => {
    const { store, track } = setup();
    store.narrow({ window: start });
    const span = 2 * H - 1000;
    const e = key(track, 'ArrowLeft');
    expect(e.defaultPrevented).toBe(true);
    expect(store.get().window).toEqual({ from: start.from - span * 0.1, to: start.to - span * 0.1 });
    store.narrow({ window: start });
    key(track, 'ArrowLeft', { shiftKey: true });
    expect(store.get().window).toEqual({ from: start.from - span * 0.5, to: start.to - span * 0.5 });
    store.narrow({ window: { from: start.from - D, to: start.to - D } });
    key(track, 'ArrowRight');
    expect(store.get().window).toEqual({ from: start.from - D + span * 0.1, to: start.to - D + span * 0.1 });
  });
  test('ArrowRight returns live only when span equals the live span', () => {
    const a = setup();
    a.store.narrow({ window: { from: NOW - 2 * H - 500, to: NOW - 100 } });
    key(a.track, 'ArrowRight', { shiftKey: true });
    expect(a.store.get().window).toEqual({ from: NOW - 2 * H - 400, to: NOW });
    const b = setup({ span: () => 2 * H });
    b.store.narrow({ window: { from: NOW - 2 * H - 100, to: NOW - 100 } });
    key(b.track, 'ArrowRight');
    expect(b.store.get().window).toBe('live');
  });
  test('Home goes live', () => {
    const { store, track } = setup();
    store.narrow({ window: start });
    expect(key(track, 'Home').defaultPrevented).toBe(true);
    expect(store.get().window).toBe('live');
  });
  test('modifiers ignored', () => {
    const { store, track } = setup();
    store.narrow({ window: start });
    for (const m of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(key(track, 'ArrowLeft', { [m]: true }).defaultPrevented).toBe(false);
    }
    expect(store.get().window).toEqual(start);
  });
  test('buttons do not handle arrows', () => {
    const { store, t } = setup();
    store.narrow({ window: start });
    for (const s of ['[data-preset="2h"]', '.transport-live', '.transport-hold']) {
      expect(key(q(t, s), 'ArrowLeft').defaultPrevented).toBe(false);
    }
    expect(store.get().window).toEqual(start);
  });
  test('dialog open blocks', () => {
    const { store, track } = setup();
    store.narrow({ window: start });
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    document.body.append(d);
    expect(key(track, 'ArrowLeft').defaultPrevented).toBe(false);
    expect(store.get().window).toEqual(start);
  });
  test('body keydown does nothing; Escape is not claimed', () => {
    const { store, track } = setup();
    store.narrow({ window: start });
    key(document.body, 'ArrowLeft');
    expect(store.get().window).toEqual(start);
    const e = key(track, 'Escape');
    expect(e.defaultPrevented).toBe(false);
    expect(isEscapeClaimed(e)).toBe(false);
  });
});

describe('drag', () => {
  const horizon = 30 * D;
  test('moves shift the window after rAF flush', () => {
    const { store, track } = setup();
    const w0 = { from: NOW - 2 * H - 5000, to: NOW - 5000 };
    store.narrow({ window: w0 });
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 400);
    expect(store.get().window).toEqual(w0);
    flushRaf();
    const d = -0.1 * horizon;
    expect(store.get().window).toEqual({ from: w0.from + d, to: w0.to + d });
  });
  test('two moves one flush give one write; pointerup flushes; moving back restores', () => {
    const { store, track } = setup();
    const w0 = { from: NOW - 2 * H - 5000, to: NOW - 5000 };
    store.narrow({ window: w0 });
    const fn = vi.fn();
    store.subscribe(fn);
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 450);
    ptr(track, 'pointermove', 400);
    flushRaf();
    expect(fn).toHaveBeenCalledTimes(1);
    ptr(track, 'pointermove', 500);
    ptr(track, 'pointerup', 500);
    expect(store.get().window).toEqual(w0);
  });
  test('clamps at now and goes live when span equals live span', () => {
    const { store, track } = setup({ span: () => 2 * H });
    store.narrow({ window: { from: NOW - 3 * H, to: NOW - H } });
    store.narrow({ window: { from: NOW - 2 * H - 1000, to: NOW - 1000 } });
    ptr(track, 'pointerdown', 0);
    ptr(track, 'pointermove', 900);
    flushRaf();
    expect(store.get().window).toBe('live');
  });
  test('non-primary button ignored', () => {
    const { store, track } = setup();
    const w0 = { from: NOW - 2 * H - 5000, to: NOW - 5000 };
    store.narrow({ window: w0 });
    ptr(track, 'pointerdown', 500, { button: 2 });
    ptr(track, 'pointermove', 400);
    flushRaf();
    expect(store.get().window).toEqual(w0);
  });
  const w0 = { from: NOW - 2 * H - 5000, to: NOW - 5000 };
  const interleavers: Array<[string, (c: ReturnType<typeof setup>) => void]> = [
    ['Home', (c) => void key(c.track, 'Home')],
    ['ArrowLeft', (c) => void key(c.track, 'ArrowLeft')],
    ['preset', (c) => preset(c.t, '8h').click()],
    ['external narrow', (c) => c.store.narrow({ window: { from: NOW - 10, to: NOW - 5 } })],
  ];
  for (const [name, act] of interleavers) {
    test(`interleaving ${name} wins over the stale frame`, () => {
      const c = setup();
      c.store.narrow({ window: w0 });
      ptr(c.track, 'pointerdown', 500);
      ptr(c.track, 'pointermove', 400);
      act(c);
      const after = c.store.get();
      flushRaf();
      expect(c.store.get()).toBe(after);
      ptr(c.track, 'pointermove', 300);
      flushRaf();
      expect(c.store.get()).toBe(after);
    });
  }
  test('Escape restores, claims, and is seen claimed by earlier document listener', () => {
    const { store, track } = setup();
    store.narrow({ window: w0 });
    let seen: boolean | undefined;
    const spy = (e: Event) => void (seen = isEscapeClaimed(e));
    document.addEventListener('keydown', spy, true);
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 400);
    flushRaf();
    expect(store.get().window).not.toEqual(w0);
    const e = key(track, 'Escape');
    document.removeEventListener('keydown', spy, true);
    expect(store.get().window).toEqual(w0);
    expect(isEscapeClaimed(e)).toBe(true);
    expect(seen).toBe(true);
    ptr(track, 'pointermove', 300);
    flushRaf();
    expect(store.get().window).toEqual(w0);
  });
  for (const ev of ['pointercancel', 'lostpointercapture']) {
    test(`${ev} ends the drag`, () => {
      const { store, track } = setup();
      store.narrow({ window: w0 });
      ptr(track, 'pointerdown', 500);
      ptr(track, ev, 500);
      ptr(track, 'pointermove', 400);
      flushRaf();
      expect(store.get().window).toEqual(w0);
    });
  }
  test('window blur ends the drag', () => {
    const { store, track } = setup();
    store.narrow({ window: w0 });
    ptr(track, 'pointerdown', 500);
    window.dispatchEvent(new Event('blur'));
    ptr(track, 'pointermove', 400);
    flushRaf();
    expect(store.get().window).toEqual(w0);
  });
  test('session or project change mid-drag aborts', () => {
    for (const patch of [{ session: { id: 'x' } }, { project: 'p' }]) {
      const { store, track } = setup();
      store.narrow({ window: w0 });
      ptr(track, 'pointerdown', 500);
      ptr(track, 'pointermove', 400);
      store.narrow(patch);
      const after = store.get();
      flushRaf();
      ptr(track, 'pointermove', 300);
      flushRaf();
      expect(store.get()).toBe(after);
    }
  });
  test('destroy removes listeners and cancels pending rAF', () => {
    const { store, t, track } = setup();
    store.narrow({ window: w0 });
    const remove = vi.spyOn(window, 'removeEventListener');
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 400);
    t.destroy();
    expect(rafQ.length).toBe(0);
    expect(remove).toHaveBeenCalledWith('keydown', expect.anything(), true);
    expect(remove).toHaveBeenCalledWith('blur', expect.anything());
    const after = store.get();
    key(track, 'Home');
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 100);
    flushRaf();
    expect(store.get()).toBe(after);
    const n = t.paintCount();
    store.narrow({ window: { from: 1, to: 2 } });
    expect(t.paintCount()).toBe(n);
  });
});

test('slider aria follows the window', () => {
  const { store, track, t } = setup();
  expect(track.getAttribute('aria-valuenow')).toBe('100');
  store.narrow({ window: { from: NOW - 2 * H - 10 * D, to: NOW - 10 * D } });
  const v = Number(track.getAttribute('aria-valuenow'));
  expect(Number.isInteger(v) && v >= 0 && v < 100).toBe(true);
  expect(track.getAttribute('aria-valuetext')).toBe(q(t, '.transport-range').textContent);
});

test('setVisible toggles hidden and keeps state', () => {
  const { store, t } = setup();
  preset(t, '2h').click();
  t.setVisible(false);
  expect(t.root.hidden).toBe(true);
  expect(store.get().liveSpanMs).toBe(2 * H);
  t.setVisible(true);
  expect(t.root.hidden).toBe(false);
});

test('mouse click blurs, keyboard activation keeps focus', () => {
  const { t } = setup();
  const b = preset(t, '2h');
  b.focus();
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  expect(document.activeElement).toBe(b);
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(document.activeElement).not.toBe(b);
  for (const s of ['.transport-live', '.transport-hold']) {
    const x = q(t, s);
    x.focus();
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(document.activeElement).not.toBe(x);
  }
});

test('no repaint when nothing changed', () => {
  const { store, t } = setup();
  const n0 = t.paintCount();
  store.narrow({ project: 'p' });
  store.narrow({ window: 'live' });
  expect(t.paintCount()).toBe(n0);
  store.narrow({ window: { from: NOW - H, to: NOW - 10 } });
  expect(t.paintCount()).toBe(n0 + 1);
  store.narrow({ window: { from: NOW - H, to: NOW - 10 } });
  expect(t.paintCount()).toBe(n0 + 1);
  t.setPanel('session');
  expect(t.paintCount()).toBe(n0 + 2);
  t.setPanel('session');
  store.narrow({ worktree: 'w' });
  expect(t.paintCount()).toBe(n0 + 2);
});

test('no timers; destroy unsubscribes', () => {
  const spy = vi.spyOn(globalThis, 'setInterval');
  const { store, t } = setup();
  store.narrow({ window: { from: NOW - H, to: NOW - 10 } });
  preset(t, '2h').click();
  expect(spy).not.toHaveBeenCalled();
  t.destroy();
  const n = t.paintCount();
  store.narrow({ window: 'live' });
  expect(t.paintCount()).toBe(n);

});

test('repaints when the panel live span changes without a scope write', () => {
  let sp = 5 * 60_000;
  const { t, track } = setup({ span: () => sp });
  const thumb = q(t, '.transport-thumb');
  const w0 = thumb.style.width;
  expect(q(t, '.transport-range').title).toContain('last 5 min');
  sp = 7 * D;
  t.refresh();
  expect(thumb.style.width).not.toBe(w0);
  expect(q(t, '.transport-range').title).toContain('last 7 d');
  expect(track.getAttribute('aria-valuetext')).toBeTruthy();
});

describe('review fixes', () => {
  test('Live readout and preset follow the effective span the panel draws', () => {
    const { t, store } = setup({ span: () => 7 * D });
    preset(t, '2h').click();
    q(t, '.transport-live').click();
    expect(store.get().liveSpanMs).toBe(2 * H);
    expect(q(t, '.transport-range').textContent).toBe('Live · last 7 d');
    expect(q(t, '.transport-range').title).toContain('Live · last 7 d');
    expect(preset(t, '2h').getAttribute('aria-pressed')).toBe('false');
  });
  test('mouse scrubbing releases focus from the track', () => {
    const { store, track } = setup();
    store.narrow({ window: { from: NOW - 2 * H - 5000, to: NOW - 5000 } });
    track.focus();
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 400);
    ptr(track, 'pointerup', 400);
    expect(document.activeElement).not.toBe(track);
  });
  test.each([
    ['setVisible(false)', (t: Transport) => t.setVisible(false)],
    ['setPanel(other)', (t: Transport) => t.setPanel('settings')],
    ['setPanel(same)', (t: Transport) => t.setPanel('project')],
  ])('%s cancels a pending scrub', (_n, act) => {
    const { store, t, track } = setup();
    const w0 = { from: NOW - 2 * H - 5000, to: NOW - 5000 };
    store.narrow({ window: w0 });
    ptr(track, 'pointerdown', 500);
    ptr(track, 'pointermove', 400);
    act(t);
    flushRaf();
    expect(store.get().window).toEqual(w0);
    const e = key(window as unknown as Element, 'Escape');
    expect(isEscapeClaimed(e)).toBe(false);
  });
  test('live tooltip re-reads the clock on hover', () => {
    let n = NOW;
    const store = createScope();
    const t = createTransport({ store, now: () => n, effectiveLiveSpan: () => 2 * H });
    made.push(t);
    document.body.append(t.root);
    const r = q(t, '.transport-range');
    const before = r.title;
    n += 3 * H;
    r.dispatchEvent(new MouseEvent('pointerenter'));
    expect(r.title).not.toBe(before);
  });
  test('held window labels the button as the return action', () => {
    const { store, t } = setup();
    expect(q(t, '.transport-hold').textContent).toBe('Hold');
    store.narrow({ window: { from: NOW - H, to: NOW - 1000 } });
    expect(q(t, '.transport-hold').textContent).toBe('Return to live');
  });
});
