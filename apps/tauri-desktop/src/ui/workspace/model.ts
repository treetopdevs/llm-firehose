import type { FirehoseEvent, SessionSummary } from "../../api";
import { workspaceKey, workspaceLabel } from "../../format";
import { BAND_BUCKETS, bucketCountsBySession, lastReported, stateFresh } from "../../spark";

/** One workspace × agent cell, as the sessions list can be scoped to it. */
export type CellScope = { where: string; agent: string; label: string };

export type MatrixCell = {
  where: string;
  whereLabel: string;
  agent: string;
  buckets: number[];
  sessions: number;
  state: string;
  lastMs: number;
};

export type Matrix = {
  wheres: { key: string; label: string }[]; // rows, most recently active first
  agents: string[]; // columns, alphabetical
  cells: MatrixCell[]; // occupied cells in reading order
  at(where: string, agent: string): MatrixCell | undefined;
};

const RANK: Record<string, number> = { idle: 1, working: 2, needs_input: 3 };

/** The state that most needs the reader: needs you, then working, then idle. */
export function worstState(a: string, b: string): string {
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

/** Folds live sessions into workspace rows and agent columns; the same staleness rule as every other view decides what is live. */
export function buildMatrix(summaries: readonly SessionSummary[], events: readonly FirehoseEvent[], nowMs: number): Matrix {
  const counts = bucketCountsBySession(events, nowMs);
  const cells = new Map<string, MatrixCell>();
  const rowLast = new Map<string, number>();
  const rowLabel = new Map<string, string>();
  const agents = new Set<string>();
  for (const s of summaries) {
    if (!s.id) continue;
    const ref = lastReported(Date.parse(s.last_time), Date.parse(s.state_since ?? ""), s.state);
    if (!stateFresh(s.state, ref, nowMs)) continue;
    const where = workspaceKey(s.repo, s.cwd);
    const agent = s.agent || s.source;
    const key = `${where}\0${agent}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        where,
        whereLabel: workspaceLabel(s.repo, s.cwd) || "—",
        agent,
        buckets: new Array<number>(BAND_BUCKETS).fill(0),
        sessions: 0,
        state: "",
        lastMs: -Infinity,
      };
      cells.set(key, c);
    }
    const buckets = counts.get(s.id);
    if (buckets) buckets.forEach((n, i) => (c!.buckets[i] += n));
    c.sessions++;
    c.state = worstState(c.state, s.state ?? "");
    c.lastMs = Math.max(c.lastMs, ref);
    rowLast.set(where, Math.max(rowLast.get(where) ?? -Infinity, ref));
    rowLabel.set(where, c.whereLabel);
    agents.add(agent);
  }
  const wheres = [...rowLast.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key]) => ({ key, label: rowLabel.get(key) ?? "—" }));
  const agentList = [...agents].sort();
  const ordered: MatrixCell[] = [];
  for (const w of wheres) {
    for (const a of agentList) {
      const c = cells.get(`${w.key}\0${a}`);
      if (c) ordered.push(c);
    }
  }
  return {
    wheres,
    agents: agentList,
    cells: ordered,
    at: (where, agent) => cells.get(`${where}\0${agent}`),
  };
}

/** The one-cell form of the band's state column. */
export function stateGlyph(state: string): string {
  switch (state) {
    case "needs_input":
      return "?";
    case "working":
      return "●";
    case "idle":
      return "·";
    default:
      return "";
  }
}
