// The macOS overlay title bar (MS-4). The overlay itself is set in src-tauri/tauri.macos.conf.json,
// so only the macOS build has it. This module decides whether the page should act as if it does:
// leave room for the traffic lights and make the toolbar the drag region. Default is off.

/** Overlay only when running inside the Tauri shell on macOS. A browser on a Mac, Linux and Windows get none. */
export function macOverlayActive(win: object | undefined, userAgent: string | undefined): boolean {
  if (!win || !userAgent) return false;
  return "__TAURI_INTERNALS__" in win && /Macintosh|Mac OS X/.test(userAgent);
}

// Non-interactive containers only. Tauri starts a drag when the mouse goes down on an element that
// carries the attribute itself, so buttons and the range pop-up never carry it and stay clickable.
const TOOLBAR_REGIONS = [".toolbar-history", ".toolbar-title", ".toolbar-place", ".toolbar-crumb", ".toolbar-views"];
const SIDEBAR_REGIONS = [".brand"];

function setRegions(root: HTMLElement, selectors: string[], on: boolean): void {
  const nodes = [root, ...selectors.flatMap((s) => [...root.querySelectorAll<HTMLElement>(s)])];
  for (const n of nodes) {
    if (on) n.setAttribute("data-tauri-drag-region", "");
    else n.removeAttribute("data-tauri-drag-region");
  }
}

/** Switch the overlay behaviour on or off for the shell, toolbar and sidebar. */
export function applyWindowChrome(shell: HTMLElement, toolbar: HTMLElement, sidebar: HTMLElement, overlay: boolean): void {
  if (overlay) shell.dataset.titlebar = "overlay";
  else delete shell.dataset.titlebar;
  setRegions(toolbar, TOOLBAR_REGIONS, overlay);
  setRegions(sidebar, SIDEBAR_REGIONS, overlay);
}
