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
  const close=vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("AudioContext",class {state="running";resume=vi.fn().mockResolvedValue(undefined);close=close;onstatechange=null;});
  document.querySelector<HTMLButtonElement>('[aria-label="Enable replay sound"]')!.click();
  await Promise.resolve();
  expect(document.querySelector('[aria-label="Disable replay sound"]')).not.toBeNull();
  [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find(b=>b.textContent==="live")!.click();
  expect(close).toHaveBeenCalledOnce();
  btn.click();expect(document.querySelector('[aria-label="Enable replay sound"]')).not.toBeNull();
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

test("leaving Files aborts its pending history request", async () => {
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
  let fileSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/artifacts/files")) {
        fileSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => {});
      }
      return new Response(
        JSON.stringify(
          url.endsWith("/health")
            ? { status: "ok", schema_version: 1 }
            : url.endsWith("/attention")
              ? { sessions: [], warnings: [] }
              : [],
        ),
      );
    }),
  );
  await import("./main");
  const nav = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".nav-btn")].find(
      (b) => b.textContent === name,
    )!;
  nav("files").click();
  expect(fileSignal).toBeDefined();
  expect(fileSignal?.aborted).toBe(false);
  nav("live").click();
  expect(fileSignal?.aborted).toBe(true);
});
