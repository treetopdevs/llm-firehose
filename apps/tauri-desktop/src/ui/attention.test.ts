// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createAttention } from "./attention";

const now = new Date("2026-09-06T15:00:00Z").getTime();
const evidence = (id: string, kind = "request") => ({
  event_id: id,
  kind,
  source: "codex",
  summary: `reason ${id}`,
  time: new Date(now - 1000).toISOString(),
  observed_at: new Date(now - 1000).toISOString(),
});
const session = (id: string, pending = true) => ({
  id,
  source: "codex",
  agent: "codex",
  events: 3,
  state: pending ? "needs_input" : "working",
  cwd: "/work/app",
  last: evidence(`last-${id}`, "activity"),
  ...(pending ? { pending: evidence(id) } : {}),
});
let snapshot = {
  sessions: [session("r1"), session("active", false)],
  warnings: [] as ReturnType<typeof evidence>[],
};
const fetcher = vi.fn(
  async (url: string) =>
    new Response(
      JSON.stringify(
        url.endsWith("/attention")
          ? snapshot
          : {
              id: new URL(url).searchParams.get("id") ?? "r1",
              source: "codex",
              category: "permission",
              time: new Date(now).toISOString(),
              summary: "captured request",
            },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
);
const saved = new Map<string, string>();
const storage = {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => {
    saved.set(key, value);
  },
};
const panels: ReturnType<typeof createAttention>[] = [];
const mount = (opts: Partial<Parameters<typeof createAttention>[0]> = {}) => {
  const panel = createAttention({
    storage,
    onSelect: () => {},
    onOpenSession: () => {},
    onDoctor: () => {},
    onOpenInbox: () => {},
    ...opts,
  });
  panels.push(panel);
  document.body.append(panel.strip, panel.root);
  return panel;
};
const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label)!;
beforeEach(() => {
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(Date, "now").mockReturnValue(now);
  saved.clear();
  fetcher.mockClear();
  snapshot = {
    sessions: [session("r1"), session("active", false)],
    warnings: [],
  };
});
afterEach(() => {
  panels.splice(0).forEach((p) => p.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(["r1", ".", "..", "a/b?&= %+"])("opens exact captured evidence for ID %s", async (id) => {
  snapshot.sessions[0].pending = evidence(id);
  const selected = vi.fn();
  const panel = mount({ onSelect: selected });
  await panel.refresh();
  expect(panel.strip.textContent).toContain("1 needs you");
  expect(panel.root.querySelector(".attention-row")?.textContent).toContain(
    `reason ${id}`,
  );
  expect(panel.root.textContent).toContain("No later resolution captured");
  button(panel.root, "Inspect evidence").click();
  await vi.waitFor(() =>
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ id, summary: "captured request" }),
    ),
  );
  expect(fetcher.mock.calls.some(([url]) => {
    const parsed = new URL(url);
    return parsed.pathname === "/attention/event" && parsed.searchParams.get("id") === id;
  })).toBe(true);
});

test("snooze survives a desktop restart, can be cleared, and never hides a new episode", async () => {
  const p = mount();
  await p.refresh();
  button(p.root, "Snooze 15 minutes").click();
  expect(p.strip.textContent).toContain("1 snoozed");
  p.dispose();
  p.root.remove();
  p.strip.remove();
  const reopened = mount();
  await reopened.refresh();
  expect(reopened.strip.textContent).toContain("1 snoozed");
  button(reopened.root, "Unsnooze").click();
  expect(reopened.strip.textContent).toContain("0 snoozed");
  button(reopened.root, "Snooze 15 minutes").click();
  snapshot.sessions[0].pending = evidence("r2");
  await reopened.refresh();
  expect(reopened.strip.textContent).toContain("1 needs you");
  expect(reopened.strip.textContent).toContain("0 snoozed");
});

test("keeps history behind search and source/workspace scope, and labels stale observations", async () => {
  snapshot.sessions.push({
    ...session("old", false),
    source: "claude-code",
    cwd: "/work/other",
    state: "done",
    last: { ...evidence("old"), time: "2026-09-01T00:00:00Z" },
  });
  const p = mount();
  await p.refresh();
  expect(p.root.textContent).not.toContain("reason old");
  button(p.root, "History").click();
  expect(p.root.textContent).toContain("reason old");
  expect(p.root.textContent).toContain("Stale observation");
  const search = p.root.querySelector<HTMLInputElement>(
    'input[type="search"]',
  )!;
  search.value = "old";
  search.dispatchEvent(new Event("input"));
  expect(p.root.querySelectorAll(".attention-row")).toHaveLength(1);
  const source = p.root.querySelector<HTMLSelectElement>(
    'select[aria-label="Source"]',
  )!;
  source.value = "codex";
  source.dispatchEvent(new Event("change"));
  expect(p.root.querySelectorAll(".attention-row")).toHaveLength(0);
});

test("rejects an old response after disconnect and recovers with an authoritative snapshot", async () => {
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const p = mount();
  const pending = p.refresh();
  p.setConnected(false);
  finish(new Response(JSON.stringify(snapshot)));
  await pending;
  expect(p.strip.textContent).toContain("Offline");
  expect(p.root.textContent).not.toContain("reason r1");
  p.setConnected(true);
  await p.refresh();
  expect(p.strip.textContent).toContain("1 needs you");
});

test("capture warnings are not in the Needs you queue or its count; they are held for Doctor (MS-9)", async () => {
  snapshot.warnings = [evidence("warning", "capture_warning")];
  const p = mount({
    storage: {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
    },
  });
  await p.refresh();
  expect(p.root.querySelector(".capture-warning")).toBeNull();
  expect(p.root.textContent).not.toContain("reason warning");
  expect(p.strip.textContent).not.toContain("capture warning");
  expect(p.count()).toBe(1); // the one session that needs you; the warning is not a need
  expect(p.warnings()).toBe(1);
  expect(p.captureIssues().warnings.map((w) => w.event_id)).toEqual(["warning"]);
  button(p.root, "Snooze 15 minutes").click();
  expect(p.root.textContent).toContain("could not be saved");
  expect(p.strip.textContent).toContain("1 snoozed");
});

test("a warning is inspected through the panel, once, by its event id", async () => {
  const selected = vi.fn();
  snapshot.warnings = [evidence("w1", "capture_warning")];
  const p = mount({ onSelect: selected });
  await p.refresh();
  await p.inspectWarning("w1");
  expect(selected).toHaveBeenCalledWith(expect.objectContaining({ summary: "captured request" }));
  expect(fetcher.mock.calls.filter(([u]) => u.includes("/attention/event?id=w1"))).toHaveLength(1);
});

test("inspecting a warning answers whether the evidence could be shown", async () => {
  snapshot.warnings = [evidence("w1", "capture_warning")];
  const p = mount();
  await p.refresh();
  expect(await p.inspectWarning("w1")).toBe(true);
  fetcher.mockImplementationOnce(async () => new Response("no", { status: 500 }));
  expect(await p.inspectWarning("w1")).toBe(false);
});

test("notifications require opt-in and send once for a new episode across reconnect and restart", async () => {
  const delivered: string[] = [];
  const notifications = {
    enable: vi.fn(async () => true),
    granted: vi.fn(async () => true),
    send: vi.fn(async () => {
      delivered.push("notification");
    }),
  };
  const p = mount({ notifications });
  await p.refresh();
  expect(delivered).toEqual([]);
  button(p.root, "Enable desktop notifications").click();
  await vi.waitFor(() =>
    expect(button(p.root, "Disable desktop notifications")).toBeTruthy(),
  );
  await p.refresh();
  expect(delivered).toEqual([]);
  snapshot.sessions[0].pending = evidence("r2");
  await p.refresh();
  expect(delivered).toEqual(["notification"]);
  p.setConnected(false);
  p.setConnected(true);
  await p.refresh();
  expect(delivered).toEqual(["notification"]);
  p.dispose();
  const reopened = mount({ notifications });
  await reopened.refresh();
  expect(delivered).toEqual(["notification"]);
  snapshot.sessions[0].pending = evidence("r3");
  await reopened.refresh();
  expect(delivered).toHaveLength(2);
  snapshot.sessions[0].pending = {
    ...evidence("old"),
    time: "2026-09-01T00:00:00Z",
  };
  await reopened.refresh();
  expect(delivered).toHaveLength(2);
});

test("a resolution or snooze during a delayed OS check suppresses the notification", async () => {
  let grant!: (value: boolean) => void;
  const notifications = {
    enable: async () => true,
    granted: () =>
      new Promise<boolean>((resolve) => {
        grant = resolve;
      }),
    send: vi.fn(async () => {}),
  };
  const p = mount({ notifications });
  await p.refresh();
  button(p.root, "Enable desktop notifications").click();
  await vi.waitFor(() =>
    expect(button(p.root, "Disable desktop notifications")).toBeTruthy(),
  );
  snapshot.sessions[0].pending = evidence("r2");
  const pending = p.refresh();
  await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
  button(p.root, "Snooze 15 minutes").click();
  grant(true);
  await pending;
  expect(notifications.send).not.toHaveBeenCalled();
  snapshot.sessions[0].pending = undefined;
  await p.refresh();
  expect(p.strip.textContent).toContain("0 need you");
});

test("only the most recently selected evidence can open and failures are readable", async () => {
  let finish!: (r: Response) => void;
  const select = vi.fn();
  const p = mount({ onSelect: select });
  await p.refresh();
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const actions = [...p.root.querySelectorAll("button")].filter(
    (b) => b.textContent === "Inspect evidence",
  );
  actions[0].click();
  actions[1].click();
  await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
  finish(new Response(JSON.stringify({ id: "late" })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(select).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(new Response("gone", { status: 404 }));
  actions[1].click();
  await vi.waitFor(() =>
    expect(p.root.textContent).toContain("Captured evidence is unavailable"),
  );
});

test("denied permission stays off and a failed delivery stays visible without retry storms", async () => {
  const notifications = {
    enable: vi.fn(async () => false),
    granted: async () => true,
    send: vi.fn(async () => {
      throw new Error("OS failure");
    }),
  };
  const p = mount({ notifications });
  await p.refresh();
  button(p.root, "Enable desktop notifications").click();
  await vi.waitFor(() =>
    expect(p.root.textContent).toContain("Permission denied"),
  );
  notifications.enable.mockResolvedValue(true);
  button(p.root, "Enable desktop notifications").click();
  await vi.waitFor(() =>
    expect(button(p.root, "Disable desktop notifications")).toBeTruthy(),
  );
  snapshot.sessions[0].pending = evidence("r2");
  await p.refresh();
  expect(p.root.textContent).toContain("could not be delivered");
  await p.refresh();
  expect(notifications.send).toHaveBeenCalledTimes(1);
});

test("snooze expires and keyboard focus survives polling", async () => {
  const p = mount();
  await p.refresh();
  button(p.root, "Snooze 15 minutes").click();
  button(p.root, "Unsnooze").focus();
  await p.refresh();
  expect(document.activeElement?.textContent).toBe("Unsnooze");
  vi.mocked(Date.now).mockReturnValue(now + 15 * 60_000);
  await p.refresh();
  expect(p.strip.textContent).toContain("0 snoozed");
  const inspect = button(p.root, "Inspect evidence");
  inspect.focus();
  await p.refresh();
  expect(document.activeElement?.textContent).toBe("Inspect evidence");
});

test("malformed preferences cannot silently enable notifications", async () => {
  saved.set(
    "firehose.attention.v1",
    JSON.stringify({ enabled: true, snoozes: "invalid" }),
  );
  const p = mount();
  await p.refresh();
  expect(button(p.root, "Enable desktop notifications")).toBeTruthy();
  expect(p.root.textContent).toContain("Local preferences unavailable");
});

test("the native notification command receives only the fixed private message", async () => {
  const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
  const commands: { cmd: string; args: unknown }[] = [];
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
    },
  );
  mockIPC((cmd, args) => {
    commands.push({ cmd, args });
  });
  try {
    const p = mount();
    await p.refresh();
    button(p.root, "Enable desktop notifications").click();
    await vi.waitFor(() =>
      expect(button(p.root, "Disable desktop notifications")).toBeTruthy(),
    );
    snapshot.sessions[0].pending = evidence("native");
    await p.refresh();
    expect(commands).toContainEqual({
      cmd: "plugin:notification|notify",
      args: {
        options: {
          title: "Agent Firehose",
          body: "An agent session needs you. Open Needs you.",
        },
      },
    });
  } finally {
    clearMocks();
  }
});

test("native episode identity preserves snooze when its supporting event changes", async () => {
  const first = { ...evidence("r1"), episode_id: "native-request" };
  snapshot.sessions[0].pending = first;
  const p = mount();
  await p.refresh();
  button(p.root, "Snooze 15 minutes").click();
  snapshot.sessions[0].pending = { ...first, event_id: "updated-evidence" };
  await p.refresh();
  expect(p.strip.textContent).toContain("1 snoozed");
});

test("unrecorded capture gaps are held for Doctor, counted on its badge and inspectable; the queue shows workspace identity only", async () => {
  const selected = vi.fn();
  Object.assign(snapshot, {
    gaps: [
      {
        source: "firehose",
        time: new Date(now).toISOString(),
        summary: "Unreadable spool line",
      },
    ],
  });
  snapshot.sessions[0].repo = "app";
  const p = mount({ onSelect: selected });
  await p.refresh();
  expect(p.root.textContent).toContain("/work/app");
  expect(p.root.querySelector(".capture-warning")).toBeNull();
  expect(p.root.textContent).not.toContain("Unreadable spool line");
  expect(p.strip.textContent).not.toContain("capture gap");
  expect(p.warnings()).toBe(1);
  p.inspectGap(p.captureIssues().gaps[0]);
  expect(selected).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "capture.gap",
      summary: expect.stringContaining("not recorded"),
    }),
  );
  expect(fetcher.mock.calls.some(([url]) => url.includes("undefined"))).toBe(
    false,
  );
});

