// Presentation helpers. Pure string functions — all event-derived text is
// rendered with textContent, never markup.

import type { FirehoseEvent } from "./api";

export function formatClock(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) {
    return "--:--:--";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

export function severityClass(severity: string | undefined): string {
  switch (severity) {
    case "error":
      return "sev-error";
    case "warn":
      return "sev-warn";
    case "notice":
      return "sev-notice";
    default:
      return "sev-info";
  }
}

export function shortPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) {
    return path;
  }
  return `…/${parts.slice(-2).join("/")}`;
}

export function summaryLine(ev: FirehoseEvent): string {
  return ev.summary || ev.name || ev.category;
}

/** Where an event happened, with what privacy allows: the repo, a short path, or eight digits of a digested path. */
export function workspaceLabel(repo: string | undefined, cwd: string | undefined): string {
  if (repo) return repo;
  if (!cwd) return "";
  if (/^[0-9a-f]{64}$/.test(cwd)) return cwd.slice(0, 8);
  return shortPath(cwd);
}

/** The identity the matrix and scope compare on; see workspaceLabel for how it prints. */
export function workspaceKey(repo: string | undefined, cwd: string | undefined): string {
  return repo || cwd || "";
}

export function formatClockMs(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) {
    return "--:--:--.---";
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
}

/** One resolution per magnitude: ms, s with two decimals, then m and h with a two-digit remainder. */
export function formatDuration(ms: number): string {
  ms = Math.abs(ms);
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  const m = Math.floor(s / 60);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Capture time read against the source's own clock. */
export function latencyLabel(ms: number): string {
  return ms < 0 ? `${formatDuration(ms)} before source` : `+${formatDuration(ms)} after source`;
}

/** One payload value on one line. Privacy digests ({sha256, len}) read as a short hash and a length. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.sha256 === "string" && "len" in o) {
      return `#${o.sha256.slice(0, 8)} · len ${formatValue(o.len)}`;
    }
  }
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Anything the daemon names a session with: /sessions summaries and /attention entries alike. */
export type SessionLike = {
  id: string;
  source: string;
  agent?: string;
  repo?: string;
  cwd?: string;
  /** Additive: the source's own session title, else a first-prompt excerpt. Absent on older daemons. */
  title?: string;
  first_time?: string;
};

const DIGEST64 = /^[0-9a-f]{64}$/;

/** First eight characters of a native session id, for a copyable detail; never a label. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Where a session runs, as a person would say it: the checkout's basename,
 * with the absolute path kept for a tooltip. A digested path (older history,
 * minimal mode) reads as `#` plus eight digits, and nothing is invented.
 */
export function sessionWhere(s: SessionLike): { label: string; full?: string } {
  if (s.repo) return { label: s.repo, full: undefined };
  if (!s.cwd) return { label: "", full: undefined };
  if (DIGEST64.test(s.cwd)) return { label: `#${s.cwd.slice(0, 8)}`, full: undefined };
  const parts = s.cwd.split(/[/\\]/).filter(Boolean);
  return { label: parts[parts.length - 1] ?? s.cwd, full: s.cwd };
}

/**
 * The one name every altitude uses for a session: its captured title, else
 * "agent in checkout", else the agent and a short id. The UUID is never the
 * name; it stays available as a copyable detail next to it.
 */
export function sessionName(s: SessionLike): string {
  if (s.title) return s.title;
  const agent = s.agent || s.source;
  const where = sessionWhere(s);
  if (where.label && !where.label.startsWith("#")) return `${agent} in ${where.label}`;
  return `${agent} · ${shortId(s.id)}`;
}
