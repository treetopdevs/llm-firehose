import { describe, expect, test } from "vitest";
import type { AttentionEvidence, AttentionSession } from "./api";
import { needYouCount, needsLabel, stateWord } from "./needs";
import { sessionStateWord } from "./ui/graph/names";
import { buildDwell } from "./ui/dwell/model";

const now = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

function ev(at: number, kind = "activity"): AttentionEvidence {
  return { event_id: `e-${at}`, source: "claude-code", kind, summary: "x", time: ago(at), observed_at: ago(at) };
}
function session(over: Partial<AttentionSession> & { id: string }): AttentionSession {
  return { source: "claude-code", agent: "claude", cwd: "/home/me/app", events: 1, state: "working", last: ev(60_000), ...over };
}

const DAY = 24 * 3_600_000;

describe("stateWord", () => {
  test("needs_input reads 'needs you', failed stays, others unchanged", () => {
    expect(stateWord("needs_input")).toBe("needs you");
    expect(stateWord("failed")).toBe("failed");
    for (const s of ["working", "idle", "unknown", "done"]) expect(stateWord(s)).toBe(s);
  });
  test("never contains an underscore for the known states", () => {
    for (const s of ["needs_input", "failed", "working", "idle"]) expect(stateWord(s)).not.toContain("_");
  });
});

describe("needsLabel", () => {
  test("a fresh pending request reads 'needs you'", () => {
    const s = session({ id: "a", state: "needs_input", pending: ev(60_000, "request") });
    expect(needsLabel(s, now)).toBe("needs you");
  });
  test("a fresh failure reads 'failed'", () => {
    const s = session({ id: "a", state: "failed", pending: ev(60_000, "failure") });
    expect(needsLabel(s, now)).toBe("failed");
  });
  test("a STALE pending needs_input still reads 'needs you', never 'needs_input'", () => {
    const s = session({ id: "a", state: "needs_input", last: ev(3 * DAY), pending: ev(3 * DAY, "request") });
    expect(needsLabel(s, now)).toBe("needs you");
  });
  test("a stale failed session reads 'failed'", () => {
    expect(needsLabel(session({ id: "a", state: "failed", last: ev(3 * DAY) }), now)).toBe("failed");
  });
});

describe("needYouCount", () => {
  test("singular and plural", () => {
    expect(needYouCount(1)).toBe("1 needs you");
    expect(needYouCount(2)).toBe("2 need you");
    expect(needYouCount(0)).toBe("0 need you");
  });
});

describe("cross-surface agreement", () => {
  const cases: [string, AttentionSession][] = [
    ["fresh pending", session({ id: "a", state: "needs_input", pending: ev(60_000, "request") })],
    ["fresh failure", session({ id: "b", state: "failed", pending: ev(60_000, "failure") })],
    ["stale pending", session({ id: "c", state: "needs_input", last: ev(3 * DAY), pending: ev(3 * DAY, "request") })],
  ];
  test.each(cases)("%s: graph word, label and dwell status agree", (_n, s) => {
    const word = needsLabel(s, now);
    expect(sessionStateWord(s, now).toLowerCase()).toBe(word);
    expect(sessionStateWord(s, now)).not.toMatch(/_|input/i);
    const row = buildDwell([s], now).rows.find((r) => r.id === s.id);
    if (row) expect(row.status).toBe(word);
  });
  test("sessionStateWord never renders 'Needs input'", () => {
    const s = session({ id: "c", state: "needs_input", last: ev(3 * DAY) });
    expect(sessionStateWord(s, now)).toBe("Needs you");
  });
});
