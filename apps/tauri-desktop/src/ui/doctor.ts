import { doctor } from "../api";
import { clear, el } from "../dom";
import { runAdapterInstall } from "./install";

const INSTALLABLE = ["claude-code", "claude-otel", "codex", "opencode", "antigravity"];

// Adapter wiring status from /doctor, with one-click install per adapter.
export function createDoctor(): { root: HTMLElement; refresh(): void } {
  const root = el("section", { class: "doctor" });

  async function refresh() {
    clear(root);
    root.append(el("p", { class: "dim" }, "running checks…"));
    try {
      const checks = await doctor();
      clear(root);
      root.append(el("h2", {}, "doctor"));
      const list = el("div", { class: "doctor-list" });
      for (const c of checks) {
        list.append(
          el(
            "div",
            { class: `doctor-check ${c.ok ? "ok" : "bad"}` },
            el("span", { class: "mark" }, c.ok ? "✓" : "✗"),
            el("span", { class: "name" }, c.name),
            el("span", { class: "detail dim" }, c.detail),
          ),
        );
      }
      root.append(list);

      const status = el("p", { class: "install-status dim" }, "");
      const buttons = el("div", { class: "doctor-actions" });
      for (const adapter of INSTALLABLE) {
        const btn = el("button", {}, `install ${adapter}`);
        btn.addEventListener("click", () => runAdapterInstall(adapter, status, { onDone: refresh }));
        buttons.append(btn);
      }
      root.append(el("h3", {}, "adapters"), buttons, status);
    } catch (err) {
      clear(root);
      root.append(el("p", { class: "error" }, String(err)));
    }
  }

  return { root, refresh };
}
