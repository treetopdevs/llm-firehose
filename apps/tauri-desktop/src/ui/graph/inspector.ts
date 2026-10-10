// The right-hand inspector: a workspace (branch, agents, comparison, Changes,
// captured activity, origin) or a bare revision. It re-renders only when its
// inputs actually changed, so the 500 ms attention poll never steals focus from
// the comparison select.

import { clear, el } from "../../dom";
import { graphAPI, type Comparison, type FileChange, type Snapshot, type Workspace } from "./api";
import { sharedAncestorCount, type GraphNode } from "./model";
import { displayText, fileName, isDigest, shortDigest, sourceName, stateDescription, type AgentState } from "./names";
import { icon } from "./toolbar";

export interface AgentRow {
  source: string;
  id: string;
  state: AgentState;
  /** `Working`, `Needs you`, `Idle`... */
  word: string;
  uncertainty?: string;
}
export interface ActivityRow {
  id: string;
  text: string;
  /** `2m ago` */
  age: string;
}
export interface InspectorContext {
  repo: string;
  snapshot: Snapshot;
  workspace?: Workspace;
  /** Pill name of the selected workspace. */
  name: string;
  /** Absolute worktree path (Git); undefined for JJ and for digests from an older daemon. */
  workspacePath?: string;
  /** Absolute repository root; undefined for digests from an older daemon. */
  repoPath?: string;
  /** `agent/cache-fix` or `Detached HEAD abc1234`. */
  branch: string;
  /** What the copy button copies. */
  copyValue: string;
  state: AgentState;
  agents: AgentRow[];
  /** Newest three scoped events. */
  activity: ActivityRow[];
  /** Selected revision key, or "". */
  revision: string;
  descendants: boolean;
  /** Sessions whose workspace identity is missing or unavailable. */
  unassigned: number;
  /** Other workspaces for the comparison menu. */
  others: { id: string; name: string; revision: string }[];
}
export interface InspectorHandlers {
  openSession(id: string, source: string): void;
  filterTimeline(source: string, id: string): void;
  openTimeline(): void;
  selectRevision(key: string): void;
  highlightAncestry(): void;
  toggleDescendants(): void;
}

const CUSTOM = "__custom__";
const FULL_ID = /^[a-f0-9]{40,64}$/;
const LIST_LIMIT = 20;

