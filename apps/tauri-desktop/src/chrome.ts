// The shell's chrome (MS-1, MS-2): a source-list sidebar that answers "where", and one toolbar
// that carries history, the title, the view switcher and the range. Both are plain DOM with no
// knowledge of panels: main.ts feeds them state and receives intents.

import { el } from "./dom";
import { NAV_CHEVRON } from "./glyphs";

// ---- sidebar ---------------------------------------------------------------------------------

/** What a sidebar item sends to the shell. */
export type SidebarTarget =
  | { kind: "needs" }
  | { kind: "fleet" }
  | { kind: "project"; id: string }
  | { kind: "files" }
  | { kind: "doctor" }
  | { kind: "settings" };

/** One project row: a name, and the per-project counts the attention poll already carries. */
export interface ProjectRow {
  id: string;
  label: string;
  needs: number;
  active: number;
}

/** The id the shell hands to setCurrent. Panels that are not in the list map onto a row. */
export type SidebarCurrent = "needs" | "fleet" | "files" | "doctor" | "settings" | { project: string } | undefined;

export interface SidebarDeps {
  onSelect(target: SidebarTarget): void;
  onLegend(): void;
}

export interface Sidebar {
  root: HTMLElement;
  setCurrent(c: SidebarCurrent): void;
  setProjects(rows: ProjectRow[]): void;
  setNeeds(n: number): void;
  /** How many projects there are: the count beside All projects. */
  setProjectCount(n: number): void;
  setWarnings(n: number): void;
  setStatus(kind: string, text: string): void;
  setEventCount(text: string): void;
  /** The daemon state, version and event count live in the sidebar footer. */
  status: { dot: HTMLElement; text: HTMLElement; count: HTMLElement };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function createSidebar(deps: SidebarDeps): Sidebar {
  const button = (panel: string, label: string, target: SidebarTarget, ...extra: Array<Node | string | null>): HTMLButtonElement => {
    const b = el("button", { type: "button", class: "nav-btn", "data-panel": panel }, el("span", { class: "nav-label" }, label), ...extra);
    b.addEventListener("click", () => deps.onSelect(target));
    return b;
  };

  const needsCount = el("span", { class: "nav-count needs" });
  needsCount.hidden = true;
  const needsBtn = button("needs", "Needs you", { kind: "needs" }, needsCount);
  const fleetCount = el("span", { class: "nav-count" });
  const fleetBtn = button("fleet", "All projects", { kind: "fleet" }, fleetCount);
  const projects = el("div", { class: "nav-projects", role: "group", "aria-labelledby": "nav-projects-heading" });
  const projectsHeading = el("div", { class: "nav-heading", id: "nav-projects-heading" }, "Projects");
  const projectsEmpty = el("p", { class: "nav-empty dim" }, "No projects yet");
  const filesBtn = button("files", "Files", { kind: "files" });
  const doctorCount = el("span", { class: "nav-count" });
  doctorCount.hidden = true;
  const doctorBtn = button("doctor", "Doctor", { kind: "doctor" }, doctorCount);
  const settingsBtn = button("settings", "Settings", { kind: "settings" });
  const legendBtn = el("button", { type: "button", class: "legend-btn", "aria-haspopup": "dialog" }, "Keys and symbols");
  legendBtn.addEventListener("click", () => deps.onLegend());

  const dot = el("span", { class: "status-dot", "aria-hidden": "true" });
  const text = el("span", { class: "status-text dim", role: "status" }, "connecting…");
  const count = el("span", { class: "event-count dim" });

  const root = el(
    "nav",
    { class: "sidebar", id: "sidebar", "aria-label": "Sidebar" },
    el("div", { class: "brand" }, "Agent Firehose"),
    el("div", { class: "nav-group" }, needsBtn, fleetBtn),
    projectsHeading,
    projects,
    projectsEmpty,
    el("div", { class: "nav-heading" }, "Capture"),
    el("div", { class: "nav-group" }, filesBtn, doctorBtn),
    el(
      "div",
      { class: "sidebar-foot" },
      el("div", { class: "sidebar-status" }, dot, text),
      count,
      el("div", { class: "sidebar-links" }, settingsBtn, legendBtn),
    ),
  );

  const projectBtns = new Map<string, HTMLButtonElement>();
  let current: SidebarCurrent;
  let warnings = 0;

  const fixed: Array<[string, HTMLButtonElement]> = [
    ["needs", needsBtn],
    ["fleet", fleetBtn],
    ["files", filesBtn],
    ["doctor", doctorBtn],
    ["settings", settingsBtn],
  ];

  function paintCurrent(): void {
    const mark = (b: HTMLButtonElement, on: boolean): void => {
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    };
    for (const [name, b] of fixed) mark(b, current === name);
    const id = typeof current === "object" ? current.project : undefined;
    for (const [pid, b] of projectBtns) mark(b, pid === id);
  }

  function projectRowBtn(row: ProjectRow): HTMLButtonElement {
    const states = [row.needs > 0 ? `${row.needs} needs you` : "", row.active > 0 ? `${row.active} active` : ""].filter(Boolean).join(" · ");
    const b = el(
      "button",
      { type: "button", class: "nav-btn nav-project", "data-panel": "project", "data-project": row.id, title: row.label },
      el("span", { class: "nav-label" }, row.label),
      states ? el("span", { class: row.needs > 0 ? "nav-sub needs" : "nav-sub dim" }, states) : null,
    );
    b.addEventListener("click", () => deps.onSelect({ kind: "project", id: row.id }));
    return b;
  }

  return {
    root,
    status: { dot, text, count },
    setCurrent(c) {
      current = c;
      paintCurrent();
    },
    setProjects(rows) {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("data-project") : null;
      projectBtns.clear();
      projects.replaceChildren(
        ...rows.map((r) => {
          const b = projectRowBtn(r);
          projectBtns.set(r.id, b);
          return b;
        }),
      );
      projectsEmpty.hidden = rows.length > 0;
      projects.hidden = rows.length === 0;
      paintCurrent();
      if (focused !== null) projectBtns.get(focused)?.focus();
    },
    setNeeds(n) {
      needsCount.hidden = n <= 0;
      needsCount.textContent = String(n);
      needsBtn.setAttribute("aria-label", n > 0 ? `Needs you, ${plural(n, "session", "sessions")}` : "Needs you");
    },
    setProjectCount(n) {
      fleetCount.textContent = n > 0 ? String(n) : "";
    },
    setWarnings(n) {
      warnings = n;
      doctorCount.hidden = n <= 0;
      doctorCount.textContent = String(n);
      doctorBtn.setAttribute("aria-label", warnings > 0 ? `Doctor, ${plural(n, "capture warning", "capture warnings")}` : "Doctor");
    },
    setStatus(kind, label) {
      dot.className = `status-dot ${kind}`;
      text.textContent = label;
    },
    setEventCount(label) {
      count.textContent = label;
    },
  };
}

// ---- toolbar ---------------------------------------------------------------------------------

export interface ToolbarDeps {
  onBack(): void;
  onForward(): void;
  onToggleSidebar(): void;
}

export interface Toolbar {
  root: HTMLElement;
  /** Where the range control mounts. */
  rangeSlot: HTMLElement;
  /** Where the active panel's view switcher (encodings or tabs) is hosted. */
  viewSlot: HTMLElement;
  crumbSlot: HTMLElement;
  setPlace(label: string): void;
  setHistory(canBack: boolean, canForward: boolean): void;
  setSidebarShown(shown: boolean): void;
}

export function createToolbar(deps: ToolbarDeps): Toolbar {
  const icon = (b: HTMLButtonElement, glyph: string): HTMLButtonElement => {
    b.append(el("span", { "aria-hidden": "true" }, glyph));
    return b;
  };
  const sidebarBtn = icon(
    el("button", { type: "button", class: "toolbar-btn toolbar-sidebar", "aria-label": "Show sidebar", "aria-controls": "sidebar", "aria-expanded": "true", title: "Show or hide the sidebar (⌃⌘S)" }),
    "☰",
  );
  const back = icon(el("button", { type: "button", class: "toolbar-btn toolbar-back", "aria-label": "Back", title: "Back (⌘[)" }), NAV_CHEVRON.back);
  const forward = icon(el("button", { type: "button", class: "toolbar-btn toolbar-forward", "aria-label": "Forward", title: "Forward (⌘])" }), NAV_CHEVRON.forward);
  // aria-disabled, not disabled: a disabled button that holds focus would drop it to <body> (MS-8).
  back.setAttribute("aria-disabled", "true");
  forward.setAttribute("aria-disabled", "true");
  sidebarBtn.addEventListener("click", () => deps.onToggleSidebar());
  back.addEventListener("click", () => back.getAttribute("aria-disabled") !== "true" && deps.onBack());
  forward.addEventListener("click", () => forward.getAttribute("aria-disabled") !== "true" && deps.onForward());

  const place = el("span", { class: "toolbar-place" });
  const crumbSlot = el("span", { class: "toolbar-crumb" });
  const title = el("div", { class: "toolbar-title" }, place, crumbSlot);
  const viewSlot = el("div", { class: "toolbar-views" });
  const rangeSlot = el("div", { class: "toolbar-range" });
  const root = el(
    "header",
    { class: "toolbar", role: "toolbar", "aria-label": "Window" },
    sidebarBtn,
    el("div", { class: "toolbar-history" }, back, forward),
    title,
    viewSlot,
    rangeSlot,
  );

  return {
    root,
    rangeSlot,
    viewSlot,
    crumbSlot,
    setPlace(label) {
      place.textContent = label;
    },
    setHistory(canBack, canForward) {
      back.setAttribute("aria-disabled", String(!canBack));
      forward.setAttribute("aria-disabled", String(!canForward));
    },
    setSidebarShown(shown) {
      sidebarBtn.setAttribute("aria-expanded", String(shown));
      sidebarBtn.setAttribute("aria-label", shown ? "Hide sidebar" : "Show sidebar");
    },
  };
}
