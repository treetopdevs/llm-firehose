// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { __resetKeysForTests, listKeys, listLocalKeys, LOCAL, LOCAL_KEYS, registerKeys, type KeyBinding } from './keys';
import { isEscapeClaimed } from './escape';
import { createScope, liveSpanOf } from './scope';
import { createTransport } from './transport';
import { SESSION_TABS, type SessionTab } from './ui/session/context';
import { createSession, type SessionLens } from './ui/session';
import { createSessionDirectory } from './session-directory';

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function binding(over: Partial<KeyBinding> & Pick<KeyBinding, 'keys'>): KeyBinding {
  return { scope: 'global', display: over.keys.join('/'), label: 'test', handler: () => {}, ...over };
}

beforeEach(() => {
  __resetKeysForTests();
  document.body.replaceChildren();
});
afterEach(() => {
  __resetKeysForTests();
  vi.restoreAllMocks();
});

describe('dispatch', () => {
  test('dispatches a registered key on document keydown', () => {
    const h = vi.fn();
    registerKeys([binding({ keys: ['q'], handler: h })]);
    press('q');
    press('w');
    expect(h).toHaveBeenCalledTimes(1);
  });

  test('matches by e.code as well as e.key (Space)', () => {
    const h = vi.fn();
    registerKeys([binding({ keys: [' ', 'Space'], handler: h })]);
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
    press(' ');
    expect(h).toHaveBeenCalledTimes(2);
  });

  test('duplicate (key,scope) throws naming key and scope; other scopes are fine; a failed batch registers nothing', () => {
    registerKeys([binding({ keys: ['a'], scope: 'one' })]);
    expect(() => registerKeys([binding({ keys: ['a'], scope: 'one' })])).toThrow(/"a".*"one"|one.*a/);
    expect(() => registerKeys([binding({ keys: ['a'], scope: 'two' })])).not.toThrow();
    const h = vi.fn();
    expect(() => registerKeys([binding({ keys: ['z'], scope: 'three', handler: h }), binding({ keys: ['a'], scope: 'one' })])).toThrow();
    press('z');
    expect(h).not.toHaveBeenCalled();
    expect(() => registerKeys([binding({ keys: ['z'], scope: 'three', handler: h })])).not.toThrow();
  });

  test('in production a conflicting binding is warned about and skipped, the rest register', () => {
    vi.stubEnv('PROD', true);
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = vi.fn();
      const second = vi.fn();
      const other = vi.fn();
      registerKeys([binding({ keys: ['a'], scope: 'one', handler: first })]);
      expect(() => registerKeys([binding({ keys: ['a'], scope: 'one', handler: second, label: 'dup' }), binding({ keys: ['b'], scope: 'one', handler: other })])).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"a".*"one"/));
      press('a');
      press('b');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
      expect(other).toHaveBeenCalledTimes(1);
      expect(listKeys().map((r) => r.label)).not.toContain('dup');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('a duplicate inside one batch throws too', () => {
    expect(() => registerKeys([binding({ keys: ['a'], scope: 's' }), binding({ keys: ['b', 'a'], scope: 's' })])).toThrow(/"a"/);
  });
});

describe('guards', () => {
  test('INPUT, TEXTAREA, SELECT and contenteditable targets are ignored by default', () => {
    const h = vi.fn();
    registerKeys([binding({ keys: ['/'], handler: h })]);
    const input = document.createElement('input');
    const ta = document.createElement('textarea');
    const sel = document.createElement('select');
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    ce.append(inner);
    document.body.append(input, ta, sel, ce);
    for (const t of [input, ta, sel, ce, inner]) press('/', {}, t);
    expect(h).not.toHaveBeenCalled();
    press('/');
    expect(h).toHaveBeenCalledTimes(1);
  });

  test('allowInInput lets Cmd+K fire from an input while a plain binding does not', () => {
    const k = vi.fn();
    const slash = vi.fn();
    registerKeys([
      binding({ keys: ['k'], scope: 'graph', modifiers: 'any', allowInInput: true, handler: k }),
      binding({ keys: ['/'], scope: 'graph', handler: slash }),
    ]);
    const input = document.createElement('input');
    document.body.append(input);
    press('k', { metaKey: true }, input);
    press('/', {}, input);
    expect(k).toHaveBeenCalledTimes(1);
    expect(slash).not.toHaveBeenCalled();
  });

  test('ctrl/meta/alt are ignored unless modifiers is any; Shift is allowed', () => {
    const plain = vi.fn();
    const any = vi.fn();
    registerKeys([binding({ keys: ['p'], handler: plain }), binding({ keys: ['Escape'], modifiers: 'any', handler: any })]);
    press('p', { ctrlKey: true });
    press('p', { metaKey: true });
    press('p', { altKey: true });
    expect(plain).not.toHaveBeenCalled();
    press('p', { shiftKey: true });
    expect(plain).toHaveBeenCalledTimes(1);
    press('Escape', { ctrlKey: true });
    press('Escape', { altKey: true });
    expect(any).toHaveBeenCalledTimes(2);
  });

  test('isComposing and defaultPrevented events are ignored', () => {
    const h = vi.fn();
    registerKeys([binding({ keys: ['q'], handler: h })]);
    press('q', { isComposing: true });
    document.body.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    press('q');
    expect(h).not.toHaveBeenCalled();
  });

  test('non-global bindings are skipped while an aria-modal dialog exists; global ones still run', () => {
    const panel = vi.fn();
    const global = vi.fn();
    registerKeys([binding({ keys: ['x'], scope: 'fleet', handler: panel }), binding({ keys: ['Escape'], handler: global })]);
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    document.body.append(dlg);
    press('x');
    press('Escape');
    expect(panel).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledTimes(1);
    dlg.remove();
    press('x');
    expect(panel).toHaveBeenCalledTimes(1);
  });
});

