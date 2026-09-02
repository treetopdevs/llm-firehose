import { describe, expect, test } from "vitest";
import { formatClock, formatDuration, formatValue, severityClass, shortPath, summaryLine, workspaceLabel } from "./format";
import type { FirehoseEvent } from "./api";

describe("formatClock", () => {
  test("renders local HH:MM:SS from RFC3339", () => {
    const out = formatClock("2026-07-02T10:04:12Z");
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("tolerates garbage", () => {
    expect(formatClock("not a time")).toBe("--:--:--");
  });
});

describe("severityClass", () => {
  test("maps severities to css classes, defaulting to info", () => {
    expect(severityClass("error")).toBe("sev-error");
    expect(severityClass("warn")).toBe("sev-warn");
    expect(severityClass(undefined)).toBe("sev-info");
  });
});

describe("shortPath", () => {
  test("keeps the last two segments", () => {
    expect(shortPath("/Users/me/dev/app")).toBe("…/dev/app");
  });
  test("recognizes backslash separators", () => {
    expect(shortPath("C:\\Users\\me\\dev\\app")).toBe("…/dev/app");
  });
  test("short paths pass through", () => {
    expect(shortPath("/app")).toBe("/app");
    expect(shortPath("")).toBe("");
  });
});

describe("summaryLine", () => {
  test("prefers summary, falls back to name then category", () => {
    const base = { id: "1", time: "2026-07-02T10:00:00Z", source: "codex", category: "tool" } as FirehoseEvent;
    expect(summaryLine({ ...base, summary: "ran: make" })).toBe("ran: make");
    expect(summaryLine({ ...base, name: "exec" })).toBe("exec");
    expect(summaryLine(base)).toBe("tool");
  });
});

describe("workspaceLabel", () => {
  test("prefers the repo, shortens a path, and shows eight digits of a digest", () => {
    expect(workspaceLabel("llm-firehose", "/x/y/z")).toBe("llm-firehose");
    expect(workspaceLabel(undefined, "/home/me/dev/app")).toBe("…/dev/app");
    expect(workspaceLabel("", "aa43f1ff4abc3b9ab1e0a477140f68ea761e0384110aa530c6de08642f762655")).toBe("aa43f1ff");
    expect(workspaceLabel(undefined, undefined)).toBe("");
  });
});

describe("formatDuration", () => {
  test("uses one resolution per magnitude", () => {
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(2590)).toBe("2.59s");
    expect(formatDuration(75_000)).toBe("1m15s");
    expect(formatDuration(3_720_000)).toBe("1h02m");
    expect(formatDuration(-42)).toBe("42ms");
  });
});

describe("formatValue", () => {
  test("renders one line per value and reads privacy digests as a hash and a length", () => {
    expect(formatValue("go test")).toBe("go test");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(true)).toBe("true");
    expect(formatValue(null)).toBe("null");
    expect(formatValue({ sha256: "abcdef0123456789", len: 512 })).toBe("#abcdef01 · len 512");
    expect(formatValue({ a: [1, "x"] })).toBe('{"a":[1,"x"]}');
  });
});
