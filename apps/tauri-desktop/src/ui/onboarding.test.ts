// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ doctor: vi.fn(), setConfig: vi.fn() }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { __resetKeysForTests, registerKeys } from "../keys";
import { isEscapeClaimed } from "../escape";
import { createOnboarding, isOnboarded } from "./onboarding";
import { PRIVACY_MODES } from "./settings";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const button = (o: HTMLElement, text: string) => [...o.querySelectorAll("button")].find((b) => b.textContent === text)!;
const radio = (o: HTMLElement, mode: string) => o.querySelector<HTMLInputElement>(`input[type=radio][value="${mode}"]`)!;
const stops = (o: HTMLElement) => [...o.querySelectorAll<HTMLElement>("input:checked, button")];

let overlay: HTMLElement;
const onDone = vi.fn();
beforeEach(() => {
  __resetKeysForTests();
  localStorage.clear();
  api.setConfig.mockReset().mockResolvedValue({ restart_required: [] });
  api.doctor.mockReset().mockResolvedValue([{ name: "spool", ok: false, detail: "spool is read-only" }]);
  onDone.mockReset();
  overlay = createOnboarding(onDone);
  document.body.append(overlay);
});
afterEach(() => {
  overlay.remove();
  document.body.replaceChildren();
  __resetKeysForTests();
});

test("is a labelled modal dialog with focus inside it", async () => {
  await settle();
  const d = overlay.querySelector('[role="dialog"]')!;
  expect(d.getAttribute("aria-modal")).toBe("true");
  expect(d.getAttribute("aria-label")).toBeTruthy();
  expect(d.contains(document.activeElement)).toBe(true);
});

test("every privacy mode explains what it captures", () => {
  for (const { mode, blurb } of PRIVACY_MODES) {
    expect(radio(overlay, mode).closest("label")!.textContent).toContain(blurb);
  }
});

test("each privacy mode sits on its own line", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  expect(css).toMatch(/\.onboarding-card \.mode-option\s*\{[^}]*display:\s*block/);
});

test("choosing a mode saves nothing until Continue; balanced is the starting choice", async () => {
  expect(radio(overlay, "balanced").checked).toBe(true);
  radio(overlay, "full").checked = true;
  radio(overlay, "full").dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(api.setConfig).not.toHaveBeenCalled();
  button(overlay, "Continue").click();
  await settle();
  expect(api.setConfig).toHaveBeenCalledWith({ privacy_mode: "full" });
  expect(overlay.textContent).toContain("2 / 3");
});

test("a failed save stays on the step and reads as a sentence", async () => {
  api.setConfig.mockRejectedValue(new TypeError("Failed to fetch"));
  button(overlay, "Continue").click();
  await settle();
  expect(overlay.textContent).toContain("1 / 3");
  expect(overlay.textContent).toContain("isn't responding");
  expect(overlay.textContent).not.toContain("TypeError");
  expect(button(overlay, "Continue").disabled).toBe(false);
});

test("the adapter step can go back to the privacy choice", async () => {
  button(overlay, "Continue").click();
  await settle();
  button(overlay, "back").click();
  expect(overlay.textContent).toContain("1 / 3");
  expect(overlay.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
});

test("Tab and Shift+Tab wrap inside the dialog", () => {
  const all = stops(overlay);
  all[all.length - 1].focus();
  expect(key(document.activeElement!, "Tab").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(all[0]);
  expect(key(document.activeElement!, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(all[all.length - 1]);
});

test("app shortcuts and Escape do not act behind the dialog", async () => {
  await settle();
  const behind = vi.fn(() => true);
  registerKeys([{ scope: "global", keys: ["n"], display: "n", label: "behind", handler: behind }]);
  key(document.activeElement!, "n");
  expect(behind).not.toHaveBeenCalled();
  expect(isEscapeClaimed(key(document.activeElement!, "Escape"))).toBe(true);
  expect(document.body.contains(overlay)).toBe(true);
});

test("an overlay removed from the page stops claiming the keyboard", () => {
  overlay.remove();
  expect(isEscapeClaimed(key(document.body, "Escape"))).toBe(false);
});

test("finishing shows the check's explanation, releases the keyboard and records completion", async () => {
  button(overlay, "Continue").click();
  await settle();
  button(overlay, "next").click();
  await settle();
  const detail = [...overlay.querySelectorAll(".doctor-check span")].find((s) => s.textContent === "spool is read-only")!;
  expect(detail.classList.contains("detail")).toBe(false);
  button(overlay, "start watching").click();
  expect(isOnboarded()).toBe(true);
  expect(onDone).toHaveBeenCalledOnce();
  expect(document.body.contains(overlay)).toBe(false);
  expect(isEscapeClaimed(key(document.body, "Escape"))).toBe(false);
});
