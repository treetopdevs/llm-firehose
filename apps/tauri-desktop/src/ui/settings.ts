import { DAEMON_URL, exportNDJSON, getConfig, setConfig } from "../api";
import { el } from "../dom";

const MODES: Array<{ mode: string; blurb: string }> = [
  { mode: "minimal", blurb: "payload values stored as {sha256, len} digests only" },
  { mode: "balanced", blurb: "payload strings truncated to 240 chars, raw payloads dropped" },
  { mode: "full", blurb: "everything, including raw source payloads" },
];

// Engine settings: privacy mode (applied live via POST /config), spool
// location, and NDJSON export.
export interface SettingsOptions {
  /** Fired once after a privacy-mode save succeeded; never when setConfig fails. */
  onPrivacyChanged?: (mode: string, saving?: unknown) => void | Promise<void>;
  /** Called synchronously before the save starts; its result is handed to onPrivacyChanged. */
  onPrivacySaving?: () => unknown;
}

export function createSettings(opts: SettingsOptions = {}): { root: HTMLElement; refresh(): void } {
  const root = el("section", { class: "settings" });
  const heading = el("h2", {}, "Settings");

  async function saveMode(mode: string, status: HTMLElement) {
    // The shell's failure must not stop the save, or the radio would misreport the mode.
    let saving: unknown;
    try {
      saving = opts.onPrivacySaving?.();
    } catch {
      /* onPrivacyChanged falls back to its own snapshot */
    }
    try {
      const res = await setConfig({ privacy_mode: mode });
      status.textContent =
        res.restart_required.length > 0
          ? `saved; restart daemon for: ${res.restart_required.join(", ")}`
          : `saved — privacy mode is now ${mode}`;
    } catch (err) {
      status.textContent = String(err);
      status.classList.add("error");
      return;
    }
    // After the save landed. The listener's own failure must not read as a failed save.
    try {
      await (opts.onPrivacySaving ? opts.onPrivacyChanged?.(mode, saving) : opts.onPrivacyChanged?.(mode));
    } catch {
      /* the shell reports its own remap failures */
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
    root.replaceChildren(heading, el("p", { class: "dim" }, "loading config…"));
    try {
      const cfg = await getConfig();
      root.replaceChildren(heading);

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
      root.append(
        el("h3", {}, "privacy mode"),
        modes,
        el(
          "p",
          { class: "dim" },
          "Modes govern captured history (spool, live stream, export). The graph shows readable names and remembers project roots in every mode.",
        ),
        status,
      );

      const info = el("dl", { class: "settings-info" });
      const add = (label: string, value: string | undefined) => {
        if (!value) return;
        info.append(el("dt", {}, label), el("dd", { class: "mono" }, value));
      };
      add("spool directory", cfg.spool_dir);
      // The address this app actually talks to; the configured one only shows when it differs.
      const actual = (() => { try { return new URL(DAEMON_URL).host; } catch { return DAEMON_URL; } })();
      add("daemon address", actual);
      if (cfg.daemon_addr && cfg.daemon_addr !== actual) add("configured address", cfg.daemon_addr);
      add("codex sessions", cfg.codex_sessions_dir);
      root.append(el("h3", {}, "engine"), info);

      const exportStatus = el("p", { class: "dim" }, "");
      const exportBtn = el("button", {}, "export all events (NDJSON)");
      exportBtn.addEventListener("click", () => downloadExport(exportStatus));
      root.append(el("h3", {}, "export"), exportBtn, exportStatus);
    } catch (err) {
      root.replaceChildren(heading, el("p", { class: "error" }, String(err)));
    }
  }

  return { root, refresh };
}
