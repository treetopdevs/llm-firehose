import { describe, expect, test } from "vitest";
import type { FirehoseEvent, Health } from "./api";
import { createConnector, normalizeSchemaVersion } from "./connect";

describe("normalizeSchemaVersion", () => {
  test("treats zero and absent as schema 1", () => {
    expect(normalizeSchemaVersion(0)).toBe(1);
    expect(normalizeSchemaVersion(undefined)).toBe(1);
    expect(normalizeSchemaVersion(1)).toBe(1);
    expect(normalizeSchemaVersion(2)).toBe(2);
  });
});

describe("createConnector", () => {
  test("concurrent connect shares one attempt and opens a single stream", async () => {
    let releaseRecent!: (evs: FirehoseEvent[]) => void;
    const recentGate = new Promise<FirehoseEvent[]>((resolve) => {
      releaseRecent = resolve;
    });
    const history: FirehoseEvent[] = [
      { id: "h1", time: "2026-07-02T10:00:00Z", source: "codex", category: "tool" },
    ];
    const received: FirehoseEvent[] = [];
    const statuses: string[] = [];
    let streamOpens = 0;

    const connector = createConnector({
      health: async () =>
        ({ version: "test", schema_version: 0, uptime_s: 1 }) as Health,
      recent: () => recentGate,
      stream: (_onEvent, onOpenChange) => {
        streamOpens++;
        onOpenChange(true);
        return () => {};
      },
      checkCompat: () => ({ compatible: true }),
      clientSchemaVersion: 1,
      onEvent: (ev) => received.push(ev),
      setStatus: ({ text }) => statuses.push(text),
    });

    const a = connector.connect();
    const b = connector.connect();
    releaseRecent(history);
    await Promise.all([a, b]);

    expect(received).toEqual(history);
    expect(streamOpens).toBe(1);
    expect(statuses.some((s) => s.includes("schema v1"))).toBe(true);
  });
});
