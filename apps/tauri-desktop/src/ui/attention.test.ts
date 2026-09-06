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
              id: "r1",
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

test("shows unresolved requests first and opens the exact captured evidence", async () => {
  const selected = vi.fn();
  const panel = mount({ onSelect: selected });
  await panel.refresh();
  expect(panel.strip.textContent).toContain("1 needs attention");
  expect(panel.root.querySelector(".attention-row")?.textContent).toContain(
    "reason r1",
  );
  expect(panel.root.textContent).toContain("No later resolution captured");
  button(panel.root, "Inspect evidence").click();
  await vi.waitFor(() =>
    expect(selected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", summary: "captured request" }),
    ),
  );
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/events/r1"))).toBe(
    true,
  );
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
  expect(reopened.strip.textContent).toContain("1 needs attention");
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
  expect(p.strip.textContent).toContain("1 needs attention");
});

test("shows captured warnings and explains storage failures without losing the inbox", async () => {
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
  expect(p.root.textContent).toContain("reason warning");
  expect(p.strip.textContent).toContain("1 capture warning");
  button(p.root, "Snooze 15 minutes").click();
  expect(p.root.textContent).toContain("could not be saved");
  expect(p.strip.textContent).toContain("1 snoozed");
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
  expect(p.strip.textContent).toContain("0 needs attention");
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
          body: "An agent session needs attention. Open the Attention inbox.",
        },
      },
    });
  } finally {
    clearMocks();
  }
});
