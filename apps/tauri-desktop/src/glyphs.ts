// The glyph table: the one place the app's mark vocabulary is spelled. Every
// renderer (Fleet, Project, Sessions, workspace states) imports its characters,
// badge strings, lane-mark geometry and dash patterns from here, and the ? legend
// is generated from GLYPH_GROUPS, so what the legend shows cannot drift from what
// the views draw. glyphs.test.ts scans the source for stray single-character marks.
import type { WorktreeState } from "./api";

/** One glyph per worktree state; Project and Fleet share the vocabulary. */
export const FORK_GLYPH: Record<WorktreeState, string> = { open: "●", landed: "✓", gone: "×", never_diverged: "·", unknown: "?" };
/** Appended to an open branch of work that has gone quiet (Fleet). */
export const IDLE_MARK = "…";
/** Project's idle flag at the end of a lane. */
export const IDLE_BANG = "!";
/** A session or branch that needs you. */
export const NEEDS_MARK = "?";
/** A captured error on a session row. */
export const ERROR_MARK = "!";
/** A removed worktree. */
export const GONE_MARK = FORK_GLYPH.gone;
/** Fleet row glyph for events that belong to no project. */
export const NO_DATA_MARK = "–";
export const NO_PROJECT_MARK = NO_DATA_MARK;
/** Project lane text beside a landed rejoin whose merge time is unknown. */
export const LANDED_UNKNOWN = "landed ?";
/** Project lane edges that run past the visible window. */
export const CLIP = { left: "‹", right: "›" } as const;

/** Ahead/behind/dirty marks beside a Project lane. */
export const BADGE = {
  ahead: "↑",
  behind: "↓",
  dirty: "±",
  /** "↑3 ↓1 ±" for an open lane; only the dirty mark for any other state. */
  format(open: boolean, ahead?: number, behind?: number, dirty?: boolean): string {
    if (!open) return dirty ? BADGE.dirty : "";
    const parts: string[] = [];
    if ((ahead ?? 0) > 0) parts.push(`${BADGE.ahead}${ahead}`);
    if ((behind ?? 0) > 0) parts.push(`${BADGE.behind}${behind}`);
    if (dirty) parts.push(BADGE.dirty);
    return parts.join(" ");
  },
} as const;

/** Session states that carry a mark in the workspace list. */
export const SESSION_STATE_MARKS = { needs_input: NEEDS_MARK, working: FORK_GLYPH.open, idle: FORK_GLYPH.never_diverged } as const;

export type LaneMarkKind = "push" | "pr_create" | "pr_merge" | "commit";
export interface LaneMarkShape { path(cx: number, cy: number, r?: number): string }
/** Geometry of the marks drawn on a Project lane; r scales the unit shape (1 = as drawn). */
export const LANE_MARK_SHAPES: Record<LaneMarkKind, LaneMarkShape> = {
  push: { path: (x, y, r = 1) => `M ${x} ${y - 6 * r} L ${x + 5 * r} ${y + 4 * r} L ${x - 5 * r} ${y + 4 * r} Z` },
  pr_create: { path: (x, y, r = 1) => `M ${x - 5 * r} ${y - 5 * r} L ${x + 5 * r} ${y - 5 * r} L ${x + 5 * r} ${y + 5 * r} L ${x - 5 * r} ${y + 5 * r} Z` },
  pr_merge: { path: (x, y, r = 1) => `M ${x} ${y - 6 * r} L ${x + 6 * r} ${y} L ${x} ${y + 6 * r} L ${x - 6 * r} ${y} Z` },
  commit: { path: (x, y, r = 1) => `M ${x - 5 * r} ${y - 5 * r} L ${x + 5 * r} ${y - 5 * r} L ${x + 5 * r} ${y + 5 * r} L ${x - 5 * r} ${y + 5 * r} Z` },
};

/** The path a lane mark draws; unknown kinds draw as a commit. */
/** A commit draws as a vertical tick on the lane (ui/project); the legend swatch uses the same extent. */
export const COMMIT_TICK = { half: 9 } as const;

export function laneMarkPath(kind: string, x: number, y: number): string {
  return (LANE_MARK_SHAPES[kind as LaneMarkKind] ?? LANE_MARK_SHAPES.commit).path(x, y);
}

