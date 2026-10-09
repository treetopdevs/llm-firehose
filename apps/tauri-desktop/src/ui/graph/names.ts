// Display names for the workspace graph. The daemon sends readable labels in every
// privacy mode (a repository's label is its absolute root, a Git worktree's its
// absolute path, a JJ workspace's its name), so names are the directory basenames
// and the full path is kept for tooltips and the inspector. Older daemons sent
// digests outside full mode: those stay digests (shown as their first eight hex
// characters), and no name is ever invented from anything else.

import type { AttentionSession } from "../../api";
import { needsLabel, pendingNow } from "../../needs";
import { formatAge, stateFresh } from "../../spark";

export type AgentState = "attention" | "working" | "observed" | "none";

/** Dot colors, mirrored by the `state-*` classes in styles.css. */
export const AGENT_STATE_COLOR: Record<AgentState, string> = {
  attention: "#f0b429",
  working: "#34d399",
  observed: "#7a5cf0",
  none: "#7d8aa0",
};

const DIGEST = /^(?:sha256:)?([a-f0-9]{64})$/;
const PILL_NAME_MAX = 24;

export function isDigest(s: string): boolean {
  return DIGEST.test(s);
}

/** First eight hex characters of a digest; any other text is returned unchanged. */
export function shortDigest(s: string): string {
  const m = DIGEST.exec(s);
  return m ? m[1].slice(0, 8) : s;
}

function looksLikePath(s: string): boolean {
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s);
}

function segments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

function baseName(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? path;
}

/** The absolute path behind a label, exactly as sent; undefined for digests and plain names. */
export function fullPath(label: string): string | undefined {
  return label && !isDigest(label) && looksLikePath(label) ? label : undefined;
}

/** Where a Git worktree lives. JJ labels are workspace names, so JJ has no path to show. */
export function workspacePath(w: NamedWorkspace, vcs: string): string | undefined {
  return vcs === "jj" ? undefined : fullPath(w.label);
}

/** Text that may be a privacy digest (commit descriptions, refs): digests read as `#abcd1234`. */
export function displayText(s: string): string {
  return isDigest(s) ? `#${shortDigest(s)}` : s;
}

export function truncateName(name: string, max = PILL_NAME_MAX): string {
  const chars = [...name];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : name;
}

/** The branch name behind a workspace's refs, or undefined for a detached checkout. */
export function branchName(refs: readonly string[] | undefined): string | undefined {
  const ref = (refs ?? []).find((r) => r && r !== "detached");
  return ref?.replace(/^refs\/heads\//, "");
}

export interface NamedWorkspace {
  label: string;
  refs?: readonly string[];
  unborn?: boolean;
}

/**
 * Short pill name. JJ: the workspace name. Git: the checkout folder; when an
 * older daemon sent a digest instead, the branch, with detached heads reading
 * `det abc1234` and digests showing their first eight hex characters.
 */
export function workspaceName(
  w: NamedWorkspace,
  vcs: string,
  mode: string | undefined,
  commitId?: string,
): string {
  if (vcs === "jj") return shortDigest(w.label) || "workspace";
  if (w.label && !isDigest(w.label) && (mode === "full" || looksLikePath(w.label))) return baseName(w.label);
  const branch = branchName(w.refs);
  if (branch) return shortDigest(branch);
  if (w.unborn) return "unborn";
  return commitId ? `det ${commitId.slice(0, 7)}` : "detached";
}

/** Repository name: the root folder, or `repo` plus eight hex for a digest from an older daemon. */
export function repoName(label: string, mode?: string): string {
  if (isDigest(label)) return `repo ${shortDigest(label)}`;
  if (mode === "full" || looksLikePath(label)) return baseName(label);
  return label;
}

/**
 * Picker names for every registered repository: the root folder, widened with
 * parent directories only for the roots that would otherwise read alike
 * (`fixtures/main` and `other/main`). A root registered under two VCSs, or two
 * digests that start alike, are told apart by VCS.
 */
export function repoNames(
  repos: readonly { label: string; vcs: string }[],
  mode?: string,
): string[] {
  const parts = repos.map((r) =>
    !isDigest(r.label) && (mode === "full" || looksLikePath(r.label)) ? segments(r.label) : [],
  );
  const depth = repos.map(() => 1);
  const nameAt = (i: number) =>
    parts[i].length
      ? parts[i].slice(-Math.min(depth[i], parts[i].length)).join("/")
      : repoName(repos[i].label, mode);
  let names = repos.map((_, i) => nameAt(i));
  for (let round = 0; round < 64; round++) {
    const groups = new Map<string, number[]>();
    names.forEach((n, i) => groups.set(n, [...(groups.get(n) ?? []), i]));
    let widened = false;
    for (const group of groups.values()) {
      // the very same root registered twice cannot be told apart by its path
      if (group.length < 2 || group.every((i) => parts[i].join("/") === parts[group[0]].join("/"))) continue;
      for (const i of group)
        if (depth[i] < parts[i].length) {
          depth[i]++;
          widened = true;
        }
    }
    if (!widened) break;
    names = repos.map((_, i) => nameAt(i));
  }
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  return names.map((n, i) => ((count.get(n) ?? 0) > 1 ? `${n} · ${repos[i].vcs}` : n));
}

/** A path as listed in Changes: the file name, or a short digest when the API sent one. */
export function fileName(path: string): string {
  return isDigest(path) ? `#${shortDigest(path)}` : baseName(path);
}

export function sourceName(source: string): string {
  switch (source) {
    case "codex":
      return "Codex";
    case "claude-code":
    case "claude":
      return "Claude Code";
    case "opencode":
      return "OpenCode";
    default:
      return source;
  }
}

/** One session's state, using the same freshness rules as the attention strip. */
export function sessionState(s: AttentionSession, nowMs: number): AgentState {
  if (pendingNow(s, nowMs)) return "attention";
  const at = Date.parse(s.last?.source_time ?? s.last?.time ?? "");
  if (s.state === "working" && stateFresh(s.state, at, nowMs)) return "working";
  return "observed";
}

const PRIORITY: Record<AgentState, number> = { attention: 3, working: 2, observed: 1, none: 0 };

/** Needs attention first, then working, then other observed states. */
export function aggregateState(states: readonly AgentState[]): AgentState {
  let best: AgentState = "none";
  for (const s of states) if (PRIORITY[s] > PRIORITY[best]) best = s;
  return best;
}

export function stateRank(s: AgentState): number {
  return PRIORITY[s];
}

const STATE_WORDS: Record<AgentState, string> = {
  attention: "needs attention",
  working: "working",
  observed: "observed",
  none: "no agent",
};
export function stateDescription(s: AgentState): string {
  return STATE_WORDS[s];
}

/** `Working`, `Needs you`, `Failed`, `Idle`: the engine's word for the session. */
export function sessionStateWord(s: AttentionSession, nowMs: number): string {
  const word = needsLabel(s, nowMs);
  const text = word === "NEEDS YOU" ? "Needs you" : word.toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ");
}

/** `2m ago`; empty when the time is unknown. */
export function relativeAge(iso: string | undefined, nowMs: number): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const ms = Math.max(0, nowMs - t);
  return ms < 1000 ? "just now" : `${formatAge(ms)} ago`;
}
