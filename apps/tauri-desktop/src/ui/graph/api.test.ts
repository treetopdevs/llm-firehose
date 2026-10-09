// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { graphAPI } from "./api";

vi.mock("../../api", () => ({ DAEMON_URL: "http://daemon.test" }));
afterEach(() => vi.unstubAllGlobals());

test("timeline hands its AbortSignal to fetch, so a superseded request frees its connection", async () => {
  const fetchMock = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  const pending = graphAPI.timeline({ repo_id: "r", limit: "20" }, controller.signal);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("http://daemon.test/workspace-graph/timeline?repo_id=r&limit=20");
  expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("requests without a signal are unchanged", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
  vi.stubGlobal("fetch", fetchMock);
  await graphAPI.repos();
  await graphAPI.timeline({ repo_id: "r" });
  for (const call of fetchMock.mock.calls as unknown as [string, RequestInit | undefined][])
    expect(call[1]?.signal).toBeUndefined();
});
