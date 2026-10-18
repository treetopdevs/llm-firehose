import type { AttentionEvidence, AttentionSession } from '../../api';
export const BANDS = [
    { id: 'request', label: 'Request captured' },
    { id: 'failure', label: 'Failure captured' },
    { id: 'recent', label: 'Recent activity' },
    { id: 'quiet', label: 'Quiet / unknown' },
    { id: 'completion', label: 'Completion captured' },
] as const;
export type Band = typeof BANDS[number]['id'];
export type AirspaceRow = {
    key: string;
    session: AttentionSession;
    band: Band;
    eventTime: number | null;
    eventAgeMs: number | null;
    clockNote: string;
    workspace: string;
};
type Options = {
    now: number;
    windowMs: number;
    source?: string;
    workspace?: string;
    query?: string;
};
function clock(evidence: AttentionEvidence, now: number) {
    const sourceClock = evidence.source_time != null;
    const label = sourceClock ? 'Source event time' : 'Event time (source clock unavailable)';
    const timestamp = Date.parse(evidence.source_time ?? evidence.time);
    if (!Number.isFinite(timestamp) || !Number.isFinite(now))
        return { eventTime: null, eventAgeMs: null, clockNote: `${label} unknown; age unavailable.` };
    if (timestamp > now)
        return { eventTime: null, eventAgeMs: null, clockNote: `${label} is in the future; age unavailable.` };
    return { eventTime: timestamp, eventAgeMs: now - timestamp, clockNote: label };
}
/** Source-scoped observation grouping, never a claim about a running process. */
export function deriveAirspace(sessions: readonly AttentionSession[], options: Options): {
    rows: AirspaceRow[];
    counts: Record<Band, number>;
    total: number;
} {
    const counts: Record<Band, number> = { request: 0, failure: 0, recent: 0, quiet: 0, completion: 0 };
    const query = (options.query ?? '').trim().toLowerCase();
    const rows: AirspaceRow[] = [];
    for (const session of sessions) {
        const workspace = session.worktree_id || session.jj_workspace_id || session.cwd || session.repo || '';
        if (options.source !== undefined && session.source !== options.source)
            continue;
        if (options.workspace !== undefined && workspace !== options.workspace)
            continue;
        const searchable = [session.source, session.id, session.agent, session.repo, workspace, session.state, session.uncertainty, session.pending?.summary, session.last.summary].filter(Boolean).join(' ').toLowerCase();
        if (query && !searchable.includes(query))
            continue;
        const timing = clock(session.pending ?? session.last, options.now);
        let band: Band;
        if (session.pending)
            band = session.pending.kind === 'failure' ? 'failure' : 'request';
        else if (session.state === 'failed')
            band = 'failure';
        else if (session.state === 'done')
            band = 'completion';
        else if (session.state === 'working' && timing.eventAgeMs !== null && timing.eventAgeMs <= options.windowMs)
            band = 'recent';
        else
            band = 'quiet';
        rows.push({ key: JSON.stringify([session.source, session.id]), session, band, ...timing, workspace });
        counts[band]++;
    }
    const bandIndex = new Map<Band, number>(BANDS.map((band, index) => [band.id, index]));
    const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    rows.sort((a, b) => {
        const bandOrder = bandIndex.get(a.band)! - bandIndex.get(b.band)!;
        if (bandOrder)
            return bandOrder;
        // Within the failure band, pending evidence precedes state-only failures.
        if (!!a.session.pending !== !!b.session.pending)
            return a.session.pending ? -1 : 1;
        if ((a.eventTime === null) !== (b.eventTime === null))
            return a.eventTime === null ? 1 : -1;
        if (a.eventTime !== null && b.eventTime !== null && a.eventTime !== b.eventTime)
            return a.session.pending ? a.eventTime - b.eventTime : b.eventTime - a.eventTime;
        return lexical(a.session.source, b.session.source) || lexical(a.session.id, b.session.id);
    });
    return { rows, counts, total: sessions.length };
}
