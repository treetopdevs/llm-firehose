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
