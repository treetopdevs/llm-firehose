// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as THREE from "three";

// happy-dom has no WebGL, so only the renderer is faked; the rest of THREE
// (scene graph, geometry, materials, raycaster) runs for real. vi.mock is
// hoisted above the imports, so the fake has to be built inside vi.hoisted.
const fake = vi.hoisted(() => {
  const instances: { disposeCalls: number; renderCalls: number }[] = [];
  class FakeRenderer {
    disposeCalls = 0;
    renderCalls = 0;
    constructor(public opts: { canvas: HTMLCanvasElement }) {
      instances.push(this);
    }
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    render() {
      this.renderCalls++;
    }
    dispose() {
      this.disposeCalls++;
    }
  }
  return { instances, FakeRenderer };
});

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return { ...actual, WebGLRenderer: fake.FakeRenderer };
});

import { createOrbitScene } from "./scene";
import type { OrbitBody } from "./model";

function body(over: Partial<OrbitBody> = {}): OrbitBody {
  return {
    sessionId: "s1",
    kind: "session",
    family: "claude-code",
    repo: "demo",
    state: "working",
    urgencyRadius: 1,
    sectorAngle: 0.5,
    activityRate: 0.5,
    labelAlways: false,
    hasError: false,
    ...over,
  } as OrbitBody;
}

let host: HTMLElement;

beforeEach(() => {
  fake.instances.length = 0;
  // happy-dom ships no ResizeObserver, which createOrbitScene observes with.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Keep the animation loop from running away inside the test.
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  vi.unstubAllGlobals();
  host.remove();
});

describe("createOrbitScene lifecycle", () => {
  test("dispose is idempotent", () => {
    const scene = createOrbitScene(host);
    scene.dispose();
    expect(() => scene.dispose()).not.toThrow();
    expect(fake.instances[0].disposeCalls).toBe(1);
    expect(host.querySelector("canvas")).toBeNull();
  });

  test("dispose releases the static core and ring props, not just the session meshes", () => {
    // These two leaked on every panel switch: main.ts recreates the panel each
    // time you leave and re-enter orbit.
    const disposed = new Set<object>();
    const geoSpy = vi
      .spyOn(THREE.BufferGeometry.prototype, "dispose")
      .mockImplementation(function (this: THREE.BufferGeometry) {
        disposed.add(this);
      });
    const matSpy = vi
      .spyOn(THREE.Material.prototype, "dispose")
      .mockImplementation(function (this: THREE.Material) {
        disposed.add(this);
      });
    try {
      const scene = createOrbitScene(host);
      scene.sync([body()]);
      scene.dispose();
      // Three meshes x (geometry + material): the core sphere, the orbit ring,
      // and the one synced session. Before the fix, core and ring were skipped.
      expect(disposed.size).toBeGreaterThanOrEqual(6);
    } finally {
      geoSpy.mockRestore();
      matSpy.mockRestore();
    }
  });

  test("sync adds nothing to the scene graph after dispose", () => {
    // Not merely "does not throw": before the disposed guard, a late sync()
    // attached a fresh mesh to a scene nobody would ever render or dispose
    // again — a leak on every panel switch that raced a pending refresh.
    const scene = createOrbitScene(host);
    scene.sync([body()]);
    scene.dispose();

    const added = vi.spyOn(THREE.Scene.prototype, "add");
    try {
      expect(() => scene.sync([body({ sessionId: "s2" })])).not.toThrow();
      expect(() => scene.spark("s1", "tool")).not.toThrow();
      expect(added).not.toHaveBeenCalled();
    } finally {
      added.mockRestore();
    }
  });

  test("pick short-circuits on a zero-size canvas instead of raycasting with NaN", () => {
    const scene = createOrbitScene(host);
    scene.sync([body()]);
    // happy-dom reports a 0x0 rect, which is also what a hidden panel reports.
    // Before the guard, pick() still computed NaN pointer coords and ran a
    // raycast with them; it only returned null because nothing intersects NaN.
    const cast = vi.spyOn(THREE.Raycaster.prototype, "setFromCamera");
    try {
      expect(scene.pick(10, 10)).toBeNull();
      expect(cast).not.toHaveBeenCalled();
    } finally {
      cast.mockRestore();
    }
  });
});

describe("createOrbitScene WebGL context loss", () => {
  test("preventDefault on webglcontextlost, which is what allows a restore", () => {
    const scene = createOrbitScene(host);
    const canvas = host.querySelector("canvas")!;

    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);

    // Without preventDefault the browser never fires webglcontextrestored.
    expect(lost.defaultPrevented).toBe(true);
    scene.dispose();
  });

  test("context listeners are removed on dispose", () => {
    const scene = createOrbitScene(host);
    const canvas = host.querySelector("canvas")!;
    scene.dispose();

    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);

    expect(lost.defaultPrevented).toBe(false);
  });
});