describe('enabled and listing', () => {
  test('enabled() false hides the binding from dispatch and listKeys()', () => {
    let on = false;
    const h = vi.fn();
    registerKeys([binding({ keys: ['q'], scope: 'live', display: 'Q', label: 'quit', handler: h, enabled: () => on })]);
    press('q');
    expect(h).not.toHaveBeenCalled();
    expect(listKeys()).toEqual([]);
    on = true;
    press('q');
    expect(h).toHaveBeenCalledTimes(1);
    expect(listKeys()).toEqual([{ scope: 'live', display: 'Q', label: 'quit' }]);
  });

  test('listKeys returns {scope,display,label} rows, panel scopes first then global', () => {
    registerKeys([
      binding({ keys: ['Escape'], scope: 'global', display: 'Esc', label: 'up' }),
      binding({ keys: ['n'], scope: 'fleet', display: 'n', label: 'next need' }),
    ]);
    expect(listKeys()).toEqual([
      { scope: 'fleet', display: 'n', label: 'next need' },
      { scope: 'global', display: 'Esc', label: 'up' },
    ]);
  });
});

describe('fall-through and ordering', () => {
  test('a panel handler returning false lets the global binding for the same key run', () => {
    const order: string[] = [];
    registerKeys([
      binding({ keys: ['Escape'], scope: 'global', handler: () => void order.push('global') }),
      binding({ keys: ['Escape'], scope: 'fleet', handler: () => { order.push('fleet'); return false; } }),
    ]);
    press('Escape');
    expect(order).toEqual(['fleet', 'global']);
  });

  test('any other return value stops dispatch (undefined, true)', () => {
    for (const ret of [undefined, true]) {
      __resetKeysForTests();
      const g = vi.fn();
      registerKeys([
        binding({ keys: ['k'], scope: 'global', handler: g }),
        binding({ keys: ['k'], scope: 'panel', handler: () => ret }),
      ]);
      press('k');
      expect(g).not.toHaveBeenCalled();
    }
  });

  test('panel scope wins over global when both are enabled, regardless of registration order', () => {
    const order: string[] = [];
    registerKeys([binding({ keys: ['k'], scope: 'global', handler: () => void order.push('g') })]);
    registerKeys([binding({ keys: ['k'], scope: 'p', handler: () => void order.push('p') })]);
    press('k');
    expect(order).toEqual(['p']);
  });

  test('a disabled panel binding does not shadow the global one', () => {
    const g = vi.fn();
    registerKeys([binding({ keys: ['k'], handler: g }), binding({ keys: ['k'], scope: 'p', enabled: () => false })]);
    press('k');
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle', () => {
  test('unregister is idempotent, and the document listener goes with the last binding', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const rem = vi.spyOn(document, 'removeEventListener');
    const off1 = registerKeys([binding({ keys: ['a'] })]);
    const off2 = registerKeys([binding({ keys: ['b'] })]);
    const adds = () => add.mock.calls.filter((c) => c[0] === 'keydown');
    const rems = () => rem.mock.calls.filter((c) => c[0] === 'keydown');
    expect(adds()).toHaveLength(1);
    off1();
    off1();
    expect(rems()).toHaveLength(0);
    off2();
    off2();
    expect(rems()).toHaveLength(1);
    expect(rems()[0]![1]).toBe(adds()[0]![1]);
    registerKeys([binding({ keys: ['c'] })]);
    expect(adds()).toHaveLength(2);
  });

  test('unregistering frees the (key,scope) pair for reuse', () => {
    const off = registerKeys([binding({ keys: ['a'], scope: 's' })]);
    off();
    expect(() => registerKeys([binding({ keys: ['a'], scope: 's' })])).not.toThrow();
  });
});

// ---- element-local keys ------------------------------------------------------

/** What each descriptor's displayed text names, spelled out as KeyboardEvent.key values. */
const NAMED: Record<keyof typeof LOCAL, string[]> = {
  scoreTrack: ['Enter', ' '],
  scoreStep: ['ArrowLeft', 'ArrowRight'],
  scorePlay: [' '],
  mapDir: ['Enter', ' '],
  mapStrip: ['ArrowLeft', 'ArrowRight', 'Home', 'End'],
  mapStripReset: ['Escape'],
  transportShift: ['ArrowLeft', 'ArrowRight'],
  transportLive: ['Home'],
  transportCancel: ['Escape'],
  canvasPan: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'],
  canvasZoom: ['+', '=', '-', '_'],
  canvasFit: ['0'],
  canvasOpen: ['Enter', ' '],
  canvasClear: ['Escape'],
  activate: ['Enter', ' '],
  graphSearch: ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'],
  graphMenu: ['Escape'],
  inspectorCompare: ['Enter'],
  fleetClear: ['Escape'],
  laneClear: ['Escape'],
  feedRows: ['ArrowUp', 'ArrowDown', 'Home', 'End'],
  sessionTabs: ['ArrowLeft', 'ArrowRight', 'Home', 'End'],
  projectViews: ['ArrowLeft', 'ArrowRight', 'Home', 'End'],
};
const PROBE = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab', 'PageUp', '+', '=', '-', '_', '0', '1', 'a', 'k', '/', '?'];

describe('local key descriptors', () => {
  test('LOCAL_KEYS is exactly the descriptor objects in LOCAL, and listLocalKeys rows come from them', () => {
    expect(LOCAL_KEYS).toEqual(Object.values(LOCAL));
    for (const d of LOCAL_KEYS) expect(Object.values(LOCAL)).toContain(d);
    expect(listLocalKeys()).toEqual(LOCAL_KEYS.map(({ scope, display, label }) => ({ scope, display, label })));
    for (const d of LOCAL_KEYS) expect(d.display && d.label && d.scope).toBeTruthy();
    expect(Object.keys(NAMED).sort()).toEqual(Object.keys(LOCAL).sort());
  });

  test.each(Object.keys(NAMED) as Array<keyof typeof LOCAL>)('%s matches exactly the keys it names', (name) => {
    const hit = PROBE.filter((k) => LOCAL[name].matches(new KeyboardEvent('keydown', { key: k })));
    expect(hit.sort()).toEqual(NAMED[name].filter((k) => PROBE.includes(k)).sort());
  });

  test('transport handlers act for exactly the keys named and not for others', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const NOW = Date.UTC(2026, 10, 1, 12);
    const store = createScope();
    const t = createTransport({ store, now: () => NOW, effectiveLiveSpan: () => liveSpanOf(store.get()) });
    document.body.append(t.root);
    const track = t.root.querySelector<HTMLElement>('.transport-track')!;
    try {
      const press2 = (k: string) => {
        const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        track.dispatchEvent(e);
        return e;
      };
      store.set({ window: { from: NOW - 4 * 3_600_000, to: NOW - 2 * 3_600_000 } });
      for (const k of PROBE) {
        const before = JSON.stringify(store.get().window);
        const e = press2(k);
        const named = LOCAL.transportShift.matches(new KeyboardEvent('keydown', { key: k })) || LOCAL.transportLive.matches(new KeyboardEvent('keydown', { key: k }));
        expect(e.defaultPrevented, k).toBe(named);
        if (!named) expect(JSON.stringify(store.get().window), k).toBe(before);
        else store.set({ window: { from: NOW - 4 * 3_600_000, to: NOW - 2 * 3_600_000 } });
      }
      store.set({ window: { from: NOW - 4 * 3_600_000, to: NOW - 2 * 3_600_000 } });
      press2('Home');
      expect(store.get().window).toBe('live');
    } finally {
      t.destroy();
      vi.unstubAllGlobals();
    }
  });

  test('transport Escape cancels a drag (and claims it) only while one is in progress', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (cb(0), 1));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const NOW = Date.UTC(2026, 10, 1, 12);
    const store = createScope();
    const t = createTransport({ store, now: () => NOW, effectiveLiveSpan: () => liveSpanOf(store.get()) });
    document.body.append(t.root);
    const track = t.root.querySelector<HTMLElement>('.transport-track')!;
    track.getBoundingClientRect = () => ({ width: 1000, height: 14, left: 0, top: 0, right: 1000, bottom: 14, x: 0, y: 0, toJSON() {} }) as DOMRect;
    try {
      const idle = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(idle);
      expect(isEscapeClaimed(idle)).toBe(false);
      track.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, bubbles: true, button: 0 }));
      track.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, bubbles: true, button: 0 }));
      const moved = JSON.stringify(store.get().window);
      expect(moved).not.toBe(JSON.stringify('live'));
      const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
      window.dispatchEvent(other);
      expect(isEscapeClaimed(other)).toBe(false);
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      window.dispatchEvent(esc);
      expect(isEscapeClaimed(esc)).toBe(true);
      expect(store.get().window).toBe('live');
    } finally {
      t.destroy();
      vi.unstubAllGlobals();
    }
  });

  test('session tablist acts for exactly the keys named', () => {
    const store = createScope();
    store.narrow({ session: { id: 's1', source: 'codex' } });
    const lens = (name: string): SessionLens => {
      const root = document.createElement('section');
      root.className = `fake-${name}`;
      return { root, refresh() {}, deactivate() {}, activate() {}, followWindow() {}, loadedSession: () => null, fullRange: () => null, setContext() {} } as unknown as SessionLens;
    };
    const lenses = Object.fromEntries(SESSION_TABS.map((t) => [t, () => lens(t)])) as Record<SessionTab, () => SessionLens>;
    const panel = createSession({ store, lenses, onTabShown: () => {}, directory: createSessionDirectory() });
    document.body.append(panel.root);
    panel.activate();
    const first = panel.root.querySelector<HTMLElement>(`#session-tab-${SESSION_TABS[0]}`)!;
    for (const k of PROBE) {
      panel.select(SESSION_TABS[0]!);
      const before = panel.tab();
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      first.dispatchEvent(e);
      const named = LOCAL.sessionTabs.matches(new KeyboardEvent('keydown', { key: k }));
      expect(e.defaultPrevented, k).toBe(named);
      if (!named) expect(panel.tab(), k).toBe(before);
    }
  });

  // Every keydown listener in the files that own element-local commands. A new one changes
  // a count, so a command cannot be added without also being declared in LOCAL (and read here).
  const SRC = join(process.cwd(), 'src');
  const LISTENERS: Record<string, { keydown: number; uses: Array<keyof typeof LOCAL> }> = {
    'dom.ts': { keydown: 1, uses: ['activate'] },
    'ui/score/index.ts': { keydown: 2, uses: ['scoreTrack', 'scoreStep', 'scorePlay'] },
    'ui/activity/index.ts': { keydown: 3, uses: ['mapDir', 'mapStrip', 'mapStripReset'] },
    'transport.ts': { keydown: 2, uses: ['transportShift', 'transportLive', 'transportCancel'] },
    'ui/graph/canvas.ts': { keydown: 1, uses: ['canvasPan', 'canvasZoom', 'canvasFit', 'canvasOpen', 'canvasClear'] },
    'ui/graph/index.ts': { keydown: 1, uses: ['canvasClear'] },
    'ui/graph/toolbar.ts': { keydown: 3, uses: ['graphSearch', 'graphMenu'] },
    'ui/graph/inspector.ts': { keydown: 1, uses: ['inspectorCompare'] },
    'ui/events/view.ts': { keydown: 1, uses: ['feedRows'] },
    'ui/session/index.ts': { keydown: 1, uses: ['sessionTabs'] },
    'ui/project/index.ts': { keydown: 2, uses: ['projectViews', 'laneClear'] },
    'ui/fleet/index.ts': { keydown: 1, uses: ['fleetClear'] },
  };
  const count = (src: string): number => (src.match(/(addEventListener|\bon)\(\s*(\w+,\s*)?["']keydown["']|\.onkeydown\s*=/g) ?? []).length;

  test.each(Object.entries(LISTENERS))('%s: keydown listeners are as declared and read their descriptors', (file, want) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(count(src), `${file} keydown registrations`).toBe(want.keydown);
    for (const name of want.uses) expect(src, `${file} uses LOCAL.${name}`).toContain(`LOCAL.${name}`);
  });

  test('every descriptor is read by some handler, and no unlisted file registers a local keydown handler', () => {
    const files = Object.keys(LISTENERS).map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');
    for (const name of Object.keys(LOCAL)) expect(files, name).toContain(`LOCAL.${name}`);
    // Files that register keydown outside the declared set must be the known non-local ones.
    const KNOWN_OTHER = new Set(['keys.ts', 'ui/legend.ts']);
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const walk = (dir: string, rel = ''): string[] =>
      readdirSync(dir).flatMap((n: string) => {
        const abs = join(dir, n);
        const r = rel ? `${rel}/${n}` : n;
        return statSync(abs).isDirectory() ? walk(abs, r) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [r] : [];
      });
    const stray = walk(SRC).filter((f) => !(f in LISTENERS) && !KNOWN_OTHER.has(f) && count(readFileSync(join(SRC, f), 'utf8')) > 0);
    expect(stray).toEqual([]);
  });
});
