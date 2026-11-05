// Escape-to-ascend plumbing. Anything that consumes Escape for itself calls
// claimEscape(e); the document-level handler then leaves the event alone.
import type { Altitude, Scope, ScopeStore } from './scope';

const claimed = new WeakSet<Event>();

export function claimEscape(e: Event): void {
  claimed.add(e);
}

export function isEscapeClaimed(e: Event): boolean {
  return claimed.has(e);
}

/** True while any aria-modal dialog (the ? legend, for one) is open. */
export function isModalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * An element-local Escape claimer (a drag, the More menu) calls this first: when an open
 * modal does not contain its element, the modal owns this Escape and the claimer leaves it
 * alone; its own Escape works again once the modal is closed.
 */
export function yieldsToModal(_e: Event, ownerEl: Element | null | undefined): boolean {
  if (typeof document === 'undefined') return false;
  for (const m of document.querySelectorAll('[aria-modal="true"]')) {
    if (!ownerEl || !m.contains(ownerEl)) return true;
  }
  return false;
}

const OVERLAYS = '.onboarding-overlay, [role="dialog"], dialog[open], [aria-modal], .action-menu, .action-dialog';

/** True when nothing else owns this Escape (input, IME, dialog, menu, claim). */
export function isEscapeEligible(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || isEscapeClaimed(e)) return false;
  const t = e.target as Element | null;
  if (t && typeof t.closest === 'function') {
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    if ((t as HTMLElement).isContentEditable || t.closest('[contenteditable=""], [contenteditable="true"]')) return false;
    if (t.closest('.graph-menu')) return false;
  }
  if (typeof document !== 'undefined' && (document.querySelector(OVERLAYS) || document.querySelector('.graph-menu:not([hidden])'))) return false;
  return true;
}

export function createEscapeHandler(deps: {
  store: ScopeStore;
  activePanel(): string;
  scopePanels: ReadonlySet<string>;
  afterAscend(alt: Altitude, active: string, prev: Scope): void;
}): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key !== 'Escape' || !isEscapeEligible(e)) return;
    const active = deps.activePanel();
    if (!deps.scopePanels.has(active)) return;
    const prev = deps.store.get();
    const alt = deps.store.ascend();
    if (alt === null) return;
    e.preventDefault();
    deps.afterAscend(alt, active, prev);
  };
}

export type PanelName = 'fleet' | 'project' | 'sessions' | 'session';
export type AscentTarget = PanelName | 'stay';

/**
 * Where an Escape lands, decided only from the scope held before the ascend and the
 * panel it came from; nothing is inferred about how the user arrived.
 */
export function ascentTarget(prev: Scope, alt: Altitude, from: string): AscentTarget {
  if (from === 'session') {
    if (prev.worktree !== undefined) return 'sessions';
    if (prev.project !== undefined) return 'project';
    return 'fleet';
  }
  if (from === 'sessions') {
    if (prev.session !== undefined) return 'stay';
    if (alt === 'project') return 'project';
    if (alt === 'fleet' && prev.project !== undefined) return 'fleet';
    return 'stay';
  }
  if (from === 'project' && alt === 'fleet') return 'fleet';
  return 'stay';
}
