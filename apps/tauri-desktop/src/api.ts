// Typed client for the firehosed local API (docs/contracts.md). The JSON
// contract is the boundary: this file mirrors the daemon's shapes and knows
// nothing about how they're rendered.

export const DAEMON_URL = (import.meta as ImportMeta & {env?:Record<string,string>}).env?.VITE_DAEMON_URL || "http://127.0.0.1:4517";

/** The schema_version this client understands (event.CurrentSchemaVersion). */
export const CLIENT_SCHEMA_VERSION = 1;

export interface FirehoseEvent {
  schema_version?: number;
  id: string;
  time: string;
  source_time?: string;
  capture_time?: string;
  source: string;
  agent?: string;
  session_id?: string;
  trace_id?: string;
  turn_id?: string;
  call_id?: string;
  upstream_event_id?: string;
  prompt_id?: string;
  message_id?: string;
  parent_id?: string;
  request_id?: string;
  sequence?: number;
  transport?: string;
  source_version?: string;
  category: string;
  name?: string;
  severity?: string;
  summary?: string;
  repo?: string;
  cwd?: string;
  repo_id?: string;
  worktree_id?: string;
  jj_repo_id?: string;
  jj_workspace_id?: string;
  payload?: Record<string, unknown>;
  raw?: string;
}

export interface Health {
  status: string;
  version: string;
  schema_version: number;
}

export interface SessionSummary {
  id: string;
  source: string;
  agent?: string;
  repo?: string;
  cwd?: string;
  first_time: string;
  last_time: string;
  events: number;
  state?: string;
  state_since?: string;
  state_reason?: string;
  has_error?: boolean;
  last_summary?: string;
  last_category?: string;
  /** Additive: the source's session title (latest wins) or a first-prompt excerpt. */
  title?: string;
}

export interface FileArtifact {
  path: string;
  events: number;
  sources: string[];
  first_time: string;
  last_time: string;
}

/** A derived Error Signature summary (GET /errors). Count and sessions are global, not re-scoped by the ?session filter. */
export interface ErrorSignature {
  key: string; // source|category|name|class
  source: string;
  category: string;
  name?: string;
  class?: string;
  sample?: string;
  count: number;
  sessions: number;
  first_time: string;
  last_time: string;
  paths?: string[];
  /** Only with ?session=: that session's qualifying event ids in (time, id) order, capped at the 500 earliest (len == 500 means truncated). */
  members?: string[];
}

/** Exact per-session aggregates, independent of the membership sample cap. */
export interface ErrorSignatureSession {
  session_id: string;
  source: string;
  count: number;
  first_time: string;
  last_time: string;
  sample_event_id: string;
}
export interface ErrorSignatureSessions {
  key: string;
  total: number;
  offset: number;
  limit: number;
  sessions: ErrorSignatureSession[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  transport?: string;
  fidelity?: string;
  supported_events?: number;
  filtered_events?: number;
}

export interface EngineConfig {
  spool_dir?: string;
  privacy_mode?: string;
  codex_sessions_dir?: string;
  daemon_addr?: string;
}

export interface ConfigUpdateResult {
  config: EngineConfig;
  restart_required: string[];
}

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const resp = await fetch(`${DAEMON_URL}${path}`, {signal});
  if (!resp.ok) {
    throw new ApiError(path, resp.status, await resp.text(), "GET");
  }
  return resp.json() as Promise<T>;
}

/** A non-2xx daemon response; `message` keeps the historical `POST path: status body` shape. */
export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
    method = "POST",
  ) {
    super(`${method} ${path}: ${status} ${body}`);
    this.name = "ApiError";
  }
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new ApiError(path, resp.status, await resp.text());
  }
  return resp.json() as Promise<T>;
}

export const health = () => getJSON<Health>("/health");
export const recent = (limit = 500) => getJSON<FirehoseEvent[]>(`/events?limit=${limit}`);
export const sessions = (signal?: AbortSignal) => getJSON<SessionSummary[]>("/sessions", signal);
export const sessionEvents = (id: string, view?: "timeline" | "correlation", signal?: AbortSignal) =>
  getJSON<FirehoseEvent[]>(`/sessions/${encodeURIComponent(id)}${view ? `?view=${view}` : ""}`, signal);
export const traceEvents = (id: string) =>
  getJSON<FirehoseEvent[]>(`/traces/${encodeURIComponent(id)}`);
export const errorSignatures = (session = "", signal?: AbortSignal) =>
  getJSON<ErrorSignature[]>(`/errors${session ? `?session=${encodeURIComponent(session)}` : ""}`, signal);
export const errorSignatureSessions = (key: string, offset = 0, limit = 50, signal?: AbortSignal) =>
  getJSON<ErrorSignatureSessions>(`/errors/sessions?key=${encodeURIComponent(key)}&offset=${offset}&limit=${limit}`, signal);
