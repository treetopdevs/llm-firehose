// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createScope } from "../../scope";
import type { ScopeStore } from "../../scope";
import { SESSION_TABS, type SessionTab } from "./context";
import { createSession, type SessionLens, type SessionPanel } from "./index";

type Fake = SessionLens & {
  refresh: ReturnType<typeof vi.fn>;
  deactivate: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  followWindow: ReturnType<typeof vi.fn>;
  setContext: ReturnType<typeof vi.fn>;
};

function fakeLens(name: string): Fake {
  const root = document.createElement("section");
  root.className = `fake-${name}`;
  return {
    root,
    refresh: vi.fn(),
    deactivate: vi.fn(),
    activate: vi.fn(),
    followWindow: vi.fn(),
    loadedSession: vi.fn(() => null),
    fullRange: vi.fn(() => null),
    setContext: vi.fn(),
  } as Fake;
}

let store: ScopeStore;
let fakes: Record<SessionTab, Fake>;
let factories: Record<SessionTab, ReturnType<typeof vi.fn> & (() => SessionLens)>;
let onTabShown: ReturnType<typeof vi.fn>;
let panel: SessionPanel;
const S1 = { id: "s1", source: "codex" };
const S2 = { id: "s2", source: "codex" };

function build(): void {
  fakes = Object.fromEntries(SESSION_TABS.map((t) => [t, fakeLens(t)])) as Record<SessionTab, Fake>;
  onTabShown = vi.fn();
  factories = Object.fromEntries(SESSION_TABS.map((t) => [t, vi.fn(() => fakes[t])])) as Record<SessionTab, ReturnType<typeof vi.fn> & (() => SessionLens)>;
  panel = createSession({ store, lenses: factories, onTabShown });
  document.body.append(panel.root);
}

const tabBtn = (t: SessionTab) => panel.root.querySelector<HTMLButtonElement>(`#session-tab-${t}`)!;
const key = (t: SessionTab, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  tabBtn(t).dispatchEvent(e);
  return e;
};

beforeEach(() => {
  document.body.replaceChildren();
  store = createScope();
  store.narrow({ session: S1 });
  build();
});