test("a gap selected while a warning is still loading is not replaced by the warning", async () => {
  const selected = vi.fn();
  snapshot.warnings = [evidence("w1", "capture_warning")];
  Object.assign(snapshot, { gaps: [{ source: "firehose", time: new Date(now).toISOString(), summary: "Unreadable spool line" }] });
  const p = mount({ onSelect: selected });
  await p.refresh();
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
  const pending = p.inspectWarning("w1");
  p.inspectGap(p.captureIssues().gaps[0]);
  release(new Response(JSON.stringify({ id: "w1", source: "codex", category: "permission", time: new Date(now).toISOString(), summary: "captured request" }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await pending;
  expect(selected).toHaveBeenCalledTimes(1);
  expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ name: "capture.gap" }));
});

test("a warning inspection superseded by a gap resolves null, even when its read failed, and writes no status", async () => {
  const selected = vi.fn();
  snapshot.warnings = [evidence("w1", "capture_warning")];
  Object.assign(snapshot, { gaps: [{ source: "firehose", time: new Date(now).toISOString(), summary: "Unreadable spool line" }] });
  const p = mount({ onSelect: selected });
  await p.refresh();
  let release!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
  const pending = p.inspectWarning("w1");
  p.inspectGap(p.captureIssues().gaps[0]);
  release(new Response("nope", { status: 500 }));
  expect(await pending).toBeNull();
});

