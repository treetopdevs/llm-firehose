import { doctor } from "../api";
import { el } from "../dom";
import { failureMessage } from "../errors";
import type { AttentionEvidence } from "../api";
import { formatAge } from "../spark";
import { runAdapterInstall } from "./install";

const INSTALLABLE = ["claude-code", "claude-otel", "codex", "opencode", "antigravity"];

export interface DoctorDeps {
  /** The capture warnings and gaps of the last attention snapshot (MS-9: Doctor is where they are listed). */
  issues?: () => { gaps: readonly { source: string; time: string; summary: string }[]; warnings: readonly AttentionEvidence[] };
  /** Resolves false when the warning's evidence could not be shown; Doctor then says so itself, since the panel that reported it is not on screen. */
  onInspectWarning?: (eventId: string) => void | boolean | Promise<void | boolean>;
  onInspectGap?: (gap: { source: string; time: string; summary: string }) => void;
}

// Adapter wiring status from /doctor, with one-click install per adapter, and the capture warnings.
export function createDoctor(deps: DoctorDeps = {}): { root: HTMLElement; refresh(): void; redraw(): void } {
  const root = el("section", { class: "doctor", tabindex: "-1", "aria-label": "Doctor" });
  const heading = el("h2", {}, "Doctor");
  const warningsBox = el("div", { class: "doctor-warnings" });
  const checksBox = el("div", { class: "doctor-checks" });
  const adaptersBox = el("div", { class: "doctor-adapters" });
  const inspectStatus = el("p", { class: "error", role: "status" });
  inspectStatus.hidden = true;
  root.append(heading, checksBox, warningsBox, adaptersBox);

  /** Capture warnings and gaps: never part of the Needs you queue or its count, always here and on the sidebar badge. */
  function paintWarnings(): void {
    const { gaps, warnings } = deps.issues?.() ?? { gaps: [], warnings: [] };
    warningsBox.replaceChildren(el("h3", {}, "capture warnings"), inspectStatus);
    if (gaps.length + warnings.length === 0) {
      warningsBox.append(el("p", { class: "dim" }, "No capture warnings."));
      return;
    }
    for (const gap of gaps) {
      const inspect = el("button", { type: "button", "data-key": `gap:${gap.source}` }, "Inspect capture gap");
      inspect.addEventListener("click", () => deps.onInspectGap?.(gap));
      warningsBox.append(
        el("article", { class: "capture-warning" }, el("p", {}, gap.summary), el("p", { class: "dim" }, "Unreadable history · this diagnostic is not a captured event."), inspect),
      );
    }
    for (const w of warnings) {
      const inspect = el("button", { type: "button", "data-key": `warning:${w.event_id}` }, "Inspect warning");
      inspect.addEventListener("click", () => {
        inspectStatus.hidden = true;
        void Promise.resolve(deps.onInspectWarning?.(w.event_id)).then(
          (ok) => { if (ok === false) { inspectStatus.textContent = "Captured evidence for that warning is unavailable. Try again after reconnecting."; inspectStatus.hidden = false; } },
          () => { inspectStatus.textContent = "Captured evidence for that warning is unavailable. Try again after reconnecting."; inspectStatus.hidden = false; },
        );
      });
      warningsBox.append(
        el(
          "article",
          { class: "capture-warning" },
          el("p", {}, `${w.source}: ${w.summary}`),
          el("p", { class: "dim" }, `Recorded ${formatAge(Math.max(0, Date.now() - Date.parse(w.time)))} ago · recovery unknown`),
          inspect,
        ),
      );
    }
  }

  async function refresh() {
    checksBox.replaceChildren(el("p", { class: "dim" }, "running checks…"));
    adaptersBox.replaceChildren();
    paintWarnings();
    try {
      const checks = await doctor();
      const list = el("div", { class: "doctor-list" });
      for (const c of checks) {
        list.append(
          el(
            "div",
            { class: `doctor-check ${c.ok ? "ok" : "bad"}` },
            el("span", { class: "mark" }, c.ok ? "✓" : "✗"),
            el("span", { class: "name" }, c.name),
            el("span", { class: "doctor-detail dim" }, c.detail),
          ),
        );
      }
      checksBox.replaceChildren(list);
      paintWarnings();

      const status = el("p", { class: "install-status dim" }, "");
      const buttons = el("div", { class: "doctor-actions" });
      for (const adapter of INSTALLABLE) {
        const btn = el("button", {}, `install ${adapter}`);
        btn.addEventListener("click", () => runAdapterInstall(adapter, status, { onDone: refresh }));
        buttons.append(btn);
      }
      adaptersBox.replaceChildren(el("h3", {}, "adapters"), buttons, status);
    } catch (err) {
      checksBox.replaceChildren(el("p", { class: "error" }, failureMessage("run the setup checks", err)));
      adaptersBox.replaceChildren();
    }
  }

  return { root, refresh, redraw: paintWarnings };
}
