// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ActivityResponse } from "./graph/api";
import { createToolbar } from "./graph/toolbar";
import { createActivityMap, type ActivityHost } from "./activity";
import activityFixture from "./activity/fixture.activity.json";
import { createScope, liveSpanOf } from "../scope";
import { createTransport } from "../transport";
import { __resetKeysForTests, listKeys, listLocalKeys, QUEUE_KEYS, registerKeys } from "../keys";
import { GLYPH_GROUPS, swatchSvg } from "../glyphs";
import { isEscapeClaimed } from "../escape";
import { TIME_CONTROL_NOTES, isLegendOpen, localScopesFor, openLegend, spaceNotes, toggleLegend } from "./legend";
import { LOCAL_KEYS } from "../keys";

vi.mock("./graph/api", () => ({ graphAPI: { activity: vi.fn(async () => structuredClone(activityFixture)) } }));

const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const dialogs = () => document.querySelectorAll('div[role="dialog"][aria-modal="true"]');
const dlg = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const text = () => dlg().textContent ?? "";
const section = (title: string) => [...dlg().querySelectorAll("h3")].find((h) => h.textContent === title)!.parentElement!;

let opener: HTMLButtonElement;
let fallback: HTMLButtonElement;
let unreg: Array<() => void> = [];

function registerShell() {
  unreg.push(
    registerKeys([
      { scope: "global", ...QUEUE_KEYS.legend, label: "keys and symbols", handler: () => void toggleLegend({ opener: document.activeElement as HTMLElement, fallbackFocus: fallback }) },
      { scope: "global", ...QUEUE_KEYS.escape, label: "go up one level", modifiers: "any", handler: () => void 0 },
    ]),
  );
}

beforeEach(() => {
  __resetKeysForTests();
  opener = document.createElement("button");
  opener.textContent = "opener";
  fallback = document.createElement("button");
  fallback.textContent = "footer";
  document.body.append(opener, fallback);
  opener.focus();
});
afterEach(() => {
  while (isLegendOpen()) toggleLegend();
  unreg = [];
  document.body.replaceChildren();
  __resetKeysForTests();
  vi.restoreAllMocks();
});

