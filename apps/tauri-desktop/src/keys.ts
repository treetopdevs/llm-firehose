// The shell key map. One document-level bubble listener dispatches registered
// bindings (global shortcuts and panel-scoped queue keys); element-local keys
// (a slider's arrows, a tablist, the graph canvas) stay on their own elements but
// are declared once here as shared descriptors, so the ? legend can list exactly
// the keys the handlers act on.

export interface KeyBinding {
  /** 'global' or a panel scope ('fleet', 'project', 'events', 'graph'). Panel scopes run first. */
  scope: string;
  /** Matched against both e.key and e.code. */
  keys: readonly string[];
  /** How the legend prints the key(s). */
  display: string;
  label: string;
  /** Return false to say "not mine" and let the next eligible binding for the key run. */
  handler(e: KeyboardEvent): void | boolean;
  enabled?(): boolean;
  /** Fire even with ctrl/meta/alt held (default: such events are skipped). */
  modifiers?: 'any';
  /** Fire from INPUT/TEXTAREA/SELECT/contenteditable targets (default: skipped). */
  allowInInput?: boolean;
}

export interface KeyRow {
  scope: string;
  display: string;
  label: string;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** The queue-walking vocabulary Fleet and Project share, plus the shell's legend and Escape. */
export const QUEUE_KEYS = {
  pick: { keys: DIGITS, display: '1–9' },
  walk: { keys: ['n', 'N'], display: 'n / N' },
  jump: { keys: [' ', 'Space'], display: 'Space' },
  open: { keys: ['Enter'], display: 'Enter' },
  legend: { keys: ['?'], display: '?' },
  escape: { keys: ['Escape'], display: 'Esc' },
} as const;

const GLOBAL = 'global';

interface Entry {
  b: KeyBinding;
  order: number;
}

let entries: Entry[] = [];
let installed = false;
let seq = 0;

declare global {
  interface ImportMeta {
    readonly env?: { readonly PROD?: boolean };
  }
}

const isProd = (): boolean => !!import.meta.env?.PROD;

function typing(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  if (!e || typeof e.closest !== 'function') return false;
  const tag = e.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!e.isContentEditable || !!e.closest('[contenteditable=""], [contenteditable="true"]');
}

const matchesKey = (b: KeyBinding, e: KeyboardEvent): boolean => b.keys.includes(e.key) || (!!e.code && b.keys.includes(e.code));

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const modified = e.ctrlKey || e.metaKey || e.altKey;
  const modal = !!document.querySelector('[aria-modal="true"]');
  const eligible = entries.filter(({ b }) => {
    if (!matchesKey(b, e)) return false;
    if (modified && b.modifiers !== 'any') return false;
    if (!b.allowInInput && typing(e.target)) return false;
    if (modal && b.scope !== GLOBAL) return false;
    return b.enabled ? b.enabled() : true;
  });
  // Panel scopes before global; registration order within each.
  eligible.sort((x, y) => Number(x.b.scope === GLOBAL) - Number(y.b.scope === GLOBAL) || x.order - y.order);
  for (const { b } of eligible) {
    if (b.handler(e) !== false) return;
  }
}

function install(): void {
  if (installed) return;
  document.addEventListener('keydown', onKeyDown);
  installed = true;
}

function uninstall(): void {
  if (!installed) return;
  document.removeEventListener('keydown', onKeyDown);
  installed = false;
}

/**
 * Registers a batch atomically: a duplicate (key, scope) throws (outside production)
 * and registers nothing; in production the conflicting binding is warned about and skipped. The returned function unregisters the batch, idempotently.
 */
export function registerKeys(bindings: KeyBinding[]): () => void {
  const dev = !isProd();
  const seen = new Set(entries.flatMap(({ b }) => b.keys.map((k) => `${b.scope}\u0000${k}`)));
  const accepted: KeyBinding[] = [];
  for (const b of bindings) {
    const mine = new Set<string>();
    let clash: string | undefined;
    for (const k of b.keys) {
      const id = `${b.scope}\u0000${k}`;
      if (seen.has(id) || mine.has(id)) { clash = k; break; }
      mine.add(id);
    }
    if (clash !== undefined) {
      const msg = `duplicate key binding: "${clash}" in scope "${b.scope}"`;
      if (dev) throw new Error(msg);
      console.warn(`${msg}; skipped`);
      continue;
    }
    for (const id of mine) seen.add(id);
    accepted.push(b);
  }
  const added = accepted.map((b) => ({ b, order: seq++ }));
  entries = entries.concat(added);
  install();
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const gone = new Set(added);
    entries = entries.filter((x) => !gone.has(x));
    if (entries.length === 0) uninstall();
  };
}

