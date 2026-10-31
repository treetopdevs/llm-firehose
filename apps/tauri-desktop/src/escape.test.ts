// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { claimEscape, createEscapeHandler, isEscapeClaimed, isEscapeEligible } from './escape';
import { createScope } from './scope';

const key = (target?: Element | Document, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target ?? document.body });
  return e;
};

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

const setup = (panel = 'sessions') => {
  const store = createScope({ project: 'p' });
  const afterAscend = vi.fn();
  const handler = createEscapeHandler({
    store,
    activePanel: () => panel,
    scopePanels: new Set(['sessions', 'score']),
    afterAscend,
  });
  return { store, afterAscend, handler };
};

test('claim registry', () => {
  const e = key();
  expect(isEscapeClaimed(e)).toBe(false);
  claimEscape(e);
  expect(isEscapeClaimed(e)).toBe(true);
  expect(isEscapeEligible(e)).toBe(false);
  const { handler, store } = setup();
  handler(e);
  expect(store.get().project).toBe('p');
});

test('defaultPrevented and composing are ignored', () => {
  const { handler, store } = setup();
  const e = key();
  e.preventDefault();
  expect(isEscapeEligible(e)).toBe(false);
  handler(e);
  expect(isEscapeEligible(key(undefined, { isComposing: true }))).toBe(false);
  handler(key(undefined, { isComposing: true }));
  expect(store.get().project).toBe('p');
});

test.each(['input', 'textarea', 'select'])('%s target ignored', (tag) => {
  const el = document.createElement(tag);
  document.body.append(el);
  expect(isEscapeEligible(key(el))).toBe(false);
  const { handler, store } = setup();
  handler(key(el));
  expect(store.get().project).toBe('p');
});

test('contentEditable target ignored', () => {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'true');
  const child = document.createElement('span');
  el.append(child);
  document.body.append(el);
  expect(isEscapeEligible(key(el))).toBe(false);
  expect(isEscapeEligible(key(child))).toBe(false);
});

test('graph-menu target ignored but hidden menu elsewhere does not block', () => {
  document.body.innerHTML = '<div class="graph-menu" hidden><button id="b">x</button></div>';
  const btn = document.getElementById('b')!;
  expect(isEscapeEligible(key(btn))).toBe(false);
  const { handler, store, afterAscend } = setup();
  handler(key(document.body));
  expect(store.get().project).toBeUndefined();
  expect(afterAscend).toHaveBeenCalledWith('fleet', 'sessions');
});

test('open graph-menu target ignored', () => {
  document.body.innerHTML = '<div class="graph-menu open"><button id="b">x</button></div>';
  expect(isEscapeEligible(key(document.getElementById('b')!))).toBe(false);
});

test.each([
  '<div class="onboarding-overlay"></div>',
  '<div role="dialog"></div>',
  '<dialog open></dialog>',
  '<div aria-modal="true"></div>',
])('overlay %s present ignores', (html) => {
  document.body.innerHTML = html;
  expect(isEscapeEligible(key())).toBe(false);
  const { handler, store } = setup();
  handler(key());
  expect(store.get().project).toBe('p');
});

test('closed dialog does not block', () => {
  document.body.innerHTML = '<dialog></dialog>';
  expect(isEscapeEligible(key())).toBe(true);
});

test('ascends only in scope panels', () => {
  const { handler, store, afterAscend } = setup('graph');
  const e = key();
  handler(e);
  expect(store.get().project).toBe('p');
  expect(e.defaultPrevented).toBe(false);
  expect(afterAscend).not.toHaveBeenCalled();
});

test('empty scope returns without preventDefault', () => {
  const store = createScope();
  const afterAscend = vi.fn();
  const handler = createEscapeHandler({
    store,
    activePanel: () => 'sessions',
    scopePanels: new Set(['sessions']),
    afterAscend,
  });
  const e = key();
  handler(e);
  expect(e.defaultPrevented).toBe(false);
  expect(afterAscend).not.toHaveBeenCalled();
});

test('ascend prevents default and calls afterAscend; works on focused button; ignores other keys', () => {
  const { handler, store, afterAscend } = setup('score');
  const btn = document.createElement('button');
  document.body.append(btn);
  const other = key(btn, { key: 'Enter' });
  handler(other);
  expect(store.get().project).toBe('p');
  const e = key(btn);
  handler(e);
  expect(e.defaultPrevented).toBe(true);
  expect(store.get().project).toBeUndefined();
  expect(afterAscend).toHaveBeenCalledWith('fleet', 'score');
});
