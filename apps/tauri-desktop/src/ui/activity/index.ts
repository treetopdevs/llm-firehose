// Activity Map: the workspace section's third tab. One repository's path
// hierarchy as an SVG treemap over GET /workspace-graph/activity, with a
// scrubber that brushes a bucket range. Tile size is window total; tile colour
// is Heat in the brushed range, so brushing never moves a tile. It reports
// observed activity, never code quality.

import { clear, el, keepFocus } from "../../dom";
import { DEFAULT_LIVE_SPAN_MS, resolveRange, shiftWindow, spanOf, type ScopeWindow } from "../../scope";
import { graphAPI, type ActivityResponse } from "../graph/api";
import { clampView, stripControl, type View } from "../score/model";
import { activityGroupLabel, buildTree, colour, findNode, histogram, hottest, layout, rangeTotals, trail, LABEL_H, PAD } from "./model";
import {errorRange,errorPathKey,renderErrorPaths} from "./errors";
import type { TreeNode } from "./model";
import { LOCAL } from "../../keys";
import { yieldsToModal } from "../../escape";

export type MapWorkspace = { id: string; name: string };
/** Shell-owned window and worktree: the hosted map has no controls of its own for either. */
export type ActivityHost = {
  onWindow(w: ScopeWindow): void;
  onPickWorktree(id: string | undefined): void;
  /** Injected clock; the hosted map reads time from nowhere else. */
  now?(): number;
};
export type ActivityView = { window: ScopeWindow; liveSpanMs?: number; worktree?: string };
export type ActivityMap = {
  root: HTMLElement;
  /** Called on every Workspaces render and poll: refetches only when the scope changed, or when Live and stale. */
  update(repo: string, workspaces: MapWorkspace[], privacyMode: string | undefined, view?: ActivityView): void;
  /** Tears down any brush in flight and its window/document listeners. */
  cancel(): void;
  /** An inactive instance never commits a window; deactivating cancels. */
  setActive(active: boolean): void;
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
/** The daemon refuses windows longer than this. */
const MAX_WINDOW_MS = 31 * 86_400_000;
const CLAMP_NOTICE = "Showing the last 31 days (the daemon limit).";
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

export function createActivityMap(host?: ActivityHost): ActivityMap {
  const hosted = host !== undefined;
  const clock = (): number => host?.now?.() ?? Date.now();
  const presetBar = el("div", { class: "map-presets", role: "group", "aria-label": "Window" });
  const liveBtn = el("button", { type: "button", class: "map-live", "aria-pressed": "true", title: "Window ends at now and follows it" }, "Live");
  const worktreeSelect = el("select", { "aria-label": "Worktree" });
  const summary = el("span", { class: "map-summary dim" });
  const head = hosted ? el("div", { class: "map-head" }, summary) : el("div", { class: "map-head" }, presetBar, liveBtn, worktreeSelect, summary);
  const scopeNote = el("div", { class: "map-scope" });
  const notices = el("div", { class: "map-notices", role: "status" });
  const crumbs = el("nav", { class: "map-crumbs", "aria-label": "Map location" });
  const chart = el("div", { class: "map-chart" });
  const scrub = el("div", { class: "map-scrub" });
  const listTitle = el("h4", {}, "Hottest in range");
  const list = el("ol", { class: "map-hot" });
  const side = el("aside", { class: "map-side", "aria-label": "Hottest in range" }, listTitle, list);
  const stage = el("div", { class: "map-stage" }, crumbs, chart, scrub);
  const bodyEl = el("div", { class: "map-body" }, stage, side);
  const root = el("section", { class: "activity-map" }, head, ...(hosted ? [scopeNote] : []), notices, bodyEl);

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
  let cachedHistResp: ActivityResponse | undefined;
  let cachedHist: number[] = [];
  let error = "";
  let loading = false;
  /** Brushed instants, or undefined for the whole window. */
  let brush: View | undefined;
  let zoom = "";
  let request: AbortController | undefined;
  let fetchedKey = "";
  /** The last request failed: the cached key is not an answer, so the next load() asks again. */
  let failed = false;
  let fetchedAt = 0;
  let view: ActivityView = { window: "live" };
  let clamped = false;
  let active = true;
  let generation = 0;
  let lastKey = "";
  /** The brush in flight: where it started and how to tear it down. */
  let drag: { gen: number; key: string; stop(): void } | undefined;

  type MapDirRec = {
    key: string;
    node: TreeNode;
    g: SVGGElement;
    title: SVGTitleElement;
    text?: SVGTextElement;
  };
  type MapTileRec = {
    key: string;
    node: TreeNode;
    g: SVGGElement;
    rect: SVGRectElement;
    title: SVGTitleElement;
    errKey: string;
  };
  let mapView:
    | {
        tree: TreeNode;
        zoom: string;
        width: number;
        svg: SVGSVGElement;
        dirs: MapDirRec[];
        tiles: MapTileRec[];
        dirByKey: Map<string, MapDirRec>;
      }
    | undefined;
  let scrubView:
    | {
        resp: ActivityResponse;
        width: number;
        bw: number;
        strip: SVGSVGElement;
        bars: { index: number; rect: SVGRectElement }[];
        brushRect: SVGRectElement;
        footText: HTMLSpanElement;
        wholeBtn?: HTMLButtonElement;
      }
    | undefined;

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
  const liveSpan = () => view.liveSpanMs ?? DEFAULT_LIVE_SPAN_MS;
  const scopeKey = () =>
    hosted
      ? [repo, worktree, view.window === "live" ? `live${liveSpan()}` : `${view.window.from}-${view.window.to}`].join("\0")
      : [repo, worktree, preset, live ? "live" : String(frozenEnd)].join("\0");

  function cancelDrag() {
    drag?.stop();
    drag = undefined;
  }

  function abort() {
    const r = request;
    request = undefined;
    r?.abort();
  }

  /** Fetch when the scope changed (or forced), or when Live and the last answer is stale. */
  function load(force = false) {
    const key = scopeKey();
    const isLiveNow = hosted ? view.window === "live" : live;
    const stale = isLiveNow && clock() - fetchedAt >= LIVE_REFRESH_MS;
    if (!repo || privacy === "minimal") {
      abort();
      render();
      return;
    }
    if (!force && !failed && key === fetchedKey && (!stale || request)) {
      render();
      return;
    }
    abort();
    const controller = new AbortController();
    request = controller;
    let from: number;
    let to: number;
    if (hosted) {
      ({ from, to } = resolveRange(view.window, clock(), liveSpan()));
      clamped = to - from > MAX_WINDOW_MS;
      if (clamped) from = to - MAX_WINDOW_MS;
    } else {
      to = live ? Date.now() : frozenEnd;
      from = to - span();
    }
    const params: Record<string, string> = {
      repo_id: repo,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    };
    if (worktree) params.workspace_id = worktree;
    if (key !== fetchedKey) {
      errorPage.page = 0;
      resp = undefined;
      tree = undefined;
    }
    fetchedKey = key;
    failed = false;
    loading = true;
    error = "";
    render();
    graphAPI.activity(params, controller.signal).then(
      (next) => {
        if (request !== controller) return;
        request = undefined;
        loading = false;
        fetchedAt = clock();
        resp = { ...next, paths: next.paths ?? [], groups: next.groups ?? [] };
        tree = buildTree(resp, groupNames());
        if (zoom && !findNode(tree, zoom)) zoom = "";
        render();
      },
      () => {
        if (controller.signal.aborted || request !== controller) return;
        request = undefined;
        loading = false;
        fetchedAt = clock();
        failed = true;
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
    renderRange();
  }

  function renderRange() {
    if (!resp || !tree || !mapView || !scrubView || mapView.tree !== tree || scrubView.resp !== resp || !chart.contains(mapView.svg) || !scrub.contains(scrubView.strip)) {
      render();
      return;
    }
    const focusedErrorControl = root.querySelector(".map-errors")?.contains(document.activeElement);
    const restore = focusedErrorControl ? keepFocus(root) : undefined;
    const r = resp;
    const [a, b] = range(r);
    paintMapRange(a, b);
    paintScrubRange(r, a, b);
    clear(list);
    renderList(r, a, b);
    root.querySelector(".map-errors")?.remove();
    if (r.error_paths) {
      list.after(renderErrorPaths(errorRange(r.error_paths, a, b), groupNames(), errorPage));
    }
    restore?.();
    if (focusedErrorControl && (!root.contains(document.activeElement) || (document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled))) {
      root.querySelector<HTMLElement>('[data-key="error-path-heading"]')?.focus();
    }
  }

  // ---- render -----------------------------------------------------------------

  function renderHead() {
    if (hosted) {
      for (const b of head.querySelectorAll<HTMLButtonElement>("button")) b.disabled = minimal();
      return;
    }
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

  const errorPage = {page: 0};
  function render() {
    const focusedErrorControl = root.querySelector(".map-errors")?.contains(document.activeElement);
    const restore = keepFocus(root);
    renderHead();
    clear(notices);
    clear(crumbs);
    root.querySelector(".map-errors")?.remove();
    clear(list);
    summary.textContent = "";
    bodyEl.hidden = false;
    if (minimal()) {
      clear(chart);
      clear(scrub);
      mapView = undefined;
      scrubView = undefined;
      notice(MINIMAL_NOTICE, "unavailable");
      bodyEl.hidden = true;
      restore();
      return;
    }
    if (hosted) renderScopeNote();
    if (error) {
      notice(error, "error");
      if (hosted) {
        const retry = el("button", { type: "button", class: "map-retry" }, "Retry");
        retry.onclick = () => load(true);
        notices.append(retry);
      }
    }
    if (!resp || !tree) {
      clear(chart);
      clear(scrub);
      mapView = undefined;
      scrubView = undefined;
      chart.append(el("p", { class: "dim map-empty" }, loading ? "Loading activity…" : repo ? "" : "Select a project."));
      restore();
      return;
    }
    const r = resp;
    const [a, b] = range(r);
    if (r.capture_gap) notice("Capture gaps reported; this map may be incomplete.", "warn");
    if (r.truncated) notice(`Showing the 2,000 hottest paths; ${r.truncated_total.toLocaleString()} Heat on other paths is not drawn.`, "warn");
    if (r.unreadable_file_events > 0)
      notice(`${plural(r.unreadable_file_events, "file event")} carried no readable path and add no Heat.`);
    if (hosted && clamped) notice(CLAMP_NOTICE);
    if (r.paths.length === 0) {
      if (hosted && worktree) {
        const p = el("p", { class: "map-notice" }, "No activity for this worktree in this window ");
        p.append(clearButton());
        notices.append(p);
      } else notice("No file activity captured in this window.");
    }
    summary.textContent = `${plural(r.file_events, "file event")} · ${plural(r.paths.length, "path")}`;

    renderCrumbs();
    renderMap(a, b);
    renderScrub(r, a, b);
    renderList(r, a, b);
    if (!r.error_paths) notice("File-linked error overlay unavailable from this daemon.");
    else {
      if (r.omitted_error_paths) notice(`${r.omitted_error_paths} error paths omitted from the loaded window; overlay and list are incomplete.`, "warn");
      list.after(renderErrorPaths(errorRange(r.error_paths,a,b),groupNames(),errorPage));
    }
    restore();
    if (focusedErrorControl && (!root.contains(document.activeElement) || (document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled))) root.querySelector<HTMLElement>('[data-key="error-path-heading"]')?.focus();
  }

  function clearButton(): HTMLButtonElement {
    const b = el("button", { type: "button", class: "map-clear" }, "Clear");
    b.onclick = () => host?.onPickWorktree(undefined);
    return b;
  }

  function renderScopeNote() {
    clear(scopeNote);
    if (!worktree) return;
    const name = workspaces.find((w) => w.id === worktree)?.name ?? worktree;
    scopeNote.append(el("span", { class: "map-scope-name" }, `Worktree: ${stripControl(name)}`), " ", clearButton());
  }

  function renderCrumbs() {
    const path = trail(tree!, zoom || tree!.key);
    path.forEach((node, i) => {
      const last = i === path.length - 1;
      const name = i === 0 ? "Project" : stripControl(node.name);
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

  function ensureMapSvg() {
    const t = tree!;
    const width = Math.max(320, chart.clientWidth || FALLBACK_W);
    if (mapView && mapView.tree === t && mapView.zoom === zoom && mapView.width === width && chart.contains(mapView.svg)) {
      return;
    }
    const viewNode = (zoom && findNode(t, zoom)) || t;
    const rects = layout(viewNode, width, MAP_H);
    const map = svg("svg", { class: "map-svg", viewBox: `0 0 ${width} ${MAP_H}`, width, height: MAP_H, role: "group", "aria-label": "Activity Map" });
    const dirs: MapDirRec[] = [];
    const tiles: MapTileRec[] = [];
    const dirByKey = new Map<string, MapDirRec>();
    for (const [i, x] of rects.entries()) {
      const title = svg("title", {});
      if (x.node.children) {
        const g = svg("g", { class: "map-dir", "data-key": x.key, tabindex: 0, role: "button" }, title);
        g.append(svg("rect", { x: x.x, y: x.y, width: x.w, height: x.h, rx: 2 }));
        let text: SVGTextElement | undefined;
        if (x.label) {
          const clip = `map-clip-${i}`;
          text = svg("text", { x: x.x + PAD + 2, y: x.y + PAD + LABEL_H - 4, "clip-path": `url(#${clip})` });
          g.append(
            svg("clipPath", { id: clip }, svg("rect", { x: x.x, y: x.y, width: Math.max(0, x.w - PAD * 2), height: LABEL_H + PAD })),
            text,
          );
        }
        const rec: MapDirRec = { key: x.key, node: x.node, g, title, text };
        dirs.push(rec);
        dirByKey.set(x.key, rec);
        map.append(g);
      } else {
        const g = svg("g", { class: "map-tile", "data-key": x.key }, title);
        const rect = svg("rect", { x: x.x, y: x.y, width: Math.max(0, x.w - 1), height: Math.max(0, x.h - 1), fill: "var(--map-zero)" });
        g.append(rect);
        if (x.w >= FILE_LABEL_W && x.h >= FILE_LABEL_H) {
          const clip = `map-clip-${i}`;
          g.append(
            svg("clipPath", { id: clip }, svg("rect", { x: x.x, y: x.y, width: x.w - 3, height: x.h })),
            svg("text", { x: x.x + 3, y: x.y + 12, "clip-path": `url(#${clip})` }, stripControl(x.node.name)),
          );
        }
        tiles.push({ key: x.key, node: x.node, g, rect, title, errKey: errorPathKey(x.node.group, x.node.path) });
        map.append(g);
      }
    }
    const activateDir = (target: EventTarget | null) => {
      const dirEl = (target as Element | null)?.closest?.(".map-dir");
      const key = dirEl?.getAttribute("data-key");
      if (!key) return;
      const rec = dirByKey.get(key);
      if (!rec) return;
      // Daemon group ids are the event's own worktree/JJ id and rows expose no alias,
      // so only a group equal to a workspace id (worktree_id) can narrow the worktree;
      // any other identity zooms as before.
      const pick = hosted && rec.node.group !== "" && rec.node.path === "" && workspaces.some((w) => w.id === rec.node.group);
      if (pick) return host!.onPickWorktree(rec.node.group);
      zoom = rec.key;
      render();
    };
    map.addEventListener("click", (e) => activateDir(e.target));
    map.addEventListener("keydown", (e) => {
      if (LOCAL.mapDir.matches(e)) {
        e.preventDefault();
        activateDir(e.target);
      }
    });
    clear(chart);
    chart.append(map);
    mapView = { tree: t, zoom, width, svg: map, dirs, tiles, dirByKey };
  }

  function paintMapRange(a: number, b: number) {
    if (!mapView || !tree) return;
    const inRange = rangeTotals(tree, a, b);
    const errors = new Map(errorRange(resp?.error_paths ?? [], a, b).map((p) => [errorPathKey(p.group, p.path), p]));
    let max = 0;
    for (const tile of mapView.tiles) {
      const h = inRange.get(tile.key) ?? 0;
      if (h > max) max = h;
    }
    for (const dir of mapView.dirs) {
      const heat = inRange.get(dir.key) ?? 0;
      dir.title.textContent = `${pathLabel(dir.node)}\nHeat in range: ${heat.toLocaleString()}\nWindow total: ${dir.node.total.toLocaleString()}`;
      if (dir.text) {
        const label = `${stripControl(dir.node.name)} · ${heat.toLocaleString()}`;
        if (dir.text.textContent !== label) dir.text.textContent = label;
      }
    }
    for (const tile of mapView.tiles) {
      const heat = inRange.get(tile.key) ?? 0;
      const repeated = errors.get(tile.errKey)?.repeated ?? 0;
      const baseTitle = `${pathLabel(tile.node)}\nHeat in range: ${heat.toLocaleString()}\nWindow total: ${tile.node.total.toLocaleString()}`;
      const nextTitle = repeated ? `${baseTitle}\n${repeated} repeated Error Signatures in range (retained observations)` : baseTitle;
      if (tile.title.textContent !== nextTitle) tile.title.textContent = nextTitle;
      const cls = (heat > 0 ? "map-tile" : "map-tile cold") + (repeated ? " map-storm" : "");
      if (tile.g.getAttribute("class") !== cls) tile.g.setAttribute("class", cls);
      const fill = colour(heat, max);
      if (tile.rect.getAttribute("fill") !== fill) tile.rect.setAttribute("fill", fill);
    }
  }

  function renderMap(a: number, b: number) {
    ensureMapSvg();
    paintMapRange(a, b);
  }

  function ensureScrubSvg(r: ActivityResponse) {
    const width = Math.max(320, scrub.clientWidth || chart.clientWidth || FALLBACK_W);
    if (scrubView && scrubView.resp === r && scrubView.width === width && scrub.contains(scrubView.strip)) {
      return;
    }
    if (cachedHistResp !== r) {
      cachedHistResp = r;
      cachedHist = histogram(r);
    }
    const counts = cachedHist;
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
      "aria-valuenow": 0,
      "aria-valuetext": "",
      "data-key": "map-strip",
    });
    const bars: { index: number; rect: SVGRectElement }[] = [];
    counts.forEach((n, i) => {
      if (n <= 0) return;
      const h = Math.max(1, (n / peak) * (STRIP_H - 4));
      const rect = svg("rect", { class: "map-bar", x: i * bw, y: STRIP_H - h, width: Math.max(0.5, bw - 0.5), height: h });
      bars.push({ index: i, rect });
      strip.append(rect);
    });
    const brushRect = svg("rect", { class: "map-brush", x: 0, y: 0, width: width, height: STRIP_H });
    strip.append(brushRect);
    const from = Date.parse(r.from);
    const end = from + r.buckets * r.bucket_seconds * 1000;
    const axis = svg("g", { class: "map-axis" });
    for (const t of axisTicks(from, end, width)) {
      const x = ((t.at - from) / (end - from)) * width;
      axis.append(svg("line", { x1: x, x2: x, y1: STRIP_H, y2: STRIP_H + 4 }), svg("text", { x: x + 3, y: STRIP_H + AXIS_H - 3 }, t.label));
    }
    strip.append(axis);

    strip.addEventListener("keydown", (e) => {
      if (!LOCAL.mapStrip.matches(e) && !LOCAL.mapStripReset.matches(e)) return;
      if (hosted) {
        if (LOCAL.mapStripReset.matches(e)) {
          if (!brush && !drag) return;
          claim(e);
          cancelDrag();
          brush = undefined;
          renderRange();
          return;
        }
        if (!e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          if (e.key === "ArrowRight" && view.window === "live") return;
          if (!active) return;
          e.preventDefault();
          const now = clock();
          const quarter = spanOf(view.window, now, liveSpan()) / 4;
          host!.onWindow(shiftWindow(view.window, e.key === "ArrowLeft" ? -quarter : quarter, now, liveSpan()));
          return;
        }
        if (!brush) return;
      }
      const [x, y] = range(r);
      const w = y - x;
      let next: [number, number] | undefined;
      if (e.key === "ArrowLeft" && e.shiftKey) next = [x, Math.max(x + 1, y - 1)];
      else if (e.key === "ArrowRight" && e.shiftKey) next = [x, y + 1];
      else if (e.key === "ArrowLeft") next = [Math.max(0, x - 1), Math.max(0, x - 1) + w];
      else if (e.key === "ArrowRight") next = [Math.min(r.buckets - w, x + 1), Math.min(r.buckets - w, x + 1) + w];
      else if (e.key === "Home") next = [0, w];
      else if (e.key === "End") next = [r.buckets - w, r.buckets];
      else if (LOCAL.mapStripReset.matches(e)) next = [0, r.buckets];
      if (!next) return;
      e.preventDefault();
      setRange(r, next[0], next[1]);
    });
    strip.addEventListener("pointerdown", (e) => {
      if (hosted && !active) return;
      const r0 = r;
      const bucketAt = (ev: PointerEvent) => {
        const box = (scrub.querySelector(".map-strip") ?? strip).getBoundingClientRect();
        const frac = box.width > 0 ? (ev.clientX - box.left) / box.width : 0;
        return Math.max(0, Math.min(r0.buckets - 1, Math.floor(frac * r0.buckets)));
      };
      const anchor = bucketAt(e);
      const startKey = scopeKey();
      const gen = generation;
      const live0 = () => hosted && (!active || gen !== generation || scopeKey() !== startKey);
      const move = (ev: PointerEvent) => {
        if (hosted ? live0() : resp !== r0) return hosted ? abandon() : stop();
        const at = bucketAt(ev);
        setRange(r0, Math.min(anchor, at), Math.max(anchor, at) + 1);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", abandon);
        document.removeEventListener("keydown", esc, true);
        if (drag?.gen === gen && drag.stop === stop) drag = undefined;
      };
      // Hosted: brushing never moves a tile, so the drag only colours locally and
      // yields to the one explicit window commit on pointerup.
      const abandon = () => {
        stop();
        if (hosted && brush) {
          brush = undefined;
          renderRange();
        }
      };
      const up = () => {
        stop();
        if (!hosted) return;
        const picked = brush;
        brush = undefined;
        const ok = picked && !live0();
        renderRange();
        if (!ok) return;
        const b = bounds(r0);
        const v = clampView(picked, b);
        if (!(v.from < v.to) || (v.from <= b.from && v.to >= b.to)) return;
        host!.onWindow({ from: v.from, to: v.to });
      };
      const esc = (ev: KeyboardEvent) => {
        if (!LOCAL.mapStripReset.matches(ev)) return;
        if (yieldsToModal(ev, strip)) return;
        claim(ev);
        abandon();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", abandon);
      if (hosted) document.addEventListener("keydown", esc, true);
      drag = { gen, key: startKey, stop };
      e.preventDefault();
      setRange(r0, anchor, anchor + 1);
    });
    strip.addEventListener("dblclick", () => {
      if (!hosted) setRange(r, 0, r.buckets);
    });

    const footText = el("span", {});
    let wholeBtn: HTMLButtonElement | undefined;
    clear(scrub);
    if (hosted) {
      scrub.append(strip, el("div", { class: "map-scrub-foot dim" }, footText));
    } else {
      wholeBtn = el("button", { type: "button", class: "map-whole", "data-key": "map-whole" }, "Whole window");
      wholeBtn.onclick = () => setRange(r, 0, r.buckets);
      scrub.append(strip, el("div", { class: "map-scrub-foot dim" }, footText, wholeBtn));
    }
    scrubView = { resp: r, width, bw, strip, bars, brushRect, footText, wholeBtn };
  }

  function paintScrubRange(r: ActivityResponse, a: number, b: number) {
    if (!scrubView) return;
    const text = rangeText(r, a, b);
    scrubView.strip.setAttribute("aria-valuenow", String(a));
    scrubView.strip.setAttribute("aria-valuetext", text);
    const activeBrush = !hosted || !!brush;
    for (const bar of scrubView.bars) {
      const cls = bar.index >= a && bar.index < b && activeBrush ? "map-bar in" : "map-bar";
      if (bar.rect.getAttribute("class") !== cls) bar.rect.setAttribute("class", cls);
    }
    scrubView.brushRect.setAttribute("x", String(a * scrubView.bw));
    scrubView.brushRect.setAttribute("width", String((b - a) * scrubView.bw));
    if (scrubView.footText.textContent !== text) scrubView.footText.textContent = text;
    if (scrubView.wholeBtn) scrubView.wholeBtn.disabled = !brush;
  }

  function renderScrub(r: ActivityResponse, a: number, b: number) {
    ensureScrubSvg(r);
    paintScrubRange(r, a, b);
  }

  function claim(e: Event) {
    e.preventDefault();
    e.stopPropagation();
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
      const owner = activityGroupLabel(h.group,groupNames());
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
    cancel() {
      generation++;
      cancelDrag();
      if (brush) {
        brush = undefined;
        if (resp) render();
      }
    },
    setActive(next) {
      if (next === active) return;
      active = next;
      if (!next) this.cancel();
    },
    update(nextRepo, nextWorkspaces, nextPrivacy, nextView) {
      if (hosted) {
        view = nextView ?? { window: "live" };
        if ((view.worktree ?? "") !== worktree) zoom = "";
        worktree = view.worktree ?? "";
      }
      if (nextRepo !== repo) {
        abort();
        repo = nextRepo;
        worktree = hosted ? (view.worktree ?? "") : "";
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
      const renamed = workspaces.map((w) => `${w.id}\0${w.name}`).join("\n") !== nextWorkspaces.map((w) => `${w.id}\0${w.name}`).join("\n");
      workspaces = nextWorkspaces;
      // Group names come from workspaces: a cached answer is relabelled, not refetched.
      if (renamed && resp) tree = buildTree(resp, groupNames());
      if (!hosted && worktree && !workspaces.some((w) => w.id === worktree)) {
        worktree = "";
        fetchedKey = "";
      }
      if (hosted) {
        const k = scopeKey();
        if (k !== lastKey) {
          lastKey = k;
          generation++;
          cancelDrag();
          brush = undefined;
        }
      }
      load();
    },
  };
}
