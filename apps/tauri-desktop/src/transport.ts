// Shell-owned time control: one transport bound to scope.window. It writes only
// through store.narrow; panels read the window from scope. Altitude (session or
// not) comes from the displayed panel via setPanel, never from scope.session.
import { el } from './dom';
import { claimEscape } from './escape';
import {
  PRESETS,
  formatRange,
  formatSpan,
  liveSpanOf,
  presetWindow,
  resolveRange,
  shiftWindow,
  spanOf,
  type PresetId,
  type Scope,
  type ScopeStore,
  type ScopeWindow,
} from './scope';

export interface TransportDeps {
  store: ScopeStore;
  now?: () => number;
  effectiveLiveSpan?: () => number;
}

export interface Transport {
  root: HTMLElement;
  destroy(): void;
  paintCount(): number;
  setVisible(v: boolean): void;
  setPanel(id: string): void;
  /** Repaint after the displayed panel's effective live span may have changed. */
  refresh(): void;
}

const DAY = 86_400_000;
const OVERLAYS = '.onboarding-overlay, [role="dialog"], dialog[open], [aria-modal]';

export function createTransport(deps: TransportDeps): Transport {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const span = (): number => deps.effectiveLiveSpan?.() ?? liveSpanOf(store.get());

  let session = false;
  let paints = 0;
  let lastKey = '';

  const presetBtns = new Map<PresetId, HTMLButtonElement>();
  const presets = el('div', { class: 'transport-presets' });
  for (const p of PRESETS) {
    const b = el('button', { type: 'button', class: 'transport-preset', 'data-preset': p.id, 'aria-pressed': 'false' }, p.label);
    presetBtns.set(p.id, b);
    presets.append(b);
  }
  const liveBtn = el('button', { type: 'button', class: 'transport-live', 'aria-pressed': 'false' }, 'Live');
  const holdBtn = el('button', { type: 'button', class: 'transport-hold' }, 'Hold');
  const range = el('span', { class: 'transport-range' });
  const hint = el('span', { class: 'transport-hint' });
  const thumb = el('div', { class: 'transport-thumb' });
  const track = el(
    'div',
    {
      class: 'transport-track',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Window position',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '100',
    },
    thumb,
  );
  const root = el(
    'div',
    { class: 'transport', role: 'group', 'aria-label': 'Time window' },
    presets,
    liveBtn,
    holdBtn,
    range,
    hint,
    track,
  );

  const horizonOf = (w: ScopeWindow): number => Math.max(30 * DAY, 2 * spanOf(w, now(), span()));

  function geometry(s: Scope): { left: number; width: number; pct: number } {
    const n = now();
    const h = horizonOf(s.window);
    const r = resolveRange(s.window, n, span());
    const clamp = (v: number): number => Math.min(100, Math.max(0, v));
    const left = clamp(((r.from - (n - h)) / h) * 100);
    const right = clamp(((r.to - (n - h)) / h) * 100);
    return { left, width: Math.max(0.5, right - left), pct: Math.round(right) };
  }

  // Readout and tooltip use the span the panel actually draws (the effective span that
  // Hold and scrubbing also use), so a preference the panel ignores is never claimed.
  function readout(s: Scope): { text: string; title: string } {
    if (session) return formatRange(s.window, now(), s.liveSpanMs, { wholeSession: true });
    const drawn = formatRange(s.window, now(), span());
    if (s.window !== 'live') return drawn;
    const text = s.liveSpanMs !== undefined ? `Live · last ${formatSpan(span())}` : 'Live';
    return { text, title: drawn.title };
  }
  const retitle = (): void => {
    range.title = readout(store.get()).title;
  };

  function paint(): void {
    const s = store.get();
    const g = geometry(s);
    const key = JSON.stringify([s.window, s.liveSpanMs ?? null, span(), session, g.left.toFixed(3), g.width.toFixed(3), g.pct]);
    if (key === lastKey) return;
    lastKey = key;
    const live = s.window === 'live';
    const sp = spanOf(s.window, now(), span());
    for (const p of PRESETS) {
      const pressed = live ? !session && s.liveSpanMs !== undefined && span() === p.ms : sp === p.ms;
      const b = presetBtns.get(p.id)!;
      b.setAttribute('aria-pressed', String(pressed));
      b.setAttribute('aria-disabled', String(session));
    }
    liveBtn.setAttribute('aria-pressed', String(live));
    holdBtn.setAttribute('aria-disabled', String(session));
    holdBtn.textContent = live ? 'Hold' : 'Return to live';
    holdBtn.setAttribute('aria-label', live ? 'Hold current window' : 'Return to live');
    const f = readout(s);
    range.textContent = f.text;
    range.title = f.title;
    hint.textContent = session ? 'Zoom with the Score' : '';
    thumb.style.left = `${g.left}%`;
    thumb.style.width = `${g.width}%`;
    track.setAttribute('aria-valuenow', String(live ? 100 : g.pct));
    track.setAttribute('aria-valuetext', f.text);
    track.setAttribute('aria-disabled', String(session));
    track.setAttribute('tabindex', session ? '-1' : '0');
    paints++;
  }

  // ---- writes ----
  const ac = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void =>
    t.addEventListener(type, fn as EventListener, { signal: ac.signal });
  let writing = false;
  const write = (patch: Parameters<ScopeStore['narrow']>[0]): void => {
    const was = writing;
    writing = true;
    try {
      store.narrow(patch);
    } finally {
      writing = was;
    }
  };

  // ---- drag ----
  interface Drag {
    startX: number;
    startWindow: ScopeWindow;
    startNow: number;
    horizon: number;
    width: number;
    x: number;
    dirty: boolean;
    raf: number | null;
    gen: number;
    project?: string;
    sessionId?: string;
  }
  let drag: Drag | null = null;
  let gen = 0;

  function flush(d: Drag): void {
    if (d.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.raf);
    d.raf = null;
    if (!d.dirty) return;
    d.dirty = false;
    const delta = ((d.x - d.startX) / d.width) * d.horizon;
    write({ window: shiftWindow(d.startWindow, delta, d.startNow, span()) });
  }

  function endDrag(): void {
    const d = drag;
    if (!d) return;
    drag = null;
    gen++;
    if (d.raf !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.raf);
    d.raf = null;
    window.removeEventListener('keydown', onDragKey, true);
    window.removeEventListener('blur', onBlur);
  }
  const abortDrag = (): void => endDrag();

  function onDragKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !drag) return;
    const d = drag;
    claimEscape(e);
    endDrag();
    write({ window: d.startWindow });
  }
  function onBlur(): void {
    abortDrag();
  }

  on(track, 'pointerdown', (e) => {
    if (session || e.button !== 0) return;
    endDrag();
    const s = store.get();
    const n = now();
    const w = track.getBoundingClientRect().width;
    if (!(w > 0)) return;
    const id = (e as PointerEvent).pointerId;
    try {
      if (typeof id === 'number') track.setPointerCapture?.(id);
    } catch {
      /* capture is best-effort */
    }
    drag = {
      startX: e.clientX,
      startWindow: s.window,
      startNow: n,
      horizon: horizonOf(s.window),
      width: w,
      x: e.clientX,
      dirty: false,
      raf: null,
      gen: ++gen,
      project: s.project,
      sessionId: s.session?.id,
    };
    window.addEventListener('keydown', onDragKey, true);
    window.addEventListener('blur', onBlur);
  })
  on(track, 'pointermove', (e) => {
    const d = drag;
    if (!d) return;
    d.x = e.clientX;
    d.dirty = true;
    if (d.raf !== null) return;
    const g = d.gen;
    d.raf = requestAnimationFrame(() => {
      d.raf = null;
      if (drag !== d || d.gen !== g || gen !== g) return;
      flush(d);
    });
  });
  on(track, 'pointerup', () => {
    const d = drag;
    if (!d) return;
    flush(d);
    endDrag();
    // Return focus to the document so panel shortcuts stay reachable after a mouse scrub.
    track.blur();
  });
  on(track, 'pointercancel', abortDrag);
  on(track, 'lostpointercapture', abortDrag);

  // Live timestamps move with the clock, so refresh the tooltip when it is about to be read.
  on(range, 'pointerenter', retitle);
  on(range, 'mouseenter', retitle);

  const unsub = store.subscribe((next, prev) => {
    if (drag && !writing) abortDrag();
    else if (drag && (next.project !== prev.project || next.session?.id !== prev.session?.id)) abortDrag();
    paint();
  });

  // ---- buttons ----
  const afterClick = (e: MouseEvent, b: HTMLElement): void => {
    if (e.detail > 0) b.blur();
  };
  for (const p of PRESETS) {
    const b = presetBtns.get(p.id)!;
    on(b, 'click', (e) => {
      afterClick(e, b);
      if (session) return;
      abortDrag();
      write({ window: presetWindow(p.id, now()), liveSpanMs: p.ms });
    });
  }
  on(liveBtn, 'click', (e) => {
    afterClick(e, liveBtn);
    abortDrag();
    write({ window: 'live' });
  });
  on(holdBtn, 'click', (e) => {
    afterClick(e, holdBtn);
    if (session) return;
    abortDrag();
    const w = store.get().window;
    write({ window: w === 'live' ? resolveRange('live', now(), span()) : 'live' });
  });

  // ---- keyboard (track only) ----
  on(track, 'keydown', (e) => {
    if (session || e.defaultPrevented || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
    if (document.querySelector(OVERLAYS)) return;
    abortDrag();
    if (e.key === 'Home') {
      write({ window: 'live' });
    } else {
      const s = store.get();
      const frac = e.shiftKey ? 0.5 : 0.1;
      const delta = (e.key === 'ArrowLeft' ? -1 : 1) * frac * spanOf(s.window, now(), span());
      write({ window: shiftWindow(s.window, delta, now(), span()) });
    }
    e.preventDefault();
  });

  paint();

  return {
    root,
    paintCount: () => paints,
    setVisible(v) {
      if (!v) abortDrag();
      root.hidden = !v;
    },
    setPanel(id) {
      const next = id === 'session';
      abortDrag();
      if (next === session) {
        paint();
        return;
      }
      session = next;
      if (session) abortDrag();
      paint();
    },
    refresh: paint,
    destroy() {
      unsub();
      endDrag();
      ac.abort();
    },
  };
}