export const files = (signal?: AbortSignal) => getJSON<FileArtifact[]>("/artifacts/files", signal);
export interface FileSession {
  workspace_kind: string;
  workspace: string;
  path: string;
  source: string;
  session_id: string;
  events: number;
  first_time: string;
  last_time: string;
  last_event_id: string;
}
export const fileSessions = (signal?: AbortSignal) => getJSON<FileSession[]>("/artifacts/file-sessions", signal);
export const doctor = () => getJSON<DoctorCheck[]>("/doctor");
export const getConfig = () => getJSON<EngineConfig>("/config");
export const setConfig = (patch: EngineConfig) =>
  postJSON<ConfigUpdateResult>("/config", patch);
export const install = (adapter: string, opts?: { replace?: boolean; forward?: boolean }) =>
  postJSON<{ ok: boolean; detail: string }>(`/install/${encodeURIComponent(adapter)}`, opts);

/** Streams live events over SSE. Returns a stop function. */
export function stream(onEvent: (ev: FirehoseEvent) => void, onStateChange?: (open: boolean) => void): () => void {
  const es = new EventSource(`${DAEMON_URL}/events/stream`);
  es.onopen = () => onStateChange?.(true);
  es.onerror = () => {
    // EventSource otherwise reconnects by itself without first reconciling
    // canonical history. The connector owns that recovery sequence.
    es.close();
    onStateChange?.(false);
  };
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as FirehoseEvent);
    } catch {
      // Malformed stream lines are dropped; the daemon surfaces parse
      // errors as meta/warn events already.
    }
  };
  return () => es.close();
}

/** Downloads a full NDJSON export via POST /export. */
export async function exportNDJSON(): Promise<Blob> {
  const resp = await fetch(`${DAEMON_URL}/export`, { method: "POST" });
  if (!resp.ok) {
    throw new Error(`POST /export: ${resp.status}`);
  }
  return resp.blob();
}

export interface AttentionEvidence {
 episode_id?:string;
 source_time?:string;
  event_id: string;
  source: string;
  kind: string;
  summary: string;
  time: string;
  observed_at: string;
}

export interface AttentionSession {
 last_observed_at?:string;
  id: string;
  source: string;
  agent?: string;
  repo?: string;
  cwd?: string;
  repo_id?: string;
  worktree_id?: string;
  jj_repo_id?: string;
  jj_workspace_id?: string;
  events: number;
  state: string;
  last: AttentionEvidence;
  pending?: AttentionEvidence;
  uncertainty?: string;
  /** Additive: same title as the /sessions summary. */
  title?: string;
}

export interface AttentionSnapshot {
 gaps?: Array<{source:string;time:string;summary:string}>;
  sessions: AttentionSession[];
  warnings: AttentionEvidence[];
}

export const attention = (signal?:AbortSignal) => getJSON<AttentionSnapshot>("/attention",signal);
export const capturedEvent = (id: string, signal?: AbortSignal) => getJSON<FirehoseEvent>(`/attention/event?id=${encodeURIComponent(id)}`, signal);

export interface WorktreeSessionRef { source: string; session_id: string; first_time: string; last_time: string; events: number }
export interface WorktreeMark {
  kind: "worktree_add" | "worktree_remove" | "commit" | "push" | "pr_create" | "pr_merge";
  session_id?: string;
  time: string;
  event_id: string;
}
export type WorktreeState = "open" | "landed" | "never_diverged" | "gone" | "unknown";
export type WorktreeOutcome = "landed" | "abandoned" | "never_diverged" | "unknown";
export interface WorktreeLifetimeView {
  repo_id: string;
  worktree_id: string;
  label?: string;
  first_time: string;
  last_time: string;
  sessions: WorktreeSessionRef[];
  sessions_total: number;
  paths: string[];
  paths_total: number;
  paths_saturated?: boolean;
  signal_events: number;
  meta_events: number;
  marks: WorktreeMark[];
  marks_total: number;
  marks_available: boolean;
  state: WorktreeState;
  outcome?: WorktreeOutcome;
  state_reason?: string;
  default_target_ref?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  last_observed?: string;
}
export interface WorktreeCommit {
  commit_id: string;
  time?: string;
  subject?: string;
  session_id?: string;
  attribution: "time_join";
}
export interface WorktreeDetail extends WorktreeLifetimeView { commits: WorktreeCommit[] }

export const worktrees = (signal?: AbortSignal) => getJSON<WorktreeLifetimeView[]>("/worktrees", signal);
export async function worktree(id: string, signal?: AbortSignal): Promise<WorktreeDetail> {
  const path = `/worktrees/${encodeURIComponent(id)}`;
  const resp = await fetch(`${DAEMON_URL}${path}`, { signal });
  if (!resp.ok) throw new ApiError(path, resp.status, await resp.text(), "GET");
  return resp.json() as Promise<WorktreeDetail>;
}
