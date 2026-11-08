// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  doctor: vi.fn(),
  getConfig: vi.fn(),
  exportAll: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { createDoctor } from "./doctor";
import { createSettings } from "./settings";

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("doctor: the h2 exists while checks run and is the same node after refresh", async () => {
  api.doctor.mockResolvedValue([{ name: "n", ok: true, detail: "d" }]);
  const p = createDoctor();
  const pending = p.refresh();
  const h2 = p.root.querySelector("h2");
  expect(h2?.textContent).toBe("Doctor");
  expect(p.root.firstElementChild).toBe(h2);
  await pending; await settle();
  expect(p.root.querySelector("h2")).toBe(h2);
  expect(p.root.querySelectorAll("h2")).toHaveLength(1);
  p.refresh(); await settle();
  expect(p.root.querySelector("h2")).toBe(h2);
});

test("settings: the h2 exists while config loads and is the same node after refresh", async () => {
  api.getConfig.mockResolvedValue({ privacy_mode: "balanced" });
  const p = createSettings();
  const pending = p.refresh();
  const h2 = p.root.querySelector("h2");
  expect(h2?.textContent).toBe("Settings");
  expect(p.root.firstElementChild).toBe(h2);
  await pending; await settle();
  expect(p.root.querySelector("h2")).toBe(h2);
  expect(p.root.querySelectorAll("h2")).toHaveLength(1);
});

test("doctor: a check's explanation does not use the side pane's zero-width class", async () => {
  api.doctor.mockResolvedValue([{ name: "n", ok: false, detail: "run firehose install" }]);
  const p = createDoctor();
  await p.refresh(); await settle();
  const detail = [...p.root.querySelectorAll(".doctor-check span")].find((s) => s.textContent === "run firehose install")!;
  expect(detail.classList.contains("detail")).toBe(false);
});

test("doctor: an unreachable engine reads as a sentence, not an exception", async () => {
  api.doctor.mockRejectedValue(new TypeError("Failed to fetch"));
  const p = createDoctor();
  await p.refresh(); await settle();
  const text = p.root.querySelector(".error")!.textContent!;
  expect(text).toContain("isn't responding");
  expect(text).not.toContain("TypeError");
});
