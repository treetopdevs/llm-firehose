// Minimal DOM builders. Everything event-derived goes through textContent —
// no innerHTML with untrusted data, ever.

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

/** Wires a node that acts as a button: click, and Enter or Space from the keyboard. */
export function onActivate(node: Element, handler: () => void): void {
  node.addEventListener("click", handler);
  node.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key !== "Enter" && key !== " ") return;
    e.preventDefault();
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
