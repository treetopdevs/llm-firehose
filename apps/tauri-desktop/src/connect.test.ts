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

  test("stream interruption brackets replacement with durable reconciliation", async () => {
    const order: string[] = [];
    const states: Array<(open: boolean) => void> = [];
    const connector = createConnector({
      health: async () => ({ status: "ok", version: "test", schema_version: 1 }),
      recent: async (limit) => {
        order.push(`recent:${limit}`);
        return [];
      },
      stream: (_onEvent, onOpenChange) => {
        order.push("stream");
        states.push(onOpenChange);
        return () => order.push("stop");
      },
      checkCompat: () => ({ compatible: true }),
      clientSchemaVersion: 1,
      onEvent: () => {},
      setStatus: () => {},
    });

    await connector.connect();
    states[0](false);
    await connector.connect();
    expect(order).toEqual([
      "recent:500", "stream", "recent:500", "stop",
      "recent:10000", "stream", "recent:10000",
    ]);
  });

  test("post-subscription snapshot closes the history/live race", async () => {
    const gap: FirehoseEvent = {
      id: "gap", time: "2026-08-17T12:00:00Z", source: "codex", category: "message",
    };
    let recentCalls = 0;
    const received: FirehoseEvent[] = [];
    const connector = createConnector({
      health: async () => ({ status: "ok", version: "test", schema_version: 1 }),
      recent: async () => (++recentCalls === 1 ? [] : [gap]),
      stream: () => () => {},
      checkCompat: () => ({ compatible: true }),
      clientSchemaVersion: 1,
      onEvent: (ev) => received.push(ev),
      setStatus: () => {},
    });

    await connector.connect();
    expect(received).toEqual([gap]);
  });

  test("bounds live events buffered during durable reconciliation", async () => {
	let releaseCatchup!: (events: FirehoseEvent[]) => void;
	const catchup = new Promise<FirehoseEvent[]>((resolve) => {
	  releaseCatchup = resolve;
	});
	let recentCalls = 0;
	let onStreamEvent: ((ev: FirehoseEvent) => void) | undefined;
	const received: FirehoseEvent[] = [];
	const connector = createConnector({
	  health: async () => ({ status: "ok", version: "test", schema_version: 1 }),
	  recent: async () => (++recentCalls === 1 ? [] : catchup),
	  stream: (onEvent) => {
		onStreamEvent = onEvent;
		return () => {};
	  },
	  checkCompat: () => ({ compatible: true }),
	  clientSchemaVersion: 1,
	  onEvent: (ev) => received.push(ev),
	  setStatus: () => {},
	});

	const connecting = connector.connect();
	while (!onStreamEvent) await Promise.resolve();
	for (let i = 0; i < 10005; i++) {
	  onStreamEvent({
		id: `pending-${i}`, time: "2026-08-17T12:00:00Z", source: "codex", category: "message",
	  });
	}
	releaseCatchup([]);
	await connecting;
	expect(received).toHaveLength(10000);
	expect(received[0].id).toBe("pending-5");
	expect(received[9999].id).toBe("pending-10004");
  });
});