/** stroke-dasharray values for Project lane parts. */
/** The hatch tile Project fills an unknown-state span with; the legend swatch uses the same tile. */
export const HATCH = { size: 6, d: "M 0 6 L 6 0" } as const;
/** A rejoin curve from (x0, y) on the lane to (rx, baseY) on the main line; lane and swatch both draw it. */
export function rejoinPath(x0: number, y: number, rx: number, baseY: number): string {
  return `M ${x0} ${y} C ${rx} ${y}, ${rx} ${y}, ${rx} ${baseY}`;
}
export const DASH = { tail: "4 3", landgap: "2 3", unknownRejoin: "3 3", flat: "2 3" } as const;

export interface GlyphEntry {
  glyph?: string;
  swatch?: { kind: "mark" | "dash"; id: string };
  name: string;
  meaning: string;
  /** The stylesheet selector that styles this part of a lane, when there is one. */
  hook?: string;
}
export interface GlyphGroup { id: string; title: string; entries: GlyphEntry[] }

export const GLYPH_GROUPS: GlyphGroup[] = [
  {
    id: "fork",
    title: "Branch of work",
    entries: [
      { glyph: FORK_GLYPH.open, name: "open", meaning: "A worktree still in use." },
      { glyph: FORK_GLYPH.landed, name: "landed", meaning: "Its work is reachable from the default branch." },
      { glyph: FORK_GLYPH.gone, name: "gone", meaning: "The worktree was removed." },
      { glyph: FORK_GLYPH.never_diverged, name: "never diverged", meaning: "No divergence from the main line was observed." },
      { glyph: FORK_GLYPH.unknown, name: "unknown", meaning: "The state could not be determined." },
    ],
  },
  {
    id: "idle",
    title: "Idle",
    entries: [
      { glyph: IDLE_MARK, name: "idle count", meaning: "Open branches of work that have gone quiet (Fleet)." },
      { glyph: IDLE_BANG, name: "idle lane", meaning: "This open worktree has gone quiet (Project)." },
    ],
  },
  {
    id: "needs",
    title: "Needs you",
    entries: [
      { glyph: NEEDS_MARK, name: "needs you", meaning: "A session is waiting on a request you have not answered." },
      { glyph: ERROR_MARK, name: "error", meaning: "An error was captured in this session." },
    ],
  },
  {
    id: "lane-marks",
    title: "Lane marks",
    entries: [
      { swatch: { kind: "mark", id: "push" }, name: "push", meaning: "A push command was observed." },
      { swatch: { kind: "mark", id: "pr_merge" }, name: "pr merge", meaning: "A pull-request merge command was observed." },
      { swatch: { kind: "mark", id: "pr_create" }, name: "pr create", meaning: "A pull-request creation command was observed." },
      { swatch: { kind: "mark", id: "commit" }, name: "commit", meaning: "A commit was made (a vertical tick)." },
    ],
  },
  {
    id: "rejoin",
    title: "Rejoin",
    entries: [
      { swatch: { kind: "dash", id: "rejoin" }, name: "rejoin", meaning: "The lane curves back to the main line at the merge.", hook: ".project-rejoin" },
      { glyph: LANDED_UNKNOWN, swatch: { kind: "dash", id: "unknown_rejoin" }, name: "landed, merge time unknown", meaning: "It landed, but no merge was recorded: the dashed rejoin sits at the last activity." },
    ],
  },
  {
    id: "badges",
    title: "Badges",
    entries: [
      { glyph: BADGE.ahead, name: "ahead", meaning: "Commits not yet on the main line, with their count." },
      { glyph: BADGE.behind, name: "behind", meaning: "Commits on the main line this worktree lacks, with their count." },
      { glyph: BADGE.dirty, name: "dirty", meaning: "Uncommitted changes." },
    ],
  },
  {
    id: "lane-styles",
    title: "Lane styles",
    entries: [
      { swatch: { kind: "dash", id: "solid" }, name: "solid", meaning: "Recorded activity on the worktree." },
      { swatch: { kind: "dash", id: "tail" }, name: "dashed tail", meaning: "An open worktree, quiet since its last activity.", hook: ".project-tail" },
      { swatch: { kind: "dash", id: "flat" }, name: "dotted run", meaning: "No divergence from the main line was observed.", hook: ".project-lane.flat" },
      { swatch: { kind: "dash", id: "hatched" }, name: "hatched", meaning: "State unknown: the span is only approximate.", hook: ".project-lane.hatched" },
      { swatch: { kind: "dash", id: "landgap" }, name: "land gap", meaning: "Time between the last activity and the recorded merge.", hook: ".project-landgap" },
    ],
  },
  {
    id: "session-state",
    title: "Session state",
    entries: [
      { glyph: SESSION_STATE_MARKS.needs_input, name: "needs you", meaning: "Waiting on you." },
      { glyph: SESSION_STATE_MARKS.working, name: "working", meaning: "Active right now." },
      { glyph: SESSION_STATE_MARKS.idle, name: "idle", meaning: "Quiet." },
    ],
  },
  {
    id: "edges",
    title: "Window edges",
    entries: [
      { glyph: CLIP.left, name: "clipped left", meaning: "The lane began before the visible window." },
      { glyph: CLIP.right, name: "clipped right", meaning: "The lane continues past the visible window." },
    ],
  },
];

