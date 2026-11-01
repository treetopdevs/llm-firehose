import { describe, expect, test, vi } from "vitest";
import { createSessionDirectory } from "./session-directory";
import { sessionRefLabel } from "./format";
import type { SessionLike } from "./format";

const A = "2385e3bc-aaaa-bbbb-cccc-111122223333";
const s = (over: Partial<SessionLike> = {}): SessionLike => ({ id: A, source: "codex", agent: "codex", title: "Fix login bug", ...over });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("session directory", () => {
  test("remember and lookup by source; id-only when exactly one source holds the id", () => {
    const d = createSessionDirectory();
    d.remember([s()]);
    expect(d.lookup({ id: A, source: "codex" })?.title).toBe("Fix login bug");
    expect(d.lookup({ id: A })?.title).toBe("Fix login bug");
    expect(d.lookup({ id: A, source: "claude-code" })).toBeUndefined();
  });

  test("an ambiguous id-only lookup is undefined and the label is unresolved", () => {
    const d = createSessionDirectory();
    d.remember([s(), s({ source: "claude-code", title: "Other" })]);
    expect(d.lookup({ id: A })).toBeUndefined();
    expect(d.lookup({ id: A, source: "claude-code" })?.title).toBe("Other");
    expect(sessionRefLabel({ id: A }, d.lookup({ id: A }))).toEqual({ label: "2385e3bc", resolved: false });
  });

  test("subscribers are told once about changed data and not about identical data", () => {
    const d = createSessionDirectory();
    const fn = vi.fn();
    d.subscribe(fn);
    d.remember([s()]);
    expect(fn).toHaveBeenCalledTimes(1);
    d.remember([s()]);
    expect(fn).toHaveBeenCalledTimes(1);
    d.remember([s({ title: "New" }), s({ id: "b", title: "B" })]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("an entry without first_time neither notifies nor erases the one that had it", () => {
    const d = createSessionDirectory();
    d.remember([s({ first_time: "2026-11-01T00:00:00Z" })]);
    const fn = vi.fn();
    d.subscribe(fn);
    d.remember([s()]);
    d.remember([s({ first_time: "2026-11-01T00:00:00Z" })]);
    expect(fn).not.toHaveBeenCalled();
    d.remember([s()]);
    expect(d.lookup({ id: A, source: "codex" })?.first_time).toBe("2026-11-01T00:00:00Z");
  });

  test("unsubscribe stops notifications", () => {
    const d = createSessionDirectory();
    const fn = vi.fn();
    const off = d.subscribe(fn);
    off();
    d.remember([s()]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("ensure loads once, not while in flight, not within 10s, and not when resolvable", async () => {
    let t = 1000;
    const first = deferred<SessionLike[]>();
    const loader = vi.fn(() => first.promise);
    const d = createSessionDirectory(loader, () => t);
    d.ensure({ id: "x", source: "codex" });
    d.ensure({ id: "x", source: "codex" });
    expect(loader).toHaveBeenCalledTimes(1);
    first.resolve([]);
    await flush();
    t += 9_000;
    d.ensure({ id: "x", source: "codex" });
    expect(loader).toHaveBeenCalledTimes(1);
    t += 2_000;
    d.ensure({ id: "x", source: "codex" });
    expect(loader).toHaveBeenCalledTimes(2);
    d.remember([s()]);
    t += 60_000;
    d.ensure({ id: A, source: "codex" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test("a rejecting loader is swallowed", async () => {
    const d = createSessionDirectory(() => Promise.reject(new Error("down")), () => 0);
    expect(() => d.ensure({ id: "x" })).not.toThrow();
    await flush();
    expect(d.lookup({ id: "x" })).toBeUndefined();
  });

  test("ORDERING: a load that began before a remember never overwrites it, but still adds absent entries", async () => {
    const gate = deferred<SessionLike[]>();
    const d = createSessionDirectory(() => gate.promise, () => 0);
    d.remember([s({ title: "Old" })]);
    d.ensure({ id: "missing", source: "codex" });
    d.remember([s({ title: "Newer" })]);
    gate.resolve([s({ title: "Old" }), s({ id: "missing", title: "Added" })]);
    await flush();
    expect(d.lookup({ id: A, source: "codex" })?.title).toBe("Newer");
    expect(d.lookup({ id: "missing", source: "codex" })?.title).toBe("Added");
  });

  test("a load fills an entry that no remember touched", async () => {
    const gate = deferred<SessionLike[]>();
    const d = createSessionDirectory(() => gate.promise, () => 0);
    const fn = vi.fn();
    d.subscribe(fn);
    d.ensure({ id: A, source: "codex" });
    gate.resolve([s()]);
    await flush();
    expect(d.lookup({ id: A, source: "codex" })?.title).toBe("Fix login bug");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