describe("session panel", () => {
  test("tablist structure and aria wiring", () => {
    const list = panel.root.querySelector(".session-tabs.graph-tabs")!;
    expect(list.getAttribute("role")).toBe("tablist");
    expect(list.getAttribute("aria-label")).toBe("Session lenses");
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.id)).toEqual(SESSION_TABS.map((t) => `session-tab-${t}`));
    for (const t of tabs) {
      const p = panel.root.querySelector(`#${t.getAttribute("aria-controls")}`)!;
      expect(p.getAttribute("role")).toBe("tabpanel");
      expect(p.getAttribute("aria-labelledby")).toBe(t.id);
    }
    panel.activate();
    expect(tabs.filter((t) => t.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(tabs.filter((t) => t.getAttribute("tabindex") === "-1")).toHaveLength(5);
    expect([...panel.root.querySelectorAll('[role="tabpanel"]')].filter((p) => !(p as HTMLElement).hidden)).toHaveLength(1);
  });

  test("activate defaults to score, loads once, other lenses untouched; named tab wins", () => {
    panel.activate();
    expect(panel.tab()).toBe("score");
    expect(fakes.score.activate).toHaveBeenCalledTimes(1);
    for (const t of SESSION_TABS.filter((x) => x !== "score")) {
      expect(fakes[t].setContext).not.toHaveBeenCalled();
      expect(fakes[t].root.isConnected).toBe(false);
    }
    expect(fakes.score.root.isConnected).toBe(true);
    panel.deactivate();
    panel.activate("loops");
    expect(panel.tab()).toBe("loops");
  });

  test("every entry delivers the raw current ctx before refresh, including after a window change elsewhere", () => {
    panel.activate();
    panel.select("loops");
    expect(fakes.loops.setContext).toHaveBeenCalledWith({ session: S1, window: "live" });
    expect(fakes.loops.setContext.mock.invocationCallOrder[0]).toBeLessThan(fakes.loops.refresh.mock.invocationCallOrder[0]!);
    panel.select("score");
    store.narrow({ window: { from: 1, to: 5 } });
    panel.select("loops");
    expect(fakes.loops.setContext).toHaveBeenLastCalledWith({ session: S1, window: { from: 1, to: 5 } });
  });

  test("score entry calls followWindow then activate, also for the same session", () => {
    (fakes.score.loadedSession as ReturnType<typeof vi.fn>).mockReturnValue(S1);
    panel.activate();
    panel.select("loops");
    panel.select("score");
    expect(fakes.score.followWindow).toHaveBeenCalledTimes(2);
    expect(fakes.score.activate).toHaveBeenCalledTimes(2);
    expect(fakes.score.followWindow.mock.invocationCallOrder[1]).toBeLessThan(fakes.score.activate.mock.invocationCallOrder[1]!);
    expect(fakes.score.refresh).not.toHaveBeenCalled();
  });

  test("select deactivates the leaving lens, detaches it, and reports the new tab", () => {
    panel.activate();
    panel.select("loom");
    expect(fakes.score.deactivate).toHaveBeenCalled();
    expect(fakes.score.root.isConnected).toBe(false);
    expect(fakes.loom.root.isConnected).toBe(true);
    expect(onTabShown).toHaveBeenLastCalledWith("loom");
  });

  test("keyboard: arrows/Home/End move and focus; others ignored", () => {
    panel.activate();
    let e = key("score", "ArrowRight");
    expect(e.defaultPrevented).toBe(true);
    expect(panel.tab()).toBe("loops");
    expect(document.activeElement).toBe(tabBtn("loops"));
    e = key("loops", "ArrowLeft");
    expect(panel.tab()).toBe("score");
    key("score", "ArrowLeft");
    expect(panel.tab()).toBe("court");
    key("court", "Home");
    expect(panel.tab()).toBe("score");
    key("score", "End");
    expect(panel.tab()).toBe("court");
    for (const k of ["Escape", "a", "Enter"]) {
      e = key("court", k);
      expect(e.defaultPrevented).toBe(false);
      expect(panel.tab()).toBe("court");
    }
  });

  test("a session switched while a filters tab is open is remembered on that tab", () => {
    panel.activate("loops");
    store.narrow({ session: S2 });
    expect(panel.tabFor(S2)).toBe("loops");
  });

  test("click selects; the tab is remembered per session (source is part of the key)", () => {
    panel.activate();
    tabBtn("loom").click();
    expect(panel.tab()).toBe("loom");
    expect(panel.tabFor(S1)).toBe("loom");
    expect(panel.tabFor({ id: "s1", source: "other" })).toBe("score");
    panel.deactivate();
    store.narrow({ session: S2 });
    panel.activate();
    expect(panel.tab()).toBe("score");
    panel.select("replay");
    panel.deactivate();
    store.narrow({ session: S1 });
    panel.activate();
    expect(panel.tab()).toBe("loom");
    panel.deactivate();
    store.narrow({ session: undefined });
    panel.activate();
    expect(panel.tab()).toBe("loom");
  });

  test("header: live shows whole session without chip; range shows label + reset; none-mode note", () => {
    panel.activate();
    const head = () => panel.root.querySelector<HTMLElement>("#session-panel-score .session-lens-head")!;
    expect(head().getAttribute("aria-live")).toBe("polite");
    expect(head().textContent).toContain("whole session");
    expect(head().querySelector("button")).toBeNull();
    store.narrow({ window: { from: 1000, to: 91000 } });
    expect(head().querySelector("button")!.textContent).toBe("whole session");
    const narrow = vi.spyOn(store, "narrow");
    head().querySelector("button")!.click();
    expect(narrow).toHaveBeenCalledTimes(1);
    expect(narrow).toHaveBeenCalledWith({ window: "live" });
    expect(store.get().window).toBe("live");
    store.narrow({ window: { from: 1000, to: 91000 } });
    panel.select("court");
    const ch = panel.root.querySelector("#session-panel-court .session-lens-head")!;
    expect(ch.textContent).toContain("whole session (notebook: the window does not apply)");
    expect(ch.querySelector("button")).toBeNull();
    panel.select("loops");
    expect(panel.root.querySelector("#session-panel-loops .session-lens-head button")).not.toBeNull();
  });

  test("no session in scope: neutral header, no window claim, current tab kept", () => {
    store.narrow({ session: undefined });
    panel.activate();
    for (const t of SESSION_TABS) {
      const h = panel.root.querySelector(`#session-panel-${t} .session-lens-head`)!;
      expect(h.textContent).toContain("no session in scope");
      expect(h.textContent).not.toContain("whole session");
    }
    expect(panel.tab()).toBe("score");
  });

  test("one owner: store changes reach the active filters tab only while entered", () => {
    panel.activate("loops");
    fakes.loops.setContext.mockClear();
    store.narrow({ window: { from: 1, to: 9 } });
    expect(fakes.loops.setContext).toHaveBeenCalledTimes(1);
    expect(fakes.loops.setContext).toHaveBeenCalledWith({ session: S1, window: { from: 1, to: 9 } });
    store.narrow({ window: { from: 1, to: 9 } });
    expect(fakes.loops.setContext).toHaveBeenCalledTimes(1);
    store.narrow({ session: S2 });
    expect(fakes.loops.setContext).toHaveBeenLastCalledWith({ session: S2, window: store.get().window });
    store.narrow({ window: { from: 2, to: 9 } });
    expect(fakes.loops.setContext).toHaveBeenCalledTimes(3);
    panel.select("score");
    store.narrow({ window: "live" });
    for (const t of ["score", "handoffs", "court"] as SessionTab[]) expect(fakes[t].setContext).not.toHaveBeenCalled();
    panel.select("handoffs");
    store.narrow({ window: { from: 3, to: 4 } });
    expect(fakes.handoffs.setContext).not.toHaveBeenCalled();
    panel.select("loom");
    fakes.loom.setContext.mockClear();
    panel.deactivate();
    store.narrow({ window: "live" });
    expect(fakes.loom.setContext).not.toHaveBeenCalled();
  });

  test("escapes only for score and loops while entered", () => {
    expect(panel.escapes()).toBe(false);
    panel.activate();
    const out: Record<string, boolean> = {};
    for (const t of SESSION_TABS) {
      panel.select(t);
      out[t] = panel.escapes();
    }
    expect(out).toEqual({ score: true, loops: true, loom: false, replay: false, handoffs: false, court: false });
    panel.deactivate();
    panel.select("score");
    expect(panel.escapes()).toBe(false);
  });

  test("deactivate leaves the lens and re-entry re-enters it; court/handoffs get lens.deactivate", () => {
    panel.activate("court");
    panel.select("handoffs");
    expect(fakes.court.deactivate).toHaveBeenCalledTimes(1);
    panel.deactivate();
    expect(fakes.handoffs.deactivate).toHaveBeenCalledTimes(1);
    expect(fakes.handoffs.root.isConnected).toBe(false);
    panel.activate();
    expect(panel.tab()).toBe("handoffs");
    expect(fakes.handoffs.refresh).toHaveBeenCalledTimes(2);
  });
});

