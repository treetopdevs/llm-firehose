// Session altitude: score, loops, loom, replay, handoffs and court as tabs over one
// session. scope.session owns the session and scope.window is the one transport; this
// panel only writes the store through the "whole session" reset chip.

import { el } from "../../dom";
import { sessionRefLabel } from "../../format";
import type { SessionDirectory } from "../../session-directory";
import type { ScopeStore, ScopeWindow, SessionRef } from "../../scope";
import { stripControl } from "../score/model";
import {
  SESSION_TABS,
  WINDOW_MODE,
  sessionKey,
  windowLabel,
  type Range,
  type SessionTab,
  type SessionTabContext,
} from "./context";
import { LOCAL } from "../../keys";

export interface SessionLens {
  root: HTMLElement;
  refresh(): unknown;
  deactivate?(): void;
  activate?(): void;
  followWindow?(): void;
  showEmpty?(): void;
  loadedSession?(): SessionRef | null;
  fullRange?(): Range | null;
  setContext?(ctx: SessionTabContext): void;
}

export interface SessionDeps {
  store: ScopeStore;
  // Factories: a lens is constructed on its first entry and cached, so a never-opened
  // lens costs nothing at boot.
  lenses: Record<SessionTab, () => SessionLens>;
  onTabShown?(tab: SessionTab): void;
  /** Names the session in each lens head; optional so a bare panel still renders its short id. */
  directory?: SessionDirectory;
}

export interface SessionPanel {
  root: HTMLElement;
  tab(): SessionTab;
  tabFor(ref: SessionRef): SessionTab;
  select(tab: SessionTab): void;
  activate(tab?: SessionTab): void;
  deactivate(): void;
  refresh(): void;
  escapes(): boolean;
  // The lens for a tab, constructed on demand (for callers that need the instance
  // before the tab is opened).
  lens(tab: SessionTab): SessionLens;
}

const TITLES: Record<SessionTab, string> = {
  score: "Score",
  loops: "Loops",
  loom: "Loom",
  replay: "Replay",
  handoffs: "Handoffs",
  court: "Court",
};