describe("dialog", () => {
  test("one role=dialog aria-modal dialog labelled by the h2 'Keys and symbols'; a second open adds none", () => {
    const a = openLegend({ opener });
    const b = openLegend({ opener });
    expect(dialogs()).toHaveLength(1);
    const d = dlg();
    const h = document.getElementById(d.getAttribute("aria-labelledby")!)!;
    expect(h.tagName).toBe("H2");
    expect(h.textContent).toBe("Keys and symbols");
    expect(isLegendOpen()).toBe(true);
    a.close();
    expect(dialogs()).toHaveLength(0);
    expect(isLegendOpen()).toBe(false);
    b.close();
  });

  test("lists enabled panel keys under This panel, global under Everywhere, locals under Elsewhere", () => {
    unreg.push(
      registerKeys([
        { scope: "fleet", keys: ["x"], display: "x-display", label: "fleet thing", handler: () => void 0 },
        { scope: "project", keys: ["y"], display: "y-display", label: "off thing", handler: () => void 0, enabled: () => false },
        { scope: "global", keys: ["z"], display: "z-display", label: "global thing", handler: () => void 0 },
      ]),
    );
    const un = registerKeys([{ scope: "live", keys: ["q"], display: "q-display", label: "gone thing", handler: () => void 0 }]);
    un();
    openLegend({ opener });
    const panel = section("This panel").textContent!;
    expect(panel).toContain("x-display");
    expect(panel).toContain("fleet thing");
    expect(panel).not.toContain("off thing");
    expect(panel).not.toContain("global thing");
    expect(section("Everywhere").textContent).toContain("z-display");
    expect(section("Everywhere").textContent).toContain("global thing");
    expect(text()).not.toContain("gone thing");
    expect(text()).not.toContain("off thing");
    expect(text()).not.toContain("Also on the keyboard");
    const local = dlg().querySelector("details")!.textContent!;
    for (const k of listLocalKeys()) {
      expect(local).toContain(k.display);
      expect(local).toContain(k.label);
    }
    expect(listKeys().map((k) => k.label)).toContain("fleet thing");
  });

  test("every glyph group and entry appears with name, meaning and its glyph or exact swatch geometry", () => {
    openLegend({ opener });
    const d = dlg();
    const sig = (s: Element) => [...s.children].map((c) => `${c.tagName}|${c.getAttribute("d")}|${c.getAttribute("stroke-dasharray")}`).join();
    for (const g of GLYPH_GROUPS) {
      expect(d.textContent).toContain(g.title);
      for (const entry of g.entries) {
        expect(d.textContent, entry.name).toContain(entry.name);
        expect(d.textContent, entry.name).toContain(entry.meaning);
        if (entry.glyph) expect(d.textContent, entry.name).toContain(entry.glyph);
        if (entry.swatch) {
          const want = sig(swatchSvg(entry)!);
          const found = [...d.querySelectorAll("svg.legend-swatch")].some((s) => sig(s) === want);
          expect(found, `${entry.name} swatch`).toBe(true);
        }
      }
    }
  });

  test("states both D115 time-control behaviours and per-panel Space with no application-wide claim", () => {
    openLegend({ opener });
    const t = text();
    const notes = TIME_CONTROL_NOTES.join(" ");
    for (const n of TIME_CONTROL_NOTES) expect(t).toContain(n);
    expect(notes).toMatch(/Session/);
    expect(notes).toMatch(/inert/);
    expect(notes).toMatch(/Live/);
    expect(notes).toMatch(/zoom/);
    expect(notes).toMatch(/Score/);
    expect(notes).toMatch(/Fleet/);
    expect(notes).toMatch(/preset/);
    const space = section("Space").textContent!;
    expect(space).toMatch(/score track: Space step to the next event in this track/i);
    expect(space).toMatch(/score: Space play or pause/i);
    expect(space).toMatch(/rows and cards: Space activate the focused row/i);
    expect(space).toMatch(/buttons.*natively/i);
    expect(t).not.toMatch(/Space (always|anywhere|everywhere)/i);
  });
});