interface CompareEntry {
  data?: Comparison;
  error?: string;
  loading: boolean;
  generation: string;
  /** Bumped on every change so the render signature never has to hash the payload. */
  v: number;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the selection-based copy */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.("copy") ?? false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createInspector(h: InspectorHandlers) {
  const root = el("aside", { class: "graph-inspector", "aria-label": "Inspector" });
  let ctx: InspectorContext | undefined;
  let signature = "";
  let target = "";
  let custom = "";
  let detailOpen = false;
  /** The comparison was just opened: bring it into view after the next draw. */
  let revealDetail = false;
  let originHelp = false;
  let epoch = 0;
  let cache = new Map<string, CompareEntry>();

  const node = (key: string): GraphNode | undefined =>
    ctx?.snapshot.nodes.find((n) => n.key === key);
  const effectiveTarget = () => {
    if (target === CUSTOM) return FULL_ID.test(custom.trim()) ? custom.trim() : "";
    return target || ctx?.snapshot.default_target || "";
  };
  /**
   * The remembered target is only valid while it is still offered: selecting the
   * workspace that was the target (or one that vanished in a refresh) removes
   * its option, and the select would then show the default while the request
   * kept comparing against the old value.
   */
  function normalizeTarget() {
    if (!ctx || !target || target === CUSTOM) return;
    if (!targetOptions(ctx).some((o) => o.value === target)) target = "";
  }
  const compareKey = () => `${ctx?.repo}|${ctx?.revision}|${effectiveTarget()}`;

  function ensureCompare() {
    if (!ctx || !ctx.revision) return;
    const tgt = effectiveTarget();
    if (!tgt || !node(ctx.revision)) return;
    const key = compareKey();
    const existing = cache.get(key);
    const generation = ctx.snapshot.generation;
    if (existing && (existing.loading || existing.generation === generation)) return;
    // A refresh for a new scan keeps showing the comparison it already has: the
    // entry only becomes visible again (v) when the answer actually differs.
    const had = existing?.data;
    const entry: CompareEntry = { data: had, loading: true, generation, v: (existing?.v ?? 0) + (had ? 0 : 1) };
    cache.set(key, entry);
    const mine = epoch;
    let request: Promise<Comparison>;
    try {
      request = Promise.resolve(graphAPI.compare(ctx.repo, ctx.revision, tgt));
    } catch (e) {
      request = Promise.reject(e);
    }
    request
      .then((data) => {
        if (mine !== epoch) return;
        if (!data) throw new Error("empty comparison");
        const changed = !had || JSON.stringify(had) !== JSON.stringify(data);
        entry.data = data;
        entry.error = undefined;
        entry.loading = false;
        if (changed) entry.v++;
        rerender();
      })
      .catch(() => {
        if (mine !== epoch) return;
        entry.error = "Comparison unavailable. Check the target revision.";
        entry.loading = false;
        entry.v++;
        rerender();
      });
  }

  function targetOptions(c: InspectorContext) {
    const opts: { value: string; label: string }[] = [];
    const def = c.snapshot.default_target;
    if (def) opts.push({ value: def, label: c.snapshot.default_target_ref ? displayText(c.snapshot.default_target_ref) : `default · ${def.slice(0, 8)}` });
    else opts.push({ value: "", label: "Choose a revision…" });
    const seen = new Set(def ? [def] : []);
    for (const o of c.others) {
      if (!o.revision || seen.has(o.revision) || o.revision === c.revision) continue;
      seen.add(o.revision);
      opts.push({ value: o.revision, label: `${o.name} · ${o.revision.slice(0, 8)}` });
      if (opts.length > 60) break;
    }
    opts.push({ value: CUSTOM, label: "Custom revision…" });
    return opts;
  }

  function fileRow(f: FileChange) {
    const row = el("div", { class: "change-row", title: f.path });
    row.append(icon("file", 15), el("span", { class: "change-name" }, fileName(f.path)));
    if (f.binary) row.append(el("span", { class: "change-count dim" }, "binary"));
    else if (f.additions !== undefined || f.deletions !== undefined) {
      row.append(
        el("span", { class: "change-count add" }, `+${f.additions ?? 0}`),
        el("span", { class: "change-count del" }, `-${f.deletions ?? 0}`),
      );
    } else row.append(el("span", { class: "change-count dim" }, f.status === "?" ? "new" : ""));
    row.append(el("span", { class: `change-status status-${f.status === "?" ? "untracked" : f.status}`, title: f.status }, f.status));
    return row;
  }
  function legacyRow(text: string) {
    const row = el("div", { class: "change-row", title: isDigest(text) ? "" : text });
    row.append(icon("file", 15), el("span", { class: "change-name" }, isDigest(text) ? `#${shortDigest(text)}` : text));
    return row;
  }

  function field(label: string, ...value: (Node | string)[]) {
    return el("div", { class: "insp-field" }, el("span", { class: "insp-label" }, label), el("div", { class: "insp-value" }, ...value));
  }
  /** A full path in a small wrapping code block; the title repeats it for the clipped case. */
  function pathField(label: string, path: string, cls: string) {
    const f = field(label, el("code", { class: "insp-path-text", title: path }, path));
    f.classList.add(cls);
    return f;
  }
  function stat(iconName: string, text: string) {
    return el("div", { class: "insp-stat" }, icon(iconName, 16), el("span", {}, text));
  }

  function renderRevision(n: GraphNode) {
    const box = el("div", { class: "insp-revision" });
    box.append(
      el("span", { class: "insp-label" }, "Revision"),
      el("div", { class: "rev-desc" }, displayText(n.description) || "No description"),
      el("code", { class: "rev-id" }, n.commit_id),
      el("div", { class: "dim rev-time" }, n.timestamp),
    );
    const parents = el("div", { class: "rev-parents" }, el("span", { class: "insp-label" }, "Parents"));
    if (!n.parents.length) parents.append(el("span", { class: "dim" }, "none"));
    n.parents.forEach((p, i) => {
      const pn = node(p);
      if (pn) {
        // index based so keyboard focus survives stepping to a revision with other parents
        const b = el("button", { type: "button", class: "parent-link", title: displayText(pn.description), "data-action": `parent:${i}` }, pn.commit_id.slice(0, 8));
        b.onclick = () => h.selectRevision(p);
        parents.append(b);
      } else parents.append(el("span", { class: "dim parent-missing", title: "Older history not loaded" }, `${p.slice(0, 8)} (not loaded)`));
    });
    box.append(parents);
    if (n.change_id) box.append(el("div", { class: "dim" }, `JJ change: ${n.change_id}`));
    return box;
  }

  function renderDetail(entry: CompareEntry | undefined, tgt: string) {
    const box = el("div", { class: "graph-comparison" });
    if (!tgt) {
      box.append(el("p", { class: "dim" }, "Select an explicit comparison target."));
      return box;
    }
    const c = entry?.data;
    if (!c) {
      box.append(el("p", { class: "dim" }, entry?.error ?? "Comparing…"));
      return box;
    }
    const ids = (title: string, list: string[]) => {
      box.append(el("h4", {}, `${title} (${list.length})`));
      const wrap = el("div", { class: "id-list" });
      for (const id of list.slice(0, LIST_LIMIT)) wrap.append(el("code", {}, id.slice(0, 12)));
      if (list.length > LIST_LIMIT) wrap.append(el("span", { class: "dim" }, `+${list.length - LIST_LIMIT} more`));
      box.append(wrap);
    };
    ids("Only on selected", c.selected_only ?? []);
    ids("Only on target", c.target_only ?? []);
    box.append(el("h4", {}, "Merge bases"));
    const bases = el("div", { class: "id-list" });
    for (const b of c.merge_bases ?? []) bases.append(el("code", {}, b.slice(0, 12)));
    if (!(c.merge_bases ?? []).length) bases.append(el("span", { class: "dim" }, "none"));
    box.append(bases);
    if (c.disconnected) box.append(el("p", {}, "Disconnected histories"));
    const files = c.changes ?? [];
    const names = c.changed_files ?? [];
    box.append(el("h4", {}, `Committed changed files (${files.length || names.length}${c.changes_truncated ? "+" : ""})`));
    if (files.length) for (const f of files) box.append(fileRow(f));
    else for (const f of names) box.append(legacyRow(f));
    for (const w of c.warnings ?? []) box.append(el("p", { class: "graph-warning" }, w));
    box.append(
      el(
        "p",
        { class: "dim" },
        "Uncommitted checkout changes are separate from this revision comparison. Revision identity does not establish patch equivalence.",
      ),
    );
    return box;
  }

  function build(c: InspectorContext) {
    const frag = document.createDocumentFragment();
    const ws = c.workspace;
    const n = node(c.revision);
    if (!ws && !n) {
      frag.append(
        el("h3", {}, "Select a workspace or revision"),
        el("p", { class: "dim" }, "Click a workspace label or a revision, or press ⌘K to search. Edges are revision parents only."),
      );
      if (c.unassigned)
        frag.append(el("p", { class: "dim" }, `${c.unassigned} sessions have unavailable or missing workspace identity.`));
      return frag;
    }

    // Header
    const head = el("div", { class: "insp-head" });
    if (ws) head.append(el("span", { class: `agent-dot big state-${c.state}`, title: stateDescription(c.state) }));
    head.append(el("h3", {}, ws ? c.name : `Revision ${n!.commit_id.slice(0, 8)}`));
    frag.append(head);

    if (ws) {
      const copy = el("button", { type: "button", class: "icon-button", "aria-label": "Copy branch name", title: "Copy", "data-action": "copy" }, icon("copy", 15));
      copy.onclick = async () => {
        const ok = await copyText(c.copyValue);
        copy.setAttribute("aria-label", ok ? "Copied" : "Copy failed");
        copy.classList.toggle("copied", ok);
        setTimeout(() => {
          copy.setAttribute("aria-label", "Copy branch name");
          copy.classList.remove("copied");
        }, 1400);
      };
      frag.append(field("Branch", el("span", { class: "insp-branch" }, c.branch), copy));
      const checkout = field(
        "Checkout",
        el(
          "span",
          { class: "insp-checkout-text" },
          [ws.availability || "available", ws.unborn ? "unborn" : "", ws.dirty ? "uncommitted changes" : "", ws.conflicted ? "conflicted" : ""]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      checkout.classList.add("insp-checkout");
      if (ws.availability && ws.availability !== "available") checkout.classList.add("unavailable");
      frag.append(checkout);
      if (c.workspacePath) frag.append(pathField("Path", c.workspacePath, "insp-path"));
      if (c.repoPath) frag.append(pathField("Repository", c.repoPath, "insp-repo-path"));

      const agents = el("div", { class: "insp-agents" });
      for (const a of c.agents) {
        const row = el("div", { class: "agent-row", "data-session": `${a.source}\0${a.id}` });
        const open = el("button", { type: "button", class: "agent-open", title: `${sourceName(a.source)} session ${a.id}`, "data-action": `session:${a.source}:${a.id}` });
        open.append(
          el("span", { class: `agent-dot state-${a.state}` }),
          el("span", { class: "agent-source" }, sourceName(a.source)),
          el("span", { class: "agent-sep" }, "•"),
          el("span", { class: "agent-word" }, a.word),
        );
        open.onclick = () => h.openSession(a.id, a.source);
        const filter = el("button", { type: "button", class: "agent-filter", "data-action": `filter:${a.source}:${a.id}` }, "Filter Timeline");
        filter.onclick = () => h.filterTimeline(a.source, a.id);
        row.append(open, el("span", { class: "agent-id dim" }, a.id.slice(0, 8)), filter);
        if (a.uncertainty) row.append(el("div", { class: "dim agent-note" }, a.uncertainty));
        agents.append(row);
      }
      if (!c.agents.length)
        agents.append(el("span", { class: "dim" }, "No explicitly associated session. Missing telemetry does not imply completion."));
      frag.append(field("Agent", agents));
    }

    if (n) frag.append(renderRevision(n));

    // Compare with <default ref>
    const tgt = effectiveTarget();
    const entry = cache.get(compareKey());
    if (n) {
      const select = el("select", { "aria-label": "Compare with", "data-action": "compare" });
      const opts = targetOptions(c);
      for (const o of opts) select.append(el("option", { value: o.value }, o.label));
      select.value = target === CUSTOM ? CUSTOM : target && opts.some((o) => o.value === target) ? target : (c.snapshot.default_target ?? "");
      select.onchange = () => {
        target = select.value;
        rerender();
      };
      const cmp = el("div", { class: "insp-compare" }, el("span", { class: "insp-label" }, "Compare with"), select, icon("chevron", 14));
      frag.append(cmp);
      if (target === CUSTOM) {
        const input = el("input", {
          "aria-label": "Custom revision",
          placeholder: "Full commit ID",
          value: custom,
          "data-action": "custom",
          spellcheck: "false",
        });
        const apply = () => {
          custom = input.value;
          rerender();
        };
        // The draft is kept as it is typed (not compared yet), so a redraw caused
        // by an activity update never erases what the user is entering.
        input.oninput = () => {
          custom = input.value;
        };
        input.onchange = apply;
        input.onkeydown = (e) => {
          if (e.key === "Enter") apply();
        };
        frag.append(input);
        if (custom && !FULL_ID.test(custom.trim()))
          frag.append(el("p", { class: "dim" }, "Comparison needs a full 40 to 64 character commit ID."));
      }

      // Stats
      const stats = el("div", { class: "insp-stats" });
      const data = entry?.data;
      if (data) stats.append(stat("commits", `${plural(data.selected_only?.length ?? 0, "unique commit")}`));
      else if (tgt && !entry?.error) stats.append(stat("commits", "Comparing…"));
      else if (entry?.error) stats.append(stat("commits", entry.error));
      if (ws) {
        const files = ws.changes?.length ?? ws.changed_files?.length ?? 0;
        stats.append(stat("file", `${files}${ws.changes_truncated ? "+" : ""} uncommitted ${files === 1 ? "file" : "files"}`));
      }
      if (tgt) {
        const targetKey = c.snapshot.nodes.find((x) => x.key === tgt || x.commit_id === tgt)?.key;
        if (targetKey && c.revision)
          stats.append(stat("nodes", `${plural(sharedAncestorCount(c.snapshot.nodes, c.revision, targetKey), "shared ancestor")} loaded`));
      }
      frag.append(stats);
    }
    // The comparison opens right under the stats and Changes, above the pinned buttons.
    const detail = n && detailOpen ? renderDetail(entry, tgt) : undefined;
    if (!ws && detail) frag.append(detail);

    if (ws) {
      const list = ws.changes ?? [];
      const legacy = ws.changed_files ?? [];
      const total = list.length || legacy.length;
      if (total) {
        const sec = el("section", { class: "insp-section insp-changes" });
        const count = `${total}${ws.changes_truncated ? "+" : ""}`;
        sec.append(el("h4", {}, `Changes (${count} ${total === 1 && !ws.changes_truncated ? "file" : "files"})`));
        if (list.length) for (const f of list) sec.append(fileRow(f));
        else for (const f of legacy) sec.append(legacyRow(f));
        if (ws.changes_truncated) sec.append(el("p", { class: "dim" }, "Only the first files are listed."));
        frag.append(sec);
      }
      if (detail) frag.append(detail);

      const act = el("section", { class: "insp-section insp-activity" });
      act.append(el("h4", {}, icon("list", 16), "Captured activity"));
      for (const a of c.activity)
        act.append(
          el("div", { class: "activity-row", "data-event": a.id }, icon("event", 15), el("span", { class: "act-text" }, a.text), el("span", { class: "act-age dim" }, a.age)),
        );
      if (!c.activity.length) act.append(el("p", { class: "dim" }, "No captured events for this workspace yet."));
      const open = el("button", { type: "button", "data-action": "timeline" }, "Open scoped Timeline");
      open.onclick = () => h.openTimeline();
      act.append(open);
      frag.append(act);

      const origin = el("section", { class: "insp-section insp-origin" });
      const help = el("button", { type: "button", class: "icon-button help", "aria-label": "About origin workspace", "aria-expanded": originHelp ? "true" : "false", "data-action": "origin-help" }, icon("help", 16));
      const helpText = el(
        "p",
        { class: "dim origin-help", id: "graph-origin-help" },
        "Firehose does not infer or record which workspace created another. Shared ancestry shows revision parents only.",
      );
      helpText.hidden = !originHelp;
      help.setAttribute("aria-controls", "graph-origin-help");
      help.onclick = () => {
        originHelp = !originHelp;
        rerender(true);
      };
      origin.append(
        el("h4", {}, "Origin workspace"),
        el("div", { class: "origin-row" }, icon("agent", 18), el("span", { class: "origin-value" }, "unknown"), help),
        helpText,
      );
      frag.append(origin);
    }

    if (n) {
      const actions = el("div", { class: "insp-actions" });
      const highlight = el("button", { type: "button", class: "primary-action", "data-action": "highlight" }, icon("branch", 16), "Highlight ancestry");
      highlight.onclick = () => h.highlightAncestry();
      const inspect = el("button", { type: "button", class: "secondary-action", "aria-expanded": detailOpen ? "true" : "false", "data-action": "inspect" }, icon("file", 16), "Inspect changes");
      inspect.onclick = () => {
        detailOpen = !detailOpen;
        revealDetail = detailOpen;
        rerender(true);
      };
      const desc = el("button", { type: "button", class: "toggle-action", "aria-pressed": c.descendants ? "true" : "false", title: "Highlight descendants instead of ancestors", "data-action": "descendants" }, c.descendants ? "Hide descendants" : "Show descendants");
      desc.onclick = () => h.toggleDescendants();
      if (c.descendants && !c.snapshot.nodes.some((x) => x.parents.includes(c.revision)))
        actions.append(el("p", { class: "dim descendants-note", role: "status" }, "No descendants loaded for this revision."));
      actions.append(highlight, el("div", { class: "insp-actions-row" }, inspect, desc));
      frag.append(actions);
    }
    if (c.unassigned)
      frag.append(el("p", { class: "dim" }, `${c.unassigned} sessions have unavailable or missing workspace identity.`));
    return frag;
  }

  function paint(force = false) {
    if (!ctx) return;
    const entry = cache.get(compareKey());
    const sig = JSON.stringify([
      ctx.repo,
      ctx.snapshot.nodes.length,
      ctx.snapshot.default_target,
      ctx.snapshot.default_target_ref,
      ctx.workspace,
      ctx.name,
      ctx.workspacePath,
      ctx.repoPath,
      ctx.branch,
      ctx.state,
      ctx.agents,
      ctx.activity,
      ctx.revision,
      ctx.descendants,
      ctx.unassigned,
      ctx.others,
      target,
      custom,
      detailOpen,
      originHelp,
      entry?.v,
    ]);
    if (!force && sig === signature) return;
    signature = sig;
    const active = root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    const focused = active?.getAttribute("data-action") ?? null;
    const range = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = root.scrollTop;
    clear(root);
    root.append(build(ctx));
    root.scrollTop = scroll;
    let restored = false;
    if (focused)
      for (const e of root.querySelectorAll<HTMLElement>("[data-action]"))
        if (e.getAttribute("data-action") === focused) {
          e.focus();
          if (range && e instanceof HTMLInputElement && range[0] !== null && range[1] !== null) e.setSelectionRange(range[0], range[1]);
          restored = true;
          break;
        }
    // The focused control no longer exists (a root revision has no parent link):
    // keep focus in the pane rather than dropping it to the page.
    if (active && !restored)
      (root.querySelector<HTMLElement>(".parent-link") ?? root.querySelector<HTMLElement>('[data-action="highlight"]'))?.focus();
    if (revealDetail) {
      revealDetail = false;
      root.querySelector(".graph-comparison")?.scrollIntoView?.({ block: "nearest" });
    }
  }
  function rerender(force = false) {
    paint(force);
    ensureCompare();
    // ensureCompare may have created a loading entry; show it.
    paint();
  }
  function update(next: InspectorContext) {
    ctx = next;
    normalizeTarget();
    paint();
    ensureCompare();
    paint();
  }
  /** Forget everything tied to a repository or privacy mode. */
  function reset() {
    epoch++;
    cache = new Map();
    target = "";
    custom = "";
    detailOpen = false;
    revealDetail = false;
    originHelp = false;
    ctx = undefined;
    signature = "";
    clear(root);
  }
  return { root, update, reset };
}

export type Inspector = ReturnType<typeof createInspector>;
