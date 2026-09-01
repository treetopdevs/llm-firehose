import * as THREE from "three";
import type { OrbitBody } from "./model";

const FAMILY_HUE: Record<string, number> = {
  "claude-code": 0.58,
  claude: 0.58,
  codex: 0.33,
  opencode: 0.78,
  antigravity: 0.13,
  cluster: 0.1,
};

type MeshEntry = {
  mesh: THREE.Mesh;
  halo?: THREE.Mesh;
  target: THREE.Vector3;
  color: THREE.Color;
  body: OrbitBody;
};

const ORBIT_SCALE = 8;

/**
 * Last gate before THREE. A body with non-finite geometry puts a mesh at a NaN
 * position that no lerp recovers and that corrupts every later raycast.
 */
export function isRenderableBody(b: OrbitBody): boolean {
  return (
    b.sessionId !== "" &&
    Number.isFinite(b.urgencyRadius) &&
    b.urgencyRadius >= 0 &&
    Number.isFinite(b.sectorAngle) &&
    Number.isFinite(b.activityRate)
  );
}

export type OrbitScene = {
  canvas: HTMLCanvasElement;
  sync(bodies: OrbitBody[]): void;
  spark(sessionId: string, category: string): void;
  pick(clientX: number, clientY: number): string | null;
  setHover(sessionId: string | null): void;
  dispose(): void;
};

