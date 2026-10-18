import type { AttentionSession, FileSession } from '../../api';
import { comparableFileScope } from '../files';
export type SharedFileLane = Pick<FileSession, 'workspace_kind' | 'workspace' | 'path'> & { members: FileSession[] };
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const identity = (source: string, id: string) => JSON.stringify([source, id]);
const validTime = (s: string) => Number.isFinite(Date.parse(s));
function firstTime(a: string, b: string): string {
  if (!validTime(a)) return validTime(b) ? b : lexical(a, b) < 0 ? a : b;
  if (!validTime(b)) return a;
  return Date.parse(a) < Date.parse(b) || (Date.parse(a) === Date.parse(b) && lexical(a, b) < 0) ? a : b;
}
function mergeDuplicate(a: FileSession, b: FileSession): FileSession {
  const timeA = validTime(a.last_time) ? Date.parse(a.last_time) : -Infinity;
  const timeB = validTime(b.last_time) ? Date.parse(b.last_time) : -Infinity;
  const order = timeA === timeB ? lexical(a.last_event_id, b.last_event_id) || lexical(a.last_time, b.last_time) : timeA < timeB ? -1 : 1;
  return { ...(order < 0 ? b : a), events: Math.max(a.events, b.events), first_time: firstTime(a.first_time, b.first_time) };
}
/** Historical recorded strings only: membership never proves simultaneous work or physical identity. */
export function sharedFileLanes(files: readonly FileSession[], sessions: readonly AttentionSession[]): SharedFileLane[] {
  const eligible = new Set(sessions.filter(s => s.source && s.id).map(s => identity(s.source, s.id)));
  const groups = new Map<string, { lane: SharedFileLane; members: Map<string, FileSession> }>();
  for (const row of files) {
    const memberKey = identity(row.source, row.session_id);
    if (!comparableFileScope(row) || !row.source || !row.session_id || !eligible.has(memberKey)) continue;
    const key = JSON.stringify([row.workspace_kind, row.workspace, row.path]);
    let group = groups.get(key);
    if (!group) {
      group = { lane: { workspace_kind: row.workspace_kind, workspace: row.workspace, path: row.path, members: [] }, members: new Map() };
      groups.set(key, group);
    }
    const prior = group.members.get(memberKey);
    group.members.set(memberKey, prior ? mergeDuplicate(prior, row) : { ...row });
  }
  return [...groups.values()].filter(g => g.members.size > 1).map(g => ({ ...g.lane, members: [...g.members.values()].sort((a, b) => lexical(a.source, b.source) || lexical(a.session_id, b.session_id)) }))
    .sort((a, b) => lexical(a.workspace_kind, b.workspace_kind) || lexical(a.workspace, b.workspace) || lexical(a.path, b.path));
}
