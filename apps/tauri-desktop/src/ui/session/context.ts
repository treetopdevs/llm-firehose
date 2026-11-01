// Session altitude tab context: pure helpers shared by the tab lenses. No DOM.
// scope.window is the one transport; 'live' is the canonical whole-session value.

import { formatClockMs, formatDuration } from "../../format";
import type { ScopeWindow, SessionRef } from "../../scope";

export type SessionTab = "score" | "loops" | "loom" | "replay" | "handoffs" | "court";

export const SESSION_TABS: readonly SessionTab[] = ["score", "loops", "loom", "replay", "handoffs", "court"];

/** How each tab relates to scope.window: drives it, filters by it, or ignores it. */
export const WINDOW_MODE: Record<SessionTab, "transport" | "filters" | "none"> = {
  score: "transport",
  loops: "filters",
  loom: "filters",
  replay: "filters",
  handoffs: "none",
  court: "none",
};

export interface SessionTabContext {
  session: SessionRef | null;
  window: ScopeWindow;
}

export type Range = { from: number; to: number };

/** The window as a range; null for 'live' (the whole session). */
export function activeRange(w: ScopeWindow): Range | null {
  return w === "live" ? null : { from: w.from, to: w.to };
}

/** Whether an ISO time falls in the range (inclusive). A null range passes everything; an unparsable time fails any range. */
export function inWindow(iso: string, w: Range | null): boolean {
  if (!w) return true;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return ms >= w.from && ms <= w.to;
}

export function windowLabel(w: ScopeWindow): string {
  if (w === "live") return "whole session";
  return `${formatClockMs(new Date(w.from).toISOString())} → ${formatClockMs(new Date(w.to).toISOString())} · ${formatDuration(w.to - w.from)}`;
}

export function sessionKey(ref: SessionRef): string {
  return `${ref.id}\u0000${ref.source ?? ""}`;
}
