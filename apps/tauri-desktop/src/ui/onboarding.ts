import { doctor, setConfig } from "../api";
import { clear, el } from "../dom";
import { failureMessage } from "../errors";
import { claimEscape } from "../escape";
import { runAdapterInstall } from "./install";
import { PRIVACY_MODES } from "./settings";

const ONBOARDED_KEY = "firehose-onboarded";

export function isOnboarded(): boolean {
  return localStorage.getItem(ONBOARDED_KEY) === "1";
}

// First-run overlay: pick a privacy mode, wire adapters, verify with doctor.
// Mirrors the CLI flow (install → doctor → view) for non-terminal users.
export function createOnboarding(onDone: () => void): HTMLElement {
  const overlay = el("div", { class: "onboarding-overlay" });
  const card = el("div", { class: "onboarding-card", role: "dialog", "aria-modal": "true", "aria-label": "Set up Agent Firehose" });
  overlay.append(card);

  // A radio group is one tab stop: its checked radio.
  const controls = () => [...card.querySelectorAll<HTMLElement>("input:checked, button:not(:disabled)")];
  /** Each step replaces the card's contents, so focus has to be put back inside it. */
  const focusStep = () => controls()[0]?.focus();

  // Document capture: it also sees keys when a click on dialog text left focus on body.
  function onKey(e: KeyboardEvent): void {
    if (!overlay.isConnected) {
      document.removeEventListener("keydown", onKey, true);
      return;
    }
    if (e.key === "Escape") {
      claimEscape(e);
      e.preventDefault();
    } else if (e.key === "Tab") {
      const stops = controls();
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (first && last && (e.shiftKey ? at === first || !card.contains(at) : at === last || !card.contains(at))) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
      return;
    }
    // Radios and buttons keep their native keys; only the app's shortcuts stop here.
    e.stopPropagation();
  }
  document.addEventListener("keydown", onKey, true);

  const finish = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    onDone();
  };

  function stepPrivacy() {
    clear(card);
    card.append(
      el("h2", {}, "Welcome to Agent Firehose"),
      el("p", {}, "A live timeline of what your AI coding agents are doing. Everything stays on this machine."),
      el("h3", {}, "1 / 3 — choose how much to capture"),
    );
    const status = el("p", { class: "dim", role: "status" }, "");
    for (const { mode, blurb } of PRIVACY_MODES) {
      const input = el("input", { type: "radio", name: "onboarding-privacy", value: mode, id: `onboarding-mode-${mode}` }) as HTMLInputElement;
      input.checked = mode === "balanced";
      card.append(el("label", { class: "mode-option", for: input.id }, input, el("strong", {}, mode), el("span", { class: "dim" }, ` — ${blurb}`)));
    }
    card.append(el("p", { class: "dim" }, "You can change this later in Settings."));
    const next = el("button", { class: "primary" }, "Continue");
    next.addEventListener("click", async () => {
      const mode = card.querySelector<HTMLInputElement>("input[name=onboarding-privacy]:checked")!.value;
      status.classList.remove("error");
      status.textContent = "saving…";
      next.disabled = true;
      try {
        await setConfig({ privacy_mode: mode });
        stepAdapters();
      } catch (err) {
        status.textContent = failureMessage("save your choice", err);
        status.classList.add("error");
        next.disabled = false;
        next.focus();
      }
    });
    card.append(next, status);
    focusStep();
  }

  function stepAdapters() {
    clear(card);
    card.append(
      el("h3", {}, "2 / 3 — wire up your agents"),
      el("p", { class: "dim" }, "Codex messages stream from local rollouts; hooks add lifecycle and tool activity. Codex will ask you to review hook trust in /hooks."),
    );
    const status = el("p", { class: "dim" }, "");
    for (const adapter of ["claude-code", "claude-otel", "codex", "opencode", "antigravity"]) {
      const btn = el("button", {}, `install ${adapter}`);
      btn.addEventListener("click", () => runAdapterInstall(adapter, status));
      card.append(btn);
    }
    const back = el("button", {}, "back");
    back.addEventListener("click", stepPrivacy);
    const next = el("button", { class: "primary" }, "next");
    next.addEventListener("click", stepVerify);
    card.append(status, back, next);
    focusStep();
  }

  async function stepVerify() {
    clear(card);
    card.append(el("h3", {}, "3 / 3 — verify"));
    const list = el("div", { class: "doctor-list" });
    card.append(list);
    try {
      const checks = await doctor();
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
    } catch (err) {
      list.append(el("p", { class: "error" }, failureMessage("run the setup checks", err)));
    }
    const done = el("button", { class: "primary" }, "start watching");
    done.addEventListener("click", finish);
    const skip = el("button", {}, "back");
    skip.addEventListener("click", stepAdapters);
    card.append(el("div", {}, skip, done));
    focusStep();
  }

  stepPrivacy();
  // The caller attaches the overlay after this returns, and detached nodes cannot take focus.
  queueMicrotask(focusStep);
  return overlay;
}
