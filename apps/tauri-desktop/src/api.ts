// Typed client for the firehosed local API (docs/contracts.md). The JSON
// contract is the boundary: this file mirrors the daemon's shapes and knows
// nothing about how they're rendered.

export const DAEMON_URL = "http://127.0.0.1:4517";

/** The schema_version this client understands (event.CurrentSchemaVersion). */
export const CLIENT_SCHEMA_VERSION = 1;

export interface FirehoseEvent {
  schema_version?: number;
  id: string;
  time: string;
  source: string;
  agent?: string;
  session_id?: string;
  trace_id?: string;
  turn_id?: string;
  call_id?: string;
  category: string;
  name?: string;
  severity?: string;
  summary?: string;
  repo?: string;
  cwd?: string;
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
}

export interface FileArtifact {
  path: string;
  events: number;
  sources: string[];
  first_time: string;
  last_time: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
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

async function getJSON<T>(path: string): Promise<T> {
  const resp = await fetch(`${DAEMON_URL}${path}`);
  if (!resp.ok) {
    throw new Error(`GET ${path}: ${resp.status} ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

async function postJSON<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`POST ${path}: ${resp.status} ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

export const health = () => getJSON<Health>("/health");
export const recent = (limit = 500) => getJSON<FirehoseEvent[]>(`/events?limit=${limit}`);
export const sessions = () => getJSON<SessionSummary[]>("/sessions");
export const sessionEvents = (id: string) =>
  getJSON<FirehoseEvent[]>(`/sessions/${encodeURIComponent(id)}`);
export const traceEvents = (id: string) =>
  getJSON<FirehoseEvent[]>(`/traces/${encodeURIComponent(id)}`);
export const files = () => getJSON<FileArtifact[]>("/artifacts/files");
export const doctor = () => getJSON<DoctorCheck[]>("/doctor");
export const getConfig = () => getJSON<EngineConfig>("/config");
export const setConfig = (patch: EngineConfig) =>
  postJSON<ConfigUpdateResult>("/config", patch);
export const install = (adapter: string) =>
  postJSON<{ ok: boolean; detail: string }>(`/install/${encodeURIComponent(adapter)}`);

/** Streams live events over SSE. Returns a stop function. */
export function stream(onEvent: (ev: FirehoseEvent) => void, onStateChange?: (open: boolean) => void): () => void {
  const es = new EventSource(`${DAEMON_URL}/events/stream`);
  es.onopen = () => onStateChange?.(true);
  es.onerror = () => onStateChange?.(false);
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
