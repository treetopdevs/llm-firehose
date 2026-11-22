// The inspector (MS-8): what a selection looks like in the shared pane. Selecting a project,
// a worktree or a session only fills this; nothing navigates until Open. It never takes focus,
// so the arrow keys keep walking the list. Unknown is drawn as unknown, with its reason.
import { clear, el } from "../dom";
import type { UnitAction } from "./actions/model";
import { releasePane } from "./detail";

export interface InspectFact {
  label: string;
  /** Undefined or empty means the value was never captured: it is drawn as unknown. */
  value: string | undefined;
  mono?: boolean;
}

export interface Inspected {
  kind: "project" | "worktree" | "session";
  /** A stable key for the selected row, so a redraw can tell the same selection from a new one. */
  key: string;
  title: string;
  /** The status in a word beside its mark; a bare mark never carries state. */
  status: { word: string; mark: string; reason?: string; needs?: boolean };
  facts: readonly InspectFact[];
  /** The full native id, shown as a copyable field. */
  id?: { label: string; value: string };
  open: { label: string; run(): void };
  actions?: readonly UnitAction[];
}

export interface InspectorOptions {
  onClose(): void;
  /** The app-owned actions controller, for the Actions button. */
  menu?: { openMenu(actions: readonly UnitAction[], anchor: HTMLElement, opts?: { returnFocus?: HTMLElement }): void };
}

const CONTROLS = ["inspector-open", "inspector-copy", "inspector-actions", "detail-close"];
const KIND_LABEL: Record<Inspected["kind"], string> = { project: "Project", worktree: "Worktree", session: "Session" };

/** Whether the pane currently shows an inspector (rather than an event, or nothing). */
export const inspectorShowing = (pane: HTMLElement): boolean => pane.hasAttribute("data-inspector");

export function renderInspector(pane: HTMLElement, s: Inspected | null, opts: InspectorOptions): void {
  releasePane(pane);
  // A redraw (the data under the selection moved) must not drop focus from the control the user is on.
  const held = pane.contains(document.activeElement) ? CONTROLS.find((c) => document.activeElement?.classList.contains(c)) : undefined;
  clear(pane);
  pane.removeAttribute("data-inspector");
  if (!s) {
    pane.classList.remove("open");
    return;
  }
  pane.classList.add("open");
  pane.setAttribute("data-inspector", s.kind);

  const close = el("button", { type: "button", class: "detail-close", title: "close", "aria-label": "Close inspector" }, "×");
  close.addEventListener("click", () => opts.onClose());

  const status = el("p", { class: `inspector-status${s.status.word === "unknown" ? " unknown" : ""}${s.status.needs ? " needs" : ""}` }, `${s.status.mark} ${s.status.word}`);
  const facts = el("dl", { class: "inspector-facts" });
  for (const f of s.facts) {
    const known = f.value !== undefined && f.value !== "";
    facts.append(el("dt", {}, f.label), el("dd", { class: `${f.mono ? "mono " : ""}${known ? "" : "unknown"}`.trim() }, known ? f.value : "unknown"));
  }

  const body: Node[] = [close, el("p", { class: "inspector-kind dim" }, KIND_LABEL[s.kind]), el("h2", {}, s.title), status];
  if (s.status.reason) body.push(el("p", { class: "inspector-reason dim" }, s.status.reason));
  body.push(facts);

  if (s.id) {
    const value = s.id.value;
    const copy = el("button", { type: "button", class: "inspector-copy", "aria-label": `Copy ${s.id.label}` }, "Copy");
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(value).then(
        () => { copy.textContent = "Copied"; },
        () => {},
      );
    });
    body.push(el("div", { class: "inspector-id" }, el("span", { class: "inspector-id-label dim" }, s.id.label), el("span", { class: "inspector-id-value", title: value }, value), copy));
  }

  const open = el("button", { type: "button", class: "inspector-open primary" }, s.open.label);
  open.addEventListener("click", () => s.open.run());
  const row = el("div", { class: "inspector-buttons" }, open);
  const { actions } = s;
  if (actions && actions.length > 0 && opts.menu) {
    const menu = opts.menu;
    const btn = el("button", { type: "button", class: "inspector-actions", "aria-haspopup": "menu" }, "Actions");
    btn.addEventListener("click", () => menu.openMenu(actions, btn, { returnFocus: btn }));
    row.append(btn);
  }
  body.push(row);
  pane.append(...body);
  if (held) pane.querySelector<HTMLElement>(`.${held}`)?.focus();
}
