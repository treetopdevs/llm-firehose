import { afterEach, describe, expect, test, vi } from "vitest";
import { DAEMON_URL, capturedEvent, sessionEvents } from "./api";

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
