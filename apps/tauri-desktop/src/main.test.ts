// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

test("Live is home and the shared attention strip remains available across views", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", version: "test", schema_version: 1 }
              : url.endsWith("/attention")
                ? { sessions: [], warnings: [] }
                : [],
          ),
        ),
    ),
  );
  await import("./main");
  expect(document.querySelector(".nav-btn.active")?.textContent).toBe("live");
  expect(document.querySelector(".attention-strip")).not.toBeNull();
  const inbox = [
    ...document.querySelectorAll<HTMLButtonElement>(".nav-btn"),
  ].find((b) => b.textContent === "attention")!;
  inbox.click();
  expect(document.querySelector(".attention-inbox")).not.toBeNull();
  expect(document.querySelector(".attention-strip")).not.toBeNull();
});

test("the score view is reachable from the sidebar and starts empty", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", version: "test", schema_version: 1 }
              : url.endsWith("/attention")
                ? { sessions: [], warnings: [] }
                : [],
          ),
        ),
    ),
  );
  await import("./main");
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find((b) => b.textContent === "score")!;
  btn.click();
  expect(document.querySelector(".score")).not.toBeNull();
  expect(document.querySelector(".score")?.textContent).toContain("open a session");
});

test("the loops view is reachable from the sidebar and starts empty", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/health")
              ? { status: "ok", version: "test", schema_version: 1 }
              : url.endsWith("/attention")
                ? { sessions: [], warnings: [] }
                : [],
          ),
        ),
    ),
  );
  await import("./main");
  const btn = [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find((b) => b.textContent === "loops")!;
  btn.click();
  expect(document.querySelector(".loops")).not.toBeNull();
  expect(document.querySelector(".loops")?.textContent).toContain("Choose a session");
});

test("entering Loom closes and empties the open shared detail pane", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("localStorage", { getItem: () => "true", setItem: () => {} });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal("EventSource", class { onopen = null; onerror = null; onmessage = null; close() {} });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/health") ? { status: "ok", version: "test", schema_version: 1 }
      : url.endsWith("/attention") ? { sessions: [], warnings: [] } : [],
  ))));
  await import("./main");
  const { renderDetail } = await import("./ui/detail");
  const fixture = (await import("./ui/score/fixture.errsig.json")).default;
  const pane = document.querySelector<HTMLElement>(".detail")!;
  renderDetail(pane, fixture[0], () => {});
  expect(pane.classList.contains("open")).toBe(true);
  expect(pane.childElementCount).toBeGreaterThan(0);
  [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find(b => b.textContent === "loom")!.click();
  expect(pane.classList.contains("open")).toBe(false);
  expect(pane.childElementCount).toBe(0);
  expect(document.querySelector(".loom")).not.toBeNull();
  expect(document.querySelector(".nav-btn.active")?.textContent).toBe("loom");
});
