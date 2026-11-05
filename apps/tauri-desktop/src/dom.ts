// Minimal DOM builders. Everything event-derived goes through textContent —
// no innerHTML with untrusted data, ever.

import { LOCAL } from "./keys";

type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") {
      node.className = v;
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [tabindex], [role="button"], [contenteditable=""], [contenteditable="true"]';

export interface ActivateOptions {
  /** Ignore events that originate in an interactive descendant (a nested button or focusable). */
  self?: boolean;
  /** Stop a handled click or key from reaching ancestor listeners. */
  stop?: boolean;
}

/**
 * Wires a node that acts as a button: click, and Enter or Space from the keyboard.
 * Use `{ self: true }` when the node contains its own controls, so their clicks
 * and keys do not also activate the container.
 */
export function onActivate(node: Element, handler: () => void, opts: ActivateOptions = {}): void {
  const fromDescendantControl = (e: Event): boolean => {
    if (!opts.self) return false;
    const t = e.target as Element | null;
    const hit = t?.closest?.(INTERACTIVE) ?? null;
    return hit !== null && hit !== node && node.contains(hit);
  };
  node.addEventListener("click", (e) => {
    if (fromDescendantControl(e)) return;
    if (opts.stop) e.stopPropagation();
    handler();
  });
  node.addEventListener("keydown", (e) => {
    if (!LOCAL.activate.matches(e as KeyboardEvent)) return;
    if (fromDescendantControl(e)) return;
    e.preventDefault();
    if (opts.stop) e.stopPropagation();
    handler();
  });
}

/**
 * Remembers which `data-key` under root has focus so a redraw that rebuilds
 * the nodes can give focus back to the same item.
 */
export function keepFocus(root: Element): () => void {
  const active = document.activeElement;
  const key = active && root.contains(active) ? active.getAttribute("data-key") : null;
  return () => {
    if (key === null) return;
    for (const node of root.querySelectorAll<HTMLElement | SVGElement>("[data-key]")) {
      if (node.getAttribute("data-key") === key) {
        node.focus();
        return;
      }
    }
  };
}

/**
 * Remembers which control under root has focus by its position among the
 * controls, for a redraw that keeps the same structure but rewrites text.
 */
export function keepControlFocus(root: Element): () => void {
  const sel = "button, input, select, textarea, a[href], [tabindex]";
  const active = document.activeElement;
  const at = active && root.contains(active) ? [...root.querySelectorAll(sel)].indexOf(active) : -1;
  const tag = active?.tagName;
  return () => {
    if (at < 0) return;
    const node = root.querySelectorAll<HTMLElement>(sel)[at];
    if (node && node.tagName === tag) node.focus();
  };
}
