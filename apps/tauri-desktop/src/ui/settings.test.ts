// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  exportNDJSON: vi.fn(),
}));
vi.mock("../api", () => ({ ...api, DAEMON_URL: "http://127.0.0.1:4599" }));
import { createSettings } from "./settings";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const pick = (root: HTMLElement, mode: string) => {
  const input = root.querySelector<HTMLInputElement>(`#mode-${mode}`)!;
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  api.getConfig.mockReset().mockResolvedValue({ privacy_mode: "balanced", daemon_addr: "127.0.0.1:4517" });
  api.setConfig.mockReset();
});

test("onPrivacyChanged fires once after a successful setConfig", async () => {
  api.setConfig.mockResolvedValue({ restart_required: [] });
  const onPrivacyChanged = vi.fn();
  const s = createSettings({ onPrivacyChanged });
  await s.refresh();
  pick(s.root, "full");
  await flush();
  expect(api.setConfig).toHaveBeenCalledWith({ privacy_mode: "full" });
  expect(onPrivacyChanged).toHaveBeenCalledTimes(1);
  expect(onPrivacyChanged).toHaveBeenCalledWith("full");
});

test("onPrivacyChanged never fires when setConfig fails", async () => {
  api.setConfig.mockRejectedValue(new Error("nope"));
  const onPrivacyChanged = vi.fn();
  const s = createSettings({ onPrivacyChanged });
  await s.refresh();
  pick(s.root, "minimal");
  await flush();
  expect(onPrivacyChanged).not.toHaveBeenCalled();
  expect(s.root.textContent).toContain("nope");
});

test("a throwing onPrivacySaving does not block the save", async () => {
  api.setConfig.mockResolvedValue({ restart_required: [] });
  const onPrivacyChanged = vi.fn();
  const s = createSettings({ onPrivacySaving: () => { throw new Error("boom"); }, onPrivacyChanged });
  await s.refresh();
  pick(s.root, "full");
  await flush();
  expect(api.setConfig).toHaveBeenCalledWith({ privacy_mode: "full" });
  expect(s.root.textContent).toContain("privacy mode is now full");
  expect(onPrivacyChanged).toHaveBeenCalledWith("full", undefined);
});

test("a throwing onPrivacyChanged does not break the saved status", async () => {
  api.setConfig.mockResolvedValue({ restart_required: [] });
  const s = createSettings({ onPrivacyChanged: () => { throw new Error("boom"); } });
  await s.refresh();
  pick(s.root, "full");
  await flush();
  expect(s.root.textContent).toContain("privacy mode is now full");
});

test("daemon address row shows the host the app actually talks to", async () => {
  const s = createSettings();
  await s.refresh();
  const dts = [...s.root.querySelectorAll("dt")].map((d) => d.textContent);
  expect(dts).toContain("daemon address");
  const dd = (label: string) => [...s.root.querySelectorAll("dt")].find((d) => d.textContent === label)?.nextElementSibling?.textContent;
  expect(dd("daemon address")).toBe("127.0.0.1:4599");
  expect(dts).toContain("configured address");
  expect(dd("configured address")).toBe("127.0.0.1:4517");
});

test("no configured address row when the config matches", async () => {
  api.getConfig.mockResolvedValue({ privacy_mode: "balanced", daemon_addr: "127.0.0.1:4599" });
  const s = createSettings();
  await s.refresh();
  const dts = [...s.root.querySelectorAll("dt")].map((d) => d.textContent);
  expect(dts).toContain("daemon address");
  expect(dts).not.toContain("configured address");
});
