// Activity Map: the workspace section's third tab. One repository's path
// hierarchy as an SVG treemap over GET /workspace-graph/activity, with a
// scrubber that brushes a bucket range. Tile size is window total; tile colour
// is Heat in the brushed range, so brushing never moves a tile. It reports
// observed activity, never code quality.

import { clear, el, keepFocus } from "../../dom";
import { graphAPI, type ActivityResponse } from "../graph/api";
import { clampView, digestLabel, stripControl, type View } from "../score/model";
import { buildTree, colour, findNode, histogram, hottest, layout, rangeTotals, trail, LABEL_H, PAD } from "./model";
import type { TreeNode } from "./model";

export type MapWorkspace = { id: string; name: string };
export type ActivityMap = {
  root: HTMLElement;
  /** Called on every Workspaces render and poll: refetches only when the scope changed, or when Live and stale. */
  update(repo: string, workspaces: MapWorkspace[], privacyMode: string | undefined): void;
};

export const PRESETS = [
  { id: "2h", label: "2h", ms: 2 * 3600_000 },
  { id: "8h", label: "8h", ms: 8 * 3600_000 },
  { id: "24h", label: "24h", ms: 24 * 3600_000 },
  { id: "7d", label: "7d", ms: 7 * 24 * 3600_000 },
] as const;
type PresetId = (typeof PRESETS)[number]["id"];

/** A Live window this old is refetched on the next update (the graph polls every 15 s). */
const LIVE_REFRESH_MS = 10_000;
const MAP_H = 460;
const FALLBACK_W = 860;
const STRIP_H = 56;
const AXIS_H = 16;
const FILE_LABEL_W = 54;
const FILE_LABEL_H = 15;
const SVG_NS = "http://www.w3.org/2000/svg";

export const MINIMAL_NOTICE = "Paths are stored as digests in minimal mode; the Activity Map is unavailable.";

// Every captured value is a text node; attributes are numbers and our own classes.
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local-time axis ticks for [from, to), at least ~90px apart. */
export function axisTicks(from: number, to: number, width: number): { at: number; label: string }[] {
  const steps = [300_000, 900_000, 1_800_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000];
  const span = to - from;
  if (!(span > 0) || !(width > 0)) return [];
  const step = steps.find((s) => (s / span) * width >= 90) ?? steps[steps.length - 1];
  const offset = new Date(from).getTimezoneOffset() * 60_000;
  const out: { at: number; label: string }[] = [];
  for (let at = Math.ceil((from - offset) / step) * step + offset; at < to; at += step) {
    const d = new Date(at);
    const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const dated = step >= 6 * 3_600_000 || (d.getHours() === 0 && d.getMinutes() === 0);
    out.push({ at, label: dated ? `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock}` : clock });
  }
  return out;
}

function pathLabel(node: TreeNode): string {
  return stripControl(node.entry ? node.path : node.path || node.name);
}

