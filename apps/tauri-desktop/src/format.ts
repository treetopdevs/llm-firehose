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
