// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { replaySoundSetting } from "./sound-setting";

afterEach(() => {
  replaySoundSetting.reset();
  vi.unstubAllGlobals();
});

test("off by default; set and subscribe; setting the same value notifies nobody", () => {
  const fn = vi.fn();
  const off = replaySoundSetting.subscribe(fn);
  expect(replaySoundSetting.get()).toBe(false);
  replaySoundSetting.set(true);
  expect(replaySoundSetting.get()).toBe(true);
  replaySoundSetting.set(true);
  expect(fn).toHaveBeenCalledTimes(1);
  off();
  replaySoundSetting.set(false);
  expect(fn).toHaveBeenCalledTimes(1);
});

test("the choice is kept on this device, and a blocked store only means it is not kept", () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  replaySoundSetting.set(true);
  expect(store.get("firehose-replay-sound")).toBe("1");
  replaySoundSetting.reload();
  expect(replaySoundSetting.get()).toBe(true);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(() => replaySoundSetting.set(false)).not.toThrow();
  expect(replaySoundSetting.get()).toBe(false);
});

test("the last audio state is shared so Settings can say when sound is unavailable", () => {
  const fn = vi.fn();
  replaySoundSetting.subscribe(fn);
  expect(replaySoundSetting.state()).toBe("off");
  replaySoundSetting.report("unavailable");
  expect(replaySoundSetting.state()).toBe("unavailable");
  expect(fn).toHaveBeenCalledTimes(1);
});
