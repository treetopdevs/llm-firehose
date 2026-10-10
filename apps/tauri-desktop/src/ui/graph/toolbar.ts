// The Workspaces header: repository picker, worktree count, search with a results
// listbox, Fit / All, the Graph / Timeline tabs and a More menu. Built once and
// updated in place, so typing in search is never interrupted by a refresh.

import { clear, el } from "../../dom";
import { stateDescription, type AgentState } from "./names";

const svgNS = "http://www.w3.org/2000/svg";

const ICONS: Record<string, string> = {
  repo: "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4.2-4.2",
  chevron: "M6 9l6 6 6-6",
  branch: "M6 4v12M6 16a2.5 2.5 0 1 0 0 .01M6 4a2.5 2.5 0 1 0 0 .01M17 8a2.5 2.5 0 1 0 0 .01M17 10.5c0 4-4 5-11 5.5",
  file: "M7 3h7l4 4v14H7zM14 3v4h4",
  commits: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3 12h6M15 12h6",
  nodes: "M6 6a2 2 0 1 0 0 .01M18 6a2 2 0 1 0 0 .01M12 18a2 2 0 1 0 0 .01M7.5 7.5l3.5 8M16.5 7.5L13 15.5",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  copy: "M9 9h10v11H9zM5 15V4h10",
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01",
  agent: "M6 8h12v9H6zM12 4v4M9.5 12h.01M14.5 12h.01M9 20h6",
  event: "M6 4v8a4 4 0 0 0 4 4h4M6 4a1.5 1.5 0 1 0 0 .01M17 16a1.5 1.5 0 1 0 0 .01",
  branchSmall: "M7 5v11M7 16a2 2 0 1 0 0 .01M7 5a2 2 0 1 0 0 .01M16 9a2 2 0 1 0 0 .01M16 11c0 3-3 4-9 5",
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const s = document.createElementNS(svgNS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("class", `icon icon-${name}`);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.6");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(svgNS, "path");
  p.setAttribute("d", ICONS[name] ?? ICONS.file);
  s.append(p);
  return s;
}

export interface SearchResult {
  kind: "workspace" | "revision";
  /** Workspace id or revision key. */
  id: string;
  title: string;
  detail: string;
  state?: AgentState;
}
export interface ToolbarRepo {
  id: string;
  name: string;
  /** Full path of the repository root, for the tooltip. */
  title?: string;
}
export interface ToolbarState {
  repos: ToolbarRepo[];
  repo: string;
  /** "7 worktrees"; empty before the first snapshot. */
  count: string;
  tab: "graph" | "timeline";
}
export interface ToolbarHandlers {
  selectRepo(id: string): void;
  setTab(tab: "graph" | "timeline"): void;
  fit(): void;
  all(): void;
  search(query: string): SearchResult[];
  pick(result: SearchResult): void;
  /** Resolves when registered; rejects with a user-facing message. */
  register(root: string, vcs: string): Promise<void>;
  refresh(): void;
}

let listboxSeq = 0;

export function createToolbar(h: ToolbarHandlers) {
  const root = el("header", { class: "graph-toolbar" });

  // Repository picker: icon, name and chevron over a native select.
  const repoWrap = el("div", { class: "graph-repo" });
  const repoSelect = el("select", { "aria-label": "Repository" });
  repoSelect.onchange = () => h.selectRepo(repoSelect.value);
  repoWrap.append(
    el("span", { class: "graph-repo-label" }, "Repository"),
    el("span", { class: "graph-repo-picker" }, icon("repo", 18), repoSelect, icon("chevron", 14)),
  );
  const count = el("span", { class: "graph-count" });

  // Search with a results listbox.
  const listId = `graph-search-results-${++listboxSeq}`;
  const searchWrap = el("div", { class: "graph-search" });
  const input = el("input", {
    type: "text",
    class: "graph-search-input",
    "aria-label": "Search graph",
    placeholder: "Search worktrees, branches, or commits…",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    autocomplete: "off",
    spellcheck: "false",
  });
  const hint = el("kbd", { class: "graph-search-hint", "aria-hidden": "true" }, "⌘K");
  const list = el("ul", { class: "graph-search-results", id: listId, role: "listbox", "aria-label": "Search results" });
  list.hidden = true;
  searchWrap.append(icon("search", 16), input, hint, list);
  let results: SearchResult[] = [];
  let active = -1;
  let open = false;

  function renderResults() {
    clear(list);
    results.forEach((r, i) => {
      const li = el("li", {
        role: "option",
        id: `${listId}-${i}`,
        class: `graph-search-option${i === active ? " active" : ""}`,
        "aria-selected": i === active ? "true" : "false",
        "data-kind": r.kind,
      });
      if (r.state) {
        const dot = el("span", { class: `agent-dot state-${r.state}`, title: stateDescription(r.state) });
        li.append(dot);
      } else li.append(el("span", { class: "result-kind" }, r.kind === "revision" ? "◆" : "•"));
      li.append(el("span", { class: "result-title" }, r.title), el("span", { class: "result-detail" }, r.detail));
      li.onmousedown = (e) => e.preventDefault(); // keep input focus until the click lands
      li.onclick = () => choose(r);
      list.append(li);
    });
    if (!results.length) list.append(el("li", { class: "graph-search-empty", role: "presentation" }, "No match"));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
    active >= 0 && list.children[active]?.scrollIntoView?.({ block: "nearest" });
  }
  function query(): string {
    return input.value;
  }
  function refreshResults() {
    results = h.search(input.value.trim());
    active = results.length ? Math.min(Math.max(active, 0), results.length - 1) : -1;
    if (!input.value.trim()) active = -1;
    renderResults();
  }
  function show() {
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    refreshResults();
  }
  function hide() {
    open = false;
    list.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
  }
  function choose(r: SearchResult) {
    input.value = "";
    hide();
    h.search(""); // clears the canvas mute
    h.pick(r);
  }
  input.addEventListener("focus", show);
  input.addEventListener("input", () => {
    if (!open) show();
    else refreshResults();
  });
  input.addEventListener("blur", () => {
    hide();
    if (!input.value) h.search("");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) show();
      if (!results.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + results.length) % results.length;
      renderResults();
    } else if (e.key === "Enter") {
      const r = results[active] ?? (results.length === 1 ? results[0] : undefined);
      if (r) {
        e.preventDefault();
        choose(r);
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (input.value) {
        input.value = "";
        refreshResults();
        h.search("");
      } else {
        hide();
        input.blur();
      }
    }
  });

  // Fit / All.
  const fitGroup = el("div", { class: "graph-fit", role: "group", "aria-label": "View" });
  const fitBtn = el("button", { type: "button", title: "Fit active tips and the history joining them" }, "Fit");
  fitBtn.onclick = () => h.fit();
  const allBtn = el("button", { type: "button", title: "Show the whole loaded graph" }, "All");
  allBtn.onclick = () => h.all();
  fitGroup.append(fitBtn, allBtn);

  // Graph / Timeline.
  const tabs = el("div", { class: "graph-tabs", role: "tablist", "aria-label": "Workspace view" });
  const tabButtons = {
    graph: el("button", { type: "button", role: "tab" }, "Graph"),
    timeline: el("button", { type: "button", role: "tab" }, "Timeline"),
  };
  for (const name of ["graph", "timeline"] as const) {
    tabButtons[name].onclick = () => h.setTab(name);
    tabs.append(tabButtons[name]);
  }

  // More menu: Register local root and Refresh.
  const more = el("div", { class: "graph-more" });
  const moreBtn = el("button", { type: "button", class: "graph-more-button", "aria-haspopup": "menu", "aria-expanded": "false" }, "More");
  const menu = el("div", { class: "graph-menu", role: "menu" });
  menu.hidden = true;
  const registerBtn = el("button", { type: "button", role: "menuitem" }, "Register local root");
  const refreshBtn = el("button", { type: "button", role: "menuitem" }, "Refresh");
  const form = el("form", { class: "graph-register" });
  form.hidden = true;
  const rootInput = el("input", {
    placeholder: "Local repository root",
    "aria-label": "Local repository root",
    required: "true",
  });
  const vcsSelect = el("select", { "aria-label": "VCS" });
  for (const [v, l] of [["", "Auto detect"], ["git", "Git"], ["jj", "JJ"]]) vcsSelect.append(el("option", { value: v }, l));
  const registerError = el("p", { class: "graph-warning", role: "alert" });
  form.append(rootInput, vcsSelect, el("button", { type: "submit" }, "Register"), registerError);
  menu.append(registerBtn, refreshBtn, form);
  more.append(moreBtn, menu);
  const closeOnOutside = (e: Event) => {
    if (!more.contains(e.target as Node)) closeMenu();
  };
  function openMenu() {
    menu.hidden = false;
    moreBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", closeOnOutside, true);
  }
  function closeMenu() {
    menu.hidden = true;
    form.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", closeOnOutside, true);
  }
  moreBtn.onclick = () => (menu.hidden ? openMenu() : closeMenu());
  menu.onkeydown = (e) => {
    if (e.key === "Escape") {
      closeMenu();
      moreBtn.focus();
    }
  };
  registerBtn.onclick = () => {
    form.hidden = !form.hidden;
    if (!form.hidden) rootInput.focus();
  };
  refreshBtn.onclick = () => {
    closeMenu();
    h.refresh();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    registerError.textContent = "";
    try {
      await h.register(rootInput.value, vcsSelect.value);
      rootInput.value = "";
      closeMenu();
    } catch (err) {
      registerError.textContent =
        err instanceof Error && err.message
          ? err.message
          : "Unable to register repository. Check the local root and VCS availability.";
    }
  };

  root.append(repoWrap, count, searchWrap, fitGroup, tabs, more);

  let reposSig = "";
  function update(s: ToolbarState) {
    const sig = JSON.stringify(s.repos);
    if (sig !== reposSig) {
      reposSig = sig;
      clear(repoSelect);
      for (const r of s.repos) repoSelect.append(el("option", r.title ? { value: r.id, title: r.title } : { value: r.id }, r.name));
    }
    repoSelect.value = s.repo;
    const path = s.repos.find((r) => r.id === s.repo)?.title;
    if (path) repoSelect.title = path;
    else repoSelect.removeAttribute("title");
    repoSelect.disabled = s.repos.length === 0;
    count.textContent = s.count;
    count.hidden = !s.count;
    for (const name of ["graph", "timeline"] as const) {
      const on = s.tab === name;
      tabButtons[name].classList.toggle("active", on);
      tabButtons[name].setAttribute("aria-selected", on ? "true" : "false");
    }
    const graph = s.tab === "graph";
    searchWrap.hidden = !graph;
    fitGroup.hidden = !graph;
  }
  /** Refreshes the open results list, for example after a snapshot changed. */
  function refreshOpenResults() {
    if (open) refreshResults();
  }
  return {
    root,
    update,
    query,
    refreshOpenResults,
    focusSearch() {
      searchWrap.hidden = false;
      input.focus();
      input.select();
    },
    input,
  };
}

export type Toolbar = ReturnType<typeof createToolbar>;
