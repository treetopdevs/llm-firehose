import { describe, expect, test } from "vitest";
import * as ctx from "./context";
import { SESSION_TABS, WINDOW_MODE, activeRange, inWindow, sessionKey, windowLabel } from "./context";
import { formatDuration } from "../../format";

describe("session context helpers", () => {
  test("activeRange: 'live' gives null; a range gives the same range", () => {
    expect(activeRange("live")).toBeNull();
    expect(activeRange({ from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
  });

  test("inWindow: null passes everything; a range is inclusive and rejects unparsable times", () => {
    expect(inWindow("garbage", null)).toBe(true);
    expect(inWindow("2026-10-15T19:32:30.000Z", null)).toBe(true);
    const t0 = Date.parse("2026-10-15T19:32:30.000Z");
    const t1 = t0 + 1000;
    const r = { from: t0, to: t1 };
    expect(inWindow(new Date(t0).toISOString(), r)).toBe(true);
    expect(inWindow(new Date(t1).toISOString(), r)).toBe(true);
    expect(inWindow(new Date(t1 + 1).toISOString(), r)).toBe(false);
    expect(inWindow("garbage", r)).toBe(false);
  });

  test("windowLabel: 'live' is the whole session; a range shows its span and duration", () => {
    expect(windowLabel("live")).toBe("whole session");
    const label = windowLabel({ from: 1_000_000, to: 1_090_000 });
    expect(label).toContain(" → ");
    expect(label).toContain(formatDuration(90_000));
  });

  test("sessionKey separates source and is stable for equal refs", () => {
    expect(sessionKey({ id: "a", source: "codex" })).toBe(sessionKey({ id: "a", source: "codex" }));
    expect(sessionKey({ id: "a", source: "codex" })).not.toBe(sessionKey({ id: "a" }));
    expect(sessionKey({ id: "a" })).toBe("a\u0000");
    expect(sessionKey({ id: "a", source: "x" })).not.toBe(sessionKey({ id: "a", source: "y" }));
  });

  test("there is no effectiveWindow; tabs and window modes are declared", () => {
    expect("effectiveWindow" in ctx).toBe(false);
    expect(SESSION_TABS).toEqual(["score", "loops", "loom", "replay", "handoffs", "court"]);
    expect(WINDOW_MODE.score).toBe("transport");
    expect(WINDOW_MODE.court).toBe("none");
  });
});
