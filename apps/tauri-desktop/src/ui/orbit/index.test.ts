// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from "vitest";

// The panel's failure handling is the thing under test, so the scene is a stub
// we can make throw on demand. A real createOrbitScene needs WebGL, which no
// test environment here provides.
const createOrbitScene = vi.fn();
vi.mock("./scene", () => ({ createOrbitScene: (host: HTMLElement) => createOrbitScene(host) }));

const sessions = vi.fn();
vi.mock("../../api", () => ({ sessions: () => sessions() }));

import { createOrbit } from "./index";

type StubScene = {
  canvas: HTMLCanvasElement;
  sync: ReturnType<typeof vi.fn>;
  spark: ReturnType<typeof vi.fn>;
  pick: ReturnType<typeof vi.fn>;
  setHover: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

function stubScene(host: HTMLElement): StubScene {
  const canvas = document.createElement("canvas");
  host.append(canvas);
  return {
    canvas,
    sync: vi.fn(),
    spark: vi.fn(),
    pick: vi.fn(() => null),
    setHover: vi.fn(),
    dispose: vi.fn(),
  };
}

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    family: "claude-code",
    repo: "demo",
    state: "working",
    state_since: new Date().toISOString(),
    last_time: new Date().toISOString(),
    events: 3,
    has_error: false,
    ...over,
  };
}

function transition(sessionId = "s1") {
  return {
    id: "e1",
    time: new Date().toISOString(),
    source: "firehose",
    category: "meta",
    name: "state.transition",
    session_id: sessionId,
    payload: { state: "needs_input", reason: "waiting" },
  } as never;
}

function fallbackText(panel: { root: HTMLElement }) {
  return panel.root.querySelector(".orbit-fallback")?.textContent ?? null;
}

beforeEach(() => {
  createOrbitScene.mockReset();
  sessions.mockReset();
  sessions.mockResolvedValue([summary()]);
});

describe("createOrbit renderer failure", () => {
  test("renders a fallback instead of a blank pane when the scene cannot be built", async () => {
    // Orbit is the default panel, so a machine without WebGL used to get a
    // permanently empty pane and an unhandled rejection with no message.
    createOrbitScene.mockImplementation(() => {
      throw new Error("WebGL unavailable");
    });
    const panel = createOrbit(() => {});

    await expect(panel.refresh()).resolves.toBeUndefined();

    expect(fallbackText(panel)).toBe("3D orbit unavailable");
    expect(panel.root.querySelector("canvas")).toBeNull();
  });

  test("does not retry a failed scene on every refresh", async () => {
    createOrbitScene.mockImplementation(() => {
      throw new Error("WebGL unavailable");
    });
    const panel = createOrbit(() => {});

    await panel.refresh();
    await panel.refresh();
    await panel.refresh();

    expect(createOrbitScene).toHaveBeenCalledTimes(1);
    expect(panel.root.querySelectorAll(".orbit-fallback")).toHaveLength(1);
  });

  test("retries after dispose so one transient failure does not kill the panel", async () => {
    createOrbitScene.mockImplementationOnce(() => {
      throw new Error("WebGL unavailable");
    });
    const panel = createOrbit(() => {});
    await panel.refresh();
    expect(fallbackText(panel)).toBe("3D orbit unavailable");

    // main.ts disposes and recreates the panel on every switch away from orbit.
    panel.dispose();
    createOrbitScene.mockImplementation((host: HTMLElement) => stubScene(host));
    await panel.refresh();

    expect(createOrbitScene).toHaveBeenCalledTimes(2);
    expect(fallbackText(panel)).toBeNull();
    expect(panel.root.querySelector("canvas")).not.toBeNull();
  });

  test("falls back when the renderer throws during refresh, and disposes the dead scene", async () => {
    let scene: StubScene | null = null;
    createOrbitScene.mockImplementation((host: HTMLElement) => {
      scene = stubScene(host);
      scene.sync.mockImplementation(() => {
        throw new Error("context lost");
      });
      return scene;
    });
    const panel = createOrbit(() => {});

    await panel.refresh();

    expect(fallbackText(panel)).toBe("3D orbit unavailable");
    expect(scene!.dispose).toHaveBeenCalledTimes(1);
    // A renderer failure must not be reported through the hover card, which is
    // where fetch errors land.
    expect(panel.root.querySelector(".orbit-hover .error")).toBeNull();
  });

  test("falls back when the renderer throws inside onEvent instead of escaping to the SSE handler", async () => {
    let scene: StubScene | null = null;
    createOrbitScene.mockImplementation((host: HTMLElement) => {
      scene = stubScene(host);
      return scene;
    });
    const panel = createOrbit(() => {});
    await panel.refresh();
    expect(fallbackText(panel)).toBeNull();

    scene!.sync.mockImplementation(() => {
      throw new Error("context lost");
    });

    expect(() => panel.onEvent(transition())).not.toThrow();
    expect(fallbackText(panel)).toBe("3D orbit unavailable");
    expect(scene!.dispose).toHaveBeenCalledTimes(1);
  });

  test("still reports fetch failures through the hover card, not the scene fallback", async () => {
    createOrbitScene.mockImplementation((host: HTMLElement) => stubScene(host));
    sessions.mockRejectedValue(new Error("daemon down"));
    const panel = createOrbit(() => {});

    await panel.refresh();

    expect(fallbackText(panel)).toBeNull();
    expect(panel.root.querySelector(".orbit-hover .error")?.textContent).toContain("daemon down");
  });
});
