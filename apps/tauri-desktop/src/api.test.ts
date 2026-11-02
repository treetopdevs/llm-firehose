import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, DAEMON_URL, capturedEvent, sessionEvents, errorSignatureSessions, worktrees, worktree } from "./api";
import type { WorktreeDetail, WorktreeLifetimeView, WorktreeState } from "./api";

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

test("sessionEvents requests additive correlation metadata with cancellation", async () => {
  const f = stubFetch(); const ctl = new AbortController();
  await sessionEvents("a/b c", "correlation", ctl.signal);
  expect(f.mock.calls[0][0]).toBe(`${DAEMON_URL}/sessions/a%2Fb%20c?view=correlation`);
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
});

describe("worktree requests", () => {
  test("worktrees requests the list and forwards the AbortSignal", async () => {
    const f = stubFetch();
    const ctl = new AbortController();
    const rows = await worktrees(ctl.signal);
    expect(rows).toEqual([]);
    expect(f.mock.calls[0][0]).toBe(`${DAEMON_URL}/worktrees`);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
  });

  test("worktree percent-encodes the id and forwards the AbortSignal", async () => {
    const f = stubFetch();
    const ctl = new AbortController();
    await worktree("/work/alpha-feat", ctl.signal);
    await worktree("a b&c");
    expect(f.mock.calls[0][0]).toBe(`${DAEMON_URL}/worktrees/%2Fwork%2Falpha-feat`);
    expect(f.mock.calls[1][0]).toBe(`${DAEMON_URL}/worktrees/${encodeURIComponent("a b&c")}`);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
  });

  test("worktree rejects with ApiError 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("worktree not found", { status: 404 })));
    const err = await worktree("nope").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });

  test("type-level literals compile", () => {
    const states: WorktreeState[] = ["open", "landed", "never_diverged", "gone", "unknown"];
    const view: WorktreeLifetimeView = {
      repo_id: "r", worktree_id: "w", first_time: "t", last_time: "t",
      sessions: [{ source: "claude-code", session_id: "s", first_time: "t", last_time: "t", events: 1 }],
      sessions_total: 1, paths: [], paths_total: 0, signal_events: 1, meta_events: 0,
      marks: [{ kind: "commit", time: "t", event_id: "e" }], marks_total: 1, marks_available: true,
      state: "gone", outcome: "landed", state_reason: "compare_failed", ahead: 0, behind: 0, dirty: false,
      head: "h", label: "/work/a", default_target_ref: "main", last_observed: "t",
    };
    const detail: WorktreeDetail = { ...view, commits: [{ commit_id: "c", attribution: "time_join" }] };
    expect(states).toHaveLength(5);
    expect(detail.commits[0].attribution).toBe("time_join");
  });
});
