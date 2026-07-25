import { doctor, install, setConfig } from "../api";
import { clear, el } from "../dom";

const ONBOARDED_KEY = "firehose-onboarded";

export function isOnboarded(): boolean {
  return localStorage.getItem(ONBOARDED_KEY) === "1";
}

// First-run overlay: pick a privacy mode, wire adapters, verify with doctor.
// Mirrors the CLI flow (install → doctor → view) for non-terminal users.
export function createOnboarding(onDone: () => void): HTMLElement {
  const overlay = el("div", { class: "onboarding-overlay" });
  const card = el("div", { class: "onboarding-card" });
  overlay.append(card);

  const finish = () => {
    localStorage.setItem(ONBOARDED_KEY, "1");
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
    const status = el("p", { class: "dim" }, "");
    for (const mode of ["minimal", "balanced", "full"]) {
      const btn = el("button", { class: mode === "balanced" ? "primary" : "" }, mode);
      btn.addEventListener("click", async () => {
        status.textContent = "saving…";
        try {
          await setConfig({ privacy_mode: mode });
          stepAdapters();
        } catch (err) {
          status.textContent = `could not save (is the engine running?): ${String(err)}`;
          status.classList.add("error");
        }
      });
      card.append(btn);
    }
    card.append(status);
  }

  function stepAdapters() {
    clear(card);
    card.append(
      el("h3", {}, "2 / 3 — wire up your agents"),
      el("p", { class: "dim" }, "Codex messages stream from local rollouts; hooks add lifecycle and tool activity. Codex will ask you to review hook trust in /hooks."),
    );
    const status = el("p", { class: "dim" }, "");
    for (const adapter of ["claude-code", "claude-otel", "codex", "opencode"]) {
      const btn = el("button", {}, `install ${adapter}`);
      btn.addEventListener("click", async () => {
        status.textContent = `installing ${adapter}…`;
        try {
          const res = await install(adapter);
          status.textContent = res.detail;
        } catch (err) {
          status.textContent = String(err);
          status.classList.add("error");
        }
      });
      card.append(btn);
    }
    const next = el("button", { class: "primary" }, "next");
    next.addEventListener("click", stepVerify);
    card.append(status, next);
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
            el("span", { class: "detail dim" }, c.detail),
          ),
        );
      }
    } catch (err) {
      list.append(el("p", { class: "error" }, String(err)));
    }
    const done = el("button", { class: "primary" }, "start watching");
    done.addEventListener("click", finish);
    const skip = el("button", {}, "back");
    skip.addEventListener("click", stepAdapters);
    card.append(el("div", {}, skip, done));
  }

  stepPrivacy();
  return overlay;
}
