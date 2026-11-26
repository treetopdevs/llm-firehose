import { READ_DEADLINE_MS } from "../deadlines";
import { attention, capturedEvent } from "../api";
import type {
  AttentionEvidence,
  AttentionSnapshot,
  AttentionSession,
  FirehoseEvent,
} from "../api";
import { clear, el, keepFocus } from "../dom";
import { disambiguateSessionLabel, projectName, sessionName, workspaceLabel, worktreeName } from "../format";
import { needYouCount, pendingNow } from "../needs";
import { formatAge } from "../spark";
import { idChip } from "./session-id";

import { createAttentionPreferences } from "./attention-preferences";
import type { LocalStorage } from "./attention-preferences";

import { desktopNotifications } from "../notifications";
import type { NotificationDelivery } from "../notifications";
import { sessionRefKey } from "../scope";

export type AttentionOptions = {
  notifications?: NotificationDelivery;
  storage?: LocalStorage;
  onSelect(ev: FirehoseEvent): void;
  onOpenSession(id: string, source?: string): void;
  onDoctor(): void;
  onOpenInbox(): void;
  /** Every load hands over the sessions it names, so other panels can name them too. */
  onSessions?(list: readonly AttentionSession[]): void;
  /** Names from the scope resolver (roots, rows); a miss falls back to the format.ts folder/prefix rule. */
  labels?: {
    worktree(id?: string, repoId?: string): string | undefined;
    project(id?: string): string | undefined;
  };
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
    JSON.stringify([
      s.source,
      s.id,
      s.pending?.episode_id ?? s.pending?.event_id,
    ]);
  const strip = el("section", {
    class: "attention-strip",
    "aria-label": "Needs you status",
  });
  const rows = el("div", { class: "attention-rows" });
  const status = el("p", { class: "dim", role: "status" });
  let history = false;
  const working = el("button", { "aria-pressed": "true" }, "Working set");
  const historyButton = el("button", { "aria-pressed": "false" }, "History");
  const search = el("input", {
    type: "search",
    placeholder: "Search sessions and reasons…",
    "aria-label": "Search sessions",
  });
  const source = el("select", { "aria-label": "Source" });
  const workspace = el("select", { "aria-label": "Worktree" });
  const eventTime = (ev: AttentionEvidence) =>
    Date.parse(ev.source_time ?? ev.time);
  const where = (s: AttentionSession) => s.worktree_id || s.cwd || s.repo || "";
  const resolved = (f: ((id?: string, repoId?: string) => string | undefined) | undefined, id: string | undefined, repoId?: string): string | undefined => {
    if (!f || !id) return undefined;
    try { return f(id, repoId) || undefined; } catch { return undefined; }
  };
  /** The name of what where() returns: resolver, else the folder/prefix fallback. Never a bare 64-hex id. */
  const whereName = (s: AttentionSession): string => {
    const id = where(s);
    if (!id) return "";
    if (s.worktree_id) return worktreeName(id, resolved(options.labels?.worktree, id, s.repo_id)).label;
    if (s.cwd) return workspaceLabel(undefined, s.cwd);
    return s.repo ?? "";
  };
  const repoName = (s: AttentionSession): string => {
    if (s.repo) return s.repo;
    if (s.repo_id) return projectName(s.repo_id, resolved(options.labels?.project, s.repo_id)).label;
    return "";
  };
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
    el("h2", {}, "Needs you"),
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
  /** How many snapshots have been applied: an answer that began before a newer one is dropped. */
  let applied = 0;
  /** Waiting for the load in flight; settled before any slow notification work. */
  const readers = new Set<{ resolve(s: AttentionSnapshot): void; reject(e: unknown): void }>();
  const settleReaders = (error?: unknown, failed = false): void => {
    for (const r of [...readers]) {
      readers.delete(r);
      if (failed) r.reject(error);
      else r.resolve(snapshot);
    }
  };

  /** Pending episodes that are not snoozed: the number the strip shows. */
  let needing = 0;
  const countListeners = new Set<() => void>();
  let inspection = 0;
  /** True when the evidence was handed to the inspector; false when it could not be read; null when a newer selection superseded it (not a failure). */
  async function inspect(id: string): Promise<boolean | null> {
    const version = ++inspection;
    try {
      const ev = await capturedEvent(id);
      if (disposed || version !== inspection) return null;
      options.onSelect(ev);
      return true;
    } catch {
      if (disposed || version !== inspection) return null;
      status.textContent = "Captured evidence is unavailable. Try again after reconnecting.";
      return false;
    }
  }
  const keyOf = (s: AttentionSession) => sessionRefKey(s.source, s.id);
  /** Names of the whole snapshot, so two sessions with one title can be told apart. */
  let names: (readonly [string, string])[] = [];
  const nameOf = (s: AttentionSession) => disambiguateSessionLabel(keyOf(s), sessionName(s), names);
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
    const current = !!s.pending && pendingNow(s, Date.now());
    const snooze = current
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
      el("h3", {}, nameOf(s)),
      el("p", { class: "dim" }, `${s.agent || s.source} · ${s.source}`),
      idChip(s.id),
      el(
        "p",
        {},
        repoName(s) || whereName(s) || "Worktree unknown",
      ),
      el(
        "p",
        { class: "dim" },
        `Worktree: ${whereName(s) || "unknown"}`,
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
        `${formatAge(Math.max(0, Date.now() - eventTime(evidence)))} ago · ${s.pending ? (current ? "No later resolution captured" : "Older than 24 hours · not counted as needing you") : s.state}`,
      ),
      el(
        "p",
        { class: "dim" },
        `${!Number.isFinite(eventTime(s.last)) || Date.now() - eventTime(s.last) > 30 * 60_000 ? "Stale observation · current state unknown" : "Last observed"} · ${formatAge(Math.max(0, Date.now() - Date.parse(s.last_observed_at ?? s.last.observed_at)))} ago`,
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
    names = snapshot.sessions.map((s) => [keyOf(s), sessionName(s)] as const);
    // One freshness rule for who needs you: an old episode stays listed but is not counted.
    const pending = snapshot.sessions.filter((s) => s.pending && pendingNow(s, Date.now()));
    const snoozed = pending.filter((s) => prefs.snoozed(episodeKey(s))).length;
    needing = pending.length - snoozed;
    for (const fn of countListeners) {
      try { fn(); } catch { /* a listener must not break the strip */ }
    }
    const open = el(
      "button",
      { "data-key": "inbox" },
      `${needYouCount(pending.length - snoozed)} · ${snoozed} snoozed`,
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
        `${!connected ? "Offline · " : !fresh ? "Snapshot unavailable · " : ""}Coverage depends on captured observations`,
      ),
      doctor,
    );
    working.setAttribute("aria-pressed", String(!history));
    historyButton.setAttribute("aria-pressed", String(history));
    function choices(
      select: HTMLSelectElement,
      values: string[],
      label: string,
      text: (v: string) => string = (v) => v,
    ) {
      const value = select.value;
      clear(select);
      select.append(el("option", { value: "" }, label));
      for (const v of [...new Set(values)].filter(Boolean).sort())
        select.append(el("option", { value: v }, text(v)));
      select.value = value;
    }
    choices(
      source,
      snapshot.sessions.map((s) => s.source),
      "All sources",
    );
    const nameById = new Map(snapshot.sessions.map((s) => [where(s), whereName(s)]));
    choices(workspace, snapshot.sessions.map(where), "All worktrees", (v) => nameById.get(v) || v);
    const term = search.value.trim().toLocaleLowerCase();
    const rank = (s: AttentionSession) =>
      s.pending
        ? !pendingNow(s, Date.now())
          ? 3
          : prefs.snoozed(episodeKey(s))
            ? 2
            : s.pending.kind === "request"
              ? 0
              : 1
        : 4;
    const all = snapshot.sessions
      .filter(
        (s) =>
          (history ||
            s.pending ||
            (s.state !== "done" &&
              Date.now() - eventTime(s.last) < 30 * 60_000)) &&
          (!source.value || source.value === s.source) &&
          (!workspace.value || workspace.value === where(s)) &&
          [
            s.id,
            s.title,
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
          eventTime(b.last) - eventTime(a.last) ||
          a.id.localeCompare(b.id),
      );
    for (const s of all) rows.append(row(s));
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
      const age = Date.now() - eventTime(s.pending);
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
    const timeout = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
    let settled = false;
    try {
      const result = await attention(controller.signal);
      if (disposed || !connected || version !== epoch) return;
      applied++;
      snapshot = result;
      fresh = true;
      options.onSessions?.(result.sessions);
      const keys = new Set(
        snapshot.sessions.filter((s) => s.pending).map(episodeKey),
      );
      prefs.retain(keys);
      if (!initialized || !prefs.enabled) prefs.markNotified([...keys]);
      initialized = true;
      status.textContent = `Snapshot checked at ${new Date(Date.now()).toLocaleTimeString()} · source coverage is not guaranteed`;
      render();
      settled = true;
      settleReaders();
      // Release the network slot before OS permission checks, which can be slow.
      inFlight = null;
      await deliverNotifications(version);
    } catch (error) {
      if (disposed || version !== epoch) return;
      fresh = false;
      status.textContent =
        "Needs you is unavailable — waiting for the local engine.";
      render();
      if (!settled) { settled = true; settleReaders(error, true); }
    } finally {
      clearTimeout(timeout);
      // Superseded with no newer load to answer: readers must not hang.
      if (!settled && abort === controller) settleReaders(new Error("needs-you snapshot unavailable"), true);
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
      ? "Refreshing needs you…"
      : "Offline · displayed observations may be out of date.";
    render();
    if (value) void refresh();
  }
  const timer = setInterval(() => void refresh(), 3000);
  return {
    root,
    strip,
    refresh,
    /** The next snapshot, from the one request every view shares. */
    read(signal?: AbortSignal): Promise<AttentionSnapshot> {
      if (disposed) return Promise.reject(new Error("needs-you snapshot unavailable"));
      // The live stream being down does not mean the daemon is: a view may still ask it directly.
      if (!connected) {
        // The stream may connect while this is in flight, so only a newer snapshot outranks it.
        const seen = applied;
        return attention(signal).then((result) => {
          if (!disposed && seen === applied) { applied++; snapshot = result; options.onSessions?.(result.sessions); render(); }
          return result;
        });
      }
      return new Promise((resolve, reject) => {
        readers.add({ resolve, reject });
        void refresh();
      });
    },
    /** The strip's count (pending, not snoozed). */
    count: () => needing,
    /** Per project: sessions that need you (pending, not snoozed) and sessions working now, from the last snapshot. */
    byProject(current: (id: string) => string = (id) => id): Map<string, { needs: number; active: number }> {
      const out = new Map<string, { needs: number; active: number }>();
      for (const s of snapshot.sessions) {
        if (!s.repo_id) continue;
        const repo = current(s.repo_id);
        const row = out.get(repo) ?? { needs: 0, active: 0 };
        if (s.pending) { if (pendingNow(s, Date.now()) && !prefs.snoozed(episodeKey(s))) row.needs++; }
        else if (s.state === "working" && Date.now() - eventTime(s.last) < 30 * 60_000) row.active++;
        out.set(repo, row);
      }
      return out;
    },
    /** Capture warnings and gaps in the last snapshot: the Doctor badge. They are Doctor's, not the queue's (MS-9). */
    warnings: () => snapshot.warnings.length + (snapshot.gaps?.length ?? 0),
    captureIssues: (): { gaps: readonly NonNullable<AttentionSnapshot["gaps"]>[number][]; warnings: readonly AttentionEvidence[] } => ({
      gaps: snapshot.gaps ?? [],
      warnings: snapshot.warnings.slice(0, 20),
    }),
    /** Fills the inspector with a captured warning's event. */
    inspectWarning: (id: string) => inspect(id),
    /** Fills the inspector with a gap (a diagnostic, not a captured event). */
    inspectGap(gap: { source: string; time: string; summary: string }): void {
      inspection++; // a warning still loading must not replace this selection
      options.onSelect({
        id: "",
        source: gap.source,
        time: gap.time,
        category: "meta",
        name: "capture.gap",
        severity: "warn",
        summary: "Capture warning: not recorded in history",
        payload: { message: gap.summary },
      });
    },
    /** Calls fn whenever the strip is redrawn (so a snooze or refresh reaches other displays at once). */
    onCount(fn: () => void) { countListeners.add(fn); },
    setConnected,
    /** Redraws from the last snapshot (names changed; nothing is refetched). */
    redraw() { if (!disposed) render(); },
    dispose() {
      disposed = true;
      epoch++;
      abort?.abort();
      clearInterval(timer);
      settleReaders(new Error("needs-you snapshot unavailable"), true);
    },
  };
}
