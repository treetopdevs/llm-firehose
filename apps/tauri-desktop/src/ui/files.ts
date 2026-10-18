import { files, fileSessions, capturedEvent } from "../api";
import type { FileArtifact, FileSession, FirehoseEvent } from "../api";
import { clear, el } from "../dom";
import { stripControl } from "./score/model";

export function recordedFilePaths(event: FirehoseEvent): string[] {
  if (event.category !== "file") return [];
  for (const key of ["file_path", "path", "file"]) {
    const value = event.payload?.[key];
    if (typeof value === "string" && value) return [value];
  }
  const changes = event.payload?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes))
    return [];
  const keys = Object.keys(changes);
  if (
    keys.length === 2 &&
    typeof (changes as Record<string, unknown>).sha256 === "string" &&
    "len" in changes
  )
    return [];
  return keys.sort();
}
export function recordedFileScope(event: FirehoseEvent): [string, string] {
  for (const key of ["worktree_id", "jj_workspace_id", "cwd"] as const)
    if (event[key]) return [key, event[key]!];
  return ["unknown", ""];
}
const groupKey = (r: FileSession) =>
  JSON.stringify([r.workspace_kind, r.workspace, r.path]);
const comparable = (r: FileSession) =>
  r.workspace_kind !== "unknown" && !!r.workspace && !r.path.endsWith("…");
const label = (s: string) => {
  const clean = stripControl(s);
  return clean.length > 160
    ? clean.slice(0, 160) + "… [display truncated]"
    : clean;
};