test("the panel heading is the nav label and the old name is gone", async () => {
  const p = mount();
  expect(p.root.querySelector("h2")?.textContent).toBe("Needs you");
  expect(p.root.textContent).not.toContain("Attention inbox");
});

test("rows are named, not identified: titled and untitled h3, short agent line, copyable full id chip", async () => {
  const UUID = "2385e3bc-aaaa-bbbb-cccc-111122223333";
  const OTHER = "bbbbbbbb-aaaa-bbbb-cccc-111122223333";
  snapshot.sessions = [
    { ...session(UUID), title: "Fix login bug" },
    { ...session(OTHER), cwd: "/Users/n/develop/llm-firehose" },
  ];
  const p = mount();
  await p.refresh();
  const h3s = [...p.root.querySelectorAll("h3")].map((h) => h.textContent);
  expect(h3s).toContain("Fix login bug");
  expect(h3s).toContain("codex in llm-firehose");
  for (const h of h3s) {
    expect(h).not.toContain(UUID);
    expect(h).not.toContain(OTHER);
  }
  const row = p.root.querySelector("article")!;
  expect(row.textContent).toContain("codex · codex");
  const chip = row.querySelector<HTMLButtonElement>("button.session-id")!;
  expect(chip.textContent).toBe(row.querySelector("h3")!.textContent === "Fix login bug" ? UUID : OTHER);
  expect(chip.getAttribute("aria-label")).toBe(`copy session id ${chip.textContent}`);
});

