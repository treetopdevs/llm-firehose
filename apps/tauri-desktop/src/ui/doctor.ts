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
  onInspectWarning?: (eventId: string) => void;
  onInspectGap?: (gap: { source: string; time: string; summary: string }) => void;
}

// Adapter wiring status from /doctor, with one-click install per adapter, and the capture warnings.
export function createDoctor(deps: DoctorDeps = {}): { root: HTMLElement; refresh(): void; redraw(): void } {
  const root = el("section", { class: "doctor", tabindex: "-1", "aria-label": "Doctor" });
  const heading = el("h2", {}, "Doctor");
  const warningsBox = el("div", { class: "doctor-warnings" });

  /** Capture warnings and gaps: never part of the Needs you queue or its count, always here and on the sidebar badge. */
  function paintWarnings(): void {
    const { gaps, warnings } = deps.issues?.() ?? { gaps: [], warnings: [] };
    warningsBox.replaceChildren(el("h3", {}, "capture warnings"));
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
      inspect.addEventListener("click", () => deps.onInspectWarning?.(w.event_id));
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
    root.replaceChildren(heading, el("p", { class: "dim" }, "running checks…"));
    try {
      const checks = await doctor();
      root.replaceChildren(heading);
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
      root.append(list);
      paintWarnings();
      root.append(warningsBox);

      const status = el("p", { class: "install-status dim" }, "");
      const buttons = el("div", { class: "doctor-actions" });
      for (const adapter of INSTALLABLE) {
        const btn = el("button", {}, `install ${adapter}`);
        btn.addEventListener("click", () => runAdapterInstall(adapter, status, { onDone: refresh }));
        buttons.append(btn);
      }
      root.append(el("h3", {}, "adapters"), buttons, status);
    } catch (err) {
      root.replaceChildren(heading, el("p", { class: "error" }, failureMessage("run the setup checks", err)));
    }
  }

  return { root, refresh, redraw: paintWarnings };
}