export function createOrbitScene(container: HTMLElement): OrbitScene {
  const canvas = document.createElement("canvas");
  canvas.className = "orbit-canvas";
  container.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0d1117, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 10, 14);
  camera.lookAt(0, 0, 0);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(5, 12, 8);
  scene.add(key);

  // Quiet core at origin.
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0x30363d, emissive: 0x161b22 }),
  );
  scene.add(core);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(ORBIT_SCALE * 0.4, ORBIT_SCALE * 1.05, 64),
    new THREE.MeshBasicMaterial({ color: 0x21262d, side: THREE.DoubleSide, transparent: true, opacity: 0.35 }),
  );
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);

  const entries = new Map<string, MeshEntry>();
  const sparks: { mesh: THREE.Mesh; life: number }[] = [];
  const sparkGeoMessage = new THREE.SphereGeometry(0.055, 6, 6);
  const sparkGeoDefault = new THREE.SphereGeometry(0.08, 6, 6);
  const MAX_SPARKS = 64;
  const HALO_OPACITY = 0.22;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoverId: string | null = null;
  let running = true;
  let raf = 0;
  let contextLost = false;
  let disposed = false;

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // preventDefault() is load-bearing: without it the browser never fires
  // webglcontextrestored.
  const onContextLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
  };
  const onContextRestored = () => {
    contextLost = false;
    resize();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  function colorFor(body: OrbitBody): THREE.Color {
    if (body.state === "needs_input") return new THREE.Color(0xff9f43);
    if (body.hasError) return new THREE.Color(0xf85149);
    const hue = FAMILY_HUE[body.family] ?? FAMILY_HUE[body.family.split(" ")[0]] ?? 0.5;
    const sat = body.state === "idle" ? 0.25 : 0.65;
    const light = body.state === "idle" ? 0.35 : 0.55;
    return new THREE.Color().setHSL(hue, sat, light);
  }

  function targetPos(body: OrbitBody): THREE.Vector3 {
    const r = body.urgencyRadius * ORBIT_SCALE;
    return new THREE.Vector3(
      Math.cos(body.sectorAngle) * r,
      body.state === "needs_input" ? 0.4 : 0,
      Math.sin(body.sectorAngle) * r,
    );
  }

  function disposeHalo(halo: THREE.Mesh) {
    halo.geometry.dispose();
    (halo.material as THREE.Material).dispose();
  }

  function sync(bodies: OrbitBody[]) {
    if (disposed) return;
    const seen = new Set<string>();
    for (const body of bodies) {
      if (!isRenderableBody(body)) continue;
      if (body.despawnAt && Date.now() > body.despawnAt) continue;
      seen.add(body.sessionId);
      let entry = entries.get(body.sessionId);
      const size = body.kind === "cluster" ? 0.55 : 0.25 + body.activityRate * 0.35;
      if (!entry) {
        const geom = new THREE.SphereGeometry(1, 20, 20);
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.sessionId = body.sessionId;
        scene.add(mesh);
        entry = {
          mesh,
          target: targetPos(body),
          color: colorFor(body),
          body,
        };
        mesh.position.copy(entry.target);
        entries.set(body.sessionId, entry);
      }
      entry.body = body;
      entry.target = targetPos(body);
      entry.color = colorFor(body);
      entry.mesh.scale.setScalar(size);
      (entry.mesh.material as THREE.MeshStandardMaterial).color.copy(entry.color);
      (entry.mesh.material as THREE.MeshStandardMaterial).emissive.copy(entry.color).multiplyScalar(
        body.state === "needs_input" ? 0.45 : 0.08,
      );

      if (body.state === "needs_input" || body.hasError) {
        if (!entry.halo) {
          const halo = new THREE.Mesh(
            new THREE.SphereGeometry(1.6, 16, 16),
            new THREE.MeshBasicMaterial({
              color: 0xff9f43,
              transparent: true,
              opacity: HALO_OPACITY,
              depthWrite: false,
            }),
          );
          entry.mesh.add(halo);
          entry.halo = halo;
        }
        const haloColor = body.hasError && body.state !== "needs_input" ? 0xf85149 : 0xff9f43;
        (entry.halo.material as THREE.MeshBasicMaterial).color.setHex(haloColor);
        entry.halo.visible = true;
      } else if (entry.halo) {
        entry.halo.visible = false;
        entry.halo.scale.setScalar(1);
        (entry.halo.material as THREE.MeshBasicMaterial).opacity = HALO_OPACITY;
      }
    }
    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        scene.remove(entry.mesh);
        if (entry.halo) {
          entry.mesh.remove(entry.halo);
          disposeHalo(entry.halo);
        }
        entry.mesh.geometry.dispose();
        (entry.mesh.material as THREE.Material).dispose();
        entries.delete(id);
      }
    }
  }

  function spark(sessionId: string, category: string) {
    if (disposed) return;
    const entry = entries.get(sessionId);
    if (!entry) return;
    const c =
      category === "file" ? 0xd29922
        : category === "shell" ? 0x3fb950
          : category === "tool" ? 0x58a6ff
            : 0x8b949e;
    const geom = category === "message" ? sparkGeoMessage : sparkGeoDefault;
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({ color: c, transparent: true }),
    );
    mesh.position.copy(entry.mesh.position);
    scene.add(mesh);
    sparks.push({ mesh, life: 1 });
    while (sparks.length > MAX_SPARKS) {
      const oldest = sparks.shift();
      if (!oldest) break;
      scene.remove(oldest.mesh);
      (oldest.mesh.material as THREE.Material).dispose();
    }
  }

  function pick(clientX: number, clientY: number): string | null {
    if (disposed) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const meshes = [...entries.values()].map((e) => e.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.sessionId as string) ?? null;
  }

  function setHover(sessionId: string | null) {
    hoverId = sessionId;
  }

  function tick() {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden || !canvas.isConnected || contextLost) return;

    const t = performance.now() / 1000;
    for (const entry of entries.values()) {
      entry.mesh.position.lerp(entry.target, 0.08);
      if (entry.body.state === "needs_input" && entry.halo) {
        const pulse = 1.4 + Math.sin(t * 4) * 0.25;
        entry.halo.scale.setScalar(pulse);
        (entry.halo.material as THREE.MeshBasicMaterial).opacity = 0.15 + Math.sin(t * 4) * 0.1;
      } else if (entry.halo && entry.body.state !== "needs_input") {
        entry.halo.scale.setScalar(1);
        (entry.halo.material as THREE.MeshBasicMaterial).opacity = HALO_OPACITY;
      }
      if (entry.body.state !== "needs_input" && entry.body.state !== "idle" && entry.body.state !== "done") {
        // Slow orbital drift for working agents.
        const angle = entry.body.sectorAngle + t * 0.15 * (0.4 + entry.body.activityRate);
        const r = entry.body.urgencyRadius * ORBIT_SCALE;
        entry.target.set(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      }
      const baseSize = entry.body.kind === "cluster" ? 0.55 : 0.25 + entry.body.activityRate * 0.35;
      const hoverBoost = hoverId === entry.body.sessionId ? 1.15 : 1;
      entry.mesh.scale.setScalar(baseSize * hoverBoost);
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= 0.04;
      s.mesh.position.y += 0.05;
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, s.life);
      if (s.life <= 0) {
        scene.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        sparks.splice(i, 1);
      }
    }
    try {
      renderer.render(scene, camera);
    } catch {
      // A lost context otherwise throws on every frame forever.
      contextLost = true;
    }
  }
  tick();

  function dispose() {
    if (disposed) return;
    disposed = true;
    running = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    for (const entry of entries.values()) {
      scene.remove(entry.mesh);
      if (entry.halo) {
        entry.mesh.remove(entry.halo);
        disposeHalo(entry.halo);
      }
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    entries.clear();
    for (const s of sparks) {
      scene.remove(s.mesh);
      (s.mesh.material as THREE.Material).dispose();
    }
    sparks.length = 0;
    sparkGeoMessage.dispose();
    sparkGeoDefault.dispose();
    core.geometry.dispose();
    (core.material as THREE.Material).dispose();
    ring.geometry.dispose();
    (ring.material as THREE.Material).dispose();
    renderer.dispose();
    canvas.remove();
  }

  return { canvas, sync, spark, pick, setHover, dispose };
}
