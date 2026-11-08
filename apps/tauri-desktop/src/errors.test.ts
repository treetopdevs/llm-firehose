import { describe, expect, test } from "vitest";
import { ApiError } from "./api";
import { failureMessage } from "./errors";

describe("failureMessage", () => {
  test.each([["Failed to fetch"], ["Load failed"], ["NetworkError when attempting to fetch resource."]])(
    "%s (a browser's unreachable-host wording) says what happened and what comes next",
    (raw) => {
      const text = failureMessage("load sessions", new TypeError(raw));
      expect(text).toContain("Couldn't load sessions");
      expect(text).toContain("isn't responding");
      expect(text).toContain("LIVE");
      expect(text).not.toContain(raw);
    },
  );
  test("a TypeError from our own code is not blamed on the engine", () => {
    const text = failureMessage("load sessions", new TypeError("x is not a function"));
    expect(text).not.toContain("isn't responding");
    expect(text).toContain("x is not a function");
    expect(text).not.toContain("TypeError:");
  });
  test("an engine refusal keeps its status and body as evidence", () => {
    expect(failureMessage("save settings", new ApiError("/config", 400, "bad mode\n"))).toBe("Couldn't save settings: the engine answered 400 (bad mode).");
  });
  test("a refusal with no body, and a thrown string, still read as sentences", () => {
    expect(failureMessage("save settings", new ApiError("/config", 500, ""))).toBe("Couldn't save settings: the engine answered 500.");
    expect(failureMessage("export", "disk full")).toBe("Couldn't export: disk full.");
  });
});
