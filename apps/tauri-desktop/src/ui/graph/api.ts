import { DAEMON_URL, type FirehoseEvent } from "../../api";
import type { GraphNode } from "./model";
export interface Repository {
  id: string;
  vcs: string;
  label: string;
  status: string;
  observed_at: string;
}
export interface Workspace {
  id: string;
  repo_id: string;
  label: string;
  revision: string;
  refs: string[];
  dirty: boolean;
  conflicted: boolean;
  availability: string;
  unborn: boolean;
  changed_files?: string[];
}
export interface Snapshot {
  repository: Repository;
  generation: string;
  nodes: GraphNode[];
  workspaces: Workspace[];
  boundaries: { child: string; parent: string; reason: string }[];
  warnings: string[];
  next_cursor?: string;
  stale: boolean;
  default_target?: string;
  attention_associations?: Record<
    string,
    { repo_id: string; workspace_id: string; event_id: string }
  >;
}
export interface Comparison {
  selected: string;
  target: string;
  selected_only: string[];
  target_only: string[];
  merge_bases: string[];
  changed_files: string[];
  disconnected: boolean;
  warnings: string[];
}
export interface EventPage {
  events: FirehoseEvent[];
  next_cursor?: string;
  has_more: boolean;
  order: string;
  capture_gap?: boolean;
  associations?: Record<string, { repo_id: string; workspace_id: string }>;
}
async function request<T>(
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const query = new URLSearchParams(params);
  const r = await fetch(
    `${DAEMON_URL}/workspace-graph${path}?${query}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!r.ok) throw new Error(`Graph request failed (${r.status})`);
  return r.json();
}
export const graphAPI = {
  repos: () => request<Repository[]>("/repos"),
  register: (root: string, vcs: string) =>
    request<Repository>("/repos", {}, { root, vcs }),
  snapshot: (repo: string, cursor = "", refresh = false) =>
    request<Snapshot>("", { repo_id: repo, cursor, refresh: String(refresh) }),
  compare: (repo: string, revision: string, target: string) =>
    request<Comparison>("/compare", { repo_id: repo, revision, target }),
  timeline: (params: Record<string, string>) =>
    request<EventPage>("/timeline", params),
};