describe("lazy lens construction", () => {
  test("a factory is not called until its tab is entered, then exactly once", () => {
    for (const t of SESSION_TABS) expect(factories[t]).not.toHaveBeenCalled();
    panel.activate();
    expect(factories.score).toHaveBeenCalledTimes(1);
    for (const t of SESSION_TABS.filter((x) => x !== "score")) expect(factories[t]).not.toHaveBeenCalled();
    panel.select("loom");
    panel.select("score");
    panel.select("loom");
    panel.deactivate();
    panel.activate("score");
    expect(factories.score).toHaveBeenCalledTimes(1);
    expect(factories.loom).toHaveBeenCalledTimes(1);
    for (const t of ["loops", "replay", "handoffs", "court"] as SessionTab[]) expect(factories[t]).not.toHaveBeenCalled();
  });

  test("select before activate constructs nothing", () => {
    panel.select("court");
    for (const t of SESSION_TABS) expect(factories[t]).not.toHaveBeenCalled();
  });

  test("lens(tab) constructs on demand and returns the cached instance the tab then uses", () => {
    const l = panel.lens("court");
    expect(l).toBe(fakes.court);
    expect(factories.court).toHaveBeenCalledTimes(1);
    expect(factories.score).not.toHaveBeenCalled();
    panel.activate("court");
    expect(factories.court).toHaveBeenCalledTimes(1);
    expect(panel.lens("court")).toBe(l);
    expect(fakes.court.root.isConnected).toBe(true);
  });
});
