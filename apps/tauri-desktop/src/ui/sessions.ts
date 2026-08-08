import { sessionEvents, sessions } from "../api";
import type { FirehoseEvent } from "../api";
import { clear, el } from "../dom";
import { shortPath } from "../format";
import { renderEventList } from "./feed";

export type SessionsPanel = {
  root: HTMLElement;
  refresh(): void;
  openSession(id: string): Promise<void>;
};

// Session explorer: summaries from /sessions, drill-down via /sessions/{id}.
export function createSessions(onSelect: (ev: FirehoseEvent) => void): SessionsPanel {
  const listBox = el("div", { class: "sessions-list" });
  const eventsBox = el("div", { class: "sessions-events" });
  const root = el("section", { class: "sessions" }, listBox, eventsBox);

  async function openSession(id: string) {
    clear(eventsBox);
    eventsBox.append(el("p", { class: "dim" }, `loading ${id}…`));
    try {
      const evs = await sessionEvents(id);
      clear(eventsBox);
      eventsBox.append(el("h3", {}, `session ${id} — ${evs.length} events`));
      renderEventList(eventsBox, evs, onSelect);
    } catch (err) {
      clear(eventsBox);
      eventsBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  async function refresh() {
    clear(listBox);
    listBox.append(el("p", { class: "dim" }, "loading sessions…"));
    try {
      const all = await sessions();
      clear(listBox);
      if (all.length === 0) {
        listBox.append(el("p", { class: "dim" }, "no sessions captured yet"));
        return;
      }
      for (const s of all) {
        const badges: HTMLElement[] = [];
        if (s.state === "needs_input") {
          badges.push(el("span", { class: "badge needs" }, "NEEDS YOU"));
        }
        if (s.has_error) {
          badges.push(el("span", { class: "badge err" }, "ERROR"));
        }
        if (s.state === "idle") {
          badges.push(el("span", { class: "badge idle" }, "idle"));
        }
        if (s.state === "done") {
          badges.push(el("span", { class: "badge dim" }, "done"));
        }
        const titleBits: (string | HTMLElement)[] = [
          `${s.source}${s.agent ? ` (${s.agent})` : ""} — ${s.events} events`,
          ...badges,
        ];
        const sub = [s.repo, s.cwd ? shortPath(s.cwd) : "", new Date(s.last_time).toLocaleString()]
          .filter(Boolean)
          .join(" · ");
        const reason = s.state_reason
          ? el("div", { class: "session-reason" }, s.state_reason)
          : null;
        const item = el(
          "div",
          { class: "session-item", tabindex: "0" },
          el("div", { class: "session-title" }, ...titleBits),
          el("div", { class: "session-sub" }, sub),
          ...(reason ? [reason] : []),
          el("div", { class: "session-id dim" }, s.id),
        );
        item.addEventListener("click", () => openSession(s.id));
        listBox.append(item);
      }
    } catch (err) {
      clear(listBox);
      listBox.append(el("p", { class: "error" }, String(err)));
    }
  }

  return { root, refresh, openSession };
}
