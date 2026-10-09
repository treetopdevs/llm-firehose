import { DAEMON_URL, type FirehoseEvent } from "../../api";
import type { GraphNode } from "./model";
export interface Repository {
  id: string;
  vcs: string;
  label: string;
  status: string;
  observed_at: string;
}
/**
 * One uncommitted (or committed, in a Comparison) file change. `path` follows the
 * privacy mode like `changed_files`; status and counts are structural metadata
 * kept in every mode. Counts are omitted for untracked and binary files.
 */
export interface FileChange {
  path: string;
  /** M modified, A added, D deleted, R renamed, C copied, T type change, U unmerged, ? untracked. */
  status: "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?" | (string & {});
  additions?: number;
  deletions?: number;
  binary?: boolean;
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
  changes?: FileChange[];
  /** True only when the workspace has more changed files than the API returns. */
  changes_truncated?: boolean;
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
  /** Name of the ref behind `default_target` (for example `main`), when known. */
  default_target_ref?: string;
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
  changes?: FileChange[];
  changes_truncated?: boolean;
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
  signal?: AbortSignal,
): Promise<T> {
  const query = new URLSearchParams(params);
  const r = await fetch(
    `${DAEMON_URL}/workspace-graph${path}?${query}`,
    body === undefined
      ? signal
        ? { signal }
        : {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
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
  /** Aborting `signal` cancels the request and frees its connection; the promise then rejects with an AbortError. */
  timeline: (params: Record<string, string>, signal?: AbortSignal) =>
    request<EventPage>("/timeline", params, undefined, signal),
};
