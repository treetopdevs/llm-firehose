// Fleet fixtures: Project's worktree rows plus attention sessions and events.
import type { AttentionEvidence, AttentionSession, FirehoseEvent } from "../../api";
import { NOW, iso } from "../project/model.fixtures";

export { NOW, iso, row, FIXTURE_ROWS } from "../project/model.fixtures";

/** An attention session fresh at NOW; override any field. `pending` is a request captured `waitMs` ago. */
export function att(over: Partial<AttentionSession> & { id: string; waitMs?: number; lastAgoMs?: number }): AttentionSession {
  const { waitMs, lastAgoMs, ...rest } = over;
  const evidence = (agoMs: number, kind: string): AttentionEvidence => ({
    event_id: `e-${over.id}-${kind}-${agoMs}`,
    source: rest.source ?? "claude-code",
    kind,
    summary: kind === "request" ? "may I run this?" : "edit view.go",
    time: iso(NOW - agoMs),
    observed_at: iso(NOW - agoMs),
  });
  const s: AttentionSession = {
    source: "claude-code",
    agent: "claude",
    events: 3,
    state: waitMs !== undefined ? "needs_input" : "working",
    last: evidence(lastAgoMs ?? Math.min(waitMs ?? 60_000, 60_000), "activity"),
    ...rest,
  };
  if (waitMs !== undefined && !s.pending) s.pending = evidence(waitMs, "request");
  return s;
}

/** A captured event; collisions on session_id/call_id across sources are the point of overriding both. */
export function ev(over: Partial<FirehoseEvent> & { id: string }): FirehoseEvent {
  return { time: iso(NOW), source: "claude-code", category: "tool", ...over };
}