// Selected mode lives in this panel instance; no new disk/browser persistence.
export function createFiles() {
  const root = el("section", { class: "files" }),
    heading = el("h2", { tabindex: "-1" }, "Files");
  const body = el("div"),
    detail = el("section", { "aria-label": "File observation detail" }),
    status = el("p", { role: "status" });
  const filter = el("input", {
      "aria-label": "Filter file activity",
      type: "search",
    }),
    shared = el("input", {
      type: "checkbox",
      "aria-label": "Only shared comparable paths",
    });
  const controls = el(
    "div",
    {},
    el("label", {}, "Filter scope, path or session ", filter),
    el("label", {}, shared, " Only shared comparable paths"),
  );
  let mode: "summary" | "sessions" = "summary",
    version = 0,
    detailVersion = 0,
    page = 0;
  let groupedRows: FileSession[] | undefined;
  let groups = new Map<string, Set<string>>();
  let rows: FileSession[] = [],
    summary: FileArtifact[] = [],
    phase = "idle";
  let listAbort: AbortController | undefined,
    detailAbort: AbortController | undefined;
  const button = (text: string, action: () => void) => {
    const b = el("button", {}, text);
    b.onclick = action;
    return b;
  };
  function cancelDetail() {
    detailVersion++;
    detailAbort?.abort();
    detailAbort = undefined;
    clear(detail);
  }
  function deactivate() {
    version++;
    listAbort?.abort();
    cancelDetail();
  }
  const summaryButton = button("Path summary", () => {
    if (mode === "summary") return;
    mode = "summary";
    void refresh();
  });
  const sessionsButton = button("Activity by session", () => {
    if (mode === "sessions") return;
    mode = "sessions";
    void refresh();
  });
  root.append(
    heading,
    summaryButton,
    sessionsButton,
    button("Refresh files", () => void refresh()),
    controls,
    status,
    body,
    detail,
  );
  filter.oninput = shared.onchange = () => {
    page = 0;
    cancelDetail();
    if (phase === "ready") draw();
  };
  function draw() {
    clear(body);
    controls.hidden = mode !== "sessions";
    summaryButton.setAttribute("aria-pressed", String(mode === "summary"));
    sessionsButton.setAttribute("aria-pressed", String(mode === "sessions"));
    if (phase !== "ready") return;
    if (mode === "summary") {
      if (!summary.length) {
        body.append(el("p", {}, "no file activity captured yet"));
        return;
      }
      const table = el(
        "table",
        { class: "files-table" },
        el(
          "tr",
          {},
          ...["path", "events", "sources", "last touched"].map((h) =>
            el("th", {}, h),
          ),
        ),
      );
      for (const f of summary)
        table.append(
          el(
            "tr",
            {},
            el("td", { class: "mono" }, stripControl(f.path)),
            el("td", {}, String(f.events)),
            el("td", {}, f.sources.join(", ")),
            el("td", {}, new Date(f.last_time).toLocaleString()),
          ),
        );
      body.append(table);
      return;
    }
    body.append(
      el(
        "p",
        {},
        "All indexed history. Same recorded scope/path does not prove simultaneous activity, physical-file identity or a write conflict. Events include write-tool starts, ends and failures; they are not edit counts. Opaque IDs reflect captured privacy. Missing, cross-kind and truncated scopes/paths are not comparable; minimal capture may yield no readable paths.",
      ),
    );
    if (groupedRows !== rows) {
      groups = new Map<string, Set<string>>();
      for (const row of rows)
        if (comparable(row) && row.session_id && row.source) {
          const key = groupKey(row),
            set = groups.get(key) ?? new Set<string>();
          set.add(JSON.stringify([row.source, row.session_id]));
          groups.set(key, set);
        }
      groupedRows = rows;
    }
    const query = filter.value.toLowerCase();
    const visible = rows.filter(
      (r) =>
        (!shared.checked ||
          (comparable(r) && (groups.get(groupKey(r))?.size ?? 0) > 1)) &&
        [r.workspace_kind, r.workspace, r.path, r.source, r.session_id]
          .join(" ")
          .toLowerCase()
          .includes(query),
    );
    page = Math.min(page, Math.max(0, Math.ceil(visible.length / 40) - 1));
    const start = page * 40,
      end = Math.min(start + 40, visible.length);
    status.textContent = `${visible.length ? start + 1 : 0}–${end} of ${visible.length} scoped rows (${rows.length} loaded).`;
    if (!visible.length)
      body.append(
        el(
          "p",
          {},
          "No matching readable file observations. This does not prove no file activity occurred.",
        ),
      );
    for (let i = start; i < end; i++) {
      const row = visible[i],
        count = groups.get(groupKey(row))?.size ?? 0;
      const scope = row.workspace
        ? (/^[a-f0-9]{64}$/.test(row.workspace)
            ? "Opaque recorded scope ID: "
            : "Recorded scope: ") + label(row.workspace)
        : "Unknown workspace";
      const inspect = button(
        `Inspect latest observation ${i + 1}`,
        () => void inspectRow(row, inspect),
      );
      inspect.disabled = !row.last_event_id;
      body.append(
        el(
          "article",
          {},
          el("h3", { class: "mono" }, stripControl(row.path)),
          el("p", {}, `${row.workspace_kind} · ${scope}`),
          el(
            "p",
            {},
            `${label(row.source)} · ${label(row.session_id) || "Unknown session"} · ${row.events} events · ${row.first_time} → ${row.last_time}`,
          ),
          el(
            "p",
            {},
            comparable(row) && row.session_id
              ? `${count} source/session scopes with this exact recorded path`
              : "Not comparable for shared-path grouping",
          ),
          inspect,
        ),
      );
    }
    if (visible.length > 40) {
      const prev = button("Previous file activity", () =>
          move(-1, "Previous file activity"),
        ),
        next = button("Next file activity", () =>
          move(1, "Next file activity"),
        );
      prev.disabled = page === 0;
      next.disabled = end === visible.length;
      body.append(prev, next);
    }
  }
  function move(delta: number, name: string) {
    cancelDetail();
    page += delta;
    draw();
    const target = [...body.querySelectorAll("button")].find(
      (b) => b.textContent === name && !b.disabled,
    );
    (target ?? heading).focus();
  }
  async function inspectRow(row: FileSession, opener: HTMLElement) {
    cancelDetail();
    if (!row.last_event_id) return;
    const token = detailVersion,
      current = version,
      ctl = new AbortController();
    detailAbort = ctl;
    detail.append(el("p", { role: "status" }, "Loading captured observation…"));
    try {
      const event = await capturedEvent(row.last_event_id, ctl.signal);
      if (token !== detailVersion || current !== version || ctl.signal.aborted)
        return;
      const [kind, scope] = recordedFileScope(event);
      if (
        event.id !== row.last_event_id ||
        event.source !== row.source ||
        (event.session_id ?? "") !== row.session_id ||
        kind !== row.workspace_kind ||
        scope !== row.workspace ||
        !recordedFilePaths(event).includes(row.path)
      )
        throw new Error("mismatch");
      clear(detail);
      detail.append(
        button("Close file observation", () => {
          cancelDetail();
          (opener.isConnected ? opener : heading).focus();
        }),
        el("pre", {}, JSON.stringify(event, null, 2)),
      );
    } catch {
      if (token !== detailVersion || current !== version || ctl.signal.aborted)
        return;
      clear(detail);
      detail.append(
        el(
          "p",
          { role: "status" },
          "Captured observation unavailable or no longer matches this row.",
        ),
      );
    }
  }
  async function refresh() {
    deactivate();
    const current = version,
      ctl = new AbortController();
    listAbort = ctl;
    page = 0;
    phase = "loading";
    status.textContent = "Loading files…";
    draw();
    try {
      const selectedMode = mode;
      const loaded =
        selectedMode === "summary"
          ? await files(ctl.signal)
          : await fileSessions(ctl.signal);
      if (current !== version || ctl.signal.aborted) return;
      if (selectedMode === "summary") summary = loaded as FileArtifact[];
      else rows = loaded as FileSession[];
      phase = "ready";
      status.textContent = "";
      draw();
    } catch {
      if (current !== version || ctl.signal.aborted) return;
      phase = "error";
      status.textContent =
        mode === "sessions"
          ? "Scoped activity unavailable on this daemon. Retry or use Path summary."
          : "File history unavailable.";
      clear(body);
      body.append(
        button("Retry files", () => {
          heading.focus();
          void refresh();
        }),
      );
    }
  }
  return { root, refresh, deactivate };
}