test("duplicate titles are told apart by source and short id", async () => {
  snapshot.sessions = [
    { ...session("aaaaaaaa-1111"), title: "Same" },
    { ...session("cccccccc-2222"), title: "Same", source: "claude-code" },
    { ...session("dddddddd-3333"), title: "Unique" },
  ];
  const p = mount();
  await p.refresh();
  const h3s = [...p.root.querySelectorAll("h3")].map((h) => h.textContent);
  expect(h3s).toContain("Same · codex aaaaaaaa");
  expect(h3s).toContain("Same · claude-code cccccccc");
  expect(h3s).toContain("Unique");
});

test("onSessions receives the session list after every load", async () => {
  const seen: unknown[][] = [];
  const p = mount({ onSessions: (l: unknown[]) => seen.push(l) } as never);
  await p.refresh();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toHaveLength(2);
  snapshot.sessions = [session("only")];
  await p.refresh();
  expect(seen).toHaveLength(2);
  expect(seen[1]).toHaveLength(1);
});

test("the inbox root keeps its h2 and class, the strip still opens the inbox, and refresh works detached", async () => {
  const open = vi.fn();
  const panel = mount({ onOpenInbox: open });
  await panel.refresh();
  expect(panel.root.querySelector("h2")?.textContent).toBe("Needs you");
  expect(panel.root.classList.contains("attention-inbox")).toBe(true);
  panel.strip.querySelector<HTMLButtonElement>("[data-key=inbox]")!.click();
  expect(open).toHaveBeenCalledTimes(1);
  panel.root.remove();
  panel.strip.remove();
  await expect(panel.refresh()).resolves.toBeUndefined();
});

