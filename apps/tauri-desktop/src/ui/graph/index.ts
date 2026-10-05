import {
  attention,
  getConfig,
  type AttentionSession,
  type FirehoseEvent,
} from "../../api";
import { el, clear, onActivate, keepFocus } from "../../dom";
import { renderDetail } from "../detail";
import { needsLabel, pendingNow } from "../../needs";
import { stateFresh } from "../../spark";
import {
  graphAPI,
  type Snapshot,
  type Repository,
  type Workspace,
} from "./api";
import { layoutGraph, relatives, TimelineState, eventWorkspace } from "./model";

const svgNS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
) {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}
function button(label: string, action: () => void) {
  const b = el("button", {}, label);
  b.onclick = action;
  return b;
}
function select(
  label: string,
  options: [string, string][],
  value: string,
  change: (v: string) => void,
) {
  const s = el("select", { "aria-label": label });
  for (const [v, l] of options) s.append(el("option", { value: v }, l));
  s.value = value;
  s.onchange = () => change(s.value);
  return s;
}

export function createWorkspaceGraph(
  onOpenSession: (id: string, source?: string) => void,
) {
  const root = el("section", { class: "workspace-graph" });
  const header = el("div", { class: "graph-toolbar" });
  const tabs = el("div", { class: "graph-tabs" });
  const status = el("div", { class: "graph-status", role: "status" });
  const body = el("div", { class: "graph-body" });
  root.append(header, tabs, status, body);
  let repos: Repository[] = [];
  let privacyMode: string | undefined;
  let repo = "";
  let snapshot: Snapshot | undefined;
  let sessions: AttentionSession[] = [];
  let tab: "graph" | "timeline" = "graph";
  let workspace = "";
  let revision = "";
  let session = "";
  let source = "";
  let category = "";
  let search = "";
  let graphSearch = "";
  let descendant = false;
  let target = "";
  let cursor = "";
  let hasMore = false;
  let historyError = "";
  let topologyEpoch = 0;
  let historyEpoch = 0;
  let busy = false;
  let view = { x: 0, y: 0, scale: 1 };
  let fitted = false;
  let timelineScrollTop = 0;
  let comparisonEpoch = 0;
  const timeline = new TimelineState();
  const selectedWorkspace = () =>
    snapshot?.workspaces.find((w) => w.id === workspace);
  function sessionAssociation(s: AttentionSession) {
    const last = s.last?.event_id ? timeline.event(s.last.event_id) : undefined;
    if (last && (last.repo_id || last.jj_repo_id))
      return timeline.association(last, repo);
    const observed = snapshot?.attention_associations?.[`${s.source}\0${s.id}`];
    return (
      (observed?.event_id === s.last?.event_id ? observed : undefined) ?? {
        repo_id: snapshot?.repository.vcs === "git" ? s.repo_id : s.jj_repo_id,
        workspace_id:
          snapshot?.repository.vcs === "git"
            ? s.worktree_id
            : s.jj_workspace_id,
      }
    );
  }
  const scopedSessions = () =>
    sessions.filter(
      (s) =>
        sessionAssociation(s).repo_id === repo &&
        (!workspace || sessionAssociation(s).workspace_id === workspace),
    );
  function setScope(id: string) {
    workspace = id;
    revision = selectedWorkspace()?.revision ?? "";
    session = "";
    cursor = "";
    void loadHistory();
    render();
  }
  function renderHeader() {
    clear(header);
    header.append(
      el("h2", {}, "Workspaces"),
      select(
        "Repository",
        repos.map((r) => [r.id, `${r.label} · ${r.vcs}`]),
        repo,
        (v) => {
          repo = v;
          session = "";
          source = "";
          snapshot = undefined;
          workspace = "";
          revision = "";
          target = "";
          fitted = false;
          cursor = "";
          historyEpoch++;
          void refresh();
        },
      ),
      button("Register local root", () => {
        const form = el("form", { class: "graph-register" });
        const input = el("input", {
          placeholder: "Local repository root",
          "aria-label": "Local repository root",
          required: "true",
        });
        const vcs = select(
          "VCS",
          [
            ["", "Auto detect"],
            ["git", "Git"],
            ["jj", "JJ"],
          ],
          "",
          () => {},
        );
        form.append(input, vcs, el("button", { type: "submit" }, "Register"));
        form.onsubmit = async (e) => {
          e.preventDefault();
          try {
            const r = await graphAPI.register(input.value, vcs.value);
            repo = r.id;
            repos = await graphAPI.repos();
            snapshot = undefined;
            fitted = false;
            await refresh();
          } catch {
            status.textContent =
              "Unable to register repository. Check the local root and VCS availability.";
          }
        };
        header.append(form);
        input.focus();
      }),
      button("Refresh", () => void refresh(true)),
    );
    clear(tabs);
    for (const name of ["graph", "timeline"] as const) {
      const b = button(name === "graph" ? "Graph" : "Timeline", () => {
        tab = name;
        render();
        if (tab === "timeline") void loadHistory();
      });
      b.classList.toggle("active", tab === name);
      tabs.append(b);
    }
    tabs.append(
      el(
        "span",
        { class: "dim" },
        `${snapshot?.workspaces.length ?? 0} workspaces · edges show revision parents`,
      ),
    );
  }
  function render() {
    const oldTimeline = body.querySelector<HTMLElement>(".graph-timeline");
    if (oldTimeline) timelineScrollTop = oldTimeline.scrollTop;
    const restore = keepFocus(root);
    renderHeader();
    clear(body);
    if (!snapshot) {
      body.append(
        el(
          "p",
          { class: "dim" },
          repos.length
            ? "Loading repository topology…"
            : "Register a local repository to inspect its ancestry. Discovery stays on this machine.",
        ),
      );
      restore();
      return;
    }
    status.textContent = [
      snapshot.stale ? "Stale snapshot — last successful scan retained" : "",
      workspace && !selectedWorkspace()
        ? "Selected workspace is no longer available."
        : "",
      ...(snapshot.warnings ?? []),
    ]
      .filter(Boolean)
      .join(" · ");
    if (tab === "graph") renderGraph();
    else renderTimeline();
    const nextTimeline = body.querySelector<HTMLElement>(".graph-timeline");
    if (nextTimeline) nextTimeline.scrollTop = timelineScrollTop;
    restore();
  }
  function workspaceCaption(w: Workspace) {
    const short = /^(sha256:)?[a-f0-9]{32,}$/.test(w.label)
      ? w.label.replace(/^sha256:/, "").slice(0, 8)
      : w.label;
    return `${(w.refs ?? []).join(", ") || (w.unborn ? "unborn" : "detached")} · ${short}`;
  }
  function renderGraph() {
    const area = el("div", { class: "graph-canvas-wrap" });
    const controls = el("div", { class: "graph-controls" });
    const input = el("input", {
      "aria-label": "Search graph",
      placeholder: "Search workspaces, refs or revisions",
      value: graphSearch,
    });
    input.oninput = () => {
      graphSearch = input.value;
      draw();
    };
    controls.append(
      select(
        "Find workspace",
        [
          ["", "Select any workspace"],
          ...snapshot!.workspaces.map(
            (w) => [w.id, workspaceCaption(w)] as [string, string],
          ),
        ],
        workspace,
        (id) => {
          if (id) {
            const p = layout.labels.get(id);
            if (p) {
              view = { x: 40 - p.x, y: 100 - p.y, scale: 1 };
              fitted = true;
            }
            setScope(id);
          }
        },
      ),
      input,
      button("Fit", () => {
        fitted = false;
        draw();
      }),
      button("+", () => {
        view.scale = Math.min(3, view.scale * 1.2);
        transform();
      }),
      button("−", () => {
        view.scale = Math.max(0.1, view.scale / 1.2);
        transform();
      }),
      button(
        descendant ? "Highlight ancestry" : "Highlight descendants",
        () => {
          descendant = !descendant;
          render();
        },
      ),
    );
    const canvas = svg("svg", {
      class: "graph-canvas",
      role: "group",
      "aria-label": "Revision ancestry graph",
      tabindex: 0,
    });
    const group = svg("g", {});
    canvas.append(group);
    area.append(controls, canvas);
    const inspector = el("aside", { class: "graph-inspector" });
    const navigator = el("div", {
      class: "graph-workspace-list",
      "aria-label": "All discovered workspaces",
    });
    navigator.append(el("h4", {}, `${snapshot!.workspaces.length} workspaces`));
    for (const w of snapshot!.workspaces) {
      const b = button(
        workspaceCaption(w) + (w.dirty ? " · dirty" : ""),
        () => {
          const p = layout.labels.get(w.id)!;
          view = { x: 40 - p.x, y: 100 - p.y, scale: 1 };
          fitted = true;
          setScope(w.id);
        },
      );
      b.classList.toggle("selected", workspace === w.id);
      navigator.append(b);
    }
    body.append(navigator, area, inspector);
    const layout = layoutGraph(
      snapshot!.nodes,
      snapshot!.workspaces.map((w) => ({ id: w.id, revision_key: w.revision })),
    );
    function transform() {
      group.setAttribute(
        "transform",
        `translate(${view.x} ${view.y}) scale(${view.scale})`,
      );
    }
    function draw() {
      group.replaceChildren();
      const chosen = revision || selectedWorkspace()?.revision;
      const highlight = chosen
        ? relatives(snapshot!.nodes, chosen, descendant)
        : null;
      for (const edge of layout.edges) {
        const c = layout.points.get(edge.child)!;
        const p = layout.points.get(edge.parent)!;
        const path = svg("path", {
          d: `M ${c.x} ${c.y} C ${c.x} ${(c.y + p.y) / 2} ${p.x} ${(c.y + p.y) / 2} ${p.x} ${p.y}`,
          class:
            highlight?.has(edge.child) && highlight.has(edge.parent)
              ? "ancestry-edge selected"
              : "ancestry-edge",
        });
        group.append(path);
      }
      for (const n of snapshot!.nodes) {
        const p = layout.points.get(n.key)!;
        const dot = svg("circle", {
          cx: p.x,
          cy: p.y,
          r: n.key === chosen ? 7 : 4,
          class: highlight?.has(n.key)
            ? "revision-node selected"
            : "revision-node",
          tabindex: 0,
          role: "button",
          "aria-label": `${n.commit_id} ${n.description}`,
          "data-key": `revision:${n.key}`,
        });
        const title = svg("title", {});
        title.textContent = `${n.commit_id}\n${n.description}`;
        dot.append(title);
        onActivate(dot, () => {
          revision = n.key;
          workspace = "";
          render();
        });
        group.append(dot);
        if (layout.boundaries.includes(n.key)) {
          const text = svg("text", {
            x: p.x - 10,
            y: p.y + 20,
            class: "graph-boundary",
          });
          text.textContent = "⋮ omitted parents";
          group.append(text);
        }
      }
      for (const w of snapshot!.workspaces) {
        const p = layout.labels.get(w.id)!;
        const attached = sessions.filter(
          (s) =>
            sessionAssociation(s).workspace_id === w.id &&
            sessionAssociation(s).repo_id === repo,
        );
        const need = attached.some((s) => pendingNow(s, Date.now()));
        const working = attached.some(
          (s) =>
            s.state === "working" &&
            stateFresh(
              s.state,
              Date.parse(s.last?.source_time ?? s.last?.time ?? ""),
              Date.now(),
            ),
        );
        const label = [
          workspaceCaption(w),
          w.unborn ? "unborn" : "",
          w.dirty ? "dirty" : "",
          w.conflicted ? "conflict" : "",
          w.availability,
          `${attached.length} agents`,
          need
            ? "needs attention"
            : working
              ? "working"
              : attached.length
                ? "observed"
                : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const matches =
          !graphSearch ||
          `${label} ${w.revision}`
            .toLowerCase()
            .includes(graphSearch.toLowerCase());
        const g = svg("g", {
          class: `workspace-label${workspace === w.id ? " selected" : ""}${matches ? "" : " muted"}`,
          tabindex: 0,
          role: "button",
          "aria-label": label,
          "data-key": `workspace:${w.id}`,
          transform: `translate(${p.x},${p.y})`,
        });
        g.append(svg("rect", { width: 285, height: 29, rx: 5 }));
        const t = svg("text", { x: 9, y: 19 });
        t.textContent = label.length > 43 ? label.slice(0, 40) + "…" : label;
        const title = svg("title", {});
        title.textContent = `${w.label} · ${label}`;
        g.append(t, title);
        onActivate(g, () => setScope(w.id));
        group.append(g);
      }
      if (!fitted) {
        view = {
          x: 25,
          y: 20,
          scale: Math.min(
            1,
            Math.max(0.00001, (area.clientWidth || 800) / layout.width),
            Math.max(
              0.00001,
              ((area.clientHeight || 650) - 60) / layout.height,
            ),
          ),
        };
        fitted = true;
      }
      transform();
    }
    let drag: { x: number; y: number } | null = null;
    canvas.onpointerdown = (e) => {
      if (e.target === canvas) {
        drag = { x: e.clientX, y: e.clientY };
        canvas.setPointerCapture?.(e.pointerId);
      }
    };
    canvas.onpointermove = (e) => {
      if (drag) {
        view.x += e.clientX - drag.x;
        view.y += e.clientY - drag.y;
        drag = { x: e.clientX, y: e.clientY };
        transform();
      }
    };
    canvas.onpointerup = () => (drag = null);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const scale = Math.max(
          0.1,
          Math.min(3, view.scale * Math.exp(-e.deltaY * 0.002)),
        );
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left,
          y = e.clientY - r.top;
        view.x = x - ((x - view.x) * scale) / view.scale;
        view.y = y - ((y - view.y) * scale) / view.scale;
        view.scale = scale;
        transform();
      },
      { passive: false },
    );
    canvas.onkeydown = (e) => {
      if (e.target !== canvas) return;
      const d = 40;
      if (e.key === "ArrowLeft") view.x += d;
      else if (e.key === "ArrowRight") view.x -= d;
      else if (e.key === "ArrowUp") view.y += d;
      else if (e.key === "ArrowDown") view.y -= d;
      else return;
      e.preventDefault();
      transform();
    };
    draw();
    renderInspector(inspector);
    if (snapshot!.next_cursor)
      area.append(
        button(
          `Expand omitted ancestry (${snapshot!.boundaries?.length ?? 0} boundaries)`,
          () => void refresh(false, snapshot!.next_cursor),
        ),
      );
  }
  function renderInspector(pane: HTMLElement) {
    const w = selectedWorkspace();
    const n = snapshot!.nodes.find((n) => n.key === (revision || w?.revision));
    pane.append(
      el(
        "h3",
        {},
        (w ? workspaceCaption(w) : undefined) ??
          n?.commit_id ??
          "Select a workspace or revision",
      ),
    );
    if (w) {
      pane.append(
        el("p", {}, (w.refs ?? []).join(" · ") || "Detached checkout"),
        el(
          "p",
          {},
          `Checkout: ${w.availability}${w.unborn ? " · unborn" : ""}${w.dirty ? " · uncommitted changes" : ""}${w.conflicted ? " · conflicted" : ""}`,
        ),
        button("Open scoped Timeline", () => {
          tab = "timeline";
          render();
          void loadHistory();
        }),
      );
      if (w.changed_files?.length) {
        pane.append(el("h4", {}, "Uncommitted checkout files"));
        for (const file of w.changed_files) pane.append(el("div", {}, file));
      }
      pane.append(el("h4", {}, "Captured sessions"));
      for (const s of scopedSessions()) {
        const b = button(
          `${s.source} · ${s.id} · ${needsLabel(s, Date.now())}${s.uncertainty ? " · " + s.uncertainty : ""}`,
          () => onOpenSession(s.id, s.source),
        );
        pane.append(
          b,
          button("Filter Timeline", () => {
            session = `${s.source}\0${s.id}`;
            tab = "timeline";
            render();
            void loadHistory();
          }),
        );
      }
      if (!scopedSessions().length)
        pane.append(
          el(
            "p",
            { class: "dim" },
            "No explicitly associated session. Missing telemetry does not imply completion.",
          ),
        );
    }
    if (n) {
      pane.append(
        el("p", {}, n.description),
        el("code", {}, n.commit_id),
        el("p", { class: "dim" }, n.timestamp),
        el("p", {}, `Parents: ${n.parents.join(", ") || "none"}`),
      );
      if (n.change_id) pane.append(el("p", {}, `JJ change: ${n.change_id}`));
      const targetInput = el("input", {
        "aria-label": "Comparison target",
        placeholder: "Full target commit ID",
        value: target || snapshot!.default_target || "",
      });
      const result = el("div", { class: "graph-comparison" });
      const compare = async () => {
        target = targetInput.value;
        if (!target) {
          result.textContent = "Select an explicit comparison target.";
          return;
        }
        const epoch = ++comparisonEpoch;
        result.textContent = "Comparing…";
        try {
          const c = await graphAPI.compare(repo, n.key, target);
          if (epoch !== comparisonEpoch || !result.isConnected) return;
          clear(result);
          result.append(
            el(
              "p",
              {},
              `${c.selected_only?.length ?? 0} selected-only commits · ${c.target_only?.length ?? 0} target-only commits`,
            ),
            el(
              "p",
              {},
              `Merge bases: ${(c.merge_bases ?? []).join(", ") || "none"}`,
            ),
            el("p", {}, c.disconnected ? "Disconnected histories" : ""),
            el("h4", {}, "Committed changed files"),
          );
          for (const f of c.changed_files ?? [])
            result.append(el("div", {}, f));
          for (const warning of c.warnings ?? [])
            result.append(el("p", {}, warning));
          result.append(
            el(
              "p",
              { class: "dim" },
              "Uncommitted checkout changes are separate from this revision comparison. Revision identity does not establish patch equivalence.",
            ),
          );
        } catch {
          result.textContent =
            "Comparison unavailable. Check the target revision.";
        }
      };
      pane.append(
        el("h4", {}, "Compare with"),
        select(
          "Select comparison revision",
          [
            ["", "Choose loaded revision"],
            ...snapshot!.nodes.map(
              (node) =>
                [
                  node.key,
                  `${node.commit_id.slice(0, 8)} · ${node.description.slice(0, 45)}`,
                ] as [string, string],
            ),
          ],
          targetInput.value,
          (value) => {
            targetInput.value = value;
            void compare();
          },
        ),
        targetInput,
        button("Compare", () => void compare()),
        result,
      );
      if (targetInput.value) void compare();
    }
    const unassigned = sessions.filter(
      (s) =>
        sessionAssociation(s).repo_id === repo &&
        !snapshot!.workspaces.some(
          (w) => w.id === sessionAssociation(s).workspace_id,
        ),
    );
    if (unassigned.length)
      pane.append(
        el(
          "p",
          { class: "dim" },
          `${unassigned.length} sessions have unavailable or missing workspace identity.`,
        ),
      );
  }
  function renderTimeline() {
    const panel = el("div", { class: "graph-timeline" });
    const filters = el("div", { class: "graph-controls" });
    function changed() {
      cursor = "";
      void loadHistory();
      render();
    }
    filters.append(
      select(
        "Workspace",
        [
          ["", "Whole repository"],
          ...snapshot!.workspaces.map(
            (w) => [w.id, workspaceCaption(w)] as [string, string],
          ),
        ],
        workspace,
        (v) => {
          workspace = v;
          revision = selectedWorkspace()?.revision ?? "";
          session = "";
          changed();
        },
      ),
      select(
        "Source",
        [
          ["", "All sources"],
          ...Array.from(
            new Set([
              ...timeline.all().map((e) => e.source),
              ...sessions.map((s) => s.source),
            ]),
          )
            .sort()
            .map((s) => [s, s] as [string, string]),
        ],
        source,
        (v) => {
          source = v;
          session = "";
          changed();
        },
      ),
      select(
        "Session",
        [
          ["", "All sessions"],
          ...Array.from(
            new Set([
              ...scopedSessions().map((s) => `${s.source}\0${s.id}`),
              ...timeline
                .all()
                .filter(
                  (e) =>
                    e.session_id &&
                    (!workspace ||
                      timeline.association(e, repo).workspace_id === workspace),
                )
                .map((e) => `${e.source}\0${e.session_id}`),
            ]),
          )
            .filter((s) => !source || s.startsWith(source + "\0"))
            .map((s) => [s, s.replace("\0", " · ")] as [string, string]),
        ],
        session,
        (v) => {
          session = v;
          changed();
        },
      ),
      select(
        "Category",
        [
          ["", "All categories"],
          ...Array.from(new Set(timeline.all().map((e) => e.category)))
            .sort()
            .map((s) => [s, s] as [string, string]),
        ],
        category,
        (v) => {
          category = v;
          changed();
        },
      ),
    );
    const searchInput = el("input", {
      "aria-label": "Search captured events",
      placeholder: "Search hooks and events",
      value: search,
    });
    let timeout: ReturnType<typeof setTimeout>;
    searchInput.oninput = () => {
      search = searchInput.value;
      clearTimeout(timeout);
      timeout = setTimeout(changed, 250);
    };
    filters.append(
      searchInput,
      button(
        timeline.paused
          ? `Resume · ${timeline.unreadFor({ repo, workspace, source, session, category, search })} arrivals`
          : "● Live · pause",
        () => {
          if (timeline.paused) {
            timeline.resume();
            void loadHistory();
          } else timeline.pause();
          render();
        },
      ),
    );
    panel.append(
      filters,
      el(
        "p",
        { class: "dim" },
        "Newest captured events first · source clocks do not establish cross-provider causal order. Captured content only.",
      ),
    );
    if (historyError)
      panel.append(el("p", { class: "graph-warning" }, historyError));
    const table = el("table", { class: "graph-events" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...[
            "Time",
            "Agent / session",
            "Native hook / event",
            "Category",
            "Summary",
            "",
          ].map((s) => el("th", {}, s)),
        ),
      ),
    );
    const rows = el("tbody");
    const filtered = timeline.rows({
      repo,
      workspace,
      source,
      session,
      category,
      search,
    });
    for (const e of filtered) {
      const row = el("tr", {
        "data-key": `event:${e.id}`,
        tabindex: "0",
        class: timeline.selected?.id === e.id ? "selected" : "",
      });
      row.append(
        el("td", {}, new Date(e.time).toLocaleTimeString()),
        el("td", {}, `${e.source} · ${e.session_id ?? "unassigned"}`),
        el("td", {}, e.name ?? "—"),
        el("td", {}, e.category),
        el("td", {}, e.summary ?? ""),
      );
      const graph = button("Show in Graph", () => showInGraph(e));
      graph.onclick = (evt) => {
        evt.stopPropagation();
        showInGraph(e);
      };
      row.append(el("td", {}, graph));
      onActivate(row, () => {
        timeline.select(e.id);
        render();
      });
      rows.append(row);
    }
    table.append(rows);
    panel.append(table);
    if (!filtered.length)
      panel.append(
        el(
          "p",
          { class: "dim" },
          "No captured events match this scope. Events with missing identity stay unassigned.",
        ),
      );
    panel.append(
      button(
        hasMore ? "Load older events" : "Reconcile durable history",
        () => void loadHistory(hasMore),
      ),
      el(
        "p",
        { class: "dim" },
        hasMore
          ? "Older durable history available."
          : "Loaded history boundary reached; capture gaps may still exist.",
      ),
    );
    const detail = el("aside", { class: "graph-event-detail" });
    if (timeline.selected) {
      renderDetail(
        detail,
        timeline.selected,
        () => {
          timeline.selected = undefined;
          render();
        },
        (e) =>
          timeline
            .all()
            .filter(
              (o) =>
                o.source === e.source &&
                o.session_id === e.session_id &&
                o.call_id === e.call_id,
            ),
      );
      detail.append(
        button("Show in Graph", () => showInGraph(timeline.selected!)),
        el(
          "p",
          {},
          `Observed workspace: ${timeline.selected.worktree_id ?? "unassigned"}`,
        ),
      );
      if (/permission/i.test(timeline.selected.name ?? ""))
        detail.append(
          el("p", {}, "Respond in the agent’s existing approval flow."),
        );
    }
    body.append(panel, detail);
  }
  function showInGraph(e: FirehoseEvent) {
    if (timeline.association(e, repo).repo_id !== repo) {
      status.textContent = "Workspace unavailable in the selected repository.";
      return;
    }
    const w = eventWorkspace(
      {
        ...e,
        worktree_id: timeline.association(e, repo).workspace_id,
        jj_workspace_id: undefined,
      },
      snapshot?.workspaces ?? [],
    );
    if (!w) {
      status.textContent =
        "Workspace unavailable: no discovered checkout matches this event’s observed identity.";
      return;
    }
    workspace = w.id;
    revision = w.revision;
    const layout = layoutGraph(
      snapshot!.nodes,
      snapshot!.workspaces.map((w) => ({ id: w.id, revision_key: w.revision })),
    );
    const point = layout.labels.get(w.id)!;
    view = { x: 40 - point.x, y: 100 - point.y, scale: 1 };
    fitted = true;
    tab = "graph";
    render();
  }
  async function loadHistory(older = false) {
    if (!repo) return;
    const epoch = ++historyEpoch;
    const params: Record<string, string> = { repo_id: repo, limit: "250" };
    if (workspace) params.workspace_id = workspace;
    if (source) params.source = source;
    if (session) {
      const [s, id] = session.split("\0");
      params.source = s;
      params.session_id = id;
    }
    if (category) params.category = category;
    if (search) params.search = search;
    if (older && cursor) params.cursor = cursor;
    try {
      const page = await graphAPI.timeline(params);
      if (epoch !== historyEpoch) return;
      timeline.merge(page.events ?? [], page.associations);
      if (older || !cursor) {
        cursor = page.next_cursor ?? "";
        hasMore = page.has_more;
      }
      historyError = page.capture_gap
        ? "Capture gaps reported; this feed may be incomplete."
        : "";
      if (tab === "timeline") render();
    } catch {
      if (epoch === historyEpoch) {
        historyError =
          "Durable history unavailable — live capture continues. Retry reconciliation.";
        if (tab === "timeline") render();
      }
    }
  }
  async function refresh(force = false, expand = "") {
    const epoch = ++topologyEpoch;
    busy = true;
    try {
      const [config, available] = await Promise.all([
        getConfig(),
        graphAPI.repos(),
      ]);
      if (epoch !== topologyEpoch) return;
      if (privacyMode !== undefined && privacyMode !== config.privacy_mode) {
        snapshot = undefined;
        workspace = "";
        revision = "";
        target = "";
        session = "";
        cursor = "";
        fitted = false;
        historyEpoch++;
      }
      privacyMode = config.privacy_mode;
      repos = available;
      if (repo && !repos.some((r) => r.id === repo)) {
        snapshot = undefined;
        repo = "";
        workspace = "";
        revision = "";
        target = "";
        session = "";
        cursor = "";
        fitted = false;
        historyEpoch++;
      }
      if (!repo) repo = repos[0]?.id ?? "";
      if (!repo) {
        render();
        return;
      }
      const next = await graphAPI.snapshot(repo, expand, force);
      if (epoch !== topologyEpoch) return;
      snapshot = {
        ...next,
        nodes: next.nodes ?? [],
        workspaces: next.workspaces ?? [],
      };
      if (workspace && selectedWorkspace())
        revision = selectedWorkspace()!.revision;
      if (workspace && !selectedWorkspace())
        status.textContent = "Selected workspace is no longer available.";
      render();
      void loadHistory();
      void refreshActivity();
    } catch {
      if (epoch === topologyEpoch) {
        if (snapshot) snapshot.stale = true;
        render();
        status.textContent =
          "Topology scan unavailable — last successful snapshot retained.";
      }
    } finally {
      if (epoch === topologyEpoch) busy = false;
    }
  }
  async function refreshActivity() {
    try {
      const a = await attention();
      sessions = a.sessions ?? [];
      if (root.isConnected) render();
      if (a.gaps?.length)
        status.textContent +=
          " · Capture gaps reported by attention projection";
    } catch {
      /* Existing shared attention strip shows connectivity. */
    }
  }
  window.addEventListener("focus", () => {
    if (root.isConnected && !busy) void refresh(true);
  });
  setInterval(() => {
    if (root.isConnected && !busy) void refresh(true);
  }, 15000);
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    root,
    refresh: () => refresh(),
    onEvent: (e: FirehoseEvent) => {
      timeline.merge([e]);
      if (tab === "timeline" && root.isConnected) render();
      if (!activityTimer)
        activityTimer = setTimeout(() => {
          activityTimer = undefined;
          if (root.isConnected) {
            void refreshActivity();
            void loadHistory();
          }
        }, 500);
    },
  };
}
