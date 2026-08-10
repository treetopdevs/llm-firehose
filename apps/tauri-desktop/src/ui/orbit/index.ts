import { sessions } from "../../api";
import type { FirehoseEvent, SessionSummary } from "../../api";
import { clear, el } from "../../dom";
import { applyActivity, applyTransition, buildScene } from "./model";
import type { OrbitBody } from "./model";
import { createOrbitScene } from "./scene";
import type { OrbitScene } from "./scene";

export type OrbitPanel = {
  root: HTMLElement;
  refresh(): void;
  onEvent(ev: FirehoseEvent): void;
  dispose(): void;
};

export function createOrbit(onOpenSession: (id: string) => void): OrbitPanel {
  const canvasHost = el("div", { class: "orbit-canvas-host" });
  const hoverCard = el("div", { class: "orbit-hover hidden" });
  const root = el("section", { class: "orbit" }, canvasHost, hoverCard);

  let scene: OrbitScene | null = null;
  let bodies: OrbitBody[] = [];
  let summaries: SessionSummary[] = [];
  let refreshGen = 0;

  function ensureScene() {
    if (!scene) {
      scene = createOrbitScene(canvasHost);
      scene.canvas.addEventListener("click", (e) => {
        const id = scene?.pick(e.clientX, e.clientY);
        if (id && !id.startsWith("cluster:")) {
          onOpenSession(id);
        }
      });
      scene.canvas.addEventListener("pointermove", (e) => {
        const id = scene?.pick(e.clientX, e.clientY) ?? null;
        scene?.setHover(id);
        showHover(id, e.clientX, e.clientY);
      });
      scene.canvas.addEventListener("pointerleave", () => {
        scene?.setHover(null);
        hoverCard.classList.add("hidden");
      });
    }
  }

  function showHover(id: string | null, x: number, y: number) {
    if (!id) {
      hoverCard.classList.add("hidden");
      return;
    }
    const body = bodies.find((b) => b.sessionId === id);
    if (!body) {
      hoverCard.classList.add("hidden");
      return;
    }
    clear(hoverCard);
    const title =
      body.kind === "cluster"
        ? `${body.memberCount ?? "?"} sessions · ${body.repo || "no repo"}`
        : `${body.family}${body.repo ? ` · ${body.repo}` : ""}`;
    hoverCard.append(
      el("div", { class: "orbit-hover-title" }, title),
      el("div", {}, body.state + (body.hasError ? " · error" : "")),
    );
    if (body.reason) {
      hoverCard.append(el("div", { class: "orbit-hover-reason" }, body.reason));
    }
    if (body.lastSummary) {
      const when = body.lastActivityAt ? new Date(body.lastActivityAt).toLocaleTimeString() : "";
      hoverCard.append(
        el("div", { class: "orbit-hover-activity" }, body.lastSummary),
        el("div", { class: "orbit-hover-time dim" }, [body.lastCategory, when].filter(Boolean).join(" · ")),
      );
    }
    hoverCard.classList.remove("hidden");
    const rect = root.getBoundingClientRect();
    hoverCard.style.left = `${Math.min(x - rect.left + 12, rect.width - 220)}px`;
    hoverCard.style.top = `${Math.min(y - rect.top + 12, rect.height - 80)}px`;
  }

  function paintLabels() {
    // Always-on labels for needs_input: reuse hover card style as pinned chips.
    for (const old of root.querySelectorAll(".orbit-label")) {
      old.remove();
    }
    if (!scene) return;
    const rect = root.getBoundingClientRect();
    for (const body of bodies) {
      if (!body.labelAlways) continue;
      const label = el(
        "div",
        { class: "orbit-label" },
        body.reason || "needs input",
      );
      // Approximate screen position from polar coords (matches tilted view roughly).
      const r = body.urgencyRadius;
      const cx = rect.width / 2 + Math.cos(body.sectorAngle) * r * Math.min(rect.width, rect.height) * 0.35;
      const cy = rect.height / 2 + Math.sin(body.sectorAngle) * r * Math.min(rect.width, rect.height) * 0.28;
      label.style.left = `${cx}px`;
      label.style.top = `${cy}px`;
      root.append(label);
    }
  }

  async function refresh() {
    ensureScene();
    const gen = ++refreshGen;
    try {
      const next = await sessions();
      if (gen !== refreshGen) return;
      summaries = next;
      bodies = buildScene(summaries, Date.now());
      scene?.sync(bodies);
      paintLabels();
    } catch (err) {
      if (gen !== refreshGen) return;
      clear(hoverCard);
      hoverCard.classList.remove("hidden");
      hoverCard.append(el("div", { class: "error" }, String(err)));
    }
  }

  function onEvent(ev: FirehoseEvent) {
    if (!scene) return;
    if (ev.source === "firehose" && ev.name === "state.transition") {
      bodies = applyTransition(bodies, ev, Date.now());
      scene.sync(bodies);
      paintLabels();
      return;
    }
    bodies = applyActivity(bodies, ev);
    scene.sync(bodies);
    if (ev.session_id && (ev.category === "message" || ev.category === "tool" || ev.category === "file" || ev.category === "shell")) {
      scene.spark(ev.session_id, ev.category);
    }
  }

  function dispose() {
    refreshGen++;
    scene?.dispose();
    scene = null;
  }

  return { root, refresh, onEvent, dispose };
}
