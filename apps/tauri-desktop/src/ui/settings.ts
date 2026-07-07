import { exportNDJSON, getConfig, setConfig } from "../api";
import { clear, el } from "../dom";

const MODES: Array<{ mode: string; blurb: string }> = [
  { mode: "minimal", blurb: "payload values stored as {sha256, len} digests only" },
  { mode: "balanced", blurb: "payload strings truncated to 240 chars, raw payloads dropped" },
  { mode: "full", blurb: "everything, including raw source payloads" },
];

// Engine settings: privacy mode (applied live via POST /config), spool
// location, and NDJSON export.
export function createSettings(): { root: HTMLElement; refresh(): void } {
  const root = el("section", { class: "settings" });

  async function saveMode(mode: string, status: HTMLElement) {
    try {
      const res = await setConfig({ privacy_mode: mode });
      status.textContent =
        res.restart_required.length > 0
          ? `saved; restart daemon for: ${res.restart_required.join(", ")}`
          : `saved — privacy mode is now ${mode}`;
    } catch (err) {
      status.textContent = String(err);
      status.classList.add("error");
    }
  }

  async function downloadExport(status: HTMLElement) {
    status.textContent = "exporting…";
    try {
      const blob = await exportNDJSON();
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const a = el("a", { href: url, download: `firehose-export-${stamp}.ndjson` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      status.textContent = "export downloaded";
    } catch (err) {
      status.textContent = String(err);
      status.classList.add("error");
    }
  }

  async function refresh() {
    clear(root);
    root.append(el("p", { class: "dim" }, "loading config…"));
    try {
      const cfg = await getConfig();
      clear(root);
      root.append(el("h2", {}, "settings"));

      const status = el("p", { class: "dim" }, "");
      const modes = el("div", { class: "settings-modes" });
      for (const { mode, blurb } of MODES) {
        const input = el("input", {
          type: "radio",
          name: "privacy",
          value: mode,
          id: `mode-${mode}`,
        }) as HTMLInputElement;
        input.checked = cfg.privacy_mode === mode;
        input.addEventListener("change", () => saveMode(mode, status));
        modes.append(
          el(
            "label",
            { class: "mode-option", for: `mode-${mode}` },
            input,
            el("strong", {}, mode),
            el("span", { class: "dim" }, ` — ${blurb}`),
          ),
        );
      }
      root.append(el("h3", {}, "privacy mode"), modes, status);

      const info = el("dl", { class: "settings-info" });
      const add = (label: string, value: string | undefined) => {
        if (!value) return;
        info.append(el("dt", {}, label), el("dd", { class: "mono" }, value));
      };
      add("spool directory", cfg.spool_dir);
      add("daemon address", cfg.daemon_addr);
      add("codex sessions", cfg.codex_sessions_dir);
      root.append(el("h3", {}, "engine"), info);

      const exportStatus = el("p", { class: "dim" }, "");
      const exportBtn = el("button", {}, "export all events (NDJSON)");
      exportBtn.addEventListener("click", () => downloadExport(exportStatus));
      root.append(el("h3", {}, "export"), exportBtn, exportStatus);
    } catch (err) {
      clear(root);
      root.append(el("p", { class: "error" }, String(err)));
    }
  }

  return { root, refresh };
}
