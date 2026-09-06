import { attention, capturedEvent } from "../api";
import type {
  AttentionSnapshot,
  AttentionSession,
  FirehoseEvent,
} from "../api";
import { clear, el, keepFocus } from "../dom";
import { workspaceLabel } from "../format";
import { formatAge } from "../spark";

import { createAttentionPreferences } from "./attention-preferences";
import type { LocalStorage } from "./attention-preferences";

import { desktopNotifications } from "../notifications";
import type { NotificationDelivery } from "../notifications";

export type AttentionOptions = {
  notifications?: NotificationDelivery;
  storage?: LocalStorage;
  onSelect(ev: FirehoseEvent): void;
  onOpenSession(id: string, source?: string): void;
  onDoctor(): void;
  onOpenInbox(): void;
};

export function createAttention(options: AttentionOptions) {
  const prefs = createAttentionPreferences(options.storage);
  const notifications = options.notifications ?? desktopNotifications;
  let initialized = false;
  let notificationMessage = "";
  let enabling = false;
  const notifyButton = el("button", {}, "Enable desktop notifications");
  const notificationStatus = el("p", { class: "dim", role: "status" });
  notifyButton.addEventListener("click", async () => {
    if (enabling) return;
    if (prefs.enabled) {
      prefs.setEnabled(false);
      notificationMessage = "Desktop notifications disabled.";
      render();
      return;
    }
    enabling = true;
    notifyButton.disabled = true;
    try {
      const granted = await notifications.enable();
      if (disposed) return;
      prefs.setEnabled(granted);
      prefs.markNotified(
        snapshot.sessions.filter((s) => s.pending).map(episodeKey),
      );
      notificationMessage = granted
        ? "Enabled while this app is open. Messages omit captured content and paths."
        : "Permission denied. Allow notifications in system settings to enable them.";
    } catch {
      notificationMessage =
        "Desktop notifications unavailable. Use the desktop app and check system notification settings.";
    } finally {
      enabling = false;
      if (!disposed) render();
    }
  });
  const episodeKey = (s: AttentionSession) =>
    JSON.stringify([s.source, s.id, s.pending?.event_id]);
  const strip = el("section", {
    class: "attention-strip",
    "aria-label": "Attention status",
  });
  const rows = el("div", { class: "attention-rows" });
  const status = el("p", { class: "dim", role: "status" });
  let history = false;
  const working = el("button", { "aria-pressed": "true" }, "Working set");
  const historyButton = el("button", { "aria-pressed": "false" }, "History");
  const search = el("input", {
    type: "search",
    placeholder: "Search sessions and reasons…",
    "aria-label": "Search attention",
  });
  const source = el("select", { "aria-label": "Source" });
  const workspace = el("select", { "aria-label": "Workspace" });
  const where = (s: AttentionSession) => s.worktree_id || s.cwd || s.repo || "";
  working.addEventListener("click", () => {
    history = false;
    render();
  });
  historyButton.addEventListener("click", () => {
    history = true;
    render();
  });
  search.addEventListener("input", render);
  source.addEventListener("change", render);
  workspace.addEventListener("change", render);
  const filters = el(
    "div",
    { class: "attention-filters" },
    working,
    historyButton,
    search,
    source,
    workspace,
  );
  const root = el(
    "section",
    { class: "attention-inbox" },
    el("h2", {}, "Attention inbox"),
    filters,
    notifyButton,
    notificationStatus,
    status,
    rows,
  );
  let connected = true;
  let fresh = false;
  let disposed = false;
  let epoch = 0;
  let inFlight: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let snapshot: AttentionSnapshot = { sessions: [], warnings: [] };

  let inspection = 0;
  async function inspect(id: string) {
    const version = ++inspection;
    try {
      const ev = await capturedEvent(id);
      if (!disposed && version === inspection) options.onSelect(ev);
    } catch {
      if (!disposed && version === inspection)
        status.textContent =
          "Captured evidence is unavailable. Try again after reconnecting.";
    }
  }
  function row(s: AttentionSession) {
    const evidence = s.pending ?? s.last;
    const inspectButton = el(
      "button",
      { "data-key": `inspect:${episodeKey(s)}` },
      "Inspect evidence",
    );
    inspectButton.addEventListener(
      "click",
      () => void inspect(evidence.event_id),
    );
    const sessionButton = el(
      "button",
      { "data-key": `history:${episodeKey(s)}` },
      "Session history",
    );
    sessionButton.addEventListener("click", () =>
      options.onOpenSession(s.id, s.source),
    );
    const snooze = s.pending
      ? el(
          "button",
          { "data-key": `snooze:${episodeKey(s)}` },
          prefs.snoozed(episodeKey(s)) ? "Unsnooze" : "Snooze 15 minutes",
        )
      : null;
    snooze?.addEventListener("click", () => {
      const key = episodeKey(s);
      if (prefs.snoozed(key)) prefs.unsnooze(key);
      else prefs.snooze(key);
      render();
    });
    return el(
      "article",
      { class: "attention-row" },
      el("h3", {}, `${s.agent || s.source} · ${s.source} · ${s.id}`),
      el(
        "p",
        {},
        workspaceLabel(s.repo, s.worktree_id || s.cwd) || "Workspace unknown",
      ),
      el(
        "p",
        { class: "attention-kind" },
        s.pending
          ? s.pending.kind === "request"
            ? "Request captured"
            : "Session failure captured"
          : "Activity captured",
      ),
      el("p", {}, evidence.summary || "Captured activity"),
      el(
        "p",
        { class: "dim" },
        `${formatAge(Math.max(0, Date.now() - Date.parse(evidence.time)))} ago · ${s.pending ? "No later resolution captured" : s.state}`,
      ),
      el(
        "p",
        { class: "dim" },
        `${!Number.isFinite(Date.parse(s.last.time)) || Date.now() - Date.parse(s.last.time) > 30 * 60_000 ? "Stale observation · current state unknown" : "Last observed"} · ${formatAge(Math.max(0, Date.now() - Date.parse(s.last.observed_at)))} ago`,
      ),
      s.uncertainty ? el("p", { class: "dim" }, s.uncertainty) : null,
      inspectButton,
      sessionButton,
      snooze,
    );
  }
  function render() {
    const restore = keepFocus(root);
    const restoreStrip = keepFocus(strip);
    notifyButton.textContent = prefs.enabled
      ? "Disable desktop notifications"
      : "Enable desktop notifications";
    notifyButton.disabled = enabling;
    notificationStatus.textContent =
      notificationMessage ||
      "Desktop notifications are opt-in and require this app to stay open.";
    clear(rows);
    clear(strip);
    const pending = snapshot.sessions.filter((s) => s.pending);
    const snoozed = pending.filter((s) => prefs.snoozed(episodeKey(s))).length;
    const open = el(
      "button",
      { "data-key": "inbox" },
      `${pending.length - snoozed} needs attention · ${snoozed} snoozed`,
    );
    open.addEventListener("click", options.onOpenInbox);
    const doctor = el(
      "button",
      { "data-key": "doctor" },
      "Check capture setup",
    );
    doctor.addEventListener("click", options.onDoctor);
    strip.append(
      open,
      el(
        "span",
        { class: "dim" },
        `${!connected ? "Offline · " : !fresh ? "Snapshot unavailable · " : ""}${snapshot.warnings.length} capture warning(s) · Coverage depends on captured observations`,
      ),
      doctor,
    );
    working.setAttribute("aria-pressed", String(!history));
    historyButton.setAttribute("aria-pressed", String(history));
    function choices(
      select: HTMLSelectElement,
      values: string[],
      label: string,
    ) {
      const value = select.value;
      clear(select);
      select.append(el("option", { value: "" }, label));
      for (const v of [...new Set(values)].filter(Boolean).sort())
        select.append(el("option", { value: v }, v));
      select.value = value;
    }
    choices(
      source,
      snapshot.sessions.map((s) => s.source),
      "All sources",
    );
    choices(workspace, snapshot.sessions.map(where), "All workspaces");
    const term = search.value.trim().toLocaleLowerCase();
    const rank = (s: AttentionSession) =>
      s.pending
        ? prefs.snoozed(episodeKey(s))
          ? 2
          : s.pending.kind === "request"
            ? 0
            : 1
        : 3;
    const all = snapshot.sessions
      .filter(
        (s) =>
          (history ||
            s.pending ||
            (s.state !== "done" &&
              Date.now() - Date.parse(s.last.time) < 30 * 60_000)) &&
          (!source.value || source.value === s.source) &&
          (!workspace.value || workspace.value === where(s)) &&
          [
            s.id,
            s.source,
            s.agent,
            s.repo,
            where(s),
            s.pending?.summary,
            s.last.summary,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(term),
      )
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          Date.parse(b.last.time) - Date.parse(a.last.time) ||
          a.id.localeCompare(b.id),
      );
    for (const s of all) rows.append(row(s));
    for (const warning of snapshot.warnings.slice(0, 20)) {
      const inspectWarning = el(
        "button",
        { "data-key": `warning:${warning.event_id}` },
        "Inspect warning",
      );
      inspectWarning.addEventListener(
        "click",
        () => void inspect(warning.event_id),
      );
      rows.append(
        el(
          "article",
          { class: "capture-warning" },
          el("p", {}, `${warning.source}: ${warning.summary}`),
          el(
            "p",
            { class: "dim" },
            `Recorded ${formatAge(Math.max(0, Date.now() - Date.parse(warning.time)))} ago · recovery unknown`,
          ),
          inspectWarning,
        ),
      );
    }
    if (prefs.warning)
      rows.prepend(el("p", { class: "error", role: "status" }, prefs.warning));
    if (!all.length)
      rows.append(
        el(
          "p",
          { class: "dim" },
          snapshot.sessions.length
            ? "No sessions match this view."
            : "No sessions captured yet.",
        ),
      );
    restore();
    restoreStrip();
  }
  async function deliverNotifications(version: number) {
    for (const s of snapshot.sessions) {
      const key = episodeKey(s);
      const current = () =>
        !disposed &&
        connected &&
        fresh &&
        version === epoch &&
        prefs.enabled &&
        !prefs.notified(key) &&
        !prefs.snoozed(key) &&
        snapshot.sessions.some((v) => v.pending && episodeKey(v) === key);
      if (!s.pending || !current()) continue;
      const age = Date.now() - Date.parse(s.pending.time);
      if (!Number.isFinite(age) || age < 0 || age > 24 * 3600_000) {
        prefs.markNotified([key]);
        continue;
      }
      try {
        if (!(await notifications.granted())) {
          notificationMessage =
            "Notification permission unavailable. Check system notification settings.";
          render();
          return;
        }
        if (!current()) continue;
        // Record the attempt before delivery: an ambiguous crash cannot resend it.
        prefs.markNotified([key]);
        await notifications.send();
      } catch {
        notificationMessage =
          "A desktop notification could not be delivered. Inspect the inbox and check system notification settings.";
      }
      if (!disposed) render();
    }
  }
  async function load(version: number) {
    const controller = new AbortController();
    abort = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await attention(controller.signal);
      if (disposed || !connected || version !== epoch) return;
      snapshot = result;
      fresh = true;
      const keys = new Set(
        snapshot.sessions.filter((s) => s.pending).map(episodeKey),
      );
      prefs.retain(keys);
      if (!initialized || !prefs.enabled) prefs.markNotified([...keys]);
      initialized = true;
      status.textContent = `Snapshot checked at ${new Date(Date.now()).toLocaleTimeString()} · source coverage is not guaranteed`;
      render();
      // Release the network slot before OS permission checks, which can be slow.
      inFlight = null;
      await deliverNotifications(version);
    } catch {
      if (disposed || version !== epoch) return;
      fresh = false;
      status.textContent =
        "Attention unavailable — waiting for the local engine.";
      render();
    } finally {
      clearTimeout(timeout);
      if (abort === controller) abort = null;
    }
  }
  function refresh(): Promise<void> {
    if (disposed || !connected) return Promise.resolve();
    if (inFlight) return inFlight;
    const task = load(epoch).finally(() => {
      if (inFlight === task) inFlight = null;
    });
    inFlight = task;
    return task;
  }
  function setConnected(value: boolean) {
    if (connected === value || disposed) return;
    connected = value;
    fresh = false;
    epoch++;
    abort?.abort();
    inFlight = null;
    status.textContent = value
      ? "Refreshing attention…"
      : "Offline · displayed observations may be out of date.";
    render();
    if (value) void refresh();
  }
  const timer = setInterval(() => void refresh(), 3000);
  return {
    root,
    strip,
    refresh,
    setConnected,
    dispose() {
      disposed = true;
      epoch++;
      abort?.abort();
      clearInterval(timer);
    },
  };
}
