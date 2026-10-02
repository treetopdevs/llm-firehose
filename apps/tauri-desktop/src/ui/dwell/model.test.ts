import { describe, expect, test } from "vitest";
import type { AttentionEvidence, AttentionSession } from "../../api";
import { DWELL_CAP, buildDwell } from "./model";

const now = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

function evidence(over: Partial<AttentionEvidence> & { at: number }): AttentionEvidence {
  const { at, ...rest } = over;
  return {
    event_id: `e-${at}`,
    source: "claude-code",
    kind: "activity",
    summary: "edit view.go",
    time: ago(at),
    observed_at: ago(at),
    ...rest,
  };
}

function session(over: Partial<AttentionSession> & { id: string }): AttentionSession {
  return {
    source: "claude-code",
    agent: "claude",
    cwd: "/home/me/dev/app",
    events: 3,
    state: "working",
    last: evidence({ at: 60_000 }),
    ...over,
  };
}

describe("buildDwell", () => {
  test("a pending request leads, measured from the request; others measure time since their last activity", () => {
    const { rows, more } = buildDwell(
      [
        session({ id: "w", last: evidence({ at: 120_000 }) }),
        session({
          id: "n",
          source: "codex",
          agent: "codex",
          state: "needs_input",
          last: evidence({ at: 30_000, summary: "still chatty" }),
          pending: evidence({ at: 7 * 60_000, kind: "request", summary: "approve Bash", episode_id: "ep1" }),
        }),
      ],
      now,
    );
    expect(more).toBe(0);
    expect(rows.map((r) => r.id)).toEqual(["n", "w"]);
    expect(rows[0]).toMatchObject({ needs: true, status: "NEEDS YOU", dwellMs: 7 * 60_000, fraction: 0.7, text: "approve Bash", source: "codex" });
    expect(rows[1]).toMatchObject({ needs: false, status: "working", dwellMs: 120_000, fraction: 0.2, text: "edit view.go" });
  });

  test("a bare notification is not a request: no NEEDS YOU, and the uncertainty is shown", () => {
    const { rows } = buildDwell(
      [
        session({
          id: "u",
          last: evidence({ at: 10_000, kind: "activity", summary: "notification" }),
          uncertainty: "Notification captured; whether input is required is unknown.",
        }),
      ],
      now,
    );
    expect(rows[0]).toMatchObject({ needs: false, status: "working", text: "Notification captured; whether input is required is unknown." });
  });

  test("a captured failure leads like a request and is marked as an error", () => {
    const { rows } = buildDwell(
      [
        session({ id: "w", last: evidence({ at: 5_000 }) }),
        session({ id: "f", state: "failed", last: evidence({ at: 90_000 }), pending: evidence({ at: 90_000, kind: "failure", summary: "StopFailure" }) }),
      ],
      now,
    );
    expect(rows[0]).toMatchObject({ id: "f", needs: true, status: "FAILED", hasError: true, text: "StopFailure" });
  });

  test("longest wait first among pending sessions, then most recent activity, then id", () => {
    const req = (at: number) => evidence({ at, kind: "request" });
    const { rows } = buildDwell(
      [
        session({ id: "b", last: evidence({ at: 50_000 }) }),
        session({ id: "a", last: evidence({ at: 50_000 }) }),
        session({ id: "recent", last: evidence({ at: 1_000 }) }),
        session({ id: "short", state: "needs_input", pending: req(60_000) }),
        session({ id: "long", state: "needs_input", pending: req(300_000) }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["long", "short", "recent", "a", "b"]);
  });

  test("prefers the source's own clock when it is captured", () => {
    const { rows } = buildDwell(
      [session({ id: "s", last: { ...evidence({ at: 1_000 }), source_time: ago(180_000) } })],
      now,
    );
    expect(rows[0].dwellMs).toBe(180_000);
  });

  test("clamps the bar and drops sessions that are no longer plausibly live", () => {
    const { rows } = buildDwell(
      [
        session({ id: "long-quiet", last: evidence({ at: 20 * 60_000 }) }),
        session({ id: "stale-working", last: evidence({ at: 31 * 60_000 }) }),
        session({ id: "done", state: "done", last: evidence({ at: 11 * 60_000 }) }),
        session({ id: "unknown", state: "unknown", last: evidence({ at: 11 * 60_000 }) }),
        session({ id: "ghost", state: "needs_input", last: evidence({ at: 48 * 3_600_000 }), pending: evidence({ at: 48 * 3_600_000, kind: "request" }) }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["long-quiet"]);
    expect(rows[0].fraction).toBe(1);
  });

  test("the same native id from two sources stays two rows", () => {
    const { rows } = buildDwell(
      [session({ id: "x", source: "codex" }), session({ id: "x", source: "claude-code" })],
      now,
    );
    expect(rows.map((r) => r.key)).toEqual([JSON.stringify(["claude-code", "x"]), JSON.stringify(["codex", "x"])]);
  });

  test("skips unreadable evidence instead of drawing a NaN bar", () => {
    const { rows } = buildDwell([session({ id: "bad", last: { ...evidence({ at: 0 }), time: "nonsense", observed_at: "nonsense" } })], now);
    expect(rows).toEqual([]);
  });

  test("caps the chart and counts the rest", () => {
    const many = Array.from({ length: DWELL_CAP + 3 }, (_, i) => session({ id: `s${i}` }));
    const { rows, more } = buildDwell(many, now);
    expect(rows).toHaveLength(DWELL_CAP);
    expect(more).toBe(3);
  });
});
