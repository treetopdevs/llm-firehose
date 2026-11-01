// The "Keys and symbols" dialog. Keys come from the shell key map (listKeys and
// listLocalKeys); symbols come from the glyph table the views draw from, so neither
// can drift from what the app does. While open it owns Escape: a document-capture
// listener closes it before any panel claimer, drag or menu sees the key.
import { el } from "../dom";
import { claimEscape } from "../escape";
import { GLYPH_GROUPS, swatchSvg } from "../glyphs";
import { QUEUE_KEYS, listKeys, listLocalKeys, type KeyRow } from "../keys";

/** The two time-control behaviours of the shell transport (D115). */
export const TIME_CONTROL_NOTES: readonly string[] = [
  "At the Session altitude the time presets are inert: only Live acts, and zoom comes from the Score.",
  "A preset survives into a session only when you arrive from Fleet, which carries the window; choosing a session directly resets the window to Live.",
];

/** Space is never application-wide: its meaning is whatever the bindings registered right now say. */
const SPACE_NATIVE = "Buttons and links: Space activates them natively.";
const spaceKey = /\bSpace\b/;

/** The Space notes, derived from the registered and element-local key rows that include Space. */
export function spaceNotes(): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const r of [...listKeys(), ...listLocalKeys()]) {
    if (!spaceKey.test(r.display)) continue;
    const n = `${r.scope}: Space ${r.label}.`;
    if (seen.has(n)) continue;
    seen.add(n);
    notes.push(n);
  }
  return [...notes, SPACE_NATIVE];
}

export interface LegendOptions {
  /** The control that opened the legend; focus returns here while it is still in the page. */
  opener?: HTMLElement | SVGElement;
  /** Where focus goes when the opener is gone. */
  fallbackFocus?: HTMLElement;
}

interface Open {
  backdrop: HTMLElement;
  close(): void;
}

let current: Open | null = null;

export function isLegendOpen(): boolean {
  return current !== null;
}

function keyRows(rows: KeyRow[], withScope: boolean): HTMLElement {
  const list = el("ul", { class: "legend-rows" });
  for (const r of rows) {
    list.append(el("li", { class: "legend-row" }, el("kbd", {}, r.display), el("span", {}, r.label), withScope ? el("span", { class: "dim" }, ` (${r.scope})`) : null));
  }
  return list;
}

function part(title: string, body: HTMLElement | null, ...extra: Array<Node | null>): HTMLElement {
  return el("div", { class: "legend-part" }, el("h3", {}, title), body, ...extra);
}

function symbols(): HTMLElement[] {
  return GLYPH_GROUPS.map((g) => {
    const list = el("ul", { class: "legend-rows" });
    for (const entry of g.entries) {
      const mark = el("span", { class: "legend-glyph", "aria-hidden": "true" });
      const sw = swatchSvg(entry);
      if (sw) mark.append(sw);
      if (entry.glyph) mark.append(entry.glyph);
      list.append(el("li", { class: "legend-row" }, mark, el("strong", {}, entry.name), el("span", {}, entry.meaning)));
    }
    return part(g.title, list);
  });
}

export function openLegend(opts: LegendOptions = {}): { close(): void } {
  if (current) return { close: current.close };
  const active = document.activeElement;
  const opener = opts.opener ?? ((active instanceof HTMLElement || active instanceof SVGElement) && active !== document.body ? active : undefined);
  const fallback = opts.fallbackFocus;

  const panel = listKeys();
  const closeBtn = el("button", { type: "button", class: "legend-close" }, "Close");
  const body = el("div", { class: "legend-body", tabindex: "0", role: "region", "aria-label": "Keys and symbols reference" });
  body.append(
    part("This panel", keyRows(panel.filter((r) => r.scope !== "global"), false)),
    part("Everywhere", keyRows(panel.filter((r) => r.scope === "global"), false)),
    part("Also on the keyboard", keyRows(listLocalKeys(), true)),
    part("Space", el("ul", { class: "legend-notes" }, ...spaceNotes().map((n) => el("li", {}, n)))),
    ...symbols(),
    part("Time controls", el("ul", { class: "legend-notes" }, ...TIME_CONTROL_NOTES.map((n) => el("li", {}, n)))),
  );
  const dialog = el(
    "div",
    { class: "legend", role: "dialog", "aria-modal": "true", "aria-labelledby": "legend-title" },
    el("div", { class: "legend-head" }, el("h2", { id: "legend-title" }, "Keys and symbols"), closeBtn),
    body,
  );
  const backdrop = el("div", { class: "legend-backdrop" }, dialog);

  let done = false;
  const close = (): void => {
    if (done) return;
    done = true;
    document.removeEventListener("keydown", onEscape, true);
    backdrop.remove();
    if (current === me) current = null;
    const back = opener?.isConnected ? opener : fallback?.isConnected ? fallback : null;
    back?.focus();
  };
  const me: Open = { backdrop, close };

  // Document-capture, so it also sees Tab when a click on dialog text left focus on body.
  function trapTab(e: KeyboardEvent): void {
    const stops = [...dialog.querySelectorAll<HTMLElement>("button, [tabindex='0']")];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const at = document.activeElement;
    if (e.shiftKey ? at === first || !dialog.contains(at) : at === last || !dialog.contains(at)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  function onEscape(e: KeyboardEvent): void {
    if (e.key === "Tab" && !e.isComposing) return trapTab(e);
    if (e.key !== QUEUE_KEYS.escape.keys[0] || e.isComposing) return;
    claimEscape(e);
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  dialog.addEventListener("keydown", (e) => {
    if ((QUEUE_KEYS.legend.keys as readonly string[]).includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener("click", close);

  document.addEventListener("keydown", onEscape, true);
  document.body.append(backdrop);
  current = me;
  closeBtn.focus();
  return { close };
}

/** Opens the legend, or closes it when it is already open. */
export function toggleLegend(opts: LegendOptions = {}): void {
  if (current) current.close();
  else openLegend(opts);
}