export function createSession(deps: SessionDeps): SessionPanel {
  const { store, onTabShown } = deps;
  const factories = deps.lenses;
  const built = new Map<SessionTab, SessionLens>();
  const lens = (t: SessionTab): SessionLens => {
    let l = built.get(t);
    if (!l) {
      l = factories[t]();
      built.set(t, l);
    }
    return l;
  };
  let current: SessionTab = "score";
  let entered = false;
  let unsub: (() => void) | null = null;
  let unsubDirectory: (() => void) | null = null;
  const memory = new Map<string, SessionTab>();
  let delivered: { key: string | null; win: ScopeWindow } | null = null;

  const root = el("div", { class: "session-panel" });
  const tablist = el("div", { class: "session-tabs graph-tabs", role: "tablist", "aria-label": "Session lenses" });
  const tabs = {} as Record<SessionTab, HTMLButtonElement>;
  const panels = {} as Record<SessionTab, HTMLElement>;
  const heads = {} as Record<SessionTab, HTMLElement>;

  for (const t of SESSION_TABS) {
    const b = el("button", {
      type: "button",
      role: "tab",
      id: `session-tab-${t}`,
      "aria-selected": "false",
      "aria-controls": `session-panel-${t}`,
      tabindex: "-1",
    }, TITLES[t]);
    b.addEventListener("click", () => select(t));
    tabs[t] = b;
    tablist.append(b);
    heads[t] = el("div", { class: "session-lens-head dim", "aria-live": "polite" });
    panels[t] = el("div", {
      role: "tabpanel",
      id: `session-panel-${t}`,
      "aria-labelledby": `session-tab-${t}`,
      class: "session-tabpanel",
    }, heads[t]);
    panels[t].hidden = true;
  }
  root.append(el("h2", {}, "Session"), tablist, ...SESSION_TABS.map((t) => panels[t]));

  tablist.addEventListener("keydown", (e) => {
    if (!LOCAL.sessionTabs.matches(e)) return;
    const i = SESSION_TABS.indexOf(current);
    let n: number;
    switch (e.key) {
      case "ArrowRight": n = (i + 1) % SESSION_TABS.length; break;
      case "ArrowLeft": n = (i - 1 + SESSION_TABS.length) % SESSION_TABS.length; break;
      case "Home": n = 0; break;
      case "End": n = SESSION_TABS.length - 1; break;
      default: return;
    }
    e.preventDefault();
    const t = SESSION_TABS[n]!;
    select(t);
    tabs[t].focus();
  });

  const ctxNow = (): SessionTabContext => {
    const s = store.get();
    return { session: s.session ?? null, window: s.window };
  };

  function paintTabs(): void {
    for (const t of SESSION_TABS) {
      const on = t === current;
      tabs[t].setAttribute("aria-selected", on ? "true" : "false");
      tabs[t].tabIndex = on ? 0 : -1;
      panels[t].hidden = !on;
    }
  }

  function renderHead(): void {
    const { session, window: win } = ctxNow();
    for (const t of SESSION_TABS) {
      const h = heads[t];
      h.replaceChildren();
      if (!session) {
        h.append(el("span", { class: "session-lens-title" }, "no session in scope"));
        continue;
      }
      const ref = sessionRefLabel(session, deps.directory?.lookup(session));
      h.append(
        el(
          "span",
          { class: "session-lens-title" },
          `${TITLES[t]} · `,
          el("span", { class: ref.resolved ? "session-lens-name" : "session-lens-name unresolved", title: stripControl(session.id) }, stripControl(ref.label)),
        ),
      );
      if (WINDOW_MODE[t] === "none") {
        h.append(el("span", { class: "session-lens-window" }, " whole session (notebook: the window does not apply)"));
      } else if (win === "live") {
        h.append(el("span", { class: "session-lens-window" }, ` ${windowLabel(win)}`));
      } else {
        h.append(el("span", { class: "session-lens-window" }, ` ${windowLabel(win)} `));
        const reset = el("button", { type: "button", class: "session-window-reset" }, "whole session");
        reset.addEventListener("click", () => store.narrow({ window: "live" }));
        h.append(reset);
      }
    }
  }

  function remember(): void {
    const s = store.get().session;
    if (s) memory.set(sessionKey(s), current);
  }

  function leave(): void {
    const l = lens(current);
    l.deactivate?.();
    l.root.remove();
  }

  function enter(tab: SessionTab): void {
    current = tab;
    paintTabs();
    const l = lens(tab);
    panels[tab].append(l.root);
    // The panel owns the h2; a hosted lens's own h2 sits one level beneath it.
    for (const h of l.root.querySelectorAll("h2")) h.setAttribute("aria-level", "3");
    renderHead();
    const ctx = ctxNow();
    delivered = { key: ctx.session ? sessionKey(ctx.session) : null, win: ctx.window };
    remember();
    if (WINDOW_MODE[tab] === "transport") {
      l.followWindow?.();
      if (ctx.session) l.activate?.();
      else l.showEmpty?.();
    } else {
      if (WINDOW_MODE[tab] === "filters") l.setContext?.(ctx);
      l.refresh();
    }
    onTabShown?.(tab);
  }

  const sameWin = (a: ScopeWindow, b: ScopeWindow): boolean =>
    a === "live" || b === "live" ? a === b : a.from === b.from && a.to === b.to;

  function onStore(): void {
    if (!entered) return;
    renderHead();
    remember();
    const now = store.get().session;
    if (now) deps.directory?.ensure(now);
    if (WINDOW_MODE[current] === "transport" && !store.get().session) lens(current).showEmpty?.();
    if (WINDOW_MODE[current] !== "filters") return;
    const ctx = ctxNow();
    const key = ctx.session ? sessionKey(ctx.session) : null;
    if (delivered && delivered.key === key && sameWin(delivered.win, ctx.window)) return;
    delivered = { key, win: ctx.window };
    lens(current).setContext?.(ctx);
  }

  function select(tab: SessionTab): void {
    if (!entered) {
      current = tab;
      paintTabs();
      remember();
      return;
    }
    if (tab === current) return;
    leave();
    enter(tab);
  }

  function activate(tab?: SessionTab): void {
    const s = store.get().session;
    const next = tab ?? (s ? memory.get(sessionKey(s)) ?? "score" : current);
    if (entered) leave();
    entered = true;
    unsub?.();
    unsub = store.subscribe(onStore);
    unsubDirectory?.();
    unsubDirectory = deps.directory?.subscribe(() => renderHead()) ?? null;
    enter(next);
    if (s) deps.directory?.ensure(s);
  }

  function deactivate(): void {
    if (!entered) return;
    leave();
    entered = false;
    unsub?.();
    unsub = null;
    unsubDirectory?.();
    unsubDirectory = null;
  }

  paintTabs();
  renderHead();

  return {
    root,
    tab: () => current,
    tabFor: (ref) => memory.get(sessionKey(ref)) ?? "score",
    select,
    activate,
    deactivate,
    refresh() {
      if (!entered) return;
      lens(current).refresh();
    },
    lens,
    escapes: () => entered && (current === "score" || current === "loops"),
  };
}