describe("close", () => {
  test("'?' inside the open dialog with the real dispatcher leaves zero dialogs; '?' on body toggles", () => {
    registerShell();
    key(document.body, "?");
    expect(dialogs()).toHaveLength(1);
    const inner = key(dlg().querySelector("button")!, "?");
    expect(dialogs()).toHaveLength(0);
    expect(inner.defaultPrevented).toBe(true);
    key(document.body, "?");
    expect(dialogs()).toHaveLength(1);
    key(document.body, "?");
    expect(dialogs()).toHaveLength(0);
  });

  test("Escape with focus inside closes, returns focus to the opener, claims, and the shell ascent does not fire", () => {
    const ascent = vi.fn();
    unreg.push(registerKeys([{ scope: "global", ...QUEUE_KEYS.escape, label: "up", modifiers: "any", handler: ascent }]));
    openLegend({ opener });
    expect(dlg().contains(document.activeElement)).toBe(true);
    const e = key(document.activeElement!, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
    expect(isEscapeClaimed(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(ascent).not.toHaveBeenCalled();
  });

  test("Escape with focus on body still closes", () => {
    openLegend({ opener });
    (document.activeElement as HTMLElement).blur();
    key(document.body, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  test("a detached opener sends focus to the fallback", () => {
    openLegend({ opener, fallbackFocus: fallback });
    opener.remove();
    key(document.body, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(fallback);
  });

  test("the capture Escape listener is removed on close", () => {
    const add = vi.spyOn(document, "addEventListener");
    const rem = vi.spyOn(document, "removeEventListener");
    const l = openLegend({ opener });
    const added = add.mock.calls.filter((c) => c[0] === "keydown");
    expect(added.length).toBeGreaterThan(0);
    l.close();
    for (const [, fn] of added) expect(rem.mock.calls.some((c) => c[0] === "keydown" && c[1] === fn)).toBe(true);
    const e = key(document.body, "Escape");
    expect(isEscapeClaimed(e)).toBe(false);
  });

  test("backdrop click closes; a click inside does not", () => {
    openLegend({ opener });
    dlg().click();
    expect(dialogs()).toHaveLength(1);
    dlg().querySelector("h2")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialogs()).toHaveLength(1);
    document.querySelector<HTMLElement>(".legend-backdrop")!.click();
    expect(dialogs()).toHaveLength(0);
  });

  test("opening moves focus to the close button; Tab and Shift+Tab wrap", () => {
    openLegend({ opener });
    const focusables = [...dlg().querySelectorAll<HTMLElement>("button, summary, [tabindex='0']")];
    expect(focusables.length).toBeGreaterThanOrEqual(2);
    expect(document.activeElement).toBe(focusables[0]);
    expect(focusables[0].tagName).toBe("BUTTON");
    focusables[focusables.length - 1].focus();
    const t = key(document.activeElement!, "Tab");
    expect(t.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
    const s = key(document.activeElement!, "Tab", { shiftKey: true });
    expect(s.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  test("Space notes follow the registry: a registered Space binding appears, a rebound one does not", () => {
    const off = registerKeys([{ scope: "demo", keys: [" "], display: "Space", label: "do the demo thing", handler: () => true }]);
    openLegend({ opener });
    expect(section("Space").textContent).toContain("demo: Space do the demo thing.");
    off();
    toggleLegend();
    const off2 = registerKeys([{ scope: "demo", keys: ["x"], display: "x", label: "do the demo thing", handler: () => true }]);
    openLegend({ opener });
    expect(section("Space").textContent).not.toContain("do the demo thing");
    off2();
  });

  test("Tab keeps focus inside the dialog even when a click on dialog text left focus on body", () => {
    openLegend({ opener });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const focusables = [...dlg().querySelectorAll<HTMLElement>("button, summary, [tabindex='0']")];
    const t = key(document.body, "Tab");
    expect(t.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
    (document.activeElement as HTMLElement).blur();
    const s = key(document.body, "Tab", { shiftKey: true });
    expect(s.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  test("the close button closes and returns focus", () => {
    openLegend({ opener });
    dlg().querySelector<HTMLElement>("button")!.click();
    expect(dialogs()).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });
});

describe("Escape ownership: the legend closes first", () => {
  const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
  const H = 3_600_000;
  const w0 = { from: NOW - 2 * H - 5000, to: NOW - 5000 };
  let raf: FrameRequestCallback[] = [];
  beforeEach(() => {
    raf = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (raf.push(cb), raf.length));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  function dragging() {
    const store = createScope();
    const t = createTransport({ store, now: () => NOW, effectiveLiveSpan: () => liveSpanOf(store.get()) });
    document.body.append(t.root);
    const track = t.root.querySelector<HTMLElement>(".transport-track")!;
    track.getBoundingClientRect = () => ({ width: 1000, height: 14, left: 0, top: 0, right: 1000, bottom: 14, x: 0, y: 0, toJSON() {} }) as DOMRect;
    store.narrow({ window: w0 });
    track.dispatchEvent(new MouseEvent("pointerdown", { clientX: 500, bubbles: true, button: 0 }));
    track.dispatchEvent(new MouseEvent("pointermove", { clientX: 400, bubbles: true }));
    raf.splice(0).forEach((cb) => cb(0));
    return { store, track };
  }

  test("(a) transport drag: first Escape closes the legend and keeps the drag, second aborts it", () => {
    const { store, track } = dragging();
    const moved = store.get().window;
    expect(moved).not.toEqual(w0);
    openLegend({ opener });
    const first = key(document.activeElement!, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(store.get().window).toEqual(moved);
    expect(isEscapeClaimed(first)).toBe(true);
    key(track, "Escape");
    expect(store.get().window).toEqual(w0);
  });

  const toolbar = () =>
    createToolbar({ selectRepo: vi.fn(), setTab: vi.fn(), fit: vi.fn(), all: vi.fn(), search: () => [], pick: vi.fn(), register: vi.fn(async () => {}), refresh: vi.fn() });

  test("(b) More menu: first Escape closes the legend and keeps the menu, second closes the menu", () => {
    const tb = toolbar();
    document.body.append(tb.root);
    const menu = tb.root.querySelector<HTMLElement>(".graph-menu")!;
    tb.root.querySelector<HTMLButtonElement>(".graph-more-button")!.click();
    expect(menu.hidden).toBe(false);
    openLegend({ opener });
    key(document.activeElement!, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(menu.hidden).toBe(false);
    key(document.body, "Escape");
    expect(menu.hidden).toBe(true);
    tb.dispose();
  });

  test("(b2) legend opened before the menu: the menu still yields", () => {
    const tb = toolbar();
    document.body.append(tb.root);
    const menu = tb.root.querySelector<HTMLElement>(".graph-menu")!;
    openLegend({ opener });
    tb.root.querySelector<HTMLButtonElement>(".graph-more-button")!.click();
    key(document.body, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(menu.hidden).toBe(false);
    tb.dispose();
  });

  test("(c) activity map drag: first Escape closes the legend and keeps the brush, second abandons it", async () => {
    const WIDTH = 1000;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: WIDTH, height: 72, right: WIDTH, bottom: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const real = activityFixture as ActivityResponse;
    const host: ActivityHost = { onWindow: vi.fn(), onPickWorktree: vi.fn(), now: () => NOW };
    const map = createActivityMap(host);
    document.body.append(map.root);
    map.update("repo-1", [{ id: "w1", name: "main" }], "balanced", { window: "live" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const strip = map.root.querySelector<SVGSVGElement>(".map-strip")!;
    const at = (b: number) => ({ clientX: (b + 0.5) * (WIDTH / real.buckets), clientY: 10, bubbles: true, pointerId: 1 });
    strip.dispatchEvent(new PointerEvent("pointerdown", at(20)));
    window.dispatchEvent(new PointerEvent("pointermove", at(30)));
    const bars = () => map.root.querySelectorAll(".map-bar.in").length;
    expect(bars()).toBeGreaterThan(0);
    openLegend({ opener });
    key(document.activeElement!, "Escape");
    expect(dialogs()).toHaveLength(0);
    expect(bars()).toBeGreaterThan(0);
    const second = key(document.body, "Escape");
    expect(bars()).toBe(0);
    expect(second.defaultPrevented).toBe(true);
  });

  test("with the legend closed the transport claimer behaves as before", () => {
    const { store, track } = dragging();
    const e = key(track, "Escape");
    expect(isEscapeClaimed(e)).toBe(true);
    expect(store.get().window).toEqual(w0);
  });
});

describe("panel context", () => {
  const has = (set: ReadonlySet<string>, ...v: string[]) => v.forEach((x) => expect(set.has(x), x).toBe(true));
  const lacks = (set: ReadonlySet<string>, ...v: string[]) => v.forEach((x) => expect(set.has(x), x).toBe(false));

  test("localScopesFor maps each panel and encoding to real LOCAL scopes", () => {
    const all = new Set(LOCAL_KEYS.map((k) => k.scope));
    const fleet = localScopesFor({ panel: "fleet", encoding: "map" });
    has(fleet, "fleet", "time window", "rows and cards");
    lacks(fleet, "graph canvas");
    const graph = localScopesFor({ panel: "project", encoding: "graph" });
    has(graph, "graph canvas", "graph search", "graph menu", "graph inspector", "time window", "project views");
    has(localScopesFor({ panel: "project", encoding: "lanes" }), "project lanes", "rows and cards", "project views", "time window");
    has(localScopesFor({ panel: "project", encoding: "map" }), "activity map", "activity strip");
    const ev = localScopesFor({ panel: "project", encoding: "events" });
    has(ev, "project views", "graph search");
    has(localScopesFor({ panel: "fleet", encoding: "events" }), "events", "live feed");
    lacks(localScopesFor({ panel: "fleet", encoding: "events" }), "fleet", "rows and cards");
    has(localScopesFor({ panel: "sessions" }), "rows and cards");
    has(localScopesFor({ panel: "session" }), "session tabs", "score", "score track", "time window");
    for (const p of ["files", "doctor", "settings"]) expect(localScopesFor({ panel: p }).size).toBe(0);
    for (const c of [fleet, graph, ev]) for (const sc of c) expect(all.has(sc), sc).toBe(true);
  });

  test("session context lists score keys and not zoom; project graph is the reverse", () => {
    openLegend({ opener, context: { panel: "session" } });
    expect(section("This panel").textContent).toContain("previous / next event");
    expect(section("This panel").textContent).not.toContain("zoom in / out");
    toggleLegend();
    openLegend({ opener, context: { panel: "project", encoding: "graph" } });
    expect(section("This panel").textContent).toContain("zoom in / out");
    expect(section("This panel").textContent).not.toContain("previous / next event");
  });

  test("Elsewhere is a collapsed details holding out-of-panel rows with scope names", () => {
    openLegend({ opener, context: { panel: "session" } });
    const d = [...dlg().querySelectorAll("details")].find((x) => x.querySelector("summary")?.textContent === "Elsewhere")!;
    expect(d).toBeTruthy();
    expect(d.hasAttribute("open")).toBe(false);
    expect(d.textContent).toContain("zoom in / out");
    expect(d.textContent).toContain("(graph canvas)");
    expect(text()).not.toContain("Also on the keyboard");
  });

  test("non-Score session tabs do not advertise Score controls", () => {
    for (const tab of ["loops", "loom", "replay", "handoffs", "court"]) {
      expect(localScopesFor({ panel: "session", tab }).has("score")).toBe(false);
      expect(spaceNotes({ panel: "session", tab }).join(" ")).not.toContain("score: Space");
    }
    expect(localScopesFor({ panel: "session", tab: "score" }).has("score")).toBe(true);
  });

  test("This panel is never an empty list", () => {
    openLegend({ opener, context: { panel: "doctor" } });
    const s = section("This panel");
    expect(s.querySelector("li")).toBeNull();
    expect(s.querySelector("p.dim")?.textContent).toBe("No panel-specific keys");
  });

  test("registered rows are filtered by context too", () => {
    unreg.push(registerKeys([{ scope: "fleet", keys: ["x"], display: "x-display", label: "fleet thing", handler: () => void 0 }]));
    openLegend({ opener, context: { panel: "session" } });
    expect(section("This panel").textContent).not.toContain("fleet thing");
  });

  test("Space notes are filtered by context", () => {
    const doctor = spaceNotes({ panel: "doctor" }).join(" ");
    expect(doctor).not.toContain("score: Space");
    expect(doctor).not.toContain("activity map");
    expect(spaceNotes({ panel: "session" }).join(" ")).toContain("score: Space play or pause");
    expect(spaceNotes().join(" ")).toContain("score: Space play or pause");
    openLegend({ opener, context: () => ({ panel: "doctor" }) });
    expect(section("Space").textContent).not.toContain("Score playback");
  });

  test("without a context registered non-global rows are This panel, all locals Elsewhere", () => {
    unreg.push(registerKeys([
      { scope: "fleet", keys: ["x"], display: "x-display", label: "fleet thing", handler: () => void 0 },
      { scope: "global", keys: ["z"], display: "z-display", label: "global thing", handler: () => void 0 },
    ]));
    openLegend({ opener });
    expect(section("This panel").textContent).toContain("fleet thing");
    expect(section("Everywhere").textContent).toContain("global thing");
    const d = dlg().querySelector("details")!;
    for (const k of LOCAL_KEYS) expect(d.textContent).toContain(k.label);
  });
});

describe("Space note for the Fleet Events host", () => {
  test("the events-scope Space binding is noted on Fleet Events only", () => {
    const un = registerKeys([{ scope: "events", keys: [" "], display: "Space", label: "pause or resume the feed", handler: () => false }]);
    expect(spaceNotes({ panel: "fleet", encoding: "events" }).join("\n")).toContain("events: Space pause or resume the feed.");
    expect(spaceNotes({ panel: "fleet", encoding: "map" }).join("\n")).not.toContain("pause or resume the feed");
    un();
  });
});