export function createActivityMap(): ActivityMap {
  const presetBar = el("div", { class: "map-presets", role: "group", "aria-label": "Window" });
  const liveBtn = el("button", { type: "button", class: "map-live", "aria-pressed": "true", title: "Window ends at now and follows it" }, "Live");
  const worktreeSelect = el("select", { "aria-label": "Worktree" });
  const summary = el("span", { class: "map-summary dim" });
  const head = el("div", { class: "map-head" }, presetBar, liveBtn, worktreeSelect, summary);
  const notices = el("div", { class: "map-notices", role: "status" });
  const crumbs = el("nav", { class: "map-crumbs", "aria-label": "Map location" });
  const chart = el("div", { class: "map-chart" });
  const scrub = el("div", { class: "map-scrub" });
  const listTitle = el("h4", {}, "Hottest in range");
  const list = el("ol", { class: "map-hot" });
  const side = el("aside", { class: "map-side", "aria-label": "Hottest in range" }, listTitle, list);
  const stage = el("div", { class: "map-stage" }, crumbs, chart, scrub);
  const bodyEl = el("div", { class: "map-body" }, stage, side);
  const root = el("section", { class: "activity-map" }, head, notices, bodyEl);

  let repo = "";
  let workspaces: MapWorkspace[] = [];
  let privacy: string | undefined;
  let preset: PresetId = "24h";
  let live = true;
  /** The end of a non-Live window, frozen when Live was turned off. */
  let frozenEnd = Date.now();
  let worktree = "";
  let resp: ActivityResponse | undefined;
  let tree: TreeNode | undefined;
  let error = "";
  let loading = false;
  /** Brushed instants, or undefined for the whole window. */
  let brush: View | undefined;
  let zoom = "";
  let request: AbortController | undefined;
  let fetchedKey = "";
  let fetchedAt = 0;

  for (const p of PRESETS) {
    const b = el("button", { type: "button", "data-preset": p.id, "aria-pressed": "false" }, p.label);
    b.onclick = () => {
      if (preset === p.id) return;
      preset = p.id;
      brush = undefined;
      load(true);
    };
    presetBar.append(b);
  }
  liveBtn.onclick = () => {
    live = !live;
    if (!live) frozenEnd = resp ? Date.parse(resp.to) : Date.now();
    load(true);
  };
  worktreeSelect.onchange = () => {
    worktree = worktreeSelect.value;
    zoom = "";
    load(true);
  };

  const groupNames = () => new Map(workspaces.map((w) => [w.id, w.name]));
  const minimal = () => privacy === "minimal" || resp?.unavailable_reason === "minimal";
  const span = () => PRESETS.find((p) => p.id === preset)!.ms;
  const scopeKey = () => [repo, worktree, preset, live ? "live" : String(frozenEnd)].join("\0");

  function abort() {
    const r = request;
    request = undefined;
    r?.abort();
  }

  /** Fetch when the scope changed (or forced), or when Live and the last answer is stale. */
  function load(force = false) {
    const key = scopeKey();
    const stale = live && Date.now() - fetchedAt >= LIVE_REFRESH_MS;
    if (!repo || privacy === "minimal") {
      abort();
      render();
      return;
    }
    if (!force && key === fetchedKey && (!stale || request)) {
      render();
      return;
    }
    abort();
    const controller = new AbortController();
    request = controller;
    const end = live ? Date.now() : frozenEnd;
    const params: Record<string, string> = {
      repo_id: repo,
      from: new Date(end - span()).toISOString(),
      to: new Date(end).toISOString(),
    };
    if (worktree) params.workspace_id = worktree;
    if (key !== fetchedKey) {
      resp = undefined;
      tree = undefined;
    }
    fetchedKey = key;
    loading = true;
    error = "";
    render();
    graphAPI.activity(params, controller.signal).then(
      (next) => {
        if (request !== controller) return;
        request = undefined;
        loading = false;
        fetchedAt = Date.now();
        resp = { ...next, paths: next.paths ?? [], groups: next.groups ?? [] };
        tree = buildTree(resp, groupNames());
        if (zoom && !findNode(tree, zoom)) zoom = "";
        render();
      },
      () => {
        if (controller.signal.aborted || request !== controller) return;
        request = undefined;
        loading = false;
        fetchedAt = Date.now();
        error = "Activity unavailable — the next refresh retries.";
        render();
      },
    );
  }

  // ---- brush ----------------------------------------------------------------

  function bounds(r: ActivityResponse): View {
    const from = Date.parse(r.from);
    return { from, to: from + r.buckets * r.bucket_seconds * 1000 };
  }
  /** The brushed bucket range [a, b), snapped and clamped to the loaded window. */
  function range(r: ActivityResponse): [number, number] {
    if (!brush) return [0, r.buckets];
    const b = bounds(r);
    const ms = r.bucket_seconds * 1000;
    const v = clampView(brush, b);
    const a = Math.max(0, Math.min(r.buckets - 1, Math.round((v.from - b.from) / ms)));
    return [a, Math.max(a + 1, Math.min(r.buckets, Math.round((v.to - b.from) / ms)))];
  }
  function setRange(r: ActivityResponse, a: number, b: number) {
    const ms = r.bucket_seconds * 1000;
    const from = Date.parse(r.from);
    a = Math.max(0, Math.min(a, r.buckets - 1));
    b = Math.max(a + 1, Math.min(b, r.buckets));
    brush = a === 0 && b === r.buckets ? undefined : { from: from + a * ms, to: from + b * ms };
    render();
  }

  // ---- render -----------------------------------------------------------------

  function renderHead() {
    for (const b of presetBar.querySelectorAll<HTMLButtonElement>("button")) {
      const on = b.dataset.preset === preset;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    liveBtn.classList.toggle("active", live);
    liveBtn.setAttribute("aria-pressed", live ? "true" : "false");
    const sig = workspaces.map((w) => `${w.id}\0${w.name}`).join("\n");
    if (worktreeSelect.dataset.sig !== sig) {
      worktreeSelect.dataset.sig = sig;
      clear(worktreeSelect);
      worktreeSelect.append(el("option", { value: "" }, "All worktrees"));
      for (const w of workspaces) worktreeSelect.append(el("option", { value: w.id }, stripControl(w.name)));
    }
    worktreeSelect.value = worktree;
    const disabled = minimal();
    for (const b of head.querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button, select")) b.disabled = disabled;
  }

  function notice(text: string, kind = "") {
    notices.append(el("p", { class: `map-notice ${kind}`.trim() }, text));
  }

  function render() {
    const restore = keepFocus(root);
    renderHead();
    clear(notices);
    clear(crumbs);
    clear(chart);
    clear(scrub);
    clear(list);
    summary.textContent = "";
    bodyEl.hidden = false;
    if (minimal()) {
      notice(MINIMAL_NOTICE, "unavailable");
      bodyEl.hidden = true;
      restore();
      return;
    }
    if (error) notice(error, "error");
    if (!resp || !tree) {
      chart.append(el("p", { class: "dim map-empty" }, loading ? "Loading activity…" : repo ? "" : "Select a repository."));
      restore();
      return;
    }
    const r = resp;
    const [a, b] = range(r);
    if (r.capture_gap) notice("Capture gaps reported; this map may be incomplete.", "warn");
    if (r.truncated) notice(`Showing the 2,000 hottest paths; ${r.truncated_total.toLocaleString()} Heat on other paths is not drawn.`, "warn");
    if (r.unreadable_file_events > 0)
      notice(`${plural(r.unreadable_file_events, "file event")} carried no readable path and add no Heat.`);
    if (r.paths.length === 0) notice("No file activity captured in this window.");
    summary.textContent = `${plural(r.file_events, "file event")} · ${plural(r.paths.length, "path")}`;

    renderCrumbs();
    renderMap(a, b);
    renderScrub(r, a, b);
    renderList(r, a, b);
    restore();
  }

  function renderCrumbs() {
    const path = trail(tree!, zoom || tree!.key);
    path.forEach((node, i) => {
      const last = i === path.length - 1;
      const name = i === 0 ? "Repository" : stripControl(node.name);
      if (last) crumbs.append(el("span", { class: "map-crumb current", "aria-current": "location" }, name));
      else {
        const btn = el("button", { type: "button", class: "map-crumb", "data-key": `crumb:${node.key}` }, name);
        btn.onclick = () => {
          zoom = node.key === tree!.key ? "" : node.key;
          render();
        };
        crumbs.append(btn, el("span", { class: "map-crumb-sep", "aria-hidden": "true" }, "/"));
      }
    });
  }

  function renderMap(a: number, b: number) {
    const view = (zoom && findNode(tree!, zoom)) || tree!;
    const width = Math.max(320, chart.clientWidth || FALLBACK_W);
    const rects = layout(view, width, MAP_H);
    const inRange = rangeTotals(tree!, a, b);
    let max = 0;
    for (const x of rects) if (!x.node.children) max = Math.max(max, inRange.get(x.key) ?? 0);
    const map = svg("svg", { class: "map-svg", viewBox: `0 0 ${width} ${MAP_H}`, width, height: MAP_H, role: "group", "aria-label": "Activity Map" });
    for (const [i, x] of rects.entries()) {
      const heat = inRange.get(x.key) ?? 0;
      const title = svg("title", {}, `${pathLabel(x.node)}\nHeat in range: ${heat.toLocaleString()}\nWindow total: ${x.node.total.toLocaleString()}`);
      if (x.node.children) {
        const g = svg("g", { class: "map-dir", "data-key": x.key, tabindex: 0, role: "button" }, title);
        g.append(svg("rect", { x: x.x, y: x.y, width: x.w, height: x.h, rx: 2 }));
        if (x.label) {
          const clip = `map-clip-${i}`;
          g.append(
            svg("clipPath", { id: clip }, svg("rect", { x: x.x, y: x.y, width: Math.max(0, x.w - PAD * 2), height: LABEL_H + PAD })),
            svg("text", { x: x.x + PAD + 2, y: x.y + PAD + LABEL_H - 4, "clip-path": `url(#${clip})` }, `${stripControl(x.node.name)} · ${heat.toLocaleString()}`),
          );
        }
        const zoomIn = () => {
          zoom = x.key;
          render();
        };
        g.addEventListener("click", zoomIn);
        g.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            zoomIn();
          }
        });
        map.append(g);
      } else {
        const g = svg("g", { class: heat > 0 ? "map-tile" : "map-tile cold", "data-key": x.key }, title);
        g.append(svg("rect", { x: x.x, y: x.y, width: Math.max(0, x.w - 1), height: Math.max(0, x.h - 1), fill: colour(heat, max) }));
        if (x.w >= FILE_LABEL_W && x.h >= FILE_LABEL_H) {
          const clip = `map-clip-${i}`;
          g.append(
            svg("clipPath", { id: clip }, svg("rect", { x: x.x, y: x.y, width: x.w - 3, height: x.h })),
            svg("text", { x: x.x + 3, y: x.y + 12, "clip-path": `url(#${clip})` }, stripControl(x.node.name)),
          );
        }
        map.append(g);
      }
    }
    chart.append(map);
  }

  function renderScrub(r: ActivityResponse, a: number, b: number) {
    const counts = histogram(r);
    const width = Math.max(320, scrub.clientWidth || chart.clientWidth || FALLBACK_W);
    const peak = Math.max(1, ...counts);
    const bw = width / Math.max(1, r.buckets);
    const strip = svg("svg", {
      class: "map-strip",
      viewBox: `0 0 ${width} ${STRIP_H + AXIS_H}`,
      width,
      height: STRIP_H + AXIS_H,
      tabindex: 0,
      role: "slider",
      "aria-label": "Brushed time range",
      "aria-valuemin": 0,
      "aria-valuemax": r.buckets,
      "aria-valuenow": a,
      "aria-valuetext": rangeText(r, a, b),
      "data-key": "map-strip",
    });
    counts.forEach((n, i) => {
      if (n <= 0) return;
      const h = Math.max(1, (n / peak) * (STRIP_H - 4));
      strip.append(svg("rect", { class: i >= a && i < b ? "map-bar in" : "map-bar", x: i * bw, y: STRIP_H - h, width: Math.max(0.5, bw - 0.5), height: h }));
    });
    strip.append(svg("rect", { class: "map-brush", x: a * bw, y: 0, width: (b - a) * bw, height: STRIP_H }));
    const from = Date.parse(r.from);
    const end = from + r.buckets * r.bucket_seconds * 1000;
    const axis = svg("g", { class: "map-axis" });
    for (const t of axisTicks(from, end, width)) {
      const x = ((t.at - from) / (end - from)) * width;
      axis.append(svg("line", { x1: x, x2: x, y1: STRIP_H, y2: STRIP_H + 4 }), svg("text", { x: x + 3, y: STRIP_H + AXIS_H - 3 }, t.label));
    }
    strip.append(axis);

    strip.addEventListener("keydown", (e) => {
      const [x, y] = range(r);
      const w = y - x;
      let next: [number, number] | undefined;
      if (e.key === "ArrowLeft" && e.shiftKey) next = [x, Math.max(x + 1, y - 1)];
      else if (e.key === "ArrowRight" && e.shiftKey) next = [x, y + 1];
      else if (e.key === "ArrowLeft") next = [Math.max(0, x - 1), Math.max(0, x - 1) + w];
      else if (e.key === "ArrowRight") next = [Math.min(r.buckets - w, x + 1), Math.min(r.buckets - w, x + 1) + w];
      else if (e.key === "Home") next = [0, w];
      else if (e.key === "End") next = [r.buckets - w, r.buckets];
      else if (e.key === "Escape") next = [0, r.buckets];
      if (!next) return;
      e.preventDefault();
      setRange(r, next[0], next[1]);
    });
    strip.addEventListener("pointerdown", (e) => {
      // Every brush change redraws the strip, so the drag lives on the window
      // and reads the current strip each time.
      const r0 = r;
      const bucketAt = (ev: PointerEvent) => {
        const box = (scrub.querySelector(".map-strip") ?? strip).getBoundingClientRect();
        const frac = box.width > 0 ? (ev.clientX - box.left) / box.width : 0;
        return Math.max(0, Math.min(r0.buckets - 1, Math.floor(frac * r0.buckets)));
      };
      const anchor = bucketAt(e);
      const move = (ev: PointerEvent) => {
        if (resp !== r0) return stop();
        const at = bucketAt(ev);
        setRange(r0, Math.min(anchor, at), Math.max(anchor, at) + 1);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      e.preventDefault();
      setRange(r0, anchor, anchor + 1);
    });
    strip.addEventListener("dblclick", () => setRange(r, 0, r.buckets));

    const whole = el("button", { type: "button", class: "map-whole", "data-key": "map-whole" }, "Whole window");
    whole.disabled = !brush;
    whole.onclick = () => setRange(r, 0, r.buckets);
    scrub.append(strip, el("div", { class: "map-scrub-foot dim" }, el("span", {}, rangeText(r, a, b)), whole));
  }

  function rangeText(r: ActivityResponse, a: number, b: number): string {
    const ms = r.bucket_seconds * 1000;
    const from = Date.parse(r.from);
    const fmt = (t: number) => {
      const d = new Date(t);
      return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    };
    const end = Math.min(from + b * ms, Date.parse(r.to));
    return `${fmt(from + a * ms)} – ${fmt(end)}`;
  }

  function renderList(r: ActivityResponse, a: number, b: number) {
    const hot = hottest(r, a, b);
    if (!hot.length) {
      list.append(el("li", { class: "dim" }, "No Heat in this range."));
      return;
    }
    for (const h of hot) {
      const owner = groupNames().get(h.group) || digestLabel(h.group) || h.group;
      const where = h.group ? `${stripControl(owner)} · outside known worktrees` : "";
      list.append(
        el(
          "li",
          { title: `${stripControl(h.path)} — window total ${h.total.toLocaleString()}` },
          el("span", { class: "map-hot-path" }, stripControl(h.path)),
          el("span", { class: "map-hot-count" }, h.heat.toLocaleString()),
          where ? el("span", { class: "map-hot-where dim" }, where) : null,
        ),
      );
    }
  }

  return {
    root,
    update(nextRepo, nextWorkspaces, nextPrivacy) {
      if (nextRepo !== repo) {
        abort();
        repo = nextRepo;
        worktree = "";
        brush = undefined;
        zoom = "";
        resp = undefined;
        tree = undefined;
        error = "";
        fetchedKey = "";
        frozenEnd = Date.now();
      }
      if (nextPrivacy !== privacy) {
        privacy = nextPrivacy;
        fetchedKey = "";
        resp = undefined;
        tree = undefined;
      }
      workspaces = nextWorkspaces;
      if (worktree && !workspaces.some((w) => w.id === worktree)) {
        worktree = "";
        fetchedKey = "";
      }
      load();
    },
  };
}