test("count() is the strip's count: snoozed and non-pending episodes do not count", async () => {
  snapshot.sessions = [session("a"), session("b"), { ...session("c"), source: "claude-code" } as ReturnType<typeof session>, session("w", false)];
  const panel = mount();
  await panel.refresh();
  expect(panel.count()).toBe(3);
  button(panel.root, "Snooze 15 minutes").click();
  expect(panel.count()).toBe(2);
  expect(panel.strip.querySelector("[data-key=inbox]")!.textContent).toBe("2 need you · 1 snoozed");
});

test("onCount listeners run when the strip redraws, so a snooze reaches them at once", async () => {
  snapshot.sessions = [session("a")];
  const panel = mount();
  const seen: number[] = [];
  panel.onCount(() => seen.push(panel.count()));
  await panel.refresh();
  button(panel.root, "Snooze 15 minutes").click();
  expect(seen.at(-1)).toBe(0);
  expect(seen).toContain(1);
});

test("worktree filter and card line name through labels, never a 64-hex value; option value stays the id", async () => {
  const HEX = "ab".repeat(32);
  const REPO = "cd".repeat(32);
  snapshot.sessions = [
    { ...session("r1"), worktree_id: HEX, repo_id: REPO, cwd: undefined as unknown as string },
    { ...session("r2", false), worktree_id: "/Users/n/develop/proj", cwd: undefined as unknown as string },
  ] as typeof snapshot.sessions;
  const panel = mount({ labels: { worktree: (id) => (id === HEX ? "alpha-wt" : undefined), project: (id) => (id === REPO ? "alpha" : undefined) } });
  await panel.refresh();
  const select = panel.root.querySelector<HTMLSelectElement>("select[aria-label=Worktree]")!;
  const opts = [...select.options].map((o) => [o.value, o.textContent]);
  expect(opts).toContainEqual([HEX, "alpha-wt"]);
  expect(opts).toContainEqual(["/Users/n/develop/proj", "proj"]);
  expect(panel.root.textContent).toContain("Worktree: alpha-wt");
  expect(panel.root.textContent).not.toContain(HEX);
  select.value = HEX;
  select.dispatchEvent(new Event("change"));
  expect(panel.root.querySelectorAll(".attention-row")).toHaveLength(1);
});

test("without labels a digest worktree shows its 8-character prefix, not 64 hex", async () => {
  const HEX = "ab".repeat(32);
  snapshot.sessions = [{ ...session("r1"), worktree_id: HEX }] as typeof snapshot.sessions;
  const panel = mount();
  await panel.refresh();
  expect(panel.root.textContent).toContain(`Worktree: ${HEX.slice(0, 8)}`);
  expect(panel.root.textContent).not.toContain(HEX);
});

test("byProject counts a session under its project's current id after a privacy change", async () => {
  snapshot = { sessions: [{ ...session("moved"), repo_id: "digest-a" } as ReturnType<typeof session>], warnings: [] };
  const panel = mount();
  await panel.refresh();
  const counts = panel.byProject((id) => (id === "digest-a" ? "/work/app" : id));
  expect(counts.get("/work/app")?.needs).toBe(1);
  expect(counts.has("digest-a")).toBe(false);
  expect(panel.byProject().get("digest-a")?.needs).toBe(1);
});

