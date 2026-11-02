// @vitest-environment happy-dom
// Fleet hosting the real Patches (ecosystem) panel: leaving the encoding mid-playback stops its timer.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FirehoseEvent } from "../../api";
import fixture from "../score/fixture.session.json";
import { __resetKeysForTests } from "../../keys";
import { createScope } from "../../scope";

const api = vi.hoisted(() => ({ attention: vi.fn(), sessionEvents: vi.fn(), capturedEvent: vi.fn(), ApiError: class extends Error {} }));
vi.mock("../../api", () => api);
import { createFleet } from "./index";
import { createEcosystem } from "../ecosystem";

const event = (fixture as FirehoseEvent[]).find((e) => e.category === "file" && typeof e.payload?.file_path === "string")!;
const click = (root: HTMLElement, text: string) => { const b = [...root.querySelectorAll("button")].find((x) => x.textContent === text); expect(b, text).toBeTruthy(); b!.click(); };
const input = (root: HTMLElement, label: string, value: string) => { const f = root.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; f.value = value; f.dispatchEvent(new Event("input")); };
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  __resetKeysForTests();
  vi.resetAllMocks();
  api.attention.mockResolvedValue({ sessions: [{ source: event.source, id: event.session_id }], warnings: [] });
  api.sessionEvents.mockResolvedValue(Array.from({ length: 3 }, (_, i) => ({ ...event, id: `e-${i}` })));
  vi.useFakeTimers();
});
afterEach(() => {
  __resetKeysForTests();
  document.body.replaceChildren();
  vi.useRealTimers();
});

test.each(["map", "dwell"])("leaving Patches to %s during playback leaves no timer running", async (dest) => {
  const eco = createEcosystem();
  const refresh = vi.spyOn(eco, "refresh");
  const fleet = createFleet({
    store: createScope(), go: vi.fn() as never, events: () => [],
    api: { worktrees: async () => [], attention: async () => ({ sessions: [], warnings: [] }), sessions: async () => [] },
    hosts: { ecosystem: { root: eco.root, activate: () => eco.refresh(), deactivate: () => eco.deactivate() } },
  });
  document.body.append(fleet.root);
  await fleet.activate();
  fleet.root.querySelector<HTMLElement>(".fleet-enc[data-enc='ecosystem']")!.click();
  await settle();
  expect(refresh).toHaveBeenCalledTimes(1);
  input(eco.root, "Source", event.source);
  input(eco.root, "Session ID", event.session_id!);
  click(eco.root, "Load file history");
  await settle();
  click(eco.root, "Beginning");
  click(eco.root, "Play");
  const during = vi.getTimerCount();
  fleet.root.querySelector<HTMLElement>(`.fleet-enc[data-enc='${dest}']`)!.click();
  expect(vi.getTimerCount()).toBeLessThan(during);
  vi.advanceTimersByTime(1000);
  expect(eco.root.isConnected).toBe(false);
  expect(eco.root.textContent).not.toContain("3 of 3 dated");
  fleet.deactivate();
  expect(vi.getTimerCount()).toBe(0);
});