const NS = "http://www.w3.org/2000/svg";
export const SWATCH_W = 24;
export const SWATCH_H = 16;
const CX = SWATCH_W / 2;
const CY = SWATCH_H / 2;

function node(tag: string, attrs: Record<string, string | number>): SVGElement {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n as SVGElement;
}

/** The legend swatch for an entry that has one, drawn from the same shapes and dashes as the views; null otherwise. */
export function swatchSvg(entry: GlyphEntry): SVGElement | null {
  const sw = entry.swatch;
  if (!sw) return null;
  const svg = node("svg", { viewBox: `0 0 ${SWATCH_W} ${SWATCH_H}`, width: SWATCH_W, height: SWATCH_H, "aria-hidden": "true", class: "legend-swatch", "data-cx": CX, "data-cy": CY });
  const ink = { stroke: "currentColor", fill: "none" };
  if (sw.kind === "mark" && sw.id === "commit") {
    svg.append(node("line", { class: "legend-tick", x1: CX, x2: CX, y1: CY - COMMIT_TICK.half, y2: CY + COMMIT_TICK.half, stroke: "currentColor", "stroke-width": 1 }));
    return svg;
  }
  if (sw.kind === "mark") {
    const shape = LANE_MARK_SHAPES[sw.id as LaneMarkKind] ?? LANE_MARK_SHAPES.pr_create;
    svg.append(node("path", { d: shape.path(CX, CY, 1), fill: "currentColor" }));
    return svg;
  }
  const line = (dash?: string): SVGElement =>
    node("line", { x1: 2, x2: SWATCH_W - 2, y1: CY, y2: CY, ...ink, "stroke-width": 2, ...(dash ? { "stroke-dasharray": dash } : {}) });
  switch (sw.id) {
    case "rejoin":
      svg.append(node("path", { d: rejoinPath(2, CY, SWATCH_W - 4, SWATCH_H - 2), ...ink }));
      break;
    case "unknown_rejoin":
      svg.append(node("path", { d: rejoinPath(2, CY, SWATCH_W - 4, SWATCH_H - 2), ...ink, "stroke-dasharray": DASH.unknownRejoin }));
      break;
    case "tail":
      svg.append(line(DASH.tail));
      break;
    case "landgap":
      svg.append(line(DASH.landgap));
      break;
    case "flat":
      svg.append(line(DASH.flat));
      break;
    case "hatched":
      const pat = node("pattern", { id: "legend-hatch", width: HATCH.size, height: HATCH.size, patternUnits: "userSpaceOnUse" });
      pat.append(node("path", { d: HATCH.d, stroke: "currentColor", "stroke-width": 1 }));
      svg.append(node("defs", {}));
      svg.lastChild!.appendChild(pat);
      svg.append(node("rect", { class: "legend-hatch", x: 2, y: CY - 4, width: SWATCH_W - 4, height: 8, fill: "url(#legend-hatch)", stroke: "currentColor" }));
      break;
    default:
      svg.append(line());
  }
  return svg;
}
