// Escape-to-ascend plumbing. Anything that consumes Escape for itself calls
// claimEscape(e); the document-level handler then leaves the event alone.
import type { Altitude, ScopeStore } from './scope';

const claimed = new WeakSet<Event>();

export function claimEscape(e: Event): void {
  claimed.add(e);
}

export function isEscapeClaimed(e: Event): boolean {
  return claimed.has(e);
}

const OVERLAYS = '.onboarding-overlay, [role="dialog"], dialog[open], [aria-modal]';

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
  afterAscend(alt: Altitude, active: string): void;
}): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key !== 'Escape' || !isEscapeEligible(e)) return;
    const active = deps.activePanel();
    if (!deps.scopePanels.has(active)) return;
    const alt = deps.store.ascend();
    if (alt === null) return;
    e.preventDefault();
    deps.afterAscend(alt, active);
  };
}