const daysOld = (id: string, days: number, repo_id = "repoA") => {
  const at = new Date(now - days * 86_400_000).toISOString();
  const old = { ...evidence(id, "failure"), time: at, observed_at: at };
  return { ...session(id), repo_id, state: "failed", last: old, pending: old };
};

test("a pending episode past the freshness limit is listed but not counted", async () => {
  snapshot = { sessions: [daysOld("ancient", 27), { ...session("fresh"), repo_id: "repoA" }] as typeof snapshot.sessions, warnings: [] };
  const p = mount();
  await p.refresh();
  expect(p.count()).toBe(1);
  expect(p.byProject().get("repoA")).toEqual({ needs: 1, active: 0 });
  const rows = [...p.root.querySelectorAll(".attention-row")].map((r) => r.textContent ?? "");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain("reason fresh");
  expect(rows[1]).toContain("Older than 24 hours");
  expect(rows[1]).not.toContain("Snooze");
});

test("with only an old episode the count is zero", async () => {
  snapshot = { sessions: [daysOld("ancient", 27)] as typeof snapshot.sessions, warnings: [] };
  const p = mount();
  await p.refresh();
  expect(p.count()).toBe(0);
  expect(p.byProject().get("repoA")?.needs ?? 0).toBe(0);
});

test("read shares one request and hands every reader the snapshot the count was drawn from", async () => {
  const p = mount();
  fetcher.mockClear();
  const [a, b] = await Promise.all([p.read(), p.read()]);
  expect(fetcher.mock.calls.filter(([u]) => u.endsWith("/attention"))).toHaveLength(1);
  expect(a).toBe(b);
  expect(a.sessions.filter((s) => s.pending)).toHaveLength(p.count());
});

test("read rejects when the snapshot cannot be loaded, and asks directly while the stream is down", async () => {
  const p = mount();
  fetcher.mockImplementationOnce(async () => new Response("no", { status: 500 }));
  await expect(p.read()).rejects.toBeDefined();
  p.setConnected(false);
  await expect(p.read()).resolves.toMatchObject({ sessions: expect.any(Array) });
  p.dispose();
  await expect(p.read()).rejects.toBeDefined();
});

test("read does not wait for a slow notification permission check", async () => {
  let release = () => {};
  const granted = new Promise<boolean>((r) => { release = () => r(true); });
  const notifications = { enable: async () => true, granted: () => granted, send: async () => {} };
  const p = mount({ notifications });
  await p.refresh();
  button(p.root, "Enable desktop notifications").click();
  await vi.waitFor(() => expect(button(p.root, "Disable desktop notifications")).toBeTruthy());
  snapshot = { ...snapshot, sessions: [...snapshot.sessions, session("new-request")] };
  const refreshing = p.refresh();
  await vi.waitFor(() => expect(p.count()).toBe(2));
  await expect(p.read()).resolves.toBeDefined();
  release();
  await refreshing;
});

test("a direct read while the stream is down updates the count too", async () => {
  const p = mount();
  await p.refresh();
  expect(p.count()).toBe(1);
  p.setConnected(false);
  snapshot = { ...snapshot, sessions: [...snapshot.sessions, session("arrived")] };
  await p.read();
  expect(p.count()).toBe(2);
});

test("a direct read that lands as the stream connects still updates the count, unless a newer snapshot already did", async () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const two = { sessions: [session("r1"), session("r2")], warnings: [] };
  const one = { sessions: [session("r1")], warnings: [] };
  const p = mount();
  await p.refresh();
  p.setConnected(false);
  let answerDirect = (_: Response) => {};
  let answerOwn = (_: Response) => {};
  fetcher.mockImplementationOnce(() => new Promise((r) => { answerDirect = r; }));
  fetcher.mockImplementationOnce(() => new Promise((r) => { answerOwn = r; }));
  const direct = p.read();
  p.setConnected(true);
  answerDirect(ok(two));
  await direct;
  expect(p.count()).toBe(2);
  answerOwn(ok(one));
  await vi.waitFor(() => expect(p.count()).toBe(1));

  p.setConnected(false);
  fetcher.mockImplementationOnce(() => new Promise((r) => { answerDirect = r; }));
  const late = p.read();
  p.setConnected(true);
  await p.refresh();
  const settled = p.count();
  answerDirect(ok({ sessions: [session("x"), session("y"), session("z")], warnings: [] }));
  await late;
  expect(p.count()).toBe(settled);
});
