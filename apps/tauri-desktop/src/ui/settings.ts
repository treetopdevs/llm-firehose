import { DAEMON_URL, exportNDJSON, getConfig, setConfig } from "../api";
import { el } from "../dom";
import { failureMessage } from "../errors";
import { REPLAY_PITCHES } from "./score/sound";
import { replaySoundSetting } from "./score/sound-setting";

export const PRIVACY_MODES: Array<{ mode: string; blurb: string }> = [
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
  let repaintSound: () => void = () => {};
  replaySoundSetting.subscribe(() => repaintSound());

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
      status.textContent = failureMessage("save the privacy mode", err);
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
      status.textContent = failureMessage("export events", err);
      status.classList.add("error");
    }
  }

  /** MS-9: the Score's quiet tones are chosen here. Off by default; the Score reads the choice when playback starts. */
  function replaySoundControl(): HTMLElement {
    const box = el("input", { type: "checkbox", id: "replay-sound" }) as HTMLInputElement;
    box.checked = replaySoundSetting.get();
    box.addEventListener("change", () => replaySoundSetting.set(box.checked));
    const status = el("p", { class: "dim replay-sound-status", role: "status" });
    const paint = (): void => {
      box.checked = replaySoundSetting.get();
      status.textContent =
        replaySoundSetting.state() === "unavailable"
          ? "Replay sound is unavailable on this device. Playback still works; it tries again the next time you play."
          : box.checked
            ? "Tones play while a session replays."
            : "Off. A replay is silent.";
    };
    // One subscription per panel; refresh() rebuilds the control, so the latest one is the one repainted.
    repaintSound = paint;
    paint();
    const tones = Object.entries(REPLAY_PITCHES).map(([category, hz]) => `${category} ${hz} Hz`).join(", ");
    return el(
      "div",
      { class: "settings-sound" },
      el("label", { class: "mode-option", for: "replay-sound" }, box, el("strong", {}, "replay sound"), el("span", { class: "dim" }, ": quiet local tones while a session replays in the Score")),
      status,
      el("p", { class: "dim" }, `Tones: ${tones}; other 196 Hz. At most one latest crossed observation every 150 ms; dense events and first or final observations may be silent. This is not an error detector. Tones describe captured categories, not success. Leaving the Score, hiding the page or opening another session switches sound off until the next play.`),
    );
  }

  async function refresh() {
    root.replaceChildren(heading, el("p", { class: "dim" }, "loading config…"));
    try {
      const cfg = await getConfig();
      root.replaceChildren(heading);

      const status = el("p", { class: "dim" }, "");
      const modes = el("div", { class: "settings-modes" });
      for (const { mode, blurb } of PRIVACY_MODES) {
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

      root.append(el("h3", {}, "replay sound"), replaySoundControl());

      const exportStatus = el("p", { class: "dim" }, "");
      const exportBtn = el("button", {}, "export all events (NDJSON)");
      exportBtn.addEventListener("click", () => downloadExport(exportStatus));
      root.append(el("h3", {}, "export"), exportBtn, exportStatus);
    } catch (err) {
      // The sound choice is this device's own and needs no daemon, so it stays when the daemon's settings cannot be read.
      root.replaceChildren(heading, el("p", { class: "error" }, failureMessage("load settings", err)), el("h3", {}, "replay sound"), replaySoundControl());
    }
  }

  return { root, refresh };
}
