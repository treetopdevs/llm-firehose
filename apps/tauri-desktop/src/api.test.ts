import { afterEach, describe, expect, test, vi } from "vitest";
import { DAEMON_URL, capturedEvent, sessionEvents, errorSignatureSessions } from "./api";

function stubFetch() {
  const f = vi.fn(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("session timeline requests", () => {
  test("sessionEvents builds the plain path and the timeline view path", async () => {
    const f = stubFetch();
    await sessionEvents("a/b c");
    await sessionEvents("a/b c", "timeline");
    expect(f.mock.calls[0][0]).toBe(`${DAEMON_URL}/sessions/a%2Fb%20c`);
    expect(f.mock.calls[1][0]).toBe(`${DAEMON_URL}/sessions/a%2Fb%20c?view=timeline`);
  });

  test("capturedEvent forwards an AbortSignal", async () => {
    const f = stubFetch();
    const ctl = new AbortController();
    await capturedEvent("e 1", ctl.signal);
    expect(f.mock.calls[0][0]).toBe(`${DAEMON_URL}/attention/event?id=e%201`);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
  });
});

test("sessionEvents forwards cancellation for superseded history scans", async () => {
  const f = stubFetch();
  const ctl = new AbortController();
  await sessionEvents("session", "timeline", ctl.signal);
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
});

test("errorSignatureSessions encodes keys and forwards page bounds and cancellation", async () => {
  const f = stubFetch(); const ctl = new AbortController();
  await errorSignatureSessions("codex|shell|a/b &c", 50, 50, ctl.signal);
  expect(f.mock.calls[0][0]).toBe(`${DAEMON_URL}/errors/sessions?key=codex%7Cshell%7Ca%2Fb%20%26c&offset=50&limit=50`);
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
});