/** Enabled bindings, panel scopes first, then global. */
export function listKeys(): KeyRow[] {
  return entries
    .filter(({ b }) => (b.enabled ? b.enabled() : true))
    .sort((x, y) => Number(x.b.scope === GLOBAL) - Number(y.b.scope === GLOBAL) || x.order - y.order)
    .map(({ b }) => ({ scope: b.scope, display: b.display, label: b.label }));
}

// ---- element-local keys ------------------------------------------------------

export interface LocalKeyDescriptor {
  scope: string;
  display: string;
  label: string;
  matches(e: KeyboardEvent): boolean;
}

const local = (scope: string, display: string, label: string, ...keys: string[]): LocalKeyDescriptor => ({
  scope,
  display,
  label,
  matches: (e) => keys.includes(e.key),
});

const enterSpace = ['Enter', ' '];

/** Every command a local handler acts on. Handlers import these and call matches(e). */
export const LOCAL = {
  scoreTrack: local('score track', 'Enter / Space', 'step to the next event in this track', ...enterSpace),
  scoreStep: local('score', '← / →', 'previous / next event', 'ArrowLeft', 'ArrowRight'),
  scorePlay: local('score', 'Space', 'play or pause', ' '),
  mapDir: local('activity map', 'Enter / Space', 'zoom into this directory', ...enterSpace),
  mapStrip: local('activity strip', '← → Home End', 'move the brushed range (Shift resizes)', 'ArrowLeft', 'ArrowRight', 'Home', 'End'),
  mapStripReset: local('activity strip', 'Esc', 'reset the range or cancel a brush', 'Escape'),
  transportShift: local('time window', '← / →', 'shift the window (Shift: larger step)', 'ArrowLeft', 'ArrowRight'),
  transportLive: local('time window', 'Home', 'return to live', 'Home'),
  transportCancel: local('time window', 'Esc', 'cancel a drag', 'Escape'),
  canvasPan: local('graph canvas', '← ↑ → ↓', 'pan the canvas, or move between nodes', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'),
  canvasZoom: local('graph canvas', '+ / -', 'zoom in / out', '+', '=', '-', '_'),
  canvasFit: local('graph canvas', '0', 'fit the graph', '0'),
  canvasOpen: local('graph canvas', 'Enter / Space', 'select the focused node', ...enterSpace),
  canvasClear: local('graph canvas', 'Esc', 'clear the selection', 'Escape'),
  activate: local('rows and cards', 'Enter / Space', 'activate the focused row, card or lane', ...enterSpace),
  graphSearch: local('graph search', '↑ ↓ Enter Esc', 'move through results, choose one, clear or close', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'),
  graphMenu: local('graph menu', 'Esc', 'close the More menu', 'Escape'),
  inspectorCompare: local('graph inspector', 'Enter', 'compare with the typed commit ID', 'Enter'),
  fleetClear: local('fleet', 'Esc', 'clear the selected row or need', 'Escape'),
  laneClear: local('project lanes', 'Esc', 'cancel a brush or clear the picked lane', 'Escape'),
  feedRows: local('live feed', '↑ ↓ Home End', 'move between events', 'ArrowUp', 'ArrowDown', 'Home', 'End'),
  sessionTabs: local('session tabs', '← → Home End', 'switch tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'),
  projectViews: local('project views', '← → Home End', 'switch view', 'ArrowLeft', 'ArrowRight', 'Home', 'End'),
} as const satisfies Record<string, LocalKeyDescriptor>;

export const LOCAL_KEYS: readonly LocalKeyDescriptor[] = Object.values(LOCAL);

export function listLocalKeys(): KeyRow[] {
  return LOCAL_KEYS.map(({ scope, display, label }) => ({ scope, display, label }));
}

export function __resetKeysForTests(): void {
  entries = [];
  seq = 0;
  uninstall();
}
