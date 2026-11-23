// @vitest-environment happy-dom
import { describe, expect, test, beforeEach } from "vitest";
import { createSidebar, createToolbar } from "./chrome";
import { el } from "./dom";
import { applyWindowChrome, macOverlayActive } from "./window";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";
const tauri = { __TAURI_INTERNALS__: {} };

describe("macOverlayActive", () => {
  test("only inside the Tauri shell on macOS", () => {
    expect(macOverlayActive(tauri, MAC)).toBe(true);
  });
  test("a browser on a Mac keeps no inset", () => {
    expect(macOverlayActive({}, MAC)).toBe(false);
  });
  test("Linux and Windows shells keep the standard title bar", () => {
    expect(macOverlayActive(tauri, LINUX)).toBe(false);
    expect(macOverlayActive(tauri, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2")).toBe(false);
  });
  test("defaults to off when nothing is known", () => {
    expect(macOverlayActive(undefined, undefined)).toBe(false);
    expect(macOverlayActive(tauri, "")).toBe(false);
  });
});

describe("applyWindowChrome", () => {
  let shell: HTMLElement, tb: ReturnType<typeof createToolbar>, sb: ReturnType<typeof createSidebar>;
  beforeEach(() => {
    document.body.replaceChildren();
    tb = createToolbar({ onBack() {}, onForward() {}, onToggleSidebar() {} });
    sb = createSidebar({ onSelect() {}, onLegend() {} });
    shell = document.createElement("div");
    shell.append(sb.root, tb.root);
    document.body.append(shell);
  });

  test("off: no attribute, no drag regions", () => {
    applyWindowChrome(shell, tb.root, sb.root, false);
    expect(shell.hasAttribute("data-titlebar")).toBe(false);
    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull();
  });

  test("on: the toolbar and sidebar header are drag regions, controls are not", () => {
    applyWindowChrome(shell, tb.root, sb.root, true);
    expect(shell.dataset.titlebar).toBe("overlay");
    expect(tb.root.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(tb.root.querySelector(".toolbar-title")!.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(sb.root.hasAttribute("data-tauri-drag-region")).toBe(true);
    for (const el of document.querySelectorAll("[data-tauri-drag-region]")) {
      expect(el.matches("button, a, input, select, textarea, [role=button], [role=tab], [tabindex]")).toBe(false);
    }
    expect(tb.root.querySelector(".toolbar-back")!.closest("button")!.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  test("a populated breadcrumb is dragged through its descendants (they do not take the mouse)", () => {
    applyWindowChrome(shell, tb.root, sb.root, true);
    const crumb = el("span", { class: "scope-crumb dim" }, el("span", { class: "crumb" }, el("span", {}, "project"), el("span", {}, "session")));
    tb.crumbSlot.append(crumb);
    const css = read("src/styles.css");
    // Tauri marks only the element carrying the attribute, so the segments must be transparent to the pointer.
    expect(tb.crumbSlot.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(crumb.querySelector("button, a, [tabindex], [role=button]")).toBeNull();
    expect(css).toMatch(/\.shell\[data-titlebar="overlay"\] \.toolbar-crumb \*\s*\{[^}]*pointer-events:\s*none/);
  });

  test("turning it off again removes everything", () => {
    applyWindowChrome(shell, tb.root, sb.root, true);
    applyWindowChrome(shell, tb.root, sb.root, false);
    expect(shell.hasAttribute("data-titlebar")).toBe(false);
    expect(document.querySelector("[data-tauri-drag-region]")).toBeNull();
  });
});

describe("overlay stylesheet and config", () => {
  const css = read("src/styles.css");
  test("insets exist only under data-titlebar=overlay", () => {
    expect(css).toMatch(/\.shell\[data-titlebar="overlay"\][^{]*\.sidebar[^{]*\{[^}]*padding-top/);
    expect(css).toMatch(/\.shell\[data-titlebar="overlay"\]\[data-sidebar-visible="false"\] \.toolbar[^{]*\{[^}]*padding-left/);
    expect(css).not.toMatch(/^\.toolbar\s*\{[^}]*80px/m);
  });
  test("the macOS config carries the overlay and the capability allows dragging", () => {
    const mac = JSON.parse(read("src-tauri/tauri.macos.conf.json"));
    const w = mac.app.windows[0];
    expect(w.titleBarStyle).toBe("Overlay");
    expect(w.hiddenTitle).toBe(true);
    // Platform window arrays replace the base entry: the base fields must be repeated.
    const base = JSON.parse(read("src-tauri/tauri.conf.json")).app.windows[0];
    for (const k of Object.keys(base)) expect(w[k]).toEqual(base[k]);
    expect(base.titleBarStyle).toBeUndefined();
    const cap = JSON.parse(read("src-tauri/capabilities/default.json"));
    expect(cap.permissions).toContain("core:window:allow-start-dragging");
  });
});
