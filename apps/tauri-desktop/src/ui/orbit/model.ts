import type { FirehoseEvent, SessionSummary } from "../../api";

export const BODY_CAP = 20;
export const NEEDS_INPUT_DRIFT_MS = 5 * 60_000;
export const DESPAWN_MS = 8_000;

export type OrbitBody = {
  sessionId: string;
  family: string;
  repo: string;
  state: string;
  urgencyRadius: number;
  sectorAngle: number;
  activityRate: number;
  reason?: string;
  hasError: boolean;
  labelAlways: boolean;
  kind: "session" | "cluster";
  despawnAt?: number;
  memberCount?: number;
  lastSummary?: string;
  lastCategory?: string;
  lastActivityAt?: string;
};

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable sector angle in [0, 2π) from repo name. */
export function sectorForRepo(repo: string): number {
  return (hashString(repo || "_none") % 3600) / 3600 * Math.PI * 2;
}

export function urgencyRadius(state: string, dwellMs: number, activityRate: number): number {
  switch (state) {
    case "needs_input":
      return Math.max(0, 1 - dwellMs / NEEDS_INPUT_DRIFT_MS);
    case "idle":
      return 0.55;
    case "done":
      return 1.2 + Math.min(0.3, dwellMs / DESPAWN_MS);
    case "working":
    default: {
      const span = 0.15;
      return 0.85 + span * Math.min(1, Math.max(0, activityRate));
    }
  }
}

function activityRate(s: SessionSummary): number {
  // Rough volume signal from event count (log-scaled into 0..1).
  return Math.min(1, Math.log10(Math.max(1, s.events)) / 2);
}

function bodyFromSession(s: SessionSummary, now: number, jitter: number): OrbitBody {
  const state = s.state ?? "working";
  const since = s.state_since ? Date.parse(s.state_since) : now;
  const dwell = Math.max(0, now - since);
  const rate = activityRate(s);
  const base = sectorForRepo(s.repo ?? "");
  const body: OrbitBody = {
    sessionId: s.id,
    family: s.agent || s.source,
    repo: s.repo ?? "",
    state,
    urgencyRadius: urgencyRadius(state, dwell, rate),
    sectorAngle: base + jitter,
    activityRate: rate,
    reason: s.state_reason,
    hasError: !!s.has_error,
    labelAlways: state === "needs_input",
    kind: "session",
    lastSummary: s.last_summary,
    lastCategory: s.last_category,
    lastActivityAt: s.last_time,
  };
  if (state === "done") {
    body.despawnAt = since + DESPAWN_MS;
  }
  return body;
}

function urgencyScore(b: OrbitBody): number {
  // Lower radius / needs_input sorts first (more urgent).
  let score = 1 - b.urgencyRadius;
  if (b.state === "needs_input") score += 10;
  if (b.hasError) score += 5;
  if (b.state === "done") score -= 5;
  return score;
}

/** Build declarative orbit bodies from session summaries. */
export function buildScene(sessions: SessionSummary[], now: number): OrbitBody[] {
  const live = sessions.filter((s) => {
    if (s.state !== "done") return true;
    const since = s.state_since ? Date.parse(s.state_since) : now;
    return now - since < DESPAWN_MS * 2;
  });

  const byRepo = new Map<string, SessionSummary[]>();
  for (const s of live) {
    const key = s.repo || "_none";
    const list = byRepo.get(key) ?? [];
    list.push(s);
    byRepo.set(key, list);
  }

  const candidates: OrbitBody[] = [];
  for (const [, group] of byRepo) {
    group.forEach((s, i) => {
      const jitter = (i - (group.length - 1) / 2) * 0.05;
      candidates.push(bodyFromSession(s, now, jitter));
    });
  }

  if (candidates.length <= BODY_CAP) {
    return candidates;
  }

  const ranked = [...candidates].sort((a, b) => urgencyScore(b) - urgencyScore(a));
  const keep = ranked.slice(0, BODY_CAP);
  const keepIds = new Set(keep.map((b) => b.sessionId));
  const dropped = candidates.filter((b) => !keepIds.has(b.sessionId));

  const clusterMap = new Map<string, OrbitBody[]>();
  for (const b of dropped) {
    const key = b.repo || "_none";
    const list = clusterMap.get(key) ?? [];
    list.push(b);
    clusterMap.set(key, list);
  }

  const clusters: OrbitBody[] = [];
  for (const [repo, members] of clusterMap) {
    clusters.push({
      sessionId: `cluster:${repo}`,
      family: "cluster",
      repo,
      state: "working",
      urgencyRadius: 0.95,
      sectorAngle: sectorForRepo(repo),
      activityRate: Math.min(1, members.length / 10),
      hasError: members.some((m) => m.hasError),
      labelAlways: false,
      kind: "cluster",
      memberCount: members.length,
    });
  }

  return [...keep, ...clusters];
}

/** Patch bodies from a live SSE event (especially state.transition). */
export function applyTransition(bodies: OrbitBody[], ev: FirehoseEvent, now: number): OrbitBody[] {
  if (ev.source !== "firehose" || ev.name !== "state.transition" || !ev.session_id) {
    return bodies;
  }
  const state = String(ev.payload?.state ?? "");
  const reason = typeof ev.payload?.reason === "string" ? ev.payload.reason : undefined;
  const hasError = !!ev.payload?.has_error;
  return bodies.map((b) => {
    if (b.sessionId !== ev.session_id || b.kind !== "session") return b;
    const dwell = 0;
    const next: OrbitBody = {
      ...b,
      state,
      reason,
      hasError,
      labelAlways: state === "needs_input",
      urgencyRadius: urgencyRadius(state, dwell, b.activityRate),
    };
    if (state === "done") {
      next.despawnAt = now + DESPAWN_MS;
    } else {
      delete next.despawnAt;
    }
    return next;
  });
}

/** Keep hover activity current from live events between summary refreshes. */
export function applyActivity(bodies: OrbitBody[], ev: FirehoseEvent): OrbitBody[] {
  if (!ev.session_id || ev.source === "firehose") return bodies;
  return bodies.map((body) => {
    if (body.kind !== "session" || body.sessionId !== ev.session_id) return body;
    return {
      ...body,
      lastSummary: ev.summary || ev.name || ev.category,
      lastCategory: ev.category,
      lastActivityAt: ev.time,
    };
  });
}
